import type { ArenaContestantId } from "./arena-contracts.js";
import {
  normalizeArenaResult,
  type ArenaCase,
  type ArenaContestantInput,
  type ArenaResult,
  type ArenaSkillManifest,
} from "./arena-contracts.js";
import {
  MAX_OPTIONAL_SKILL_CANDIDATES,
  type FallbackReason,
  type PrecheckedInput,
  type RiskDimension,
  type RouterInput,
  type TaskType,
} from "./contracts.js";
import { routeWithTelemetry, type RouteTelemetry } from "./router.js";
import {
  SemanticGatewayError,
  type Pass1Result,
  type Pass2Result,
  type SemanticGateway,
} from "./semantic-gateway.js";

export const ARENA_TASK_REVISION = 1;
export const ARENA_POLICY_VERSION = "arena-dev-v1";

export interface ArenaContestant {
  readonly id: ArenaContestantId;
  run(input: ArenaContestantInput): Promise<ArenaResult>;
}

export class ArenaReplayError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ArenaReplayError";
  }
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

const RISK_DIMENSION_KEYS: readonly RiskDimension[] = [
  "security",
  "data-loss",
  "public-contract",
  "migration",
  "user-behavior",
];

const FALLBACK_REASONS: ReadonlySet<string> = new Set([
  "invalid-input",
  "service-error",
  "malformed-response",
  "stale-decision",
  "unknown-id",
  "low-confidence",
  "uncalibrated-thresholds",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isUnique = (ids: readonly string[]): boolean => new Set(ids).size === ids.length;

const isProbability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const isNonNegativeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

export function arenaContestantInput(
  arenaCase: ArenaCase,
  manifest: ArenaSkillManifest,
): ArenaContestantInput {
  return {
    caseId: arenaCase.id,
    taskText: arenaCase.taskText,
    skills: manifest.skills,
    explicitSkillIds: arenaCase.explicitSkillIds,
    requiredSkillIds: arenaCase.requiredSkillIds,
  };
}

export function toArenaRouterInput(
  input: ArenaContestantInput,
  manifestFingerprint: string,
): RouterInput {
  return {
    taskId: input.caseId,
    taskRevision: ARENA_TASK_REVISION,
    taskText: input.taskText,
    policyVersion: ARENA_POLICY_VERSION,
    catalogHash: manifestFingerprint,
    explicitSkillIds: input.explicitSkillIds,
    requiredSkillIds: input.requiredSkillIds,
    skills: input.skills.map(({ id, description, excerpt }) => ({ id, description, excerpt })),
    criticalGapCandidates: [],
    architectureForkCandidates: [],
    reuseCandidates: [],
    contextFragments: [],
  };
}

interface ObservedTelemetry {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number | null;
  readonly costUsd: number | null;
}

// Only pass metadata recorded by the provider counts as observed. Passes that
// failed before an envelope was parsed contribute wall-clock latency, which is
// not a recorded observation and would break byte-identical runs, so they are
// excluded. Cost is never observed in the arena and stays null.
const summarizeTelemetry = (telemetry: RouteTelemetry): ObservedTelemetry => {
  let inputTokens = 0;
  let outputTokens = 0;
  let latencyMs = 0;
  let observed = false;
  for (const pass of telemetry.passes) {
    if (typeof pass.model !== "string") {
      continue;
    }
    observed = true;
    inputTokens += pass.inputTokens ?? 0;
    outputTokens += pass.outputTokens ?? 0;
    latencyMs += pass.latencyMs;
  }
  return {
    inputTokens: observed ? inputTokens : null,
    outputTokens: observed ? outputTokens : null,
    latencyMs: observed ? latencyMs : null,
    costUsd: null,
  };
};

export function createJevContestant(options: {
  gateway: SemanticGateway;
  manifestFingerprint: string;
}): ArenaContestant {
  const gateway = options?.gateway;
  if (
    gateway === null ||
    typeof gateway !== "object" ||
    typeof gateway.pass1 !== "function" ||
    typeof gateway.pass2 !== "function"
  ) {
    throw new Error("jev-gateway-required");
  }
  if (!isNonEmptyString(options?.manifestFingerprint)) {
    throw new Error("jev-manifest-fingerprint-required");
  }
  const manifestFingerprint = options.manifestFingerprint;
  return {
    id: "jev",
    async run(input: ArenaContestantInput): Promise<ArenaResult> {
      let execution;
      try {
        execution = await routeWithTelemetry(toArenaRouterInput(input, manifestFingerprint), gateway);
      } catch {
        return normalizeArenaResult(
          { contestantId: "jev", status: "error", reason: "adapter-failure" },
          input,
        );
      }
      const telemetry = summarizeTelemetry(execution.telemetry);
      const { decision } = execution;
      if (decision.status === "fallback") {
        return normalizeArenaResult(
          {
            contestantId: "jev",
            status: "abstain",
            reason: decision.reason,
            ...telemetry,
          },
          input,
        );
      }
      return normalizeArenaResult(
        {
          contestantId: "jev",
          status: "ok",
          selectedSkillIds: [...decision.forcedSkillIds, ...decision.signals.skillCandidates],
          ...telemetry,
        },
        input,
      );
    },
  };
}

interface ReplayMetadata {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
}

type ReplayPass1 =
  | {
      readonly kind: "ok";
      readonly taskType: TaskType;
      readonly skillCandidates: readonly string[];
      readonly riskDimensions: Readonly<Record<RiskDimension, number>>;
      readonly metadata: ReplayMetadata;
    }
  | { readonly kind: "error"; readonly reason: FallbackReason; readonly metadata?: ReplayMetadata };

type ReplayPass2 =
  | {
      readonly kind: "ok";
      readonly shortlist: readonly string[];
      readonly skillCandidates: readonly string[];
      readonly metadata: ReplayMetadata;
    }
  | {
      readonly kind: "error";
      readonly shortlist: readonly string[];
      readonly reason: FallbackReason;
      readonly metadata?: ReplayMetadata;
    };

interface ReplayRecord {
  readonly pass1: ReplayPass1;
  readonly pass2?: ReplayPass2;
}

const parseReplayMetadata = (value: unknown): ReplayMetadata => {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["model", "inputTokens", "outputTokens", "latencyMs"]) ||
    !isNonEmptyString(value.model) ||
    !isNonNegativeInteger(value.inputTokens) ||
    !isNonNegativeInteger(value.outputTokens) ||
    !isNonNegativeNumber(value.latencyMs)
  ) {
    throw new ArenaReplayError("invalid-replay-metadata");
  }
  return {
    model: value.model,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    latencyMs: value.latencyMs,
  };
};

const optionalReplayMetadata = (
  value: Record<string, unknown>,
): { metadata?: ReplayMetadata } =>
  Object.hasOwn(value, "metadata") ? { metadata: parseReplayMetadata(value.metadata) } : {};

const parseReplayReason = (value: unknown): FallbackReason => {
  if (typeof value !== "string" || !FALLBACK_REASONS.has(value)) {
    throw new ArenaReplayError("invalid-replay-reason");
  }
  return value as FallbackReason;
};

const parseShortlist = (value: unknown): readonly string[] => {
  if (
    !isStringArray(value) ||
    value.length === 0 ||
    value.length > MAX_OPTIONAL_SKILL_CANDIDATES ||
    !value.every(isNonEmptyString) ||
    !isUnique(value)
  ) {
    throw new ArenaReplayError("invalid-replay-shortlist");
  }
  return [...value];
};

const parseReplayPass1 = (value: unknown): ReplayPass1 => {
  if (!isRecord(value)) {
    throw new ArenaReplayError("invalid-replay-pass1");
  }
  if (Object.hasOwn(value, "error")) {
    if (!exactKeys(value, ["error"]) && !exactKeys(value, ["error", "metadata"])) {
      throw new ArenaReplayError("invalid-replay-pass1");
    }
    const parsed: ReplayPass1 = {
      kind: "error",
      reason: parseReplayReason(value.error),
      ...optionalReplayMetadata(value),
    };
    return parsed;
  }
  if (
    !exactKeys(value, [
      "taskType",
      "skillCandidates",
      "criticalGap",
      "reuseCandidate",
      "architectureFork",
      "riskDimensions",
      "contextRelevance",
      "metadata",
    ]) ||
    typeof value.taskType !== "string" ||
    !TASK_TYPES.has(value.taskType) ||
    !isStringArray(value.skillCandidates) ||
    !value.skillCandidates.every(isNonEmptyString) ||
    !isUnique(value.skillCandidates) ||
    value.criticalGap !== null ||
    value.reuseCandidate !== null ||
    value.architectureFork !== null ||
    !isRecord(value.riskDimensions) ||
    !exactKeys(value.riskDimensions, [...RISK_DIMENSION_KEYS]) ||
    !Array.isArray(value.contextRelevance) ||
    value.contextRelevance.length !== 0
  ) {
    throw new ArenaReplayError("invalid-replay-pass1");
  }
  const riskDimensions = value.riskDimensions;
  if (
    RISK_DIMENSION_KEYS.some((dimension) => !isProbability(riskDimensions[dimension]))
  ) {
    throw new ArenaReplayError("invalid-replay-pass1");
  }
  const parsedDimensions = {} as Record<RiskDimension, number>;
  for (const dimension of RISK_DIMENSION_KEYS) {
    parsedDimensions[dimension] = riskDimensions[dimension] as number;
  }
  return {
    kind: "ok",
    taskType: value.taskType as TaskType,
    skillCandidates: [...value.skillCandidates],
    riskDimensions: parsedDimensions,
    metadata: parseReplayMetadata(value.metadata),
  };
};

const parseReplayPass2 = (value: unknown): ReplayPass2 => {
  if (!isRecord(value)) {
    throw new ArenaReplayError("invalid-replay-pass2");
  }
  if (Object.hasOwn(value, "error")) {
    if (
      !exactKeys(value, ["shortlist", "error"]) &&
      !exactKeys(value, ["shortlist", "error", "metadata"])
    ) {
      throw new ArenaReplayError("invalid-replay-pass2");
    }
    const parsed: ReplayPass2 = {
      kind: "error",
      shortlist: parseShortlist(value.shortlist),
      reason: parseReplayReason(value.error),
      ...optionalReplayMetadata(value),
    };
    return parsed;
  }
  if (
    !exactKeys(value, ["shortlist", "skillCandidates", "metadata"]) ||
    !isStringArray(value.skillCandidates) ||
    !value.skillCandidates.every(isNonEmptyString) ||
    !isUnique(value.skillCandidates) ||
    value.skillCandidates.length > MAX_OPTIONAL_SKILL_CANDIDATES
  ) {
    throw new ArenaReplayError("invalid-replay-pass2");
  }
  const shortlist = parseShortlist(value.shortlist);
  const shortlistIds = new Set(shortlist);
  if (value.skillCandidates.some((id) => !shortlistIds.has(id))) {
    throw new ArenaReplayError("invalid-replay-pass2");
  }
  return {
    kind: "ok",
    shortlist,
    skillCandidates: [...value.skillCandidates],
    metadata: parseReplayMetadata(value.metadata),
  };
};

const parseReplayFixture = (fixture: unknown): Map<string, ReplayRecord> => {
  if (
    !isRecord(fixture) ||
    !exactKeys(fixture, ["schemaVersion", "records"]) ||
    fixture.schemaVersion !== 1 ||
    !isRecord(fixture.records)
  ) {
    throw new ArenaReplayError("invalid-replay-fixture");
  }
  const records = new Map<string, ReplayRecord>();
  for (const [caseId, entry] of Object.entries(fixture.records)) {
    if (
      !isNonEmptyString(caseId) ||
      !isRecord(entry) ||
      (!exactKeys(entry, ["pass1"]) && !exactKeys(entry, ["pass1", "pass2"]))
    ) {
      throw new ArenaReplayError("invalid-replay-record");
    }
    const record: ReplayRecord = { pass1: parseReplayPass1(entry.pass1) };
    if (Object.hasOwn(entry, "pass2")) {
      if (record.pass1.kind !== "ok") {
        throw new ArenaReplayError("invalid-replay-record");
      }
      records.set(caseId, { ...record, pass2: parseReplayPass2(entry.pass2) });
      continue;
    }
    records.set(caseId, record);
  }
  return records;
};

export function createJevReplayGateway(fixture: unknown): SemanticGateway {
  const records = parseReplayFixture(fixture);
  const entryFor = (input: PrecheckedInput): ReplayRecord => {
    const record = records.get(input.taskId);
    if (record === undefined) {
      throw new ArenaReplayError("replay-unexpected-case");
    }
    return record;
  };
  return {
    async pass1(input: PrecheckedInput): Promise<Pass1Result> {
      const record = entryFor(input).pass1;
      if (record.kind === "error") {
        throw new SemanticGatewayError(record.reason, record.metadata);
      }
      return {
        echo: {
          taskId: input.taskId,
          taskRevision: input.taskRevision,
          policyVersion: input.policyVersion,
          catalogHash: input.catalogHash,
        },
        taskType: record.taskType,
        skillCandidates: record.skillCandidates,
        criticalGap: null,
        reuseCandidate: null,
        architectureFork: null,
        riskDimensions: record.riskDimensions,
        contextRelevance: [],
        metadata: record.metadata,
      };
    },
    async pass2(input: PrecheckedInput, shortlist: readonly string[]): Promise<Pass2Result> {
      const record = entryFor(input).pass2;
      if (record === undefined) {
        throw new ArenaReplayError("replay-unexpected-pass");
      }
      if (
        record.shortlist.length !== shortlist.length ||
        record.shortlist.some((id, index) => id !== shortlist[index])
      ) {
        throw new ArenaReplayError("replay-unexpected-shortlist");
      }
      if (record.kind === "error") {
        throw new SemanticGatewayError(record.reason, record.metadata);
      }
      return {
        skillCandidates: record.skillCandidates,
        metadata: record.metadata,
      };
    },
  };
}

interface CodexFixtureRecord {
  readonly status: "ok" | "abstain" | "error";
  readonly selectedSkillIds: readonly string[];
  readonly reason: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number | null;
  readonly costUsd: number | null;
}

const isNullableInteger = (value: unknown): value is number | null =>
  value === null || isNonNegativeInteger(value);

const isNullableAmount = (value: unknown): value is number | null =>
  value === null || isNonNegativeNumber(value);

// Returns the validated record, or null when the record is malformed. A null
// marker is kept in the index so a malformed record yields a per-case error
// result instead of failing the whole fixture at construction.
const parseCodexRecord = (value: unknown): CodexFixtureRecord | null => {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "status",
      "selectedSkillIds",
      "reason",
      "inputTokens",
      "outputTokens",
      "latencyMs",
      "costUsd",
    ]) ||
    (value.status !== "ok" && value.status !== "abstain" && value.status !== "error") ||
    !isStringArray(value.selectedSkillIds) ||
    !value.selectedSkillIds.every(isNonEmptyString)
  ) {
    return null;
  }
  if (value.status === "ok") {
    if (value.reason !== null) {
      return null;
    }
  } else if (!isNonEmptyString(value.reason) || value.selectedSkillIds.length !== 0) {
    return null;
  }
  if (
    !isNullableInteger(value.inputTokens) ||
    !isNullableInteger(value.outputTokens) ||
    !isNullableAmount(value.latencyMs) ||
    !isNullableAmount(value.costUsd)
  ) {
    return null;
  }
  return {
    status: value.status,
    selectedSkillIds: [...value.selectedSkillIds],
    reason: value.reason as string | null,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    latencyMs: value.latencyMs,
    costUsd: value.costUsd,
  };
};

export function createCodexFixtureContestant(
  fixture: unknown,
  manifest: ArenaSkillManifest,
): ArenaContestant {
  if (
    !isRecord(fixture) ||
    !exactKeys(fixture, ["schemaVersion", "records"]) ||
    fixture.schemaVersion !== 1 ||
    !isRecord(fixture.records)
  ) {
    throw new Error("invalid-codex-fixture");
  }
  if (!isRecord(manifest) || !Array.isArray(manifest.skills) || manifest.skills.length === 0) {
    throw new Error("invalid-arena-manifest");
  }
  const records = new Map<string, CodexFixtureRecord | null>();
  for (const [caseId, value] of Object.entries(fixture.records)) {
    if (!isNonEmptyString(caseId)) {
      throw new Error("invalid-codex-fixture");
    }
    records.set(caseId, parseCodexRecord(value));
  }
  return {
    id: "codex",
    async run(input: ArenaContestantInput): Promise<ArenaResult> {
      const entry = records.get(input.caseId);
      if (entry === undefined) {
        return normalizeArenaResult(
          { contestantId: "codex", status: "error", reason: "missing-record" },
          input,
        );
      }
      if (entry === null) {
        return normalizeArenaResult(
          { contestantId: "codex", status: "error", reason: "malformed-record" },
          input,
        );
      }
      return normalizeArenaResult({ contestantId: "codex", ...entry }, input);
    },
  };
}
