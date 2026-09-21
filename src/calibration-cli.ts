import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Fetch } from "@typesafe-ai/sdk";
import type { RouterInput } from "./contracts.js";
import { precheck } from "./policy.js";
import {
  createAtomicCalibrationCheckpointStore,
  createAtomicCalibrationReportWriter,
  createCalibrationTransport,
  loadCalibrationCorpus,
  runCalibrationExperiment,
  type CalibrationReport,
} from "./calibration-runner.js";

const DEFAULT_REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REPORT_PATH = "artifacts/calibration-report.json";
const CHECKPOINT_PATH = "artifacts/calibration-checkpoint.json";
const CORPUS_PATH = "fixtures/calibration-corpus.json";
const SMOKE_PATH = "fixtures/two-pass-smoke-input.json";

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

const evidencePaths = async (
  repositoryRoot: string,
): Promise<{ report: string; checkpoint: string } | null> => {
  try {
    const root = await realpath(repositoryRoot);
    const artifacts = join(root, "artifacts");
    const artifactsStat = await lstat(artifacts);
    if (!artifactsStat.isDirectory()) return null;
    const canonicalArtifacts = await realpath(artifacts);
    if (!isWithin(root, canonicalArtifacts)) return null;

    const report = join(root, REPORT_PATH);
    const checkpoint = join(root, CHECKPOINT_PATH);
    for (const path of [report, checkpoint]) {
      try {
        await lstat(path);
        return null;
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) return null;
      }
    }
    return { report, checkpoint };
  } catch {
    return null;
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

  const repositoryRoot = resolve(options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT);
  const paths = await evidencePaths(repositoryRoot);
  if (paths === null) {
    return { exitCode: 2, error: "evidence path unavailable" };
  }

  let corpus: ReturnType<typeof loadCalibrationCorpus>;
  let smokeInput: RouterInput;
  try {
    corpus = loadCalibrationCorpus(join(repositoryRoot, CORPUS_PATH));
    smokeInput = JSON.parse(
      await readFile(join(repositoryRoot, SMOKE_PATH), "utf8"),
    ) as RouterInput;
    precheck(smokeInput);
  } catch {
    return { exitCode: 2, error: "invalid frozen input" };
  }

  try {
    const transport = await (options.createTransport ?? createCalibrationTransport)({
      apiKey,
      corpus,
      fetch: options.fetch ?? globalThis.fetch,
      checkpoint: createAtomicCalibrationCheckpointStore(paths.checkpoint),
    });
    const report = await runCalibrationExperiment({
      corpus,
      smokeInput,
      transport,
      writeReport: createAtomicCalibrationReportWriter(paths.report),
    });
    return {
      exitCode: report.smoke?.status === "failed" ? 2 : 0,
      summary: summaryOf(report),
    };
  } catch {
    return { exitCode: 2, error: "calibration failed" };
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
