import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { link, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
import {
  PASS1_THRESHOLDS_ENV,
  parsePass1Thresholds,
} from "./pass1-thresholds.js";
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

export interface CalibrationTransportLimits {
  readonly maxAttempts: number;
  readonly spendCapUsd: number;
  readonly requestReserveUsd: number;
}

export const CALIBRATION_TRANSPORT_LIMITS: CalibrationTransportLimits = {
  maxAttempts: CALIBRATION_MAX_ATTEMPTS,
  spendCapUsd: CALIBRATION_SPEND_CAP_USD,
  requestReserveUsd: CALIBRATION_REQUEST_RESERVE_USD,
};

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

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
};

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
    !exactKeys(value, ["id", "set", "input", "expected"]) ||
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
    !exactKeys(value.input, [
      "taskId",
      "taskRevision",
      "taskText",
      "policyVersion",
      "catalogHash",
      "explicitSkillIds",
      "requiredSkillIds",
      "skills",
      "criticalGapCandidates",
      "architectureForkCandidates",
      "reuseCandidates",
      "contextFragments",
    ]) ||
    input.taskId !== expectedId ||
    !Array.isArray(input.criticalGapCandidates) ||
    !Array.isArray(input.reuseCandidates) ||
    !Array.isArray(input.architectureForkCandidates) ||
    !Array.isArray(input.contextFragments)
  ) {
    throw new CalibrationError("incomplete-corpus-input");
  }
  if (
    input.skills.some((entry) =>
      !isRecord(entry) || !exactKeys(entry, ["id", "description", "excerpt"])) ||
    input.criticalGapCandidates.some((entry) =>
      !isRecord(entry) || !exactKeys(entry, ["id", "fact", "blocks"])) ||
    input.architectureForkCandidates.some((entry) =>
      !isRecord(entry) || !exactKeys(entry, ["id", "alternatives", "tradeoff"])) ||
    input.reuseCandidates.some((entry) =>
      !isRecord(entry) || !exactKeys(entry, ["id", "summary"])) ||
    input.contextFragments.some((entry) =>
      !isRecord(entry) || !exactKeys(
        entry,
        entry.protected === undefined ? ["id", "summary"] : ["id", "summary", "protected"],
      ))
  ) {
    throw new CalibrationError("invalid-corpus-input");
  }

  const expected = value.expected;
  const riskDimensions = expected.riskDimensions;
  if (
    !exactKeys(expected, [
      "taskType",
      "skillCandidates",
      "criticalGapId",
      "reuseCandidateId",
      "architectureForkId",
      "riskDimensions",
      "contextRelevance",
      "forcedSkillIds",
      "protectedContextIds",
    ]) ||
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
      isRecord(entry) &&
      exactKeys(entry, ["id", "probability"]) &&
      typeof entry.id === "string" &&
      isRange(entry.probability))
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

  return {
    id: expectedId,
    set: expectedSet,
    input: {
      taskId: input.taskId,
      taskRevision: input.taskRevision,
      taskText: input.taskText,
      policyVersion: input.policyVersion,
      catalogHash: input.catalogHash,
      explicitSkillIds: [...input.explicitSkillIds],
      requiredSkillIds: [...input.requiredSkillIds],
      skills: input.skills.map(({ id, description, excerpt }) => ({ id, description, excerpt })),
      criticalGapCandidates: input.criticalGapCandidates.map(({ id, fact, blocks }) => ({
        id,
        fact,
        blocks,
      })),
      architectureForkCandidates: input.architectureForkCandidates.map(
        ({ id, alternatives, tradeoff }) => ({ id, alternatives: [...alternatives], tradeoff }),
      ),
      reuseCandidates: input.reuseCandidates.map(({ id, summary }) => ({ id, summary })),
      contextFragments: input.contextFragments.map(({ id, summary, protected: isProtected }) => ({
        id,
        summary,
        ...(isProtected === undefined ? {} : { protected: isProtected }),
      })),
    },
    expected: {
      taskType: expected.taskType as TaskType,
      skillCandidates: [...expected.skillCandidates],
      criticalGapId: expected.criticalGapId,
      reuseCandidateId: expected.reuseCandidateId,
      architectureForkId: expected.architectureForkId,
      riskDimensions: Object.fromEntries(
        RISK_DIMENSIONS.map((dimension) => {
          const range = riskDimensions[dimension] as unknown as InclusiveRange;
          return [dimension, { min: range.min, max: range.max }];
        }),
      ) as Readonly<Record<RiskDimension, InclusiveRange>>,
      contextRelevance: expected.contextRelevance.map((entry) => ({
        id: entry.id as string,
        probability: { ...(entry.probability as unknown as InclusiveRange) },
      })),
      forcedSkillIds: [...expected.forcedSkillIds],
      protectedContextIds: [...expected.protectedContextIds],
    },
  };
};

export const parseCalibrationCorpus = (serialized: string): CalibrationCorpus => {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new CalibrationError("invalid-corpus-json");
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, ["schemaVersion", "cases"]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.cases)
  ) {
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

export const loadCalibrationCorpus = (path: string): CalibrationCorpus => {
  try {
    return parseCalibrationCorpus(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof CalibrationError) throw error;
    throw new CalibrationError("invalid-corpus-json");
  }
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

const CHECKPOINT_FAILURES = [
  "attempt-cap",
  "concurrent-dispatch",
  "corpus-mutated",
  "evidence-write",
  "post-transport-validation",
  "provider-error",
  "redirect",
  "runtime-override",
  "spend-cap",
  "timeout",
  "unknown-accounting",
] as const;

export type CalibrationCheckpointFailure = (typeof CHECKPOINT_FAILURES)[number];

export const isCheckpointFailure = (value: unknown): value is CalibrationCheckpointFailure =>
  typeof value === "string" && (CHECKPOINT_FAILURES as readonly string[]).includes(value);

export interface CalibrationCheckpoint {
  readonly schemaVersion: 1;
  readonly corpusFingerprint: string;
  readonly phase: "active" | "reserved" | "terminal" | "complete";
  readonly accounting: CalibrationAccounting;
  readonly failureReason: CalibrationCheckpointFailure | null;
}

export interface CalibrationCheckpointStore {
  claim(checkpoint: CalibrationCheckpoint): Promise<boolean>;
  write(checkpoint: CalibrationCheckpoint): Promise<void>;
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

export interface CalibrationPassEvidence {
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

export type CalibrationDiagnosticReason =
  | "invalid-provider-evidence"
  | "invalid-pass1-decision"
  | "pass1-label-mismatch";

export interface CalibrationFailureEvidence {
  readonly caseId: string;
  readonly stage: "pass1" | "pass2";
  readonly reason: CalibrationDiagnosticReason;
  readonly pass1: CalibrationPass1Evidence | null;
  readonly pass1Decision: ClosedDecisionEvidence | null;
  readonly currentTransport: CalibrationPassEvidence | null;
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
  | "tuple-selected"
  | "holdout-complete"
  | "smoke-completed"
  | "smoke-skipped"
  | "smoke-failed";

export type CalibrationSmokeResult =
  | {
      readonly status: "completed";
      readonly inputFingerprint: string;
      readonly pass1: CalibrationPass1Evidence;
      readonly pass2: CalibrationPass2Evidence;
      readonly decision: RouterDecision;
    }
  | {
      readonly status: "skipped";
      readonly inputFingerprint: string;
      readonly reason: "calibration-failed" | "holdout-failed" | "budget-insufficient";
    }
  | {
      readonly status: "failed";
      readonly inputFingerprint: string;
      readonly reason: "provider-failure" | "invalid-evidence";
    };

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
    readonly failure: CalibrationFailureEvidence | null;
    readonly evaluations: readonly CalibrationTupleEvaluation[] | null;
    readonly pass: boolean | null;
  };
  readonly selectedTuple: Pass2Thresholds | null;
  readonly holdout: null | {
    readonly denominator: 2;
    readonly cases: readonly CalibrationEvidenceCase[];
    readonly pass: boolean;
  };
  readonly smoke: CalibrationSmokeResult | null;
  readonly accounting: CalibrationAccounting;
}

const writeTemporarySynced = async (path: string, contents: string): Promise<void> => {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const syncParent = async (path: string): Promise<void> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dirname(path), "r");
    await handle.sync();
  } catch {
    // Directory fsync is not supported on every platform/filesystem.
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const writeJsonAtomic = async (path: string, value: unknown): Promise<void> => {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeTemporarySynced(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporaryPath, path);
    await syncParent(path);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // The temporary path may not exist or may already have been renamed.
    }
    throw error;
  }
};

export interface CalibrationReportWriterOptions {
  readonly writeTemporary?: (path: string, contents: string) => Promise<void>;
  readonly beforeWrite?: () => Promise<void>;
}

export const createAtomicCalibrationReportWriter = (
  path: string,
  options: CalibrationReportWriterOptions = {},
) => {
  let claimed = false;
  return async (report: CalibrationReport): Promise<void> => {
    await options.beforeWrite?.();
    if (!claimed) {
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
      let published = false;
      let pathIdentityValid = true;
      try {
        await (options.writeTemporary ?? writeTemporarySynced)(
          temporaryPath,
          `${JSON.stringify(report, null, 2)}\n`,
        );
        await link(temporaryPath, path);
        published = true;
        try {
          await options.beforeWrite?.();
        } catch (error) {
          pathIdentityValid = false;
          throw error;
        }
        await syncParent(path);
      } catch (error) {
        if (pathIdentityValid && published) await unlink(path).catch(() => undefined);
        throw error;
      } finally {
        // Once identity is lost, pathname cleanup could delete unrelated outside data.
        // Preserve the moved-directory evidence for deliberate manual recovery instead.
        if (pathIdentityValid) await unlink(temporaryPath).catch(() => undefined);
      }
      claimed = true;
      return;
    }
    await writeJsonAtomic(path, report);
    await options.beforeWrite?.();
  };
};

export interface CalibrationCheckpointBounds {
  readonly maxAttempts: number;
  readonly spendCapUsd: number;
}

const DEFAULT_CHECKPOINT_BOUNDS: CalibrationCheckpointBounds = {
  maxAttempts: CALIBRATION_MAX_ATTEMPTS,
  spendCapUsd: CALIBRATION_SPEND_CAP_USD,
};

const parseCheckpoint = (
  value: unknown,
  bounds: CalibrationCheckpointBounds,
): CalibrationCheckpoint => {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "corpusFingerprint",
      "phase",
      "accounting",
      "failureReason",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.corpusFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.corpusFingerprint) ||
    !["active", "reserved", "terminal", "complete"].includes(
      value.phase as string,
    ) ||
    !isRecord(value.accounting) ||
    !exactKeys(value.accounting, ["attempts", "spentUsd", "reservedUsd", "terminal"]) ||
    !Number.isInteger(value.accounting.attempts) ||
    (value.accounting.attempts as number) < 0 ||
    (value.accounting.attempts as number) > bounds.maxAttempts ||
    typeof value.accounting.spentUsd !== "number" ||
    !Number.isFinite(value.accounting.spentUsd) ||
    value.accounting.spentUsd < 0 ||
    value.accounting.spentUsd > bounds.spendCapUsd ||
    typeof value.accounting.reservedUsd !== "number" ||
    ![0, CALIBRATION_REQUEST_RESERVE_USD].includes(value.accounting.reservedUsd) ||
    typeof value.accounting.terminal !== "boolean" ||
    !(value.failureReason === null || isCheckpointFailure(value.failureReason))
  ) {
    throw new CalibrationError("invalid-checkpoint");
  }
  const phase = value.phase as CalibrationCheckpoint["phase"];
  const failureReason = value.failureReason as CalibrationCheckpointFailure | null;
  if (
    (phase === "reserved" &&
      value.accounting.reservedUsd !== CALIBRATION_REQUEST_RESERVE_USD) ||
    (["active", "complete"].includes(phase) &&
      value.accounting.reservedUsd !== 0) ||
    (["active", "reserved"].includes(phase) && value.accounting.terminal) ||
    (["terminal", "complete"].includes(phase) && !value.accounting.terminal) ||
    ((phase === "terminal") !== (failureReason !== null))
  ) {
    throw new CalibrationError("invalid-checkpoint");
  }
  return structuredClone(value) as unknown as CalibrationCheckpoint;
};

export const createAtomicCalibrationCheckpointStore = (
  path: string,
  bounds: CalibrationCheckpointBounds = DEFAULT_CHECKPOINT_BOUNDS,
  options?: { readonly resume?: boolean },
): CalibrationCheckpointStore => ({
  claim: async (checkpoint) => {
    if (options?.resume === true) {
      await writeJsonAtomic(path, parseCheckpoint(checkpoint, bounds));
      return true;
    }
    try {
      await writeFile(path, `${JSON.stringify(parseCheckpoint(checkpoint, bounds), null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return true;
    } catch (error) {
      if (isRecord(error) && error.code === "EEXIST") {
        return false;
      }
      throw error;
    }
  },
  write: async (checkpoint) =>
    writeJsonAtomic(path, parseCheckpoint(checkpoint, bounds)),
});

interface CalibrationTransportOptions {
  readonly apiKey: string;
  readonly corpus: CalibrationCorpus;
  readonly fetch: Fetch;
  readonly checkpoint: CalibrationCheckpointStore;
  readonly timeoutMs?: number;
  readonly accounting?: {
    readonly attempts: number;
    readonly spentUsd: number;
  };
  readonly limits?: CalibrationTransportLimits;
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

export const createCalibrationTransport = async (options: CalibrationTransportOptions) => {
  if (options.apiKey.trim().length === 0) {
    throw new CalibrationError("missing-api-key");
  }
  const limits = options.limits ?? CALIBRATION_TRANSPORT_LIMITS;
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
    phase: CalibrationCheckpoint["phase"],
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
  const terminalize = async (reason: CalibrationCheckpointFailure): Promise<void> => {
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
      return fail("runtime-override");
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
      const calibrationError = calibrationErrorFrom(error);
      if (calibrationError?.reason === "checkpoint-failed") {
        throw calibrationError;
      }
      const reason = calibrationError !== null && isCheckpointFailure(calibrationError.reason)
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
      envelope.metadata.inputTokens * CALIBRATION_INPUT_USD_PER_MILLION / 1_000_000 +
      envelope.metadata.outputTokens * CALIBRATION_OUTPUT_USD_PER_MILLION / 1_000_000;
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

type CalibrationTransport = Awaited<ReturnType<typeof createCalibrationTransport>>;

interface RunCalibrationExperimentOptions {
  readonly corpus: CalibrationCorpus;
  readonly smokeInput: RouterInput;
  readonly transport: CalibrationTransport;
  readonly writeReport: (report: CalibrationReport) => Promise<void>;
  readonly env?: NodeJS.ProcessEnv;
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
  env: NodeJS.ProcessEnv,
): Promise<Pass1Result> => {
  try {
    return await new TypeSafeGateway(
      { systemOne: async () => rawEnvelope(result) },
      env,
    ).pass1(input);
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

class CaseCollectionError extends CalibrationError {
  constructor(
    reason: CalibrationDiagnosticReason,
    readonly evidence: CalibrationFailureEvidence,
  ) {
    super(reason);
  }
}

const transportEvidence = (
  result: CalibrationTransportResult,
): CalibrationPassEvidence => ({
  metadata: { ...result.metadata },
  costUsd: result.costUsd,
});

const collectionFailure = (
  caseId: string,
  stage: "pass1" | "pass2",
  reason: CalibrationDiagnosticReason,
  pass1: CalibrationPass1Evidence | null,
  pass1Decision: ClosedDecisionEvidence | null,
  currentTransport: CalibrationPassEvidence | null,
): CaseCollectionError => new CaseCollectionError(reason, {
  caseId,
  stage,
  reason,
  pass1,
  pass1Decision,
  currentTransport,
});

const collectCase = async (
  corpusCase: CalibrationCorpusCase,
  systemOne: CalibrationTransport["systemOne"],
  env: NodeJS.ProcessEnv,
): Promise<CollectedCase> => {
  const checked = precheck(corpusCase.input);
  let pass1Transport: CalibrationTransportResult;
  try {
    pass1Transport = await systemOne(buildPass1Request(checked));
  } catch {
    throw collectionFailure(
      corpusCase.id, "pass1", "invalid-provider-evidence", null, null, null,
    );
  }
  let pass1: Pass1Result;
  try {
    pass1 = await validatePass1(checked, pass1Transport, env);
  } catch {
    throw collectionFailure(
      corpusCase.id,
      "pass1",
      "invalid-provider-evidence",
      null,
      null,
      transportEvidence(pass1Transport),
    );
  }
  const pass1Evidence: CalibrationPass1Evidence = {
    answers: closedAnswers(pass1Transport.answers),
    metadata: { ...pass1Transport.metadata },
    costUsd: pass1Transport.costUsd,
  };
  let preliminary: RouterDecision;
  try {
    preliminary = postcheck(checked, semanticFromPass1(pass1));
  } catch {
    throw collectionFailure(
      corpusCase.id, "pass1", "invalid-pass1-decision", pass1Evidence, null, null,
    );
  }
  const pass1Decision = decisionEvidence(preliminary);
  if (pass1Decision === null) {
    throw collectionFailure(
      corpusCase.id, "pass1", "invalid-pass1-decision", pass1Evidence, null, null,
    );
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
    throw collectionFailure(
      corpusCase.id,
      "pass1",
      "pass1-label-mismatch",
      pass1Evidence,
      pass1Decision,
      null,
    );
  }

  let pass2Transport: CalibrationTransportResult;
  try {
    pass2Transport = await systemOne(
      buildPass2Request(checked, pass1Decision.skillCandidates),
    );
  } catch {
    throw collectionFailure(
      corpusCase.id,
      "pass2",
      "invalid-provider-evidence",
      pass1Evidence,
      pass1Decision,
      null,
    );
  }
  let record: ParsedPass2;
  try {
    record = parsePass2Record(
      pass2Transport.answers,
      checked,
      pass1Decision.skillCandidates,
    );
  } catch {
    throw collectionFailure(
      corpusCase.id,
      "pass2",
      "invalid-provider-evidence",
      pass1Evidence,
      pass1Decision,
      transportEvidence(pass2Transport),
    );
  }

  return {
    checked,
    pass1,
    evidence: {
      caseId: corpusCase.id,
      set: corpusCase.set,
      expected: structuredClone(corpusCase.expected),
      pass1: pass1Evidence,
      pass2: {
        record: structuredClone(record),
        metadata: { ...pass2Transport.metadata },
        costUsd: pass2Transport.costUsd,
      },
      pass1Decision,
    },
  };
};

const collectSmoke = async (
  input: RouterInput,
  systemOne: CalibrationTransport["systemOne"],
  thresholds: Pass2Thresholds,
  env: NodeJS.ProcessEnv,
): Promise<Extract<CalibrationSmokeResult, { status: "completed" }>> => {
  const checked = precheck(input);
  const pass1Transport = await systemOne(buildPass1Request(checked));
  const pass1 = await validatePass1(checked, pass1Transport, env);
  const preliminary = postcheck(checked, semanticFromPass1(pass1));
  if (preliminary.status !== "ok" || preliminary.signals.skillCandidates.length === 0) {
    throw new CalibrationError("invalid-smoke-evidence");
  }

  const pass2Transport = await systemOne(
    buildPass2Request(checked, preliminary.signals.skillCandidates),
  );
  let record: ParsedPass2;
  try {
    record = parsePass2Record(
      pass2Transport.answers,
      checked,
      preliminary.signals.skillCandidates,
    );
  } catch {
    throw new CalibrationError("invalid-smoke-evidence");
  }
  const evaluation = evaluatePass2(record, thresholds);
  const decision: RouterDecision = evaluation.status === "ok"
    ? postcheck(checked, {
      ...semanticFromPass1(pass1),
      skillCandidates: evaluation.skillCandidates,
    })
    : {
      status: "fallback",
      reason: "low-confidence",
      forcedSkillIds: checked.forcedSkillIds,
      protectedContextIds: checked.protectedContextIds,
    };

  return {
    status: "completed",
    inputFingerprint: canonicalFingerprint(input),
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
    decision: structuredClone(decision),
  };
};

const baseReport = (
  phase: CalibrationReportPhase,
  fingerprint: string,
  cases: readonly CalibrationEvidenceCase[],
  accounting: CalibrationAccounting,
  failure: CalibrationFailureEvidence | null = null,
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
    failure,
    evaluations: null,
    pass: null,
  },
  selectedTuple: null,
  holdout: null,
  smoke: null,
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
  const pass1Policy = (options.env ?? process.env)[PASS1_THRESHOLDS_ENV];
  if (parsePass1Thresholds(pass1Policy) === null) {
    throw new CalibrationError("uncalibrated-thresholds");
  }
  const env: NodeJS.ProcessEnv = { [PASS1_THRESHOLDS_ENV]: pass1Policy };
  const guard = createCorpusGuard(options.corpus);
  const smokeGuard = createCorpusGuard(options.smokeInput);
  const corpus = structuredClone(options.corpus);
  const smokeInput = structuredClone(options.smokeInput);
  const fingerprint = guard.fingerprint;
  const assertInputsUnchanged = (): void => {
    guard.assertUnchanged();
    smokeGuard.assertUnchanged();
  };
  const systemOne: CalibrationTransport["systemOne"] = async (request) => {
    assertInputsUnchanged();
    const result = await options.transport.systemOne(request);
    assertInputsUnchanged();
    return result;
  };
  const writeReport = async (report: CalibrationReport): Promise<void> => {
    assertInputsUnchanged();
    await options.writeReport(report);
    assertInputsUnchanged();
  };
  const finish = async (report: CalibrationReport): Promise<CalibrationReport> => {
    assertInputsUnchanged();
    await options.transport.complete();
    assertInputsUnchanged();
    const completed = { ...report, accounting: options.transport.accounting() };
    await writeReport(completed);
    return completed;
  };
  const terminalizeFailure = async (error: unknown): Promise<void> => {
    if (options.transport.accounting().terminal) return;
    const reason = calibrationErrorFrom(error)?.reason === "corpus-mutated"
      ? "corpus-mutated"
      : "post-transport-validation";
    await options.transport.terminalize(reason);
  };

  try {
    assertInputsUnchanged();
    if (
      canonicalFingerprint(corpus) !== fingerprint ||
      canonicalFingerprint(smokeInput) !== smokeGuard.fingerprint ||
      options.transport.fingerprint !== fingerprint
    ) {
      throw new CalibrationError("corpus-fingerprint-mismatch");
    }
    const calibrationCases = corpus.cases.filter(({ set }) => set === "calibration");
    const holdoutCases = corpus.cases.filter(({ set }) => set === "holdout");
    if (calibrationCases.length !== 6 || holdoutCases.length !== 2) {
      throw new CalibrationError("invalid-corpus-size");
    }

    const collectedCalibration: CollectedCase[] = [];
    for (const corpusCase of calibrationCases) {
      try {
        collectedCalibration.push(
          await collectCase(corpusCase, systemOne, env),
        );
      } catch (error) {
        await terminalizeFailure(error);
        const failure = error instanceof CaseCollectionError
          ? error.evidence
          : collectionFailure(
            corpusCase.id,
            "pass1",
            "invalid-provider-evidence",
            null,
            null,
            null,
          ).evidence;
        await writeReport(baseReport(
          "calibration-records",
          fingerprint,
          collectedCalibration.map(({ evidence }) => evidence),
          options.transport.accounting(),
          failure,
        ));
        throw error;
      }
      await writeReport(baseReport(
        "calibration-records",
        fingerprint,
        collectedCalibration.map(({ evidence }) => evidence),
        options.transport.accounting(),
      ));
    }
    const recordReport = baseReport(
      "calibration-records",
      fingerprint,
      collectedCalibration.map(({ evidence }) => evidence),
      options.transport.accounting(),
    );
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
        phase: "smoke-skipped",
        calibration: { ...recordReport.calibration, evaluations, pass: false },
        smoke: {
          status: "skipped",
          inputFingerprint: smokeGuard.fingerprint,
          reason: "calibration-failed",
        },
        accounting: options.transport.accounting(),
      };
      return await finish(failed);
    }

    const selectedTuple: Pass2Thresholds = Object.freeze({ ...selected.thresholds });
    const tupleReport: CalibrationReport = {
      ...recordReport,
      phase: "tuple-selected",
      calibration: { ...recordReport.calibration, evaluations, pass: true },
      selectedTuple,
      accounting: options.transport.accounting(),
    };
    await writeReport(tupleReport);

    const collectedHoldout: CalibrationEvidenceCase[] = [];
    for (const corpusCase of holdoutCases) {
      let collected: CollectedCase;
      try {
        collected = await collectCase(corpusCase, systemOne, env);
      } catch (error) {
        await terminalizeFailure(error);
        const skipped: CalibrationReport = {
          ...tupleReport,
          phase: "smoke-skipped",
          holdout: { denominator: 2, cases: collectedHoldout, pass: false },
          smoke: {
            status: "skipped",
            inputFingerprint: smokeGuard.fingerprint,
            reason: "holdout-failed",
          },
          accounting: options.transport.accounting(),
        };
        await writeReport(skipped);
        return skipped;
      }
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
    const holdoutReport: CalibrationReport = {
      ...tupleReport,
      phase: "holdout-complete",
      holdout: { denominator: 2, cases: collectedHoldout, pass: holdoutPass },
      accounting: options.transport.accounting(),
    };
    if (!holdoutPass) {
      return await finish({
        ...holdoutReport,
        phase: "smoke-skipped",
        smoke: {
          status: "skipped",
          inputFingerprint: smokeGuard.fingerprint,
          reason: "holdout-failed",
        },
      });
    }
    await writeReport(holdoutReport);

    const beforeSmoke = options.transport.accounting();
    if (
      beforeSmoke.reservedUsd !== 0 ||
      beforeSmoke.attempts > CALIBRATION_MAX_ATTEMPTS - 2 ||
      beforeSmoke.spentUsd + 2 * CALIBRATION_REQUEST_RESERVE_USD >
        CALIBRATION_SPEND_CAP_USD
    ) {
      return await finish({
        ...holdoutReport,
        phase: "smoke-skipped",
        smoke: {
          status: "skipped",
          inputFingerprint: smokeGuard.fingerprint,
          reason: "budget-insufficient",
        },
      });
    }

    try {
      const smoke = await collectSmoke(
        smokeInput,
        systemOne,
        selectedTuple,
        env,
      );
      return await finish({
        ...holdoutReport,
        phase: "smoke-completed",
        smoke,
        accounting: options.transport.accounting(),
      });
    } catch (error) {
      const providerFailure = options.transport.accounting().terminal;
      await terminalizeFailure(error);
      const failed: CalibrationReport = {
        ...holdoutReport,
        phase: "smoke-failed",
        smoke: {
          status: "failed",
          inputFingerprint: smokeGuard.fingerprint,
          reason: providerFailure ? "provider-failure" : "invalid-evidence",
        },
        accounting: options.transport.accounting(),
      };
      await writeReport(failed);
      return failed;
    }
  } catch (error) {
    await terminalizeFailure(error);
    throw error;
  }
};
