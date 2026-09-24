import {
  MAX_OPTIONAL_SKILL_CANDIDATES,
  MAX_SEMANTIC_FIELD_CHARS,
  MAX_TASK_TEXT_CHARS,
  type AdvisorySignals,
  type FallbackReason,
  type PrecheckedInput,
  type RiskDimension,
  type RouterDecision,
  type RouterInput,
  type SemanticResponse,
  type TaskType,
} from "./contracts.js";

export class PolicyError extends Error {
  readonly reason: FallbackReason = "invalid-input";

  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

const TASK_TYPES: ReadonlySet<TaskType> = new Set([
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

const ADVISORY_SIGNAL_KEYS: readonly (keyof AdvisorySignals)[] = [
  "taskType",
  "skillCandidates",
  "criticalGap",
  "reuseCandidate",
  "architectureFork",
  "riskDimensions",
  "contextRelevance",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isNonEmptyString = (value: unknown): value is string =>
  isString(value) && value.trim().length > 0;

const isBoundedString = (value: unknown, maxChars: number): value is string =>
  isString(value) && value.length <= maxChars;

const isNonEmptyBoundedString = (value: unknown, maxChars: number): value is string =>
  isNonEmptyString(value) && value.length <= maxChars;

const isProbability = (value: unknown): boolean =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const hasStringId = (value: unknown): value is { id: string } =>
  isRecord(value) && isString(value.id);

const dedupe = (ids: readonly string[]): string[] => [...new Set(ids)];

const requireStringIdArray = (value: unknown, field: string): void => {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    throw new PolicyError(`${field} must be an array of non-empty string ids`);
  }
};

const requireCandidateEntries = (
  value: unknown,
  field: string,
  check: (entry: Record<string, unknown>) => boolean,
): void => {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new PolicyError(`${field} must be an array`);
  }
  for (const entry of value) {
    if (!isRecord(entry) || !check(entry)) {
      throw new PolicyError(`${field} contains an invalid entry`);
    }
  }
};

const requireUniqueIds = (ids: readonly string[], field: string): void => {
  if (new Set(ids).size !== ids.length) {
    throw new PolicyError(`${field} contains duplicate ids`);
  }
};

export function precheck(input: RouterInput): PrecheckedInput {
  if (!isRecord(input)) {
    throw new PolicyError("input must be an object");
  }
  if (
    !isNonEmptyString(input.taskId) ||
    !isNonEmptyString(input.policyVersion) ||
    !isNonEmptyString(input.catalogHash)
  ) {
    throw new PolicyError("taskId, policyVersion, and catalogHash must be non-empty strings");
  }
  if (!isNonEmptyBoundedString(input.taskText, MAX_TASK_TEXT_CHARS)) {
    throw new PolicyError(
      `taskText must be a non-empty string of at most ${MAX_TASK_TEXT_CHARS} UTF-16 code units`,
    );
  }
  if (!Number.isInteger(input.taskRevision) || input.taskRevision < 1) {
    throw new PolicyError("taskRevision must be a positive integer");
  }
  requireStringIdArray(input.explicitSkillIds, "explicitSkillIds");
  requireStringIdArray(input.requiredSkillIds, "requiredSkillIds");
  if (!Array.isArray(input.skills)) {
    throw new PolicyError("skills catalogue must be an array");
  }

  const catalogIds = new Set<string>();
  for (const skill of input.skills) {
    if (!isRecord(skill) || !isNonEmptyString(skill.id)) {
      throw new PolicyError("skills catalogue entries must be objects with a non-empty string id");
    }
    if (
      !isBoundedString(skill.description, MAX_SEMANTIC_FIELD_CHARS) ||
      !isBoundedString(skill.excerpt, MAX_SEMANTIC_FIELD_CHARS)
    ) {
      throw new PolicyError(
        `skills catalogue entry ${skill.id} must have description and excerpt of at most ${MAX_SEMANTIC_FIELD_CHARS} UTF-16 code units`,
      );
    }
    if (catalogIds.has(skill.id)) {
      throw new PolicyError(`skills catalogue contains duplicate id ${skill.id}`);
    }
    catalogIds.add(skill.id);
  }

  for (const id of [...input.explicitSkillIds, ...input.requiredSkillIds]) {
    if (!catalogIds.has(id)) {
      throw new PolicyError(`mandatory skill ${id} is not in the catalogue allowlist`);
    }
  }

  requireCandidateEntries(input.criticalGapCandidates, "criticalGapCandidates", (entry) =>
    isNonEmptyString(entry.id) &&
    isBoundedString(entry.fact, MAX_SEMANTIC_FIELD_CHARS) &&
    isBoundedString(entry.blocks, MAX_SEMANTIC_FIELD_CHARS),
  );
  requireCandidateEntries(input.architectureForkCandidates, "architectureForkCandidates", (entry) =>
    isNonEmptyString(entry.id) &&
    Array.isArray(entry.alternatives) &&
    entry.alternatives.every((alternative) =>
      isBoundedString(alternative, MAX_SEMANTIC_FIELD_CHARS)) &&
    isBoundedString(entry.tradeoff, MAX_SEMANTIC_FIELD_CHARS),
  );
  requireCandidateEntries(input.reuseCandidates, "reuseCandidates", (entry) =>
    isNonEmptyString(entry.id) && isBoundedString(entry.summary, MAX_SEMANTIC_FIELD_CHARS),
  );
  requireCandidateEntries(input.contextFragments, "contextFragments", (entry) =>
    isNonEmptyString(entry.id) &&
    isBoundedString(entry.summary, MAX_SEMANTIC_FIELD_CHARS) &&
    (entry.protected === undefined || typeof entry.protected === "boolean"),
  );

  requireUniqueIds((input.criticalGapCandidates ?? []).map((c) => c.id), "criticalGapCandidates");
  requireUniqueIds((input.architectureForkCandidates ?? []).map((c) => c.id), "architectureForkCandidates");
  requireUniqueIds((input.reuseCandidates ?? []).map((c) => c.id), "reuseCandidates");
  requireUniqueIds((input.contextFragments ?? []).map((c) => c.id), "contextFragments");

  const forcedSkillIds = dedupe([...input.explicitSkillIds, ...input.requiredSkillIds]);
  const protectedContextIds = (input.contextFragments ?? [])
    .filter((fragment) => fragment.protected === true)
    .map((fragment) => fragment.id);

  return { ...input, forcedSkillIds, protectedContextIds };
}

const fallback = (reason: FallbackReason, input: PrecheckedInput): RouterDecision => ({
  status: "fallback",
  reason,
  forcedSkillIds: input.forcedSkillIds,
  protectedContextIds: input.protectedContextIds,
});

export function postcheck(input: PrecheckedInput, semantic: SemanticResponse): RouterDecision {
  const forcedSkillIds = input.forcedSkillIds;

  if (
    !isRecord(semantic) ||
    ADVISORY_SIGNAL_KEYS.some((key) => !Object.hasOwn(semantic, key)) ||
    !isString(semantic.taskType) ||
    !TASK_TYPES.has(semantic.taskType) ||
    !Array.isArray(semantic.skillCandidates) ||
    !semantic.skillCandidates.every(isString) ||
    !Array.isArray(semantic.contextRelevance) ||
    !isRecord(semantic.riskDimensions) ||
    RISK_DIMENSIONS.some((dimension) => !isProbability(semantic.riskDimensions[dimension])) ||
    semantic.contextRelevance.some(
      (entry) => !isRecord(entry) || !isString(entry.id) || !isProbability(entry.probability),
    ) ||
    !(semantic.criticalGap === null || hasStringId(semantic.criticalGap)) ||
    !(semantic.architectureFork === null || hasStringId(semantic.architectureFork)) ||
    !(semantic.reuseCandidate === null || isString(semantic.reuseCandidate)) ||
    !isRecord(semantic.echo)
  ) {
    return fallback("malformed-response", input);
  }

  if (
    semantic.echo.taskId !== input.taskId ||
    semantic.echo.taskRevision !== input.taskRevision ||
    semantic.echo.policyVersion !== input.policyVersion ||
    semantic.echo.catalogHash !== input.catalogHash
  ) {
    return fallback("stale-decision", input);
  }

  const catalogIds = new Set(input.skills.map((skill) => skill.id));
  if (semantic.skillCandidates.some((id) => !catalogIds.has(id))) {
    return fallback("unknown-id", input);
  }

  const gapById = new Map((input.criticalGapCandidates ?? []).map((c) => [c.id, c]));
  const forkById = new Map((input.architectureForkCandidates ?? []).map((c) => [c.id, c]));
  const reuseById = new Map((input.reuseCandidates ?? []).map((c) => [c.id, c]));
  const fragmentById = new Map(
    (input.contextFragments ?? [])
      .filter((fragment) => fragment.protected !== true)
      .map((fragment) => [fragment.id, fragment]),
  );

  if (
    (semantic.criticalGap != null && !gapById.has(semantic.criticalGap.id)) ||
    (semantic.architectureFork != null && !forkById.has(semantic.architectureFork.id)) ||
    (semantic.reuseCandidate != null && !reuseById.has(semantic.reuseCandidate)) ||
    semantic.contextRelevance.some((entry) => !fragmentById.has(entry.id))
  ) {
    return fallback("unknown-id", input);
  }

  if (
    new Set(semantic.skillCandidates).size !== semantic.skillCandidates.length ||
    new Set(semantic.contextRelevance.map((entry) => entry.id)).size !==
      semantic.contextRelevance.length
  ) {
    return fallback("malformed-response", input);
  }

  const forced = new Set(forcedSkillIds);
  const optionalSkillIds = semantic.skillCandidates.filter((id) => !forced.has(id));
  if (optionalSkillIds.length > MAX_OPTIONAL_SKILL_CANDIDATES) {
    return fallback("malformed-response", input);
  }

  const criticalGap =
    semantic.criticalGap == null ? null : gapById.get(semantic.criticalGap.id)!;
  const architectureFork =
    semantic.architectureFork == null ? null : forkById.get(semantic.architectureFork.id)!;

  const signals: AdvisorySignals = {
    taskType: semantic.taskType,
    skillCandidates: optionalSkillIds,
    criticalGap: criticalGap ? { id: criticalGap.id, fact: criticalGap.fact, blocks: criticalGap.blocks } : null,
    reuseCandidate: semantic.reuseCandidate,
    architectureFork: architectureFork
      ? { id: architectureFork.id, alternatives: architectureFork.alternatives, tradeoff: architectureFork.tradeoff }
      : null,
    riskDimensions: {
      security: semantic.riskDimensions.security,
      "data-loss": semantic.riskDimensions["data-loss"],
      "public-contract": semantic.riskDimensions["public-contract"],
      migration: semantic.riskDimensions.migration,
      "user-behavior": semantic.riskDimensions["user-behavior"],
    },
    contextRelevance: semantic.contextRelevance.map((entry) => ({
      id: entry.id,
      probability: entry.probability,
    })),
  };

  return {
    status: "ok",
    signals,
    forcedSkillIds,
    protectedContextIds: input.protectedContextIds,
  };
}
