import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Fetch } from "@typesafe-ai/sdk";
import type { RouterInput } from "./contracts.js";
import { precheck } from "./policy.js";
import {
  createAtomicCalibrationCheckpointStore,
  createAtomicCalibrationReportWriter,
  createCalibrationTransport,
  canonicalFingerprint,
  parseCalibrationCorpus,
  runCalibrationExperiment,
  type CalibrationCorpus,
  type CalibrationReport,
} from "./calibration-runner.js";

const DEFAULT_REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REPORT_NAME = "calibration-report.json";
const CHECKPOINT_NAME = "calibration-checkpoint.json";
const CORPUS_PATH = "fixtures/calibration-corpus.json";
const SMOKE_PATH = "fixtures/two-pass-smoke-input.json";
const CORPUS_FINGERPRINT = "85fdb0f1183f8fb42332d14f6396bc4a5fd32c079ea968f40a998975f7eb9fa3";
const SMOKE_FINGERPRINT = "fa506bb74e22abff184bbd643f4b175cc8198abeaa7a184357d037e4ff06e4af";

export interface CalibrationCliOptions {
  readonly repositoryRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: Fetch;
  readonly createTransport?: typeof createCalibrationTransport;
}

export interface CalibrationCliSummary {
  readonly phase: CalibrationReport["phase"];
  readonly corpusFingerprint: string;
  readonly model: string;
  readonly attempts: number;
  readonly spentUsd: number;
  readonly holdoutPass: boolean | null;
  readonly smokeStatus: "completed" | "skipped" | "failed" | null;
  readonly smokeDecisionStatus: "ok" | "fallback" | null;
}

export interface CalibrationCliResult {
  readonly exitCode: 0 | 2;
  readonly summary?: CalibrationCliSummary;
  readonly error?: string;
}

const hasErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const isWithin = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
};

const sameIdentity = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const readPinnedFixture = async <T>(
  root: string,
  relativePath: string,
  expectedFingerprint: string,
  parse: (serialized: string) => T,
): Promise<T> => {
  const path = join(root, relativePath);
  if (await realpath(path) !== path || !(await lstat(path)).isFile()) {
    throw new Error("invalid fixture path");
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("invalid fixture");
    const serialized = await handle.readFile({ encoding: "utf8" });
    const current = await lstat(path);
    if (!current.isFile() || !sameIdentity(opened, current)) {
      throw new Error("fixture path changed");
    }
    const parsed = parse(serialized);
    if (canonicalFingerprint(parsed) !== expectedFingerprint) {
      throw new Error("fixture fingerprint mismatch");
    }
    return parsed;
  } finally {
    await handle.close();
  }
};

interface EvidencePaths {
  readonly handle: FileHandle;
  readonly requestedDirectory: string;
  readonly identity: Stats;
  readonly report: string;
  readonly checkpoint: string;
}

const evidencePaths = async (
  repositoryRoot: string,
): Promise<EvidencePaths | null> => {
  let handle: FileHandle | undefined;
  try {
    const root = await realpath(repositoryRoot);
    const artifacts = join(root, "artifacts");
    const artifactsStat = await lstat(artifacts);
    if (!artifactsStat.isDirectory()) return null;
    const canonicalArtifacts = await realpath(artifacts);
    if (!isWithin(root, canonicalArtifacts)) return null;

    handle = await open(
      artifacts,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const identity = await handle.stat();
    if (!identity.isDirectory() || !sameIdentity(identity, artifactsStat)) return null;

    const report = join(canonicalArtifacts, REPORT_NAME);
    const checkpoint = join(canonicalArtifacts, CHECKPOINT_NAME);
    for (const path of [report, checkpoint]) {
      try {
        await lstat(path);
        return null;
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) return null;
      }
    }
    const result = {
      handle,
      requestedDirectory: artifacts,
      identity,
      report,
      checkpoint,
    };
    handle = undefined;
    return result;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const evidencePathUnchanged = async (paths: EvidencePaths): Promise<boolean> => {
  try {
    const current = await lstat(paths.requestedDirectory);
    return current.isDirectory() && sameIdentity(paths.identity, current);
  } catch {
    return false;
  }
};

const summaryOf = (report: CalibrationReport): CalibrationCliSummary => ({
  phase: report.phase,
  corpusFingerprint: report.corpusFingerprint,
  model: report.model,
  attempts: report.accounting.attempts,
  spentUsd: report.accounting.spentUsd,
  holdoutPass: report.holdout?.pass ?? null,
  smokeStatus: report.smoke?.status ?? null,
  smokeDecisionStatus: report.smoke?.status === "completed"
    ? report.smoke.decision.status
    : null,
});

export const runCalibrationCli = async (
  argv: readonly string[],
  options: CalibrationCliOptions = {},
): Promise<CalibrationCliResult> => {
  if (argv.length !== 0) {
    return { exitCode: 2, error: "invalid CLI usage" };
  }
  const apiKey = (options.env ?? process.env).TYPESAFE_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return { exitCode: 2, error: "missing TYPESAFE_API_KEY" };
  }

  let repositoryRoot: string;
  try {
    repositoryRoot = await realpath(resolve(options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT));
  } catch {
    return { exitCode: 2, error: "evidence path unavailable" };
  }
  const paths = await evidencePaths(repositoryRoot);
  if (paths === null) {
    return { exitCode: 2, error: "evidence path unavailable" };
  }

  try {
    let corpus: CalibrationCorpus;
    let smokeInput: RouterInput;
    try {
      corpus = await readPinnedFixture(
        repositoryRoot,
        CORPUS_PATH,
        CORPUS_FINGERPRINT,
        parseCalibrationCorpus,
      );
      smokeInput = await readPinnedFixture(
        repositoryRoot,
        SMOKE_PATH,
        SMOKE_FINGERPRINT,
        (serialized) => JSON.parse(serialized) as RouterInput,
      );
      precheck(smokeInput);
    } catch {
      return { exitCode: 2, error: "invalid frozen input" };
    }

    const checkpoint = createAtomicCalibrationCheckpointStore(paths.checkpoint);
    const assertEvidencePath = async (): Promise<void> => {
      if (!await evidencePathUnchanged(paths)) {
        throw new Error("evidence path changed");
      }
    };
    const guardedCheckpoint = {
      claim: async (value: Parameters<typeof checkpoint.claim>[0]) => {
        await assertEvidencePath();
        const claimed = await checkpoint.claim(value);
        // Never clean up by pathname after identity failure: it may now target outside data.
        await assertEvidencePath();
        return claimed;
      },
      write: async (value: Parameters<typeof checkpoint.write>[0]) => {
        await assertEvidencePath();
        await checkpoint.write(value);
        await assertEvidencePath();
      },
    };
    const transport = await (options.createTransport ?? createCalibrationTransport)({
      apiKey,
      corpus,
      fetch: options.fetch ?? globalThis.fetch,
      checkpoint: guardedCheckpoint,
    });
    if (!await evidencePathUnchanged(paths)) {
      await transport.terminalize("post-transport-validation");
      return { exitCode: 2, error: "evidence path unavailable" };
    }
    const report = await runCalibrationExperiment({
      corpus,
      smokeInput,
      transport,
      writeReport: createAtomicCalibrationReportWriter(paths.report, {
        beforeWrite: assertEvidencePath,
      }),
    });
    if (!await evidencePathUnchanged(paths)) {
      return { exitCode: 2, error: "evidence path unavailable" };
    }
    return {
      exitCode: report.phase === "smoke-completed" &&
          report.smoke?.status === "completed" &&
          report.smoke.decision.status === "ok"
        ? 0
        : 2,
      summary: summaryOf(report),
    };
  } catch {
    return { exitCode: 2, error: "calibration failed" };
  } finally {
    await paths.handle.close().catch(() => undefined);
  }
};

const main = async (): Promise<void> => {
  const result = await runCalibrationCli(process.argv.slice(2));
  if (result.summary !== undefined) {
    process.stdout.write(`${JSON.stringify(result.summary)}\n`);
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
