import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Fetch } from "@typesafe-ai/sdk";
import {
  CalibrationError,
  createAtomicCalibrationCheckpointStore,
  createCorpusGuard,
} from "./calibration-runner.js";
import {
  createPass1ThresholdEvidenceSink,
  createPass1ThresholdTransport,
  parsePass1AnnotatedCorpus,
  parsePass1CorpusManifest,
  parsePass1ThresholdCaseRecord,
  runPass1ThresholdCollection,
  PASS1_THRESHOLD_LIMITS,
  PASS1_THRESHOLD_RESUME_ATTEMPT_CEILING,
  PASS1_THRESHOLD_TIMEOUT_MS,
  type Pass1AnnotatedCorpus,
  type Pass1CorpusManifest,
  type Pass1CorpusSplit,
  type Pass1ThresholdCaseRecord,
  type Pass1ThresholdRunResult,
} from "./pass1-threshold-runner.js";
import {
  buildPass1SelectionArtifact,
  parsePass1SelectionArtifact,
  selectPass1Threshold,
  type Pass1SelectionInputs,
} from "./pass1-threshold-selector.js";
import { runPass1ThresholdEvaluation } from "./pass1-threshold-evaluator.js";

const DEFAULT_REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CORPUS_MANIFEST_PATH = "fixtures/pass1-corpus-manifest.json";
const SELECTION_ARTIFACT_PATH = "artifacts/pass1-threshold-selection.json";
const EVALUATION_REPORT_PATH = "artifacts/pass1-threshold-evaluation.json";
const EVIDENCE_DIR: Readonly<Record<Pass1CorpusSplit, string>> = {
  calibration: "pass1-threshold-evidence-calibration",
  evaluation: "pass1-threshold-evidence-evaluation",
};
const CASE_RECORD_PATTERN = /^case-(?:CAL|EVAL)-\d{3}\.json$/;

export interface Pass1ThresholdCliOptions {
  readonly repositoryRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: Fetch;
  readonly createTransport?: typeof createPass1ThresholdTransport;
  readonly delay?: (ms: number) => Promise<void>;
}

export interface Pass1ThresholdCliSummary {
  readonly mode: "collect" | "select";
  readonly split?: Pass1CorpusSplit;
  readonly status?: Pass1ThresholdRunResult["status"];
  readonly collected?: number;
  readonly attempts?: number;
  readonly spentUsd?: number;
  readonly selected?: { floor: number; lo: number; hi: number };
  readonly eligible?: boolean;
  readonly tieBroken?: boolean;
}

export interface Pass1ThresholdCliResult {
  readonly exitCode: 0 | 2;
  readonly summary?: Pass1ThresholdCliSummary;
  readonly error?: string;
}

const sha256Hex = (contents: string | Buffer): string =>
  createHash("sha256").update(contents).digest("hex");

const isWithin = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
};

const readPinnedText = async (
  root: string,
  relativePath: string,
): Promise<{ contents: string; sha256: string } | null> => {
  const path = join(root, relativePath);
  try {
    if (await realpath(path) !== path || !(await lstat(path)).isFile()) {
      return null;
    }
    const contents = await readFile(path, "utf8");
    return { contents, sha256: sha256Hex(contents) };
  } catch {
    return null;
  }
};

interface EvidenceDirectory {
  readonly handle: Awaited<ReturnType<typeof open>>;
  readonly requestedDirectory: string;
  readonly identity: Stats;
  readonly directory: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const openEvidenceDirectory = async (
  root: string,
  relativeDirectory: string,
  resume: boolean,
): Promise<EvidenceDirectory | null> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const artifacts = join(root, "artifacts");
    const artifactsStat = await lstat(artifacts);
    if (!artifactsStat.isDirectory()) return null;
    const canonicalArtifacts = await realpath(artifacts);
    if (!isWithin(root, canonicalArtifacts)) return null;

    const directory = join(canonicalArtifacts, relativeDirectory);
    if (resume) {
      const existing = await lstat(directory);
      if (!existing.isDirectory() || existing.isSymbolicLink()) return null;
    } else {
      await mkdir(directory, { mode: 0o700 });
    }
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      return null;
    }
    const canonicalDirectory = await realpath(directory);
    if (canonicalDirectory !== directory || !isWithin(root, canonicalDirectory)) {
      return null;
    }
    handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const identity = await handle.stat();
    if (!identity.isDirectory() || !sameIdentity(identity, directoryStat)) {
      return null;
    }
    const result = {
      handle,
      requestedDirectory: directory,
      identity,
      directory: canonicalDirectory,
    };
    handle = undefined;
    return result;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const sameIdentity = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const evidenceDirectoryUnchanged = async (
  directory: EvidenceDirectory,
): Promise<boolean> => {
  try {
    const current = await lstat(directory.requestedDirectory);
    return (
      current.isDirectory() &&
      sameIdentity(directory.identity, current) &&
      await realpath(directory.requestedDirectory) === directory.directory
    );
  } catch {
    return false;
  }
};

const publishOnce = async (
  path: string,
  value: unknown,
  beforeWrite?: () => Promise<void>,
): Promise<void> => {
  await beforeWrite?.();
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await beforeWrite?.();
    await link(temporaryPath, path);
    await beforeWrite?.();
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
};

const publishOrReplace = async (
  path: string,
  value: unknown,
  beforeWrite?: () => Promise<void>,
): Promise<void> => {
  await beforeWrite?.();
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await beforeWrite?.();
    await rename(temporaryPath, path);
    await beforeWrite?.();
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
};

interface FrozenInputs {
  readonly manifest: Pass1CorpusManifest;
  readonly corpus: Pass1AnnotatedCorpus;
  readonly corpusPath: string;
  readonly pins: {
    readonly corpusFileSha256: string;
    readonly questionBuilderSha256: string;
  };
  readonly actual: {
    readonly corpusFileSha256: string;
    readonly questionBuilderSha256: string;
  };
}

const loadFrozenInputs = async (
  root: string,
  split: Pass1CorpusSplit,
): Promise<FrozenInputs | null> => {
  const manifestFile = await readPinnedText(root, CORPUS_MANIFEST_PATH);
  if (manifestFile === null) return null;
  let manifest: Pass1CorpusManifest;
  try {
    manifest = parsePass1CorpusManifest(manifestFile.contents);
  } catch {
    return null;
  }
  const corpusPin = manifest.splits[split];
  const corpusFile = await readPinnedText(root, corpusPin.path);
  const questionsFile = await readPinnedText(root, manifest.questionBuilder.path);
  if (corpusFile === null || questionsFile === null) return null;
  let corpus: Pass1AnnotatedCorpus;
  try {
    corpus = parsePass1AnnotatedCorpus(corpusFile.contents, split);
  } catch {
    return null;
  }
  return {
    manifest,
    corpus,
    corpusPath: corpusPin.path,
    pins: {
      corpusFileSha256: corpusPin.sha256,
      questionBuilderSha256: manifest.questionBuilder.sha256,
    },
    actual: {
      corpusFileSha256: corpusFile.sha256,
      questionBuilderSha256: questionsFile.sha256,
    },
  };
};

const parseArgs = (
  argv: readonly string[],
):
  | { mode: "collect"; split: Pass1CorpusSplit; resume: boolean }
  | { mode: "select"; evidenceDir: string }
  | null => {
  if (
    (argv.length === 2 || (argv.length === 3 && argv[2] === "--resume")) &&
    argv[0] === "--split"
  ) {
    const split = argv[1];
    if (split === "calibration" || split === "evaluation") {
      return { mode: "collect", split, resume: argv.length === 3 };
    }
    return null;
  }
  if (argv.length === 2 && argv[0] === "--offline-select") {
    return { mode: "select", evidenceDir: argv[1]! };
  }
  return null;
};

interface ResumeState {
  readonly priorRecords: Map<string, Pass1ThresholdCaseRecord>;
  readonly priorAccounting: { readonly attempts: number; readonly spentUsd: number };
  readonly resumeCount: number;
}

const loadResumeState = async (
  directory: string,
  corpus: Pass1AnnotatedCorpus,
  pins: { readonly corpusFileSha256: string; readonly questionBuilderSha256: string },
): Promise<ResumeState | null> => {
  try {
    const manifestRaw = await readFile(join(directory, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
    const summaryRaw = await readFile(join(directory, "summary.json"), "utf8");
    const summary = JSON.parse(summaryRaw) as Record<string, unknown>;
    const checkpointRaw = await readFile(
      join(directory, "checkpoint.json"),
      "utf8",
    );
    const checkpoint = JSON.parse(checkpointRaw) as Record<string, unknown>;
    const accounting = checkpoint.accounting as Record<string, unknown> | undefined;
    const expectedFingerprint = createCorpusGuard(corpus).fingerprint;
    if (
      manifest.kind !== "pass1-threshold-evidence" ||
      manifest.corpusFileSha256 !== pins.corpusFileSha256 ||
      manifest.questionBuilderSha256 !== pins.questionBuilderSha256 ||
      manifest.corpusFingerprint !== expectedFingerprint ||
      checkpoint.corpusFingerprint !== expectedFingerprint ||
      summary.status !== "incomplete" ||
      !isRecord(accounting) ||
      !Number.isInteger(accounting.attempts) ||
      (accounting.attempts as number) < 0 ||
      typeof accounting.spentUsd !== "number" ||
      !Number.isFinite(accounting.spentUsd) ||
      (accounting.spentUsd as number) < 0
    ) {
      return null;
    }
    const priorRecords = new Map<string, Pass1ThresholdCaseRecord>();
    const names = await readdir(directory);
    for (const name of names) {
      if (!CASE_RECORD_PATTERN.test(name)) continue;
      const record = parsePass1ThresholdCaseRecord(
        JSON.parse(await readFile(join(directory, name), "utf8")),
      );
      priorRecords.set(record.caseId, record);
    }
    if (priorRecords.size === 0) return null;
    const priorResumeCount = manifest.resumeCount;
    return {
      priorRecords,
      priorAccounting: {
        attempts: accounting.attempts as number,
        spentUsd: accounting.spentUsd,
      },
      resumeCount:
        typeof priorResumeCount === "number" &&
          Number.isInteger(priorResumeCount) &&
          priorResumeCount >= 1
          ? priorResumeCount + 1
          : 1,
    };
  } catch {
    return null;
  }
};

const runCollection = async (
  root: string,
  split: Pass1CorpusSplit,
  resume: boolean,
  options: Pass1ThresholdCliOptions,
): Promise<Pass1ThresholdCliResult> => {
  const apiKey = options.env !== undefined
    ? options.env.TYPESAFE_API_KEY
    : process.env.TYPESAFE_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return { exitCode: 2, error: "missing TYPESAFE_API_KEY" };
  }
  const frozen = await loadFrozenInputs(root, split);
  if (frozen === null) {
    return { exitCode: 2, error: "invalid frozen input" };
  }
  const directory = await openEvidenceDirectory(
    root,
    EVIDENCE_DIR[split],
    resume,
  );
  if (directory === null) {
    return { exitCode: 2, error: "evidence path unavailable" };
  }
  try {
    const assertEvidencePath = async (): Promise<void> => {
      if (!await evidenceDirectoryUnchanged(directory)) {
        throw new CalibrationError("evidence-write");
      }
    };
    const resumeState = resume
      ? await loadResumeState(directory.directory, frozen.corpus, frozen.pins)
      : null;
    if (resume && resumeState === null) {
      return { exitCode: 2, error: "invalid resume state" };
    }
    const bounds = {
      maxAttempts: resumeState === null
        ? PASS1_THRESHOLD_LIMITS[split].maxAttempts
        : PASS1_THRESHOLD_RESUME_ATTEMPT_CEILING[split],
      spendCapUsd: PASS1_THRESHOLD_LIMITS[split].spendCapUsd,
    };
    const checkpoint = createAtomicCalibrationCheckpointStore(
      join(directory.directory, "checkpoint.json"),
      bounds,
      resume ? { resume: true } : undefined,
    );
    const transport = await (options.createTransport ??
      createPass1ThresholdTransport)({
      apiKey,
      corpus: frozen.corpus,
      fetch: options.fetch ?? globalThis.fetch,
      checkpoint,
      limits: {
        maxAttempts: bounds.maxAttempts,
        spendCapUsd: bounds.spendCapUsd,
        requestReserveUsd: PASS1_THRESHOLD_LIMITS[split].requestReserveUsd,
      },
      timeoutMs: PASS1_THRESHOLD_TIMEOUT_MS,
      ...(resumeState === null
        ? {}
        : {
          accounting: {
            attempts: resumeState.priorAccounting.attempts,
            spentUsd: resumeState.priorAccounting.spentUsd,
          },
        }),
    });
    const sink = createPass1ThresholdEvidenceSink(
      directory.directory,
      assertEvidencePath,
      resume ? { resume: true } : undefined,
    );

    if (split === "calibration") {
      const result = await runPass1ThresholdCollection({
        split,
        corpus: frozen.corpus,
        corpusPath: frozen.corpusPath,
        pins: frozen.pins,
        actual: frozen.actual,
        transport,
        sink,
        ...(options.delay === undefined ? {} : { delay: options.delay }),
        ...(resumeState === null
          ? {}
          : {
            resume: {
              priorRecords: resumeState.priorRecords,
              priorAccounting: resumeState.priorAccounting,
              resumeCount: resumeState.resumeCount,
            },
          }),
      });
      return {
        exitCode: result.status === "complete" ? 0 : 2,
        summary: {
          mode: "collect",
          split,
          status: result.status,
          collected: result.records.filter(
            (record) => record.outcome === "collected",
          ).length,
          attempts: result.accounting.attempts,
          spentUsd: result.accounting.spentUsd,
        },
      };
    }

    const artifactFile = await readPinnedText(root, SELECTION_ARTIFACT_PATH);
    if (artifactFile === null) {
      return { exitCode: 2, error: "missing selection artifact" };
    }
    let artifact;
    try {
      artifact = parsePass1SelectionArtifact(artifactFile.contents);
    } catch {
      return { exitCode: 2, error: "invalid selection artifact" };
    }
    if (
      artifact.inputs.evaluationCorpusFileSha256 !==
        frozen.actual.corpusFileSha256 ||
      artifact.inputs.questionBuilderSha256 !==
        frozen.actual.questionBuilderSha256
    ) {
      return { exitCode: 2, error: "selection artifact fingerprint mismatch" };
    }
    const calibrationFrozen = await loadFrozenInputs(root, "calibration");
    if (calibrationFrozen === null) {
      return { exitCode: 2, error: "invalid frozen input" };
    }
    const canonicalArtifacts = await realpath(join(root, "artifacts")).catch(
      () => null,
    );
    const calibrationEvidence = canonicalArtifacts === null
      ? null
      : await loadCalibrationEvidence(
        canonicalArtifacts,
        EVIDENCE_DIR.calibration,
        calibrationFrozen.corpus,
      );
    if (calibrationEvidence === null || calibrationEvidence === "invalid") {
      return { exitCode: 2, error: "calibration evidence unavailable" };
    }
    const rederived = selectPass1Threshold(
      calibrationFrozen.corpus,
      calibrationEvidence.records,
    );
    if (
      calibrationEvidence.evidenceSha256 !== artifact.inputs.evidenceSha256 ||
      rederived.tuple.floor !== artifact.selected.floor ||
      rederived.tuple.lo !== artifact.selected.lo ||
      rederived.tuple.hi !== artifact.selected.hi
    ) {
      return { exitCode: 2, error: "selection artifact not derived" };
    }
    const reportPath = join(root, EVALUATION_REPORT_PATH);
    if (!isWithin(root, await realpath(join(root, "artifacts")))) {
      return { exitCode: 2, error: "evidence path unavailable" };
    }
    const { result } = await runPass1ThresholdEvaluation({
      artifact,
      artifactSha256: artifactFile.sha256,
      corpus: frozen.corpus,
      corpusPath: frozen.corpusPath,
      pins: frozen.pins,
      actual: frozen.actual,
      transport,
      sink,
      ...(resumeState === null
        ? {}
        : {
          resume: {
            priorRecords: resumeState.priorRecords,
            priorAccounting: resumeState.priorAccounting,
            resumeCount: resumeState.resumeCount,
          },
        }),
      ...(options.delay === undefined ? {} : { delay: options.delay }),
      writeReport: (evaluation) =>
        (resume
          ? publishOrReplace(reportPath, evaluation, assertEvidencePath)
          : publishOnce(reportPath, evaluation, assertEvidencePath)),
    });
    return {
      exitCode: result.status === "complete" ? 0 : 2,
      summary: {
        mode: "collect",
        split,
        status: result.status,
        collected: result.records.filter(
          (record) => record.outcome === "collected",
        ).length,
        attempts: result.accounting.attempts,
        spentUsd: result.accounting.spentUsd,
      },
    };
  } catch {
    return { exitCode: 2, error: "collection failed" };
  } finally {
    await directory.handle.close().catch(() => undefined);
  }
};

interface CalibrationEvidence {
  readonly records: Pass1ThresholdCaseRecord[];
  readonly evidenceSha256: string;
}

const loadCalibrationEvidence = async (
  canonicalArtifacts: string,
  evidenceDirArgument: string,
  corpus: Pass1AnnotatedCorpus,
): Promise<CalibrationEvidence | "invalid" | null> => {
  const evidenceDir = resolve(canonicalArtifacts, evidenceDirArgument);
  if (!isWithin(canonicalArtifacts, evidenceDir)) {
    return null;
  }
  const canonicalEvidenceDir = await realpath(evidenceDir).catch(() => null);
  if (canonicalEvidenceDir === null || canonicalEvidenceDir !== evidenceDir) {
    return null;
  }
  let names: readonly string[];
  try {
    names = await readdir(canonicalEvidenceDir);
  } catch {
    return null;
  }
  const caseFiles = names.filter((name) => CASE_RECORD_PATTERN.test(name)).sort();
  if (caseFiles.length === 0) {
    return null;
  }
  const records: Pass1ThresholdCaseRecord[] = [];
  const evidenceHash = createHash("sha256");
  try {
    const manifestRaw = await readFile(
      join(canonicalEvidenceDir, "manifest.json"),
      "utf8",
    );
    const manifestEvidence = JSON.parse(manifestRaw) as { split?: unknown };
    if (manifestEvidence.split !== "calibration") {
      return "invalid";
    }
    evidenceHash.update(manifestRaw);
    for (const name of caseFiles) {
      const raw = await readFile(join(canonicalEvidenceDir, name), "utf8");
      records.push(parsePass1ThresholdCaseRecord(JSON.parse(raw)));
      evidenceHash.update(raw);
    }
  } catch {
    return "invalid";
  }
  const expectedIds = new Set(corpus.cases.map((entry) => entry.caseId));
  const recordIds = new Set(records.map((record) => record.caseId));
  if (
    records.some((record) => record.outcome === "failed") ||
    expectedIds.size !== recordIds.size ||
    ![...expectedIds].every((id) => recordIds.has(id))
  ) {
    return "invalid";
  }
  return { records, evidenceSha256: evidenceHash.digest("hex") };
};

const runOfflineSelect = async (
  root: string,
  evidenceDirArgument: string,
): Promise<Pass1ThresholdCliResult> => {
  const frozen = await loadFrozenInputs(root, "calibration");
  if (frozen === null) {
    return { exitCode: 2, error: "invalid frozen input" };
  }
  const canonicalArtifacts = await realpath(join(root, "artifacts")).catch(
    () => null,
  );
  if (canonicalArtifacts === null || !isWithin(root, canonicalArtifacts)) {
    return { exitCode: 2, error: "evidence path unavailable" };
  }
  const evidence = await loadCalibrationEvidence(
    canonicalArtifacts,
    evidenceDirArgument,
    frozen.corpus,
  );
  if (evidence === null) {
    return { exitCode: 2, error: "evidence path unavailable" };
  }
  if (evidence === "invalid") {
    return { exitCode: 2, error: "incomplete evidence" };
  }
  const records = evidence.records;
  const evidenceSha256 = evidence.evidenceSha256;

  const selection = selectPass1Threshold(frozen.corpus, records);
  const inputs: Pass1SelectionInputs = {
    corpusFileSha256: frozen.actual.corpusFileSha256,
    evaluationCorpusFileSha256: frozen.manifest.splits.evaluation.sha256,
    questionBuilderSha256: frozen.actual.questionBuilderSha256,
    corpusFingerprint: createCorpusGuard(frozen.corpus).fingerprint,
    evidenceSha256,
  };
  const artifact = buildPass1SelectionArtifact(selection, inputs);
  try {
    await publishOnce(join(root, SELECTION_ARTIFACT_PATH), artifact);
  } catch {
    return { exitCode: 2, error: "selection artifact unavailable" };
  }
  return {
    exitCode: 0,
    summary: {
      mode: "select",
      selected: { ...selection.tuple },
      eligible: selection.eligible,
      tieBroken: selection.tieBroken,
    },
  };
};

export const runPass1ThresholdCli = async (
  argv: readonly string[],
  options: Pass1ThresholdCliOptions = {},
): Promise<Pass1ThresholdCliResult> => {
  const parsed = parseArgs(argv);
  if (parsed === null) {
    return { exitCode: 2, error: "invalid CLI usage" };
  }
  let repositoryRoot: string;
  try {
    repositoryRoot = await realpath(
      resolve(options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT),
    );
  } catch {
    return { exitCode: 2, error: "repository root unavailable" };
  }
  if (parsed.mode === "select") {
    return runOfflineSelect(repositoryRoot, parsed.evidenceDir);
  }
  return runCollection(repositoryRoot, parsed.split, parsed.resume, options);
};

const main = async (): Promise<void> => {
  const result = await runPass1ThresholdCli(process.argv.slice(2));
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
  await main();
}
