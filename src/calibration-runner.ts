import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  APITimeoutError,
  TypeSafeClient,
  type EntryType,
  type Fetch,
  type Questions,
} from "@typesafe-ai/sdk";
import type {
  AdvisorySignals,
  RiskDimension,
  RouterDecision,
  RouterInput,
  TaskType,
} from "./contracts.js";
import { postcheck, precheck } from "./policy.js";
import type {
  Pass1Result,
  PassMetadata,
  SystemOneRequest,
} from "./semantic-gateway.js";
import {
  evaluatePass2,
  evaluateThresholdGrid,
  selectThreshold,
  type ParsedPass2,
  type Pass2Thresholds,
  type TupleEvaluation,
} from "./threshold-calibration.js";
import {
  parsePass2Record,
  parseTypeSafeEnvelope,
  TypeSafeGateway,
} from "./typesafe-gateway.js";
import { buildPass1Request, buildPass2Request } from "./questions.js";

export const CALIBRATION_MODEL = "jev-1.13.0";
export const CALIBRATION_INPUT_USD_PER_MILLION = 0.042;
export const CALIBRATION_OUTPUT_USD_PER_MILLION = 0;
export const CALIBRATION_MAX_INPUT_TOKENS = 64_000;
export const CALIBRATION_MAX_ATTEMPTS = 18;
export const CALIBRATION_REQUEST_RESERVE_USD = 0.002688;
export const CALIBRATION_SPEND_CAP_USD = 0.05;

export class CalibrationError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CalibrationError";
  }
}

export interface InclusiveRange {
  readonly min: number;
  readonly max: number;
}

export interface ExpectedCalibrationSignals {
  readonly taskType: TaskType;
  readonly skillCandidates: readonly string[];
  readonly criticalGapId: string | null;
  readonly reuseCandidateId: string | null;
  readonly architectureForkId: string | null;
  readonly riskDimensions: Readonly<Record<RiskDimension, InclusiveRange>>;
  readonly contextRelevance: readonly {
    readonly id: string;
    readonly probability: InclusiveRange;
  }[];
  readonly forcedSkillIds: readonly string[];
  readonly protectedContextIds: readonly string[];
}

export interface CalibrationCorpusCase {
  readonly id: string;
  readonly set: "calibration" | "holdout";
  readonly input: RouterInput;
  readonly expected: ExpectedCalibrationSignals;
}

export interface CalibrationCorpus {
  readonly schemaVersion: 1;
  readonly cases: readonly CalibrationCorpusCase[];
}

export const DEFAULT_CALIBRATION_CORPUS_PATH = resolve("fixtures/calibration-corpus.json");

const TASK_TYPES: ReadonlySet<string> = new Set([
  "explain", "research", "plan", "diagnose", "change", "review", "operate",
]);
const RISK_DIMENSIONS: readonly RiskDimension[] = [
  "security", "data-loss", "public-contract", "migration", "user-behavior",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isRange = (value: unknown): value is InclusiveRange =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  typeof value.min === "number" &&
  typeof value.max === "number" &&
  Number.isFinite(value.min) &&
  Number.isFinite(value.max) &&
  value.min >= 0 &&
  value.min <= value.max &&
  value.max <= 1;

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

const assertKnownId = (id: string | null, allowed: readonly string[]): void => {
  if (id !== null && !allowed.includes(id)) {
    throw new CalibrationError("invalid-corpus-label");
  }
};

const parseCorpusCase = (
  value: unknown,
  expectedId: string,
  expectedSet: "calibration" | "holdout",
): CalibrationCorpusCase => {
  if (
    !isRecord(value) ||
    value.id !== expectedId ||
    value.set !== expectedSet ||
    !isRecord(value.input) ||
    !isRecord(value.expected)
  ) {
    throw new CalibrationError("invalid-corpus-case");
  }

  const input = value.input as unknown as RouterInput;
  const checked = precheck(input);
  if (
    input.taskId !== expectedId ||
    !Array.isArray(input.criticalGapCandidates) ||
    !Array.isArray(input.reuseCandidates) ||
    !Array.isArray(input.architectureForkCandidates) ||
    !Array.isArray(input.contextFragments)
  ) {
    throw new CalibrationError("incomplete-corpus-input");
  }

  const expected = value.expected;
  const riskDimensions = expected.riskDimensions;
  if (
    typeof expected.taskType !== "string" ||
    !TASK_TYPES.has(expected.taskType) ||
    !isStringArray(expected.skillCandidates) ||
    !(expected.criticalGapId === null || typeof expected.criticalGapId === "string") ||
    !(expected.reuseCandidateId === null || typeof expected.reuseCandidateId === "string") ||
    !(expected.architectureForkId === null || typeof expected.architectureForkId === "string") ||
    !isRecord(riskDimensions) ||
    !Array.isArray(expected.contextRelevance) ||
    !isStringArray(expected.forcedSkillIds) ||
    !isStringArray(expected.protectedContextIds) ||
    !RISK_DIMENSIONS.every((dimension) => isRange(riskDimensions[dimension])) ||
    Object.keys(riskDimensions).length !== RISK_DIMENSIONS.length ||
    !expected.contextRelevance.every((entry) =>
      isRecord(entry) && typeof entry.id === "string" && isRange(entry.probability))
  ) {
    throw new CalibrationError("invalid-corpus-label");
  }

  const skillIds = input.skills.map(({ id }) => id);
  const forced = new Set(checked.forcedSkillIds);
  if (
    expected.skillCandidates.length > 1 ||
    expected.skillCandidates.some((id) => !skillIds.includes(id) || forced.has(id)) ||
    new Set(expected.skillCandidates).size !== expected.skillCandidates.length ||
    !sameIds(expected.forcedSkillIds, checked.forcedSkillIds) ||
    !sameIds(expected.protectedContextIds, checked.protectedContextIds)
  ) {
    throw new CalibrationError("invalid-corpus-label");
  }
  assertKnownId(
    expected.criticalGapId,
    input.criticalGapCandidates.map(({ id }) => id),
  );
  assertKnownId(expected.reuseCandidateId, input.reuseCandidates.map(({ id }) => id));
  assertKnownId(
    expected.architectureForkId,
    input.architectureForkCandidates.map(({ id }) => id),
  );
  const publicContextIds = input.contextFragments
    .filter(({ protected: isProtected }) => isProtected !== true)
    .map(({ id }) => id);
  if (
    expected.contextRelevance.some(({ id }) => !publicContextIds.includes(id)) ||
    new Set(expected.contextRelevance.map(({ id }) => id)).size !==
      expected.contextRelevance.length
  ) {
    throw new CalibrationError("invalid-corpus-label");
  }

  return value as unknown as CalibrationCorpusCase;
};

export const loadCalibrationCorpus = (path: string): CalibrationCorpus => {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CalibrationError("invalid-corpus-json");
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.cases)) {
    throw new CalibrationError("invalid-corpus");
  }
  const cases = value.cases;
  const ids = ["C1", "C2", "C3", "C4", "C5", "C6", "H1", "H2"] as const;
  if (cases.length !== ids.length) {
    throw new CalibrationError("invalid-corpus-size");
  }
  return {
    schemaVersion: 1,
    cases: ids.map((id, index) =>
      parseCorpusCase(cases[index], id, id.startsWith("C") ? "calibration" : "holdout")),
  };
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  throw new CalibrationError("non-canonical-value");
};

export const canonicalFingerprint = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

export const createCorpusGuard = (corpus: unknown) => {
  const fingerprint = canonicalFingerprint(corpus);
  return {
    fingerprint,
    assertUnchanged(): void {
      if (canonicalFingerprint(corpus) !== fingerprint) {
        throw new CalibrationError("corpus-mutated");
      }
    },
  };
};

export interface CalibrationAccounting {
  readonly attempts: number;
  readonly spentUsd: number;
  readonly reservedUsd: number;
  readonly terminal: boolean;
}

export interface CalibrationTransportResult {
  readonly answers: Readonly<Record<string, unknown>>;
  readonly metadata: PassMetadata;
  readonly costUsd: number;
}

export type ClosedAnswerEvidence =
  | {
      readonly type: "choice";
      readonly choice: string;
      readonly confidence: number;
      readonly probabilities: Readonly<Record<string, number>>;
    }
  | { readonly type: "noul"; readonly noul: number };

interface CalibrationPassEvidence {
  readonly metadata: PassMetadata;
  readonly costUsd: number;
}

export interface CalibrationPass1Evidence extends CalibrationPassEvidence {
  readonly answers: Readonly<Record<string, ClosedAnswerEvidence>>;
}

export interface CalibrationPass2Evidence extends CalibrationPassEvidence {
  readonly record: ParsedPass2;
}

export interface ClosedDecisionEvidence {
  readonly taskType: TaskType;
  readonly skillCandidates: readonly string[];
  readonly criticalGapId: string | null;
  readonly reuseCandidateId: string | null;
  readonly architectureForkId: string | null;
  readonly riskDimensions: Readonly<Record<RiskDimension, number>>;
  readonly contextRelevance: readonly { readonly id: string; readonly probability: number }[];
  readonly forcedSkillIds: readonly string[];
  readonly protectedContextIds: readonly string[];
}

export interface CalibrationEvidenceCase {
  readonly caseId: string;
  readonly set: "calibration" | "holdout";
  readonly expected: ExpectedCalibrationSignals;
  readonly pass1: CalibrationPass1Evidence;
  readonly pass2: CalibrationPass2Evidence;
  readonly pass1Decision: ClosedDecisionEvidence;
  readonly finalDecision?: ClosedDecisionEvidence;
  readonly pass?: boolean;
}

export interface CalibrationTupleEvaluation extends TupleEvaluation {
  readonly metrics: {
    readonly exactMatchCount: number;
    readonly shortlistRecallCount: number;
    readonly fallbackCount: number;
    readonly falsePositiveCount: number;
    readonly falseNegativeCount: number;
    readonly minimumBoundaryMargin: number;
  };
}

export type CalibrationReportPhase =
  | "calibration-records"
  | "calibration-failed"
  | "tuple-selected"
  | "holdout-complete";

export interface CalibrationReport {
  readonly schemaVersion: 1;
  readonly phase: CalibrationReportPhase;
  readonly corpusFingerprint: string;
  readonly model: typeof CALIBRATION_MODEL;
  readonly prices: {
    readonly inputUsdPerMillion: typeof CALIBRATION_INPUT_USD_PER_MILLION;
    readonly outputUsdPerMillion: typeof CALIBRATION_OUTPUT_USD_PER_MILLION;
  };
  readonly limits: {
    readonly maxAttempts: typeof CALIBRATION_MAX_ATTEMPTS;
    readonly spendCapUsd: typeof CALIBRATION_SPEND_CAP_USD;
    readonly requestReserveUsd: typeof CALIBRATION_REQUEST_RESERVE_USD;
  };
  readonly calibration: {
    readonly denominator: 6;
    readonly cases: readonly CalibrationEvidenceCase[];
    readonly evaluations: readonly CalibrationTupleEvaluation[] | null;
    readonly pass: boolean | null;
  };
  readonly selectedTuple: Pass2Thresholds | null;
  readonly holdout: null | {
    readonly denominator: 2;
    readonly cases: readonly CalibrationEvidenceCase[];
    readonly pass: boolean;
  };
  readonly accounting: CalibrationAccounting;
}

export const createAtomicCalibrationReportWriter = (path: string) =>
  async (report: CalibrationReport): Promise<void> => {
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, path);
    } catch (error) {
      try {
        await unlink(temporaryPath);
      } catch {
        // The temporary path may not exist or may already have been renamed.
      }
      throw error;
    }
  };

interface CalibrationTransportOptions {
  readonly apiKey: string;
  readonly corpus: CalibrationCorpus;
  readonly fetch: Fetch;
  readonly timeoutMs?: number;
  readonly accounting?: {
    readonly attempts: number;
    readonly spentUsd: number;
  };
}

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

export const createCalibrationTransport = (options: CalibrationTransportOptions) => {
  if (options.apiKey.trim().length === 0) {
    throw new CalibrationError("missing-api-key");
  }
  const initial = options.accounting ?? { attempts: 0, spentUsd: 0 };
  if (
    !Number.isInteger(initial.attempts) ||
    initial.attempts < 0 ||
    initial.attempts > CALIBRATION_MAX_ATTEMPTS ||
    !Number.isFinite(initial.spentUsd) ||
    initial.spentUsd < 0 ||
    initial.spentUsd > CALIBRATION_SPEND_CAP_USD
  ) {
    throw new CalibrationError("invalid-accounting");
  }

  const guard = createCorpusGuard(options.corpus);
  let attempts = initial.attempts;
  let spentUsd = initial.spentUsd;
  let reservedUsd = 0;
  let terminal = false;

  const guardedFetch: Fetch = async (input, init) => {
    guard.assertUnchanged();
    if (terminal) {
      throw new CalibrationError("terminal");
    }
    if (reservedUsd !== 0) {
      terminal = true;
      throw new CalibrationError("concurrent-dispatch");
    }
    if (attempts >= CALIBRATION_MAX_ATTEMPTS) {
      terminal = true;
      throw new CalibrationError("attempt-cap");
    }
    if (spentUsd + CALIBRATION_REQUEST_RESERVE_USD > CALIBRATION_SPEND_CAP_USD) {
      terminal = true;
      throw new CalibrationError("spend-cap");
    }
    attempts += 1;
    reservedUsd = CALIBRATION_REQUEST_RESERVE_USD;
    const response = await options.fetch(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      terminal = true;
      throw new CalibrationError("redirect");
    }
    return response;
  };

  const client = new TypeSafeClient({
    apiKey: options.apiKey,
    defaultModel: CALIBRATION_MODEL,
    fetch: guardedFetch,
    logLevel: "off",
    retry: { maxRetries: 0 },
    timeout: options.timeoutMs ?? 10_000,
  });

  const systemOne = async (request: SystemOneRequest): Promise<CalibrationTransportResult> => {
    if (terminal) {
      throw new CalibrationError("terminal");
    }
    if (hasRuntimeOverride(request)) {
      throw new CalibrationError("runtime-override");
    }
    const started = performance.now();
    let response: unknown;
    try {
      response = await client.systemOne({
        state: request.state as EntryType,
        questions: request.questions as Questions,
        model: CALIBRATION_MODEL,
      });
    } catch (error) {
      terminal = true;
      const calibrationError = calibrationErrorFrom(error);
      if (calibrationError !== null) {
        throw calibrationError;
      }
      throw new CalibrationError(
        error instanceof APITimeoutError ? "timeout" : "provider-error",
      );
    }

    let envelope: ReturnType<typeof parseTypeSafeEnvelope>;
    try {
      envelope = parseTypeSafeEnvelope(
        response,
        Object.keys(request.questions),
        performance.now() - started,
      );
    } catch {
      terminal = true;
      throw new CalibrationError("unknown-accounting");
    }
    if (
      envelope.metadata.model !== CALIBRATION_MODEL ||
      envelope.metadata.inputTokens > CALIBRATION_MAX_INPUT_TOKENS
    ) {
      terminal = true;
      throw new CalibrationError("unknown-accounting");
    }
    const costUsd =
      envelope.metadata.inputTokens * CALIBRATION_INPUT_USD_PER_MILLION / 1_000_000 +
      envelope.metadata.outputTokens * CALIBRATION_OUTPUT_USD_PER_MILLION / 1_000_000;
    if (
      !Number.isFinite(costUsd) ||
      costUsd < 0 ||
      costUsd > reservedUsd ||
      spentUsd + costUsd > CALIBRATION_SPEND_CAP_USD
    ) {
      terminal = true;
      throw new CalibrationError("unknown-accounting");
    }
    reservedUsd = 0;
    spentUsd += costUsd;
    return { ...envelope, costUsd };
  };

  return {
    fingerprint: guard.fingerprint,
    systemOne,
    accounting: (): CalibrationAccounting => ({ attempts, spentUsd, reservedUsd, terminal }),
  };
};

type CalibrationTransport = ReturnType<typeof createCalibrationTransport>;

interface RunCalibrationExperimentOptions {
  readonly corpus: CalibrationCorpus;
  readonly transport: CalibrationTransport;
  readonly writeReport: (report: CalibrationReport) => Promise<void>;
}

const rawEnvelope = (result: CalibrationTransportResult): Record<string, unknown> => ({
  model: result.metadata.model,
  usage: {
    input_tokens: result.metadata.inputTokens,
    output_tokens: result.metadata.outputTokens,
  },
  answers: result.answers,
});

const semanticFromPass1 = (result: Pass1Result): AdvisorySignals & { readonly echo: Pass1Result["echo"] } => ({
  echo: result.echo,
  taskType: result.taskType,
  skillCandidates: result.skillCandidates,
  criticalGap: result.criticalGap,
  reuseCandidate: result.reuseCandidate,
  architectureFork: result.architectureFork,
  riskDimensions: result.riskDimensions,
  contextRelevance: result.contextRelevance,
});

const validatePass1 = async (
  input: ReturnType<typeof precheck>,
  result: CalibrationTransportResult,
): Promise<Pass1Result> => {
  try {
    return await new TypeSafeGateway({ systemOne: async () => rawEnvelope(result) }).pass1(input);
  } catch {
    throw new CalibrationError("invalid-provider-evidence");
  }
};

const closedAnswers = (
  answers: Readonly<Record<string, unknown>>,
): Readonly<Record<string, ClosedAnswerEvidence>> =>
  structuredClone(answers) as Readonly<Record<string, ClosedAnswerEvidence>>;

const decisionEvidence = (decision: RouterDecision): ClosedDecisionEvidence | null => {
  if (decision.status !== "ok") {
    return null;
  }
  return {
    taskType: decision.signals.taskType,
    skillCandidates: [...decision.signals.skillCandidates],
    criticalGapId: decision.signals.criticalGap?.id ?? null,
    reuseCandidateId: decision.signals.reuseCandidate,
    architectureForkId: decision.signals.architectureFork?.id ?? null,
    riskDimensions: { ...decision.signals.riskDimensions },
    contextRelevance: decision.signals.contextRelevance.map((entry) => ({ ...entry })),
    forcedSkillIds: [...decision.forcedSkillIds],
    protectedContextIds: [...decision.protectedContextIds],
  };
};

const exactIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

const matchesExpected = (
  actual: ClosedDecisionEvidence,
  expected: ExpectedCalibrationSignals,
): boolean =>
  actual.taskType === expected.taskType &&
  exactIds(actual.skillCandidates, expected.skillCandidates) &&
  actual.criticalGapId === expected.criticalGapId &&
  actual.reuseCandidateId === expected.reuseCandidateId &&
  actual.architectureForkId === expected.architectureForkId &&
  RISK_DIMENSIONS.every((dimension) => {
    const value = actual.riskDimensions[dimension];
    const range = expected.riskDimensions[dimension];
    return value >= range.min && value <= range.max;
  }) &&
  actual.contextRelevance.length === expected.contextRelevance.length &&
  actual.contextRelevance.every((entry, index) => {
    const wanted = expected.contextRelevance[index]!;
    return entry.id === wanted.id &&
      entry.probability >= wanted.probability.min &&
      entry.probability <= wanted.probability.max;
  }) &&
  exactIds(actual.forcedSkillIds, expected.forcedSkillIds) &&
  exactIds(actual.protectedContextIds, expected.protectedContextIds);

interface CollectedCase {
  readonly checked: ReturnType<typeof precheck>;
  readonly pass1: Pass1Result;
  readonly evidence: CalibrationEvidenceCase;
}

const collectCase = async (
  corpusCase: CalibrationCorpusCase,
  transport: CalibrationTransport,
): Promise<CollectedCase> => {
  const checked = precheck(corpusCase.input);
  const pass1Transport = await transport.systemOne(buildPass1Request(checked));
  const pass1 = await validatePass1(checked, pass1Transport);
  const preliminary = postcheck(checked, semanticFromPass1(pass1));
  const pass1Decision = decisionEvidence(preliminary);
  if (pass1Decision === null) {
    throw new CalibrationError("invalid-pass1-decision");
  }
  const expectedWithoutSkills: ExpectedCalibrationSignals = {
    ...corpusCase.expected,
    skillCandidates: pass1Decision.skillCandidates,
  };
  if (
    !matchesExpected(pass1Decision, expectedWithoutSkills) ||
    !corpusCase.expected.skillCandidates.every((id) => pass1Decision.skillCandidates.includes(id)) ||
    pass1Decision.skillCandidates.length === 0
  ) {
    throw new CalibrationError("pass1-label-mismatch");
  }

  const pass2Transport = await transport.systemOne(
    buildPass2Request(checked, pass1Decision.skillCandidates),
  );
  let record: ParsedPass2;
  try {
    record = parsePass2Record(
      pass2Transport.answers,
      checked,
      pass1Decision.skillCandidates,
    );
  } catch {
    throw new CalibrationError("invalid-provider-evidence");
  }

  return {
    checked,
    pass1,
    evidence: {
      caseId: corpusCase.id,
      set: corpusCase.set,
      expected: structuredClone(corpusCase.expected),
      pass1: {
        answers: closedAnswers(pass1Transport.answers),
        metadata: { ...pass1Transport.metadata },
        costUsd: pass1Transport.costUsd,
      },
      pass2: {
        record: structuredClone(record),
        metadata: { ...pass2Transport.metadata },
        costUsd: pass2Transport.costUsd,
      },
      pass1Decision,
    },
  };
};

const baseReport = (
  phase: CalibrationReportPhase,
  fingerprint: string,
  cases: readonly CalibrationEvidenceCase[],
  accounting: CalibrationAccounting,
): CalibrationReport => ({
  schemaVersion: 1,
  phase,
  corpusFingerprint: fingerprint,
  model: CALIBRATION_MODEL,
  prices: {
    inputUsdPerMillion: CALIBRATION_INPUT_USD_PER_MILLION,
    outputUsdPerMillion: CALIBRATION_OUTPUT_USD_PER_MILLION,
  },
  limits: {
    maxAttempts: CALIBRATION_MAX_ATTEMPTS,
    spendCapUsd: CALIBRATION_SPEND_CAP_USD,
    requestReserveUsd: CALIBRATION_REQUEST_RESERVE_USD,
  },
  calibration: {
    denominator: 6,
    cases,
    evaluations: null,
    pass: null,
  },
  selectedTuple: null,
  holdout: null,
  accounting,
});

const reportEvaluation = (
  evaluation: TupleEvaluation,
  cases: readonly {
    readonly record: ParsedPass2;
    readonly expectedSkillIds: readonly string[];
  }[],
): CalibrationTupleEvaluation => {
  const margins = cases.flatMap(({ record }) => [
    Math.abs(record.ranking.confidence - evaluation.thresholds.rankingMin),
    ...record.fits.flatMap((fit) => [
      Math.abs(fit - evaluation.thresholds.lower),
      Math.abs(fit - evaluation.thresholds.upper),
    ]),
  ]);
  return {
    ...evaluation,
    metrics: {
      exactMatchCount: evaluation.cases.filter(({ exactMatch }) => exactMatch).length,
      shortlistRecallCount: cases.filter(({ record, expectedSkillIds }) =>
        expectedSkillIds.every((id) => record.shortlist.includes(id))).length,
      fallbackCount: evaluation.cases.filter(({ status }) => status === "low-confidence").length,
      falsePositiveCount: evaluation.cases.reduce(
        (count, result) => count + result.falsePositives.length,
        0,
      ),
      falseNegativeCount: evaluation.cases.reduce(
        (count, result) => count + result.expectedSkillIds
          .filter((id) => !result.skillCandidates.includes(id)).length,
        0,
      ),
      minimumBoundaryMargin: Math.min(...margins),
    },
  };
};

export const runCalibrationExperiment = async (
  options: RunCalibrationExperimentOptions,
): Promise<CalibrationReport> => {
  const fingerprint = canonicalFingerprint(options.corpus);
  if (options.transport.fingerprint !== fingerprint) {
    throw new CalibrationError("corpus-fingerprint-mismatch");
  }
  const calibrationCases = options.corpus.cases.filter(({ set }) => set === "calibration");
  const holdoutCases = options.corpus.cases.filter(({ set }) => set === "holdout");
  if (calibrationCases.length !== 6 || holdoutCases.length !== 2) {
    throw new CalibrationError("invalid-corpus-size");
  }

  const collectedCalibration: CollectedCase[] = [];
  for (const corpusCase of calibrationCases) {
    collectedCalibration.push(await collectCase(corpusCase, options.transport));
  }
  const recordReport = baseReport(
    "calibration-records",
    fingerprint,
    collectedCalibration.map(({ evidence }) => evidence),
    options.transport.accounting(),
  );
  await options.writeReport(recordReport);

  const selectorCases = collectedCalibration.map(({ evidence }) => ({
    caseId: evidence.caseId,
    record: evidence.pass2.record,
    expectedSkillIds: evidence.expected.skillCandidates,
  }));
  const evaluations = evaluateThresholdGrid(selectorCases)
    .map((evaluation) => reportEvaluation(evaluation, selectorCases));
  const selected = selectThreshold(selectorCases);
  if (selected === null) {
    const failed: CalibrationReport = {
      ...recordReport,
      phase: "calibration-failed",
      calibration: { ...recordReport.calibration, evaluations, pass: false },
      accounting: options.transport.accounting(),
    };
    await options.writeReport(failed);
    return failed;
  }

  const selectedTuple: Pass2Thresholds = Object.freeze({ ...selected.thresholds });
  const tupleReport: CalibrationReport = {
    ...recordReport,
    phase: "tuple-selected",
    calibration: { ...recordReport.calibration, evaluations, pass: true },
    selectedTuple,
    accounting: options.transport.accounting(),
  };
  await options.writeReport(tupleReport);

  const collectedHoldout: CalibrationEvidenceCase[] = [];
  for (const corpusCase of holdoutCases) {
    const collected = await collectCase(corpusCase, options.transport);
    const evaluation = evaluatePass2(collected.evidence.pass2.record, selectedTuple);
    const final = evaluation.status === "ok"
      ? postcheck(collected.checked, {
        ...semanticFromPass1(collected.pass1),
        skillCandidates: evaluation.skillCandidates,
      })
      : null;
    const finalDecision = final === null ? null : decisionEvidence(final);
    const pass = finalDecision !== null && matchesExpected(finalDecision, corpusCase.expected);
    collectedHoldout.push({
      ...collected.evidence,
      ...(finalDecision === null ? {} : { finalDecision }),
      pass,
    });
    if (!pass) {
      break;
    }
  }

  const holdoutPass =
    collectedHoldout.length === 2 && collectedHoldout.every(({ pass }) => pass === true);
  const finalReport: CalibrationReport = {
    ...tupleReport,
    phase: "holdout-complete",
    holdout: { denominator: 2, cases: collectedHoldout, pass: holdoutPass },
    accounting: options.transport.accounting(),
  };
  await options.writeReport(finalReport);
  return finalReport;
};
