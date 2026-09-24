import { constants } from "node:fs";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  APITimeoutError,
  TypeSafeClient,
  type EntryType,
  type Fetch,
  type Questions,
} from "@typesafe-ai/sdk";
import type {
  PrecheckedInput,
  RiskDimension,
  TaskType,
} from "./contracts.js";
import {
  CALIBRATION_INPUT_USD_PER_MILLION,
  CALIBRATION_MAX_INPUT_TOKENS,
  CALIBRATION_MODEL,
  CALIBRATION_OUTPUT_USD_PER_MILLION,
  CALIBRATION_REQUEST_RESERVE_USD,
  CalibrationError,
  createCorpusGuard,
  isCheckpointFailure,
  type CalibrationAccounting,
  type CalibrationCheckpointFailure,
  type CalibrationCheckpointStore,
  type CalibrationTransportLimits,
  type CalibrationTransportResult,
  type ClosedAnswerEvidence,
} from "./calibration-runner.js";
import { PolicyError, precheck } from "./policy.js";
import { buildPass1Request } from "./questions.js";
import {
  SemanticGatewayError,
  type PassMetadata,
  type SystemOneRequest,
} from "./semantic-gateway.js";
import {
  parsePass1Observations,
  parseTypeSafeEnvelope,
  type Pass1ChoiceObservation,
  type Pass1Observations,
} from "./typesafe-gateway.js";

export const PASS1_THRESHOLD_SDK = "@typesafe-ai/sdk@0.6.0";
export const PASS1_THRESHOLD_MODEL = CALIBRATION_MODEL;
export const PASS1_THRESHOLD_TIMEOUT_MS = 120_000;

export type Pass1CorpusSplit = "calibration" | "evaluation";

export const PASS1_THRESHOLD_LIMITS: Readonly<
  Record<Pass1CorpusSplit, CalibrationTransportLimits>
> = {
  calibration: {
    maxAttempts: 56,
    spendCapUsd: 0.25,
    requestReserveUsd: CALIBRATION_REQUEST_RESERVE_USD,
  },
  evaluation: {
    maxAttempts: 28,
    spendCapUsd: 0.25,
    requestReserveUsd: CALIBRATION_REQUEST_RESERVE_USD,
  },
};

export const PASS1_THRESHOLD_RESUME_ATTEMPT_CEILING: Readonly<
  Record<Pass1CorpusSplit, number>
> = {
  calibration: 80,
  evaluation: 40,
};

export const PASS1_THRESHOLD_INTER_CALL_DELAY_MS = 1_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isProbability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface Pass1CorpusManifestPin {
  readonly path: string;
  readonly sha256: string;
}

export interface Pass1CorpusManifest {
  readonly splits: Readonly<Record<Pass1CorpusSplit, Pass1CorpusManifestPin>>;
  readonly questionBuilder: Pass1CorpusManifestPin;
}

const parseManifestPin = (value: unknown): Pass1CorpusManifestPin => {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["path", "sha256"]) ||
    typeof value.path !== "string" ||
    value.path.length === 0 ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256)
  ) {
    throw new CalibrationError("invalid-corpus-manifest");
  }
  return { path: value.path, sha256: value.sha256 };
};

export const parsePass1CorpusManifest = (
  serialized: string,
): Pass1CorpusManifest => {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new CalibrationError("invalid-corpus-manifest");
  }
  if (!isRecord(value) || !isRecord(value.hashes)) {
    throw new CalibrationError("invalid-corpus-manifest");
  }
  const hashes = value.hashes;
  const splits = hashes.splits;
  if (
    !isRecord(splits) ||
    !isRecord(splits.calibration) ||
    !isRecord(splits.evaluation) ||
    !isRecord(hashes.questionBuilder)
  ) {
    throw new CalibrationError("invalid-corpus-manifest");
  }
  return {
    splits: {
      calibration: parseManifestPin(splits.calibration),
      evaluation: parseManifestPin(splits.evaluation),
    },
    questionBuilder: parseManifestPin(hashes.questionBuilder),
  };
};

export type Pass1LabelStatus = "resolved" | "ambiguous" | "not_queried";

export interface Pass1GoldLeaf<T> {
  readonly status: Pass1LabelStatus;
  readonly value: T | null;
}

export interface Pass1CaseLabels {
  readonly taskType: Pass1GoldLeaf<TaskType>;
  readonly skillCandidates: Pass1GoldLeaf<readonly string[]>;
  readonly criticalGap: Pass1GoldLeaf<string>;
  readonly reuseCandidate: Pass1GoldLeaf<string>;
  readonly architectureFork: Pass1GoldLeaf<string>;
  readonly contextRelevance: Pass1GoldLeaf<readonly string[]>;
  readonly riskDimensions: Readonly<
    Record<RiskDimension, Pass1GoldLeaf<"positive" | "negative">>
  >;
}

export interface Pass1AnnotatedCase {
  readonly caseId: string;
  readonly input: PrecheckedInput;
  readonly labels: Pass1CaseLabels;
}

export interface Pass1AnnotatedCorpus {
  readonly split: Pass1CorpusSplit;
  readonly cases: readonly Pass1AnnotatedCase[];
}

const TASK_TYPES: ReadonlySet<string> = new Set([
  "explain",
  "research",
  "plan",
  "diagnose",
  "change",
  "review",
  "operate",
]);

const RISK_DIMENSIONS: readonly RiskDimension[] = [
  "security",
  "data-loss",
  "public-contract",
  "migration",
  "user-behavior",
];

const TOP_LABEL_KEYS = [
  "taskType",
  "skillCandidates",
  "criticalGap",
  "reuseCandidate",
  "architectureFork",
  "contextRelevance",
  "riskDimensions",
] as const;

const SPLIT_EXPECTED: Readonly<
  Record<Pass1CorpusSplit, { readonly count: number; readonly pattern: RegExp }>
> = {
  calibration: { count: 56, pattern: /^CAL-\d{3}$/ },
  evaluation: { count: 28, pattern: /^EVAL-\d{3}$/ },
};

const labelLeaf = <T>(
  value: unknown,
  resolved: (candidate: unknown) => candidate is T,
): Pass1GoldLeaf<T> => {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["status", "value", "evidence"]) ||
    (value.status !== "resolved" &&
      value.status !== "ambiguous" &&
      value.status !== "not_queried") ||
    !Array.isArray(value.evidence)
  ) {
    throw new CalibrationError("invalid-corpus-label");
  }
  if (value.status !== "resolved") {
    if (value.value !== null) {
      throw new CalibrationError("invalid-corpus-label");
    }
    return { status: value.status, value: null };
  }
  if (value.value !== null && !resolved(value.value)) {
    throw new CalibrationError("invalid-corpus-label");
  }
  return {
    status: "resolved",
    value: value.value === null ? null : structuredClone(value.value as T),
  };
};

const isTaskTypeValue = (value: unknown): value is TaskType =>
  typeof value === "string" && TASK_TYPES.has(value);

const isIdListValue = (value: unknown): value is readonly string[] =>
  isStringArray(value) && new Set(value).size === value.length;

const isNullableIdValue = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isRiskValue = (value: unknown): value is "positive" | "negative" =>
  value === "positive" || value === "negative";

const parseCaseLabels = (value: unknown): Pass1CaseLabels => {
  if (!isRecord(value) || !exactKeys(value, TOP_LABEL_KEYS)) {
    throw new CalibrationError("invalid-corpus-label");
  }
  const risks = value.riskDimensions;
  if (!isRecord(risks) || !exactKeys(risks, RISK_DIMENSIONS)) {
    throw new CalibrationError("invalid-corpus-label");
  }
  return {
    taskType: labelLeaf(value.taskType, isTaskTypeValue),
    skillCandidates: labelLeaf(value.skillCandidates, isIdListValue),
    criticalGap: labelLeaf(value.criticalGap, isNullableIdValue),
    reuseCandidate: labelLeaf(value.reuseCandidate, isNullableIdValue),
    architectureFork: labelLeaf(value.architectureFork, isNullableIdValue),
    contextRelevance: labelLeaf(value.contextRelevance, isIdListValue),
    riskDimensions: Object.fromEntries(
      RISK_DIMENSIONS.map((dimension) => [
        dimension,
        labelLeaf(risks[dimension], isRiskValue),
      ]),
    ) as Readonly<Record<RiskDimension, Pass1GoldLeaf<"positive" | "negative">>>,
  };
};

const parseAnnotatedCase = (
  value: unknown,
  split: Pass1CorpusSplit,
): Pass1AnnotatedCase => {
  const expected = SPLIT_EXPECTED[split];
  if (
    !isRecord(value) ||
    typeof value.caseId !== "string" ||
    !expected.pattern.test(value.caseId) ||
    value.split !== split ||
    !isRecord(value.input) ||
    !isRecord(value.labels)
  ) {
    throw new CalibrationError("invalid-corpus-case");
  }
  let checked: PrecheckedInput;
  try {
    checked = precheck(value.input as unknown as Pass1AnnotatedCase["input"]);
  } catch (error) {
    if (error instanceof PolicyError) {
      throw new CalibrationError("invalid-corpus-input");
    }
    throw error;
  }
  if (checked.taskId !== value.caseId) {
    throw new CalibrationError("invalid-corpus-input");
  }
  return {
    caseId: value.caseId,
    input: checked,
    labels: parseCaseLabels(value.labels),
  };
};

export const parsePass1AnnotatedCorpus = (
  serialized: string,
  split: Pass1CorpusSplit,
): Pass1AnnotatedCorpus => {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new CalibrationError("invalid-corpus");
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== "pass1-annotated-corpus-v1" ||
    value.split !== split ||
    !Array.isArray(value.cases) ||
    value.cases.length !== SPLIT_EXPECTED[split].count
  ) {
    throw new CalibrationError("invalid-corpus");
  }
  const cases = value.cases.map((entry) => parseAnnotatedCase(entry, split));
  if (new Set(cases.map(({ caseId }) => caseId)).size !== cases.length) {
    throw new CalibrationError("invalid-corpus");
  }
  return { split, cases };
};

export interface Pass1ThresholdSdkClient {
  readonly systemOne: (request: {
    readonly state: unknown;
    readonly questions: unknown;
    readonly model: string;
  }) => Promise<unknown>;
}

export type Pass1ThresholdClientFactory = (options: {
  readonly apiKey: string;
  readonly fetch: Fetch;
  readonly timeoutMs: number;
}) => Pass1ThresholdSdkClient;

export interface Pass1ThresholdTransportOptions {
  readonly apiKey: string;
  readonly corpus: unknown;
  readonly fetch: Fetch;
  readonly checkpoint: CalibrationCheckpointStore;
  readonly limits: CalibrationTransportLimits;
  readonly timeoutMs?: number;
  readonly accounting?: {
    readonly attempts: number;
    readonly spentUsd: number;
  };
  readonly createClient?: Pass1ThresholdClientFactory;
}

const defaultClientFactory: Pass1ThresholdClientFactory = ({
  apiKey,
  fetch,
  timeoutMs,
}) => {
  const client = new TypeSafeClient({
    apiKey,
    defaultModel: CALIBRATION_MODEL,
    fetch,
    logLevel: "off",
    retry: { maxRetries: 0 },
    timeout: timeoutMs,
  });
  return {
    systemOne: (request) =>
      client.systemOne({
        state: request.state as EntryType,
        questions: request.questions as Questions,
        model: request.model,
      }),
  };
};

const calibrationErrorFrom = (error: unknown): CalibrationError | null => {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current instanceof CalibrationError) {
      return current;
    }
    current = current.cause;
  }
  return null;
};

const hasRuntimeOverride = (request: SystemOneRequest): boolean => {
  const value = request as unknown as Record<string, unknown>;
  return ["model", "inputPriceUsdPerMillion", "outputPriceUsdPerMillion"]
    .some((key) => Object.hasOwn(value, key));
};

export const createPass1ThresholdTransport = async (
  options: Pass1ThresholdTransportOptions,
) => {
  if (options.apiKey.trim().length === 0) {
    throw new CalibrationError("missing-api-key");
  }
  const limits = options.limits;
  if (
    !Number.isInteger(limits.maxAttempts) ||
    limits.maxAttempts < 1 ||
    !Number.isFinite(limits.spendCapUsd) ||
    limits.spendCapUsd <= 0 ||
    !Number.isFinite(limits.requestReserveUsd) ||
    limits.requestReserveUsd <= 0 ||
    limits.requestReserveUsd > limits.spendCapUsd
  ) {
    throw new CalibrationError("invalid-limits");
  }
  const initial = options.accounting ?? { attempts: 0, spentUsd: 0 };
  if (
    !Number.isInteger(initial.attempts) ||
    initial.attempts < 0 ||
    initial.attempts > limits.maxAttempts ||
    !Number.isFinite(initial.spentUsd) ||
    initial.spentUsd < 0 ||
    initial.spentUsd > limits.spendCapUsd
  ) {
    throw new CalibrationError("invalid-accounting");
  }

  const guard = createCorpusGuard(options.corpus);
  let attempts = initial.attempts;
  let spentUsd = initial.spentUsd;
  let reservedUsd = 0;
  let terminal = false;

  const accounting = (): CalibrationAccounting => ({
    attempts,
    spentUsd,
    reservedUsd,
    terminal,
  });
  const persistCheckpoint = async (
    phase: "active" | "reserved" | "terminal" | "complete",
    failureReason: CalibrationCheckpointFailure | null,
  ): Promise<void> => {
    try {
      await options.checkpoint.write({
        schemaVersion: 1,
        corpusFingerprint: guard.fingerprint,
        phase,
        accounting: accounting(),
        failureReason,
      });
    } catch {
      terminal = true;
      throw new CalibrationError("checkpoint-failed");
    }
  };
  const terminalize = async (
    reason: CalibrationCheckpointFailure,
  ): Promise<void> => {
    terminal = true;
    await persistCheckpoint("terminal", reason);
  };
  const fail = async (reason: CalibrationCheckpointFailure): Promise<never> => {
    await terminalize(reason);
    throw new CalibrationError(reason);
  };

  let claimed: boolean;
  try {
    claimed = await options.checkpoint.claim({
      schemaVersion: 1,
      corpusFingerprint: guard.fingerprint,
      phase: "active",
      accounting: accounting(),
      failureReason: null,
    });
  } catch {
    terminal = true;
    throw new CalibrationError("checkpoint-failed");
  }
  if (!claimed) {
    throw new CalibrationError("checkpoint-exists");
  }

  const guardedFetch: Fetch = async (input, init) => {
    guard.assertUnchanged();
    if (terminal) {
      throw new CalibrationError("terminal");
    }
    if (reservedUsd !== 0) {
      throw new CalibrationError("concurrent-dispatch");
    }
    if (attempts >= limits.maxAttempts) {
      throw new CalibrationError("attempt-cap");
    }
    if (spentUsd + limits.requestReserveUsd > limits.spendCapUsd) {
      throw new CalibrationError("spend-cap");
    }
    attempts += 1;
    reservedUsd = limits.requestReserveUsd;
    await persistCheckpoint("reserved", null);
    guard.assertUnchanged();
    const response = await options.fetch(input, { ...init, redirect: "manual" });
    guard.assertUnchanged();
    if (response.status >= 300 && response.status < 400) {
      throw new CalibrationError("redirect");
    }
    return response;
  };

  const client = (options.createClient ?? defaultClientFactory)({
    apiKey: options.apiKey,
    fetch: guardedFetch,
    timeoutMs: options.timeoutMs ?? PASS1_THRESHOLD_TIMEOUT_MS,
  });

  const systemOne = async (
    request: SystemOneRequest,
  ): Promise<CalibrationTransportResult> => {
    if (terminal) {
      throw new CalibrationError("terminal");
    }
    if (hasRuntimeOverride(request)) {
      return fail("runtime-override");
    }
    const started = performance.now();
    let response: unknown;
    try {
      response = await client.systemOne({
        state: request.state,
        questions: request.questions,
        model: CALIBRATION_MODEL,
      });
    } catch (error) {
      const calibrationError = calibrationErrorFrom(error);
      if (calibrationError?.reason === "checkpoint-failed") {
        throw calibrationError;
      }
      const reason =
        calibrationError !== null && isCheckpointFailure(calibrationError.reason)
          ? calibrationError.reason
          : error instanceof APITimeoutError
            ? "timeout"
            : "provider-error";
      return fail(reason);
    }

    try {
      guard.assertUnchanged();
    } catch {
      return fail("corpus-mutated");
    }
    let envelope: ReturnType<typeof parseTypeSafeEnvelope>;
    try {
      envelope = parseTypeSafeEnvelope(
        response,
        Object.keys(request.questions),
        performance.now() - started,
      );
    } catch {
      return fail("unknown-accounting");
    }
    if (
      envelope.metadata.model !== CALIBRATION_MODEL ||
      envelope.metadata.inputTokens > CALIBRATION_MAX_INPUT_TOKENS
    ) {
      return fail("unknown-accounting");
    }
    const costUsd =
      envelope.metadata.inputTokens * CALIBRATION_INPUT_USD_PER_MILLION /
        1_000_000 +
      envelope.metadata.outputTokens * CALIBRATION_OUTPUT_USD_PER_MILLION /
        1_000_000;
    if (
      !Number.isFinite(costUsd) ||
      costUsd < 0 ||
      costUsd > reservedUsd ||
      spentUsd + costUsd > limits.spendCapUsd
    ) {
      return fail("unknown-accounting");
    }
    reservedUsd = 0;
    spentUsd += costUsd;
    await persistCheckpoint("active", null);
    return { ...envelope, costUsd };
  };

  const complete = async (): Promise<void> => {
    guard.assertUnchanged();
    if (terminal || reservedUsd !== 0) {
      throw new CalibrationError("terminal");
    }
    terminal = true;
    await persistCheckpoint("complete", null);
  };

  return {
    fingerprint: guard.fingerprint,
    systemOne,
    accounting,
    terminalize,
    complete,
  };
};

export type Pass1ThresholdTransport = Awaited<
  ReturnType<typeof createPass1ThresholdTransport>
>;

export interface Pass1ThresholdCaseCollected {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly outcome: "collected";
  readonly questionKeys: readonly string[];
  readonly answers: Readonly<Record<string, ClosedAnswerEvidence>>;
  readonly metadata: PassMetadata;
  readonly costUsd: number;
  readonly attempts: number;
}

export interface Pass1ThresholdCaseInvalidResponse {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly outcome: "invalid-response";
  readonly reason: string;
  readonly questionKeys: readonly string[];
  readonly attempts: number;
  readonly metadata?: PassMetadata;
  readonly costUsd?: number;
}

export interface Pass1ThresholdCaseFailed {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly outcome: "failed";
  readonly error: string;
  readonly attempts: number;
  readonly metadata?: PassMetadata;
  readonly costUsd?: number;
}

export type Pass1ThresholdCaseRecord =
  | Pass1ThresholdCaseCollected
  | Pass1ThresholdCaseInvalidResponse
  | Pass1ThresholdCaseFailed;

const parseMetadata = (value: unknown): PassMetadata => {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["model", "inputTokens", "outputTokens", "latencyMs"]) ||
    typeof value.model !== "string" ||
    !Number.isInteger(value.inputTokens) ||
    (value.inputTokens as number) < 0 ||
    !Number.isInteger(value.outputTokens) ||
    (value.outputTokens as number) < 0 ||
    typeof value.latencyMs !== "number" ||
    !Number.isFinite(value.latencyMs) ||
    value.latencyMs < 0
  ) {
    throw new CalibrationError("invalid-evidence-record");
  }
  return {
    model: value.model,
    inputTokens: value.inputTokens as number,
    outputTokens: value.outputTokens as number,
    latencyMs: value.latencyMs,
  };
};

const parseClosedAnswer = (value: unknown): ClosedAnswerEvidence => {
  if (!isRecord(value)) {
    throw new CalibrationError("invalid-evidence-record");
  }
  if (value.type === "noul") {
    if (!exactKeys(value, ["type", "noul"]) || !isProbability(value.noul)) {
      throw new CalibrationError("invalid-evidence-record");
    }
    return { type: "noul", noul: value.noul };
  }
  if (
    value.type !== "choice" ||
    !exactKeys(value, ["type", "choice", "confidence", "probabilities"]) ||
    typeof value.choice !== "string" ||
    value.choice.length === 0 ||
    !isProbability(value.confidence) ||
    !isRecord(value.probabilities) ||
    !Object.values(value.probabilities).every(isProbability)
  ) {
    throw new CalibrationError("invalid-evidence-record");
  }
  return {
    type: "choice",
    choice: value.choice,
    confidence: value.confidence,
    probabilities: { ...(value.probabilities as Record<string, number>) },
  };
};

const parseOptionalTransportFields = (
  value: Record<string, unknown>,
): { readonly metadata?: PassMetadata; readonly costUsd?: number } => {
  const fields: { metadata?: PassMetadata; costUsd?: number } = {};
  if (value.metadata !== undefined) {
    fields.metadata = parseMetadata(value.metadata);
  }
  if (value.costUsd !== undefined) {
    if (
      typeof value.costUsd !== "number" ||
      !Number.isFinite(value.costUsd) ||
      value.costUsd < 0
    ) {
      throw new CalibrationError("invalid-evidence-record");
    }
    fields.costUsd = value.costUsd;
  }
  return fields;
};

const CASE_ID_PATTERN = /^[A-Z]+-\d{3}$/;

export const parsePass1ThresholdCaseRecord = (
  value: unknown,
): Pass1ThresholdCaseRecord => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.caseId !== "string" ||
    !CASE_ID_PATTERN.test(value.caseId) ||
    !Number.isInteger(value.attempts) ||
    (value.attempts as number) < 0
  ) {
    throw new CalibrationError("invalid-evidence-record");
  }
  const caseId = value.caseId;
  const attempts = value.attempts as number;
  if (value.outcome === "collected") {
    if (
      !isStringArray(value.questionKeys) ||
      !isRecord(value.answers) ||
      !Object.values(value.answers).every(
        (answer) => parseClosedAnswer(answer) !== undefined,
      ) ||
      typeof value.costUsd !== "number" ||
      !Number.isFinite(value.costUsd) ||
      value.costUsd < 0
    ) {
      throw new CalibrationError("invalid-evidence-record");
    }
    return {
      schemaVersion: 1,
      caseId,
      outcome: "collected",
      questionKeys: [...value.questionKeys],
      answers: Object.fromEntries(
        Object.entries(value.answers).map(([key, answer]) => [
          key,
          parseClosedAnswer(answer),
        ]),
      ),
      metadata: parseMetadata(value.metadata),
      costUsd: value.costUsd,
      attempts,
    };
  }
  if (value.outcome === "invalid-response") {
    if (
      typeof value.reason !== "string" ||
      value.reason.length === 0 ||
      !isStringArray(value.questionKeys)
    ) {
      throw new CalibrationError("invalid-evidence-record");
    }
    return {
      schemaVersion: 1,
      caseId,
      outcome: "invalid-response",
      reason: value.reason,
      questionKeys: [...value.questionKeys],
      attempts,
      ...parseOptionalTransportFields(value),
    };
  }
  if (value.outcome === "failed") {
    if (typeof value.error !== "string" || value.error.length === 0) {
      throw new CalibrationError("invalid-evidence-record");
    }
    return {
      schemaVersion: 1,
      caseId,
      outcome: "failed",
      error: value.error,
      attempts,
      ...parseOptionalTransportFields(value),
    };
  }
  throw new CalibrationError("invalid-evidence-record");
};

export interface Pass1ThresholdEvidenceManifest {
  readonly schemaVersion: 1;
  readonly kind: "pass1-threshold-evidence";
  readonly split: Pass1CorpusSplit;
  readonly corpusPath: string;
  readonly corpusFileSha256: string;
  readonly questionBuilderSha256: string;
  readonly corpusFingerprint: string;
  readonly sdk: string;
  readonly model: string;
  readonly caseOrder: readonly string[];
  readonly resumedFrom?: {
    readonly attempts: number;
    readonly spentUsd: number;
  };
  readonly resumeCount?: number;
  readonly limits: {
    readonly maxAttempts: number;
    readonly spendCapUsd: number;
    readonly requestReserveUsd: number;
    readonly maxInputTokens: number;
    readonly inputUsdPerMillion: number;
    readonly outputUsdPerMillion: number;
    readonly timeoutMs: number;
    readonly retries: number;
    readonly redirects: "manual";
    readonly interCallDelayMs: number;
  };
}

export type Pass1ThresholdSummaryStatus =
  | "collected"
  | "invalid-response"
  | "failed"
  | "aborted";

export interface Pass1ThresholdSummaryCase {
  readonly caseId: string;
  readonly status: Pass1ThresholdSummaryStatus;
  readonly error?: string;
}

export interface Pass1ThresholdEvidenceSummary {
  readonly schemaVersion: 1;
  readonly kind: "pass1-threshold-evidence-summary";
  readonly split: Pass1CorpusSplit;
  readonly corpusPath: string;
  readonly corpusFileSha256: string;
  readonly questionBuilderSha256: string;
  readonly corpusFingerprint: string;
  readonly sdk: string;
  readonly model: string;
  readonly status: "complete" | "incomplete";
  readonly incomplete: boolean;
  readonly cases: readonly Pass1ThresholdSummaryCase[];
  readonly accounting: CalibrationAccounting;
}

export interface Pass1ThresholdRunResult {
  readonly status: "complete" | "incomplete";
  readonly records: readonly Pass1ThresholdCaseRecord[];
  readonly accounting: CalibrationAccounting;
  readonly failure: { readonly caseId: string; readonly error: string } | null;
}

export interface Pass1ThresholdEvidenceSink {
  writeManifest(manifest: Pass1ThresholdEvidenceManifest): Promise<void>;
  writeCaseRecord(
    caseId: string,
    record: Pass1ThresholdCaseRecord,
  ): Promise<void>;
  writeSummary(summary: Pass1ThresholdEvidenceSummary): Promise<void>;
}

export interface RunPass1ThresholdCollectionOptions {
  readonly split: Pass1CorpusSplit;
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
}

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
    risk_public_contract: closedNoul(
      observations.riskDimensions["public-contract"],
    ),
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

export const runPass1ThresholdCollection = async (
  options: RunPass1ThresholdCollectionOptions,
): Promise<Pass1ThresholdRunResult> => {
  if (
    options.actual.corpusFileSha256 !== options.pins.corpusFileSha256 ||
    options.actual.questionBuilderSha256 !== options.pins.questionBuilderSha256
  ) {
    throw new CalibrationError("fingerprint-mismatch");
  }
  const guard = createCorpusGuard(options.corpus);
  const { transport, sink } = options;
  if (transport.fingerprint !== guard.fingerprint) {
    throw new CalibrationError("corpus-fingerprint-mismatch");
  }
  if (
    options.corpus.split !== options.split ||
    options.corpus.cases.length === 0
  ) {
    throw new CalibrationError("invalid-corpus");
  }
  const cases = options.corpus.cases;
  const caseOrder = cases.map(({ caseId }) => caseId);

  const manifest: Pass1ThresholdEvidenceManifest = {
    schemaVersion: 1,
    kind: "pass1-threshold-evidence",
    split: options.split,
    corpusPath: options.corpusPath,
    corpusFileSha256: options.pins.corpusFileSha256,
    questionBuilderSha256: options.pins.questionBuilderSha256,
    corpusFingerprint: guard.fingerprint,
    sdk: PASS1_THRESHOLD_SDK,
    model: PASS1_THRESHOLD_MODEL,
    caseOrder,
    ...(options.resume === undefined
      ? {}
      : {
        resumedFrom: {
          attempts: options.resume.priorAccounting.attempts,
          spentUsd: options.resume.priorAccounting.spentUsd,
        },
        resumeCount: options.resume.resumeCount,
      }),
    limits: {
      maxAttempts: options.resume === undefined
        ? PASS1_THRESHOLD_LIMITS[options.split].maxAttempts
        : PASS1_THRESHOLD_RESUME_ATTEMPT_CEILING[options.split],
      spendCapUsd: PASS1_THRESHOLD_LIMITS[options.split].spendCapUsd,
      requestReserveUsd: PASS1_THRESHOLD_LIMITS[options.split].requestReserveUsd,
      maxInputTokens: CALIBRATION_MAX_INPUT_TOKENS,
      inputUsdPerMillion: CALIBRATION_INPUT_USD_PER_MILLION,
      outputUsdPerMillion: CALIBRATION_OUTPUT_USD_PER_MILLION,
      timeoutMs: PASS1_THRESHOLD_TIMEOUT_MS,
      retries: 0,
      redirects: "manual",
      interCallDelayMs: PASS1_THRESHOLD_INTER_CALL_DELAY_MS,
    },
  };

  const records: Pass1ThresholdCaseRecord[] = [];
  const recordById = new Map<string, Pass1ThresholdCaseRecord>();

  const summaryFile = (
    status: "complete" | "incomplete",
  ): Pass1ThresholdEvidenceSummary => ({
    schemaVersion: 1,
    kind: "pass1-threshold-evidence-summary",
    split: manifest.split,
    corpusPath: manifest.corpusPath,
    corpusFileSha256: manifest.corpusFileSha256,
    questionBuilderSha256: manifest.questionBuilderSha256,
    corpusFingerprint: manifest.corpusFingerprint,
    sdk: manifest.sdk,
    model: manifest.model,
    status,
    incomplete: status === "incomplete",
    cases: caseOrder.map((caseId) => {
      const record = recordById.get(caseId);
      if (record === undefined) {
        return { caseId, status: "aborted" };
      }
      if (record.outcome === "failed") {
        return { caseId, status: "failed", error: record.error };
      }
      if (record.outcome === "invalid-response") {
        return { caseId, status: "invalid-response", error: record.reason };
      }
      return { caseId, status: "collected" };
    }),
    accounting: transport.accounting(),
  });

  try {
    await sink.writeManifest(manifest);
    for (const corpusCase of cases) {
      guard.assertUnchanged();
      const prior = options.resume?.priorRecords.get(corpusCase.caseId);
      if (
        prior !== undefined &&
        (prior.outcome === "collected" || prior.outcome === "invalid-response")
      ) {
        records.push(prior);
        recordById.set(corpusCase.caseId, prior);
        continue;
      }
      await (options.delay ??
        ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))))(
        PASS1_THRESHOLD_INTER_CALL_DELAY_MS,
      );
      const request = buildPass1Request(corpusCase.input);
      let result: CalibrationTransportResult | null = null;
      let record: Pass1ThresholdCaseRecord;
      try {
        result = await transport.systemOne(request);
        const observations = parsePass1Observations(
          result.answers,
          corpusCase.input,
        );
        record = {
          schemaVersion: 1,
          caseId: corpusCase.caseId,
          outcome: "collected",
          questionKeys: Object.keys(request.questions),
          answers: closedAnswers(observations),
          metadata: { ...result.metadata },
          costUsd: result.costUsd,
          attempts: transport.accounting().attempts,
        };
      } catch (error) {
        if (error instanceof SemanticGatewayError && result !== null) {
          record = {
            schemaVersion: 1,
            caseId: corpusCase.caseId,
            outcome: "invalid-response",
            reason: error.reason,
            questionKeys: Object.keys(request.questions),
            attempts: transport.accounting().attempts,
            metadata: { ...result.metadata },
            costUsd: result.costUsd,
          };
        } else {
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
            caseId: corpusCase.caseId,
            outcome: "failed",
            error: boundedReason(error),
            attempts: transport.accounting().attempts,
          };
        }
      }
      records.push(record);
      recordById.set(corpusCase.caseId, record);
      await sink.writeCaseRecord(corpusCase.caseId, record);
      if (record.outcome === "failed") {
        const failure = { caseId: corpusCase.caseId, error: record.error };
        await sink.writeSummary(summaryFile("incomplete"));
        return {
          status: "incomplete",
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

const hasErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const CASE_FILE_PATTERN = /^case-(?:CAL|EVAL)-\d{3}\.json$/;

export const createPass1ThresholdEvidenceSink = (
  directory: string,
  beforeWrite?: () => Promise<void>,
  options?: { readonly resume?: boolean },
): Pass1ThresholdEvidenceSink => {
  const resume = options?.resume === true;
  const overwrite = async (name: string, value: unknown): Promise<void> => {
    await beforeWrite?.();
    const temporaryPath = join(
      directory,
      `${name}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await beforeWrite?.();
      await rename(temporaryPath, join(directory, name));
      await beforeWrite?.();
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  };
  const write = async (name: string, value: unknown): Promise<void> => {
    if (resume) {
      await overwrite(name, value);
      return;
    }
    await beforeWrite?.();
    let file;
    try {
      file = await open(
        join(directory, name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
          constants.O_NOFOLLOW,
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
      if (!resume) {
        await write(name, record);
        return;
      }
      const path = join(directory, name);
      try {
        const existing = parsePass1ThresholdCaseRecord(
          JSON.parse(await readFile(path, "utf8")),
        );
        if (existing.outcome !== "failed") {
          throw new CalibrationError("evidence-exists");
        }
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) {
          await write(name, record);
          return;
        }
        throw error;
      }
      await overwrite(name, record);
    },
    writeSummary: (summary) => write("summary.json", summary),
  };
};
