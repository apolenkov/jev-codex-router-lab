import {
  CalibrationError,
  createCorpusGuard,
  type CalibrationAccounting,
} from "./calibration-runner.js";
import {
  runPass1ThresholdCollection,
  type Pass1AnnotatedCorpus,
  type Pass1ThresholdCaseRecord,
  type Pass1ThresholdEvidenceSink,
  type Pass1ThresholdRunResult,
  type Pass1ThresholdTransport,
} from "./pass1-threshold-runner.js";
import {
  scorePass1ThresholdCases,
  PASS1_THRESHOLD_GRID,
  type Pass1SignalScore,
  type Pass1SignalUnit,
  type Pass1ThresholdSelectionArtifact,
  type Pass1ThresholdTuple,
} from "./pass1-threshold-selector.js";

export const PASS1_EVALUATION_REPORT_KIND = "pass1-threshold-evaluation";

export interface Pass1ThresholdEvaluationReport {
  readonly schemaVersion: 1;
  readonly kind: typeof PASS1_EVALUATION_REPORT_KIND;
  readonly split: "evaluation";
  readonly status: "complete" | "incomplete";
  readonly selection: {
    readonly floor: number;
    readonly lo: number;
    readonly hi: number;
    readonly eligible: boolean;
    readonly tieBroken: boolean;
    readonly artifactSha256: string;
  };
  readonly inputs: {
    readonly corpusFileSha256: string;
    readonly questionBuilderSha256: string;
    readonly corpusFingerprint: string;
  };
  readonly totalCases: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly invalidResponses: number;
  readonly uncollected: number;
  readonly perSignal: Readonly<Record<Pass1SignalUnit, Pass1SignalScore>>;
  readonly totalErrors: number;
  readonly accounting: CalibrationAccounting;
}

const isFrozenTuple = (tuple: Pass1ThresholdTuple): boolean =>
  PASS1_THRESHOLD_GRID.some(
    (candidate) =>
      candidate.floor === tuple.floor &&
      candidate.lo === tuple.lo &&
      candidate.hi === tuple.hi,
  );

export const buildPass1ThresholdEvaluation = (options: {
  readonly artifact: Pass1ThresholdSelectionArtifact;
  readonly artifactSha256: string;
  readonly corpus: Pass1AnnotatedCorpus;
  readonly records: Pass1ThresholdRunResult["records"];
  readonly status: "complete" | "incomplete";
  readonly accounting: CalibrationAccounting;
  readonly pins: {
    readonly corpusFileSha256: string;
    readonly questionBuilderSha256: string;
  };
}): Pass1ThresholdEvaluationReport => {
  const tuple = options.artifact.selected;
  if (!isFrozenTuple(tuple)) {
    throw new CalibrationError("invalid-selection-artifact");
  }
  const score = scorePass1ThresholdCases(
    options.corpus,
    options.records,
    tuple,
  );
  return {
    schemaVersion: 1,
    kind: PASS1_EVALUATION_REPORT_KIND,
    split: "evaluation",
    status: options.status,
    selection: {
      floor: tuple.floor,
      lo: tuple.lo,
      hi: tuple.hi,
      eligible: options.artifact.eligible,
      tieBroken: options.artifact.tieBroken,
      artifactSha256: options.artifactSha256,
    },
    inputs: {
      corpusFileSha256: options.pins.corpusFileSha256,
      questionBuilderSha256: options.pins.questionBuilderSha256,
      corpusFingerprint: createCorpusGuard(options.corpus).fingerprint,
    },
    totalCases: score.totalCases,
    accepted: score.accepted,
    rejected: score.rejected,
    invalidResponses: score.invalidResponses,
    uncollected: score.uncollected,
    perSignal: score.perSignal,
    totalErrors: score.totalErrors,
    accounting: options.accounting,
  };
};

export interface RunPass1ThresholdEvaluationOptions {
  readonly artifact: Pass1ThresholdSelectionArtifact;
  readonly artifactSha256: string;
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
  readonly transport: Pass1ThresholdTransport;
  readonly sink: Pass1ThresholdEvidenceSink;
  readonly resume?: {
    readonly priorRecords: ReadonlyMap<string, Pass1ThresholdCaseRecord>;
    readonly priorAccounting: {
      readonly attempts: number;
      readonly spentUsd: number;
    };
    readonly resumeCount: number;
  };
  readonly delay?: (ms: number) => Promise<void>;
  readonly writeReport: (
    report: Pass1ThresholdEvaluationReport,
  ) => Promise<void>;
}

export const runPass1ThresholdEvaluation = async (
  options: RunPass1ThresholdEvaluationOptions,
): Promise<{
  result: Pass1ThresholdRunResult;
  report: Pass1ThresholdEvaluationReport;
}> => {
  if (!isFrozenTuple(options.artifact.selected)) {
    throw new CalibrationError("invalid-selection-artifact");
  }
  const result = await runPass1ThresholdCollection({
    split: "evaluation",
    corpus: options.corpus,
    corpusPath: options.corpusPath,
    pins: options.pins,
    actual: options.actual,
    transport: options.transport,
    sink: options.sink,
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.delay === undefined ? {} : { delay: options.delay }),
  });
  const report = buildPass1ThresholdEvaluation({
    artifact: options.artifact,
    artifactSha256: options.artifactSha256,
    corpus: options.corpus,
    records: result.records,
    status: result.status,
    accounting: result.accounting,
    pins: options.pins,
  });
  await options.writeReport(report);
  return { result, report };
};
