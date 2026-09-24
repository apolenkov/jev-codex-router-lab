import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { Fetch } from "@typesafe-ai/sdk";
import {
  CALIBRATION_INPUT_USD_PER_MILLION,
  CALIBRATION_MAX_INPUT_TOKENS,
  CALIBRATION_MODEL,
  CALIBRATION_OUTPUT_USD_PER_MILLION,
  CalibrationError,
  createCalibrationTransport,
  createCorpusGuard,
  isCheckpointFailure,
  type CalibrationAccounting,
  type CalibrationCheckpointStore,
  type CalibrationCorpus,
  type CalibrationTransportLimits,
  type CalibrationTransportResult,
  type ClosedAnswerEvidence,
} from "./calibration-runner.js";
import { PolicyError, precheck } from "./policy.js";
import { buildPass1Request } from "./questions.js";
import {
  SemanticGatewayError,
  type PassMetadata,
} from "./semantic-gateway.js";
import {
  parsePass1Observations,
  type Pass1ChoiceObservation,
  type Pass1Observations,
} from "./typesafe-gateway.js";

export const PASS1_CORPUS_FILE_SHA256 =
  "848ffc0f04e1dd6c93a5006e9a000871982c3a3754543dbde7d95a3dbba9d73e";
export const PASS1_QUESTION_BUILDER_SHA256 =
  "5101440bf90c2a6d174b6f87c112bbdffa8eac2080a2e1eb8d2bc938ccc25e78";
export const PASS1_COLLECTION_SDK = "@typesafe-ai/sdk@0.6.0";
export const PASS1_COLLECTION_MODEL = CALIBRATION_MODEL;
export const PASS1_CASE_ORDER = [
  "C1",
  "C2",
  "C3",
  "C4",
  "C5",
  "C6",
  "H1",
  "H2",
] as const;

export const PASS1_COLLECTION_LIMITS: CalibrationTransportLimits = {
  maxAttempts: 8,
  spendCapUsd: 0.021504,
  requestReserveUsd: 0.002688,
};

export type Pass1CaseGroup = "provisional-analysis" | "exposed-secondary";

export interface Pass1CaseCollected {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly group: Pass1CaseGroup;
  readonly outcome: "collected";
  readonly answers: Readonly<Record<string, ClosedAnswerEvidence>>;
  readonly metadata: PassMetadata;
  readonly costUsd: number;
  readonly attempts: number;
}

export interface Pass1CaseFailed {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly group: Pass1CaseGroup;
  readonly outcome: "failed";
  readonly error: string;
  readonly attempts: number;
  readonly metadata?: PassMetadata;
  readonly costUsd?: number;
}

export type Pass1CaseRecord = Pass1CaseCollected | Pass1CaseFailed;

export interface Pass1CollectionManifest {
  readonly schemaVersion: 1;
  readonly kind: "pass1-confidence-evidence";
  readonly corpusFileSha256: string;
  readonly questionBuilderSha256: string;
  readonly corpusFingerprint: string;
  readonly sdk: string;
  readonly model: string;
  readonly caseOrder: readonly string[];
  readonly groups: Readonly<Record<Pass1CaseGroup, readonly string[]>>;
  readonly labelStatus: Readonly<Record<Pass1CaseGroup, string>>;
  readonly limits: {
    readonly maxAttempts: number;
    readonly spendCapUsd: number;
    readonly requestReserveUsd: number;
    readonly maxInputTokens: number;
    readonly inputUsdPerMillion: number;
    readonly outputUsdPerMillion: number;
    readonly retries: number;
    readonly redirects: "manual";
  };
  readonly claimLimits: readonly string[];
}

export interface Pass1CollectionSummaryCase {
  readonly caseId: string;
  readonly group: Pass1CaseGroup;
  readonly outcome: "collected" | "failed";
  readonly error?: string;
}

export interface Pass1CollectionSummaryFile {
  readonly schemaVersion: 1;
  readonly kind: "pass1-confidence-evidence-summary";
  readonly corpusFileSha256: string;
  readonly questionBuilderSha256: string;
  readonly corpusFingerprint: string;
  readonly sdk: string;
  readonly model: string;
  readonly status: "complete" | "terminal";
  readonly cases: readonly Pass1CollectionSummaryCase[];
  readonly accounting: CalibrationAccounting;
}

export interface Pass1CollectionResult {
  readonly status: "complete" | "terminal";
  readonly records: readonly Pass1CaseRecord[];
  readonly accounting: CalibrationAccounting;
  readonly failure: { readonly caseId: string; readonly error: string } | null;
}

export interface Pass1EvidenceSink {
  writeManifest(manifest: Pass1CollectionManifest): Promise<void>;
  writeCaseRecord(caseId: string, record: Pass1CaseRecord): Promise<void>;
  writeSummary(summary: Pass1CollectionSummaryFile): Promise<void>;
}

export interface Pass1CollectionTransportOptions {
  readonly apiKey: string;
  readonly corpus: CalibrationCorpus;
  readonly fetch: Fetch;
  readonly checkpoint: CalibrationCheckpointStore;
  readonly timeoutMs?: number;
  readonly accounting?: {
    readonly attempts: number;
    readonly spentUsd: number;
  };
}

export type Pass1CollectionTransport = Awaited<
  ReturnType<typeof createCalibrationTransport>
>;

export interface CollectPass1EvidenceOptions {
  readonly corpus: CalibrationCorpus;
  readonly corpusFileSha256: string;
  readonly questionBuilderSha256: string;
  readonly transport: Pass1CollectionTransport;
  readonly sink: Pass1EvidenceSink;
}

export const createPass1CollectionTransport = (
  options: Pass1CollectionTransportOptions,
): Promise<Pass1CollectionTransport> =>
  createCalibrationTransport({
    apiKey: options.apiKey,
    corpus: options.corpus,
    fetch: options.fetch,
    checkpoint: options.checkpoint,
    limits: PASS1_COLLECTION_LIMITS,
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ...(options.accounting === undefined
      ? {}
      : { accounting: options.accounting }),
  });

const groupOf = (caseId: string): Pass1CaseGroup =>
  caseId.startsWith("C") ? "provisional-analysis" : "exposed-secondary";

const LABEL_STATUS: Readonly<Record<Pass1CaseGroup, string>> = {
  "provisional-analysis":
    "provisional expert judgments, not verified truth",
  "exposed-secondary":
    "exposed to label review; secondary observations, not hidden or untouched holdout",
};

const CLAIM_LIMITS = [
  "case-bounded observations with exact denominators only",
  "no statistical calibration or general-quality claim",
  "no accepted routing decision or runtime threshold selection",
  "no production-readiness or economy claim",
] as const;

const buildManifest = (corpusFingerprint: string): Pass1CollectionManifest => ({
  schemaVersion: 1,
  kind: "pass1-confidence-evidence",
  corpusFileSha256: PASS1_CORPUS_FILE_SHA256,
  questionBuilderSha256: PASS1_QUESTION_BUILDER_SHA256,
  corpusFingerprint,
  sdk: PASS1_COLLECTION_SDK,
  model: PASS1_COLLECTION_MODEL,
  caseOrder: [...PASS1_CASE_ORDER],
  groups: {
    "provisional-analysis": PASS1_CASE_ORDER.filter(
      (id) => groupOf(id) === "provisional-analysis",
    ),
    "exposed-secondary": PASS1_CASE_ORDER.filter(
      (id) => groupOf(id) === "exposed-secondary",
    ),
  },
  labelStatus: LABEL_STATUS,
  limits: {
    maxAttempts: PASS1_COLLECTION_LIMITS.maxAttempts,
    spendCapUsd: PASS1_COLLECTION_LIMITS.spendCapUsd,
    requestReserveUsd: PASS1_COLLECTION_LIMITS.requestReserveUsd,
    maxInputTokens: CALIBRATION_MAX_INPUT_TOKENS,
    inputUsdPerMillion: CALIBRATION_INPUT_USD_PER_MILLION,
    outputUsdPerMillion: CALIBRATION_OUTPUT_USD_PER_MILLION,
    retries: 0,
    redirects: "manual",
  },
  claimLimits: [...CLAIM_LIMITS],
});

const closedChoice = (
  observation: Pass1ChoiceObservation,
): ClosedAnswerEvidence => ({
  type: "choice",
  choice: observation.choice,
  confidence: observation.confidence,
  probabilities: { ...observation.probabilities },
});

const closedNoul = (value: number): ClosedAnswerEvidence => ({
  type: "noul",
  noul: value,
});

const closedAnswers = (
  observations: Pass1Observations,
): Record<string, ClosedAnswerEvidence> => {
  const answers: Record<string, ClosedAnswerEvidence> = {
    task_type: closedChoice(observations.taskType),
    risk_security: closedNoul(observations.riskDimensions.security),
    risk_data_loss: closedNoul(observations.riskDimensions["data-loss"]),
    risk_public_contract: closedNoul(observations.riskDimensions["public-contract"]),
    risk_migration: closedNoul(observations.riskDimensions.migration),
    risk_user_behavior: closedNoul(observations.riskDimensions["user-behavior"]),
  };
  if (observations.skillCandidates !== null) {
    answers.skill_candidates = closedChoice(observations.skillCandidates);
  }
  if (observations.criticalGap !== null) {
    answers.critical_gap = closedChoice(observations.criticalGap);
  }
  if (observations.reuseCandidate !== null) {
    answers.reuse_candidate = closedChoice(observations.reuseCandidate);
  }
  if (observations.architectureFork !== null) {
    answers.architecture_fork = closedChoice(observations.architectureFork);
  }
  if (observations.contextRelevance !== null) {
    answers.context_relevance = closedChoice(observations.contextRelevance);
  }
  return answers;
};

const boundedReason = (error: unknown): string => {
  if (
    error instanceof CalibrationError ||
    error instanceof SemanticGatewayError ||
    error instanceof PolicyError
  ) {
    return error.reason;
  }
  return "unexpected-error";
};

export const collectPass1Evidence = async (
  options: CollectPass1EvidenceOptions,
): Promise<Pass1CollectionResult> => {
  if (
    options.corpusFileSha256 !== PASS1_CORPUS_FILE_SHA256 ||
    options.questionBuilderSha256 !== PASS1_QUESTION_BUILDER_SHA256
  ) {
    throw new CalibrationError("fingerprint-mismatch");
  }
  const guard = createCorpusGuard(options.corpus);
  const { transport, sink } = options;
  if (transport.fingerprint !== guard.fingerprint) {
    throw new CalibrationError("corpus-fingerprint-mismatch");
  }
  const cases = options.corpus.cases;
  if (
    cases.length !== PASS1_CASE_ORDER.length ||
    !PASS1_CASE_ORDER.every((id, index) => cases[index]?.id === id)
  ) {
    throw new CalibrationError("invalid-corpus");
  }

  const manifest = buildManifest(guard.fingerprint);
  const records: Pass1CaseRecord[] = [];

  const summaryFile = (
    status: "complete" | "terminal",
  ): Pass1CollectionSummaryFile => ({
    schemaVersion: 1,
    kind: "pass1-confidence-evidence-summary",
    corpusFileSha256: manifest.corpusFileSha256,
    questionBuilderSha256: manifest.questionBuilderSha256,
    corpusFingerprint: manifest.corpusFingerprint,
    sdk: manifest.sdk,
    model: manifest.model,
    status,
    cases: records.map((record) =>
      record.outcome === "failed"
        ? {
          caseId: record.caseId,
          group: record.group,
          outcome: "failed",
          error: record.error,
        }
        : {
          caseId: record.caseId,
          group: record.group,
          outcome: "collected",
        }
    ),
    accounting: transport.accounting(),
  });

  try {
    await sink.writeManifest(manifest);
    for (const corpusCase of cases) {
      guard.assertUnchanged();
      const checked = precheck(corpusCase.input);
      const group = groupOf(corpusCase.id);
      let result: CalibrationTransportResult | null = null;
      let record: Pass1CaseRecord;
      try {
        result = await transport.systemOne(buildPass1Request(checked));
        const observations = parsePass1Observations(result.answers, checked);
        record = {
          schemaVersion: 1,
          caseId: corpusCase.id,
          group,
          outcome: "collected",
          answers: closedAnswers(observations),
          metadata: { ...result.metadata },
          costUsd: result.costUsd,
          attempts: transport.accounting().attempts,
        };
      } catch (error) {
        if (!transport.accounting().terminal) {
          await transport.terminalize(
            error instanceof CalibrationError &&
              isCheckpointFailure(error.reason)
              ? error.reason
              : "post-transport-validation",
          );
        }
        record = {
          schemaVersion: 1,
          caseId: corpusCase.id,
          group,
          outcome: "failed",
          error: boundedReason(error),
          attempts: transport.accounting().attempts,
          ...(result === null
            ? {}
            : {
              metadata: { ...result.metadata },
              costUsd: result.costUsd,
            }),
        };
      }
      records.push(record);
      await sink.writeCaseRecord(corpusCase.id, record);
      if (record.outcome === "failed") {
        const failure = { caseId: corpusCase.id, error: record.error };
        await sink.writeSummary(summaryFile("terminal"));
        return {
          status: "terminal",
          records,
          accounting: transport.accounting(),
          failure,
        };
      }
    }
    await transport.complete();
    await sink.writeSummary(summaryFile("complete"));
    return {
      status: "complete",
      records,
      accounting: transport.accounting(),
      failure: null,
    };
  } catch (error) {
    if (!transport.accounting().terminal) {
      await transport.terminalize(
        error instanceof CalibrationError && isCheckpointFailure(error.reason)
          ? error.reason
          : "evidence-write",
      );
    }
    throw error;
  }
};

const CASE_FILE_PATTERN = /^case-(C[1-6]|H[12])\.json$/;

export const createPass1EvidenceSink = (
  directory: string,
  beforeWrite?: () => Promise<void>,
): Pass1EvidenceSink => {
  const write = async (name: string, value: unknown): Promise<void> => {
    await beforeWrite?.();
    let file;
    try {
      file = await open(
        join(directory, name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new CalibrationError("evidence-exists");
      }
      throw error;
    }
    try {
      await beforeWrite?.();
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await beforeWrite?.();
  };
  return {
    writeManifest: (manifest) => write("manifest.json", manifest),
    writeCaseRecord: async (caseId, record) => {
      const name = `case-${caseId}.json`;
      if (!CASE_FILE_PATTERN.test(name)) {
        throw new CalibrationError("invalid-case-id");
      }
      await write(name, record);
    },
    writeSummary: (summary) => write("summary.json", summary),
  };
};
