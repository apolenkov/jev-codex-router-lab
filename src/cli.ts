import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RouterDecision, RouterInput } from "./contracts.js";
import { PolicyError, precheck } from "./policy.js";
import { NONE } from "./questions.js";
import { routeWithTelemetry, type RouteExecution } from "./router.js";
import type { SemanticGateway } from "./semantic-gateway.js";
import { buildReport, type PriceEnvironment } from "./telemetry.js";
import { createTypeSafeGateway } from "./typesafe-gateway.js";

interface ParsedArguments {
  input: string;
  report?: string;
}

type ReportHandle = Awaited<ReturnType<typeof open>>;

interface ReportIo {
  fstat(handle: ReportHandle): Promise<Stats>;
  write(
    handle: ReportHandle,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<number>;
  sync(handle: ReportHandle): Promise<void>;
}

interface InputIo {
  fstat(handle: ReportHandle): Promise<Stats>;
  read(handle: ReportHandle): Promise<string>;
}

export interface CliOptions {
  cwd?: string;
  repositoryRoot?: string;
  createGateway?: () => SemanticGateway;
  env?: PriceEnvironment;
  inputIo?: Partial<InputIo>;
  reportIo?: Partial<ReportIo>;
}

export interface CliRunResult {
  exitCode: 0 | 2;
  decision?: RouterDecision;
  error?: string;
}

const DEFAULT_REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const parseArguments = (argv: readonly string[]): ParsedArguments | null => {
  let input: string | undefined;
  let report: string | undefined;

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      (flag !== "--input" && flag !== "--report") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      return null;
    }
    if (flag === "--input") {
      if (input !== undefined) {
        return null;
      }
      input = value;
    } else {
      if (report !== undefined) {
        return null;
      }
      report = value;
    }
  }

  if (input === undefined) {
    return null;
  }
  return report === undefined ? { input } : { input, report };
};

const isWithin = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
};

interface FileIdentity {
  device: number;
  inode: number;
}

interface InputDocument extends FileIdentity {
  canonicalPath: string;
  requestedPath: string;
  contents: string;
}

interface OpenedReport {
  handle: ReportHandle;
}

type ReportPreparation =
  | { status: "ready"; report: OpenedReport }
  | { status: "invalid" }
  | { status: "created-file-failure" };

const REPORT_FAILURE =
  "unable to write report; incomplete report file may require manual removal";

const DEFAULT_INPUT_IO: InputIo = {
  fstat: (handle) => handle.stat(),
  read: (handle) => handle.readFile({ encoding: "utf8" }),
};

const DEFAULT_REPORT_IO: ReportIo = {
  fstat: (handle) => handle.stat(),
  write: async (handle, buffer, offset, length, position) =>
    (await handle.write(buffer, offset, length, position)).bytesWritten,
  sync: (handle) => handle.sync(),
};

const REPORT_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin", "linux"]);

const hasErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const identityOf = (value: Stats): FileIdentity => ({
  device: value.dev,
  inode: value.ino,
});

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.device === right.device && left.inode === right.inode;

const canonicalReportPath = async (
  value: string,
  cwd: string,
  repositoryRoot: string,
): Promise<{ parentPath: string; targetPath: string } | null> => {
  const target = resolve(cwd, value);
  try {
    const [root, parent] = await Promise.all([
      realpath(repositoryRoot),
      realpath(dirname(target)),
    ]);
    const canonicalTarget = resolve(parent, basename(target));
    if (!isWithin(root, canonicalTarget) || !isWithin(root, parent)) {
      return null;
    }
    return { parentPath: parent, targetPath: canonicalTarget };
  } catch {
    return null;
  }
};

const readInput = async (
  inputPath: string,
  io: InputIo,
): Promise<InputDocument | null> => {
  let handle: ReportHandle | undefined;
  try {
    const canonicalPath = await realpath(inputPath);
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    handle = await open(canonicalPath, flags);
    const opened = await io.fstat(handle);
    if (!opened.isFile()) {
      return null;
    }
    const contents = await io.read(handle);
    return {
      canonicalPath,
      requestedPath: inputPath,
      contents,
      ...identityOf(opened),
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const prepareReport = async (
  value: string,
  cwd: string,
  repositoryRoot: string,
  input: InputDocument,
  io: ReportIo,
): Promise<ReportPreparation> => {
  const paths = await canonicalReportPath(value, cwd, repositoryRoot);
  if (paths === null) {
    return { status: "invalid" };
  }

  let existing: Stats | undefined;
  try {
    existing = await lstat(paths.targetPath);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      return { status: "invalid" };
    }
  }
  if (
    paths.targetPath === input.canonicalPath ||
    paths.targetPath === input.requestedPath ||
    (existing !== undefined && sameIdentity(identityOf(existing), input)) ||
    existing !== undefined
  ) {
    return { status: "invalid" };
  }

  const flags = constants.O_WRONLY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK |
    constants.O_CREAT |
    constants.O_EXCL;
  let handle: ReportHandle;
  try {
    handle = await open(paths.targetPath, flags, 0o600);
  } catch {
    return { status: "invalid" };
  }

  try {
    const opened = await io.fstat(handle);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      sameIdentity(identityOf(opened), input)
    ) {
      throw new Error("invalid created report");
    }
    return { status: "ready", report: { handle } };
  } catch {
    await handle.close().catch(() => undefined);
    return { status: "created-file-failure" };
  }
};

const writeReport = async (
  report: OpenedReport,
  contents: string,
  io: ReportIo,
): Promise<boolean> => {
  const buffer = Buffer.from(contents, "utf8");
  try {
    let offset = 0;
    while (offset < buffer.length) {
      const bytesWritten = await io.write(
        report.handle,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (
        !Number.isInteger(bytesWritten) ||
        bytesWritten <= 0 ||
        bytesWritten > buffer.length - offset
      ) {
        return false;
      }
      offset += bytesWritten;
    }
    await io.sync(report.handle);
    return true;
  } catch {
    return false;
  }
};

const serviceFallback = (forcedSkillIds: readonly string[]): RouteExecution => ({
  decision: { status: "fallback", reason: "service-error", forcedSkillIds },
  telemetry: { passes: [], totalLatencyMs: 0 },
});

const hasReservedChoiceId = (input: ReturnType<typeof precheck>): boolean => [
  input.taskId,
  input.policyVersion,
  input.catalogHash,
  ...input.skills.map(({ id }) => id),
  ...(input.criticalGapCandidates ?? []).map(({ id }) => id),
  ...(input.architectureForkCandidates ?? []).map(({ id }) => id),
  ...(input.reuseCandidates ?? []).map(({ id }) => id),
  ...(input.contextFragments ?? []).map(({ id }) => id),
].includes(NONE);

export async function runCli(
  argv: readonly string[],
  options: CliOptions = {},
): Promise<CliRunResult> {
  const args = parseArguments(argv);
  if (args === null) {
    return { exitCode: 2, error: "invalid CLI usage" };
  }

  const cwd = options.cwd ?? process.cwd();
  const repositoryRoot = options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT;
  const inputPath = resolve(cwd, args.input);

  const inputIo: InputIo = {
    fstat: options.inputIo?.fstat ?? DEFAULT_INPUT_IO.fstat,
    read: options.inputIo?.read ?? DEFAULT_INPUT_IO.read,
  };
  const input = await readInput(inputPath, inputIo);
  if (input === null) {
    return { exitCode: 2, error: "unable to read input" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.contents);
  } catch {
    return { exitCode: 2, error: "invalid JSON input" };
  }

  let checked: ReturnType<typeof precheck>;
  try {
    checked = precheck(parsed as RouterInput);
  } catch (error) {
    const message = error instanceof PolicyError ? "invalid input" : "unable to validate input";
    return { exitCode: 2, error: message };
  }
  if (hasReservedChoiceId(checked)) {
    return { exitCode: 2, error: "invalid input" };
  }

  const reportIo: ReportIo = {
    fstat: options.reportIo?.fstat ?? DEFAULT_REPORT_IO.fstat,
    write: options.reportIo?.write ?? DEFAULT_REPORT_IO.write,
    sync: options.reportIo?.sync ?? DEFAULT_REPORT_IO.sync,
  };
  let openedReport: OpenedReport | undefined;
  if (args.report !== undefined) {
    if (!REPORT_PLATFORMS.has(process.platform)) {
      return { exitCode: 2, error: "report publishing unsupported on this platform" };
    }
    const prepared = await prepareReport(
      args.report,
      cwd,
      repositoryRoot,
      input,
      reportIo,
    );
    if (prepared.status === "invalid") {
      return { exitCode: 2, error: "invalid report path" };
    }
    if (prepared.status === "created-file-failure") {
      return { exitCode: 2, error: REPORT_FAILURE };
    }
    openedReport = prepared.report;
  }

  try {
    let execution: RouteExecution;
    try {
      const gateway = (options.createGateway ?? createTypeSafeGateway)();
      execution = await routeWithTelemetry(parsed as RouterInput, gateway);
    } catch {
      execution = serviceFallback(checked.forcedSkillIds);
    }

    if (openedReport !== undefined) {
      const report = buildReport(execution.decision, execution.telemetry, options.env ?? process.env);
      if (!await writeReport(
        openedReport,
        `${JSON.stringify(report, null, 2)}\n`,
        reportIo,
      )) {
        return { exitCode: 2, error: REPORT_FAILURE };
      }
    }

    const exitCode = execution.decision.status === "fallback" &&
      execution.decision.reason === "invalid-input"
      ? 2
      : 0;
    return { exitCode, decision: execution.decision };
  } finally {
    await openedReport?.handle.close().catch(() => undefined);
  }
}

const main = async (): Promise<void> => {
  const result = await runCli(process.argv.slice(2));
  if (result.decision !== undefined) {
    process.stdout.write(`${JSON.stringify(result.decision)}\n`);
  }
  if (result.error !== undefined) {
    process.stderr.write(`${result.error}\n`);
  }
  process.exitCode = result.exitCode;
};

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  pathToFileURL(resolve(entrypoint)).href === import.meta.url
) {
  void main();
}
