import {
  MAX_OPTIONAL_SKILL_CANDIDATES,
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

const isNonEmpty = (value: string): boolean => value.trim().length > 0;

const isProbability = (value: number): boolean =>
  Number.isFinite(value) && value >= 0 && value <= 1;

const dedupe = (ids: readonly string[]): string[] => [...new Set(ids)];

const requireUniqueIds = (ids: readonly string[], field: string): void => {
  for (const id of ids) {
    if (!isNonEmpty(id)) {
      throw new PolicyError(`${field} contains an empty id`);
    }
  }
  if (new Set(ids).size !== ids.length) {
    throw new PolicyError(`${field} contains duplicate ids`);
  }
};

export function precheck(input: RouterInput): PrecheckedInput {
  if (
    !isNonEmpty(input.taskId) ||
    !isNonEmpty(input.taskText) ||
    !isNonEmpty(input.policyVersion) ||
    !isNonEmpty(input.catalogHash)
  ) {
    throw new PolicyError("taskId, taskText, policyVersion, and catalogHash must be non-empty");
  }
  if (!Number.isInteger(input.taskRevision) || input.taskRevision < 1) {
    throw new PolicyError("taskRevision must be a positive integer");
  }
  if (!Array.isArray(input.skills)) {
    throw new PolicyError("skills catalogue must be an array");
  }

  const catalogIds = new Set<string>();
  for (const skill of input.skills) {
    if (!isNonEmpty(skill.id)) {
      throw new PolicyError("skills catalogue contains an empty id");
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

const fallback = (reason: FallbackReason, forcedSkillIds: readonly string[]): RouterDecision => ({
  status: "fallback",
  reason,
  forcedSkillIds,
});

export function postcheck(input: PrecheckedInput, semantic: SemanticResponse): RouterDecision {
  const forcedSkillIds = input.forcedSkillIds;

  if (
    typeof semantic.taskType !== "string" ||
    !TASK_TYPES.has(semantic.taskType) ||
    !Array.isArray(semantic.skillCandidates) ||
    !Array.isArray(semantic.contextRelevance) ||
    typeof semantic.riskDimensions !== "object" ||
    semantic.riskDimensions === null ||
    RISK_DIMENSIONS.some((dimension) => !isProbability(semantic.riskDimensions[dimension])) ||
    semantic.contextRelevance.some(
      (entry) => typeof entry !== "object" || entry === null || !isProbability(entry.probability),
    ) ||
    typeof semantic.echo !== "object" ||
    semantic.echo === null
  ) {
    return fallback("malformed-response", forcedSkillIds);
  }

  if (
    semantic.echo.taskId !== input.taskId ||
    semantic.echo.taskRevision !== input.taskRevision ||
    semantic.echo.policyVersion !== input.policyVersion ||
    semantic.echo.catalogHash !== input.catalogHash
  ) {
    return fallback("stale-decision", forcedSkillIds);
  }

  const catalogIds = new Set(input.skills.map((skill) => skill.id));
  if (semantic.skillCandidates.some((id) => !catalogIds.has(id))) {
    return fallback("unknown-id", forcedSkillIds);
  }

  const gapById = new Map((input.criticalGapCandidates ?? []).map((c) => [c.id, c]));
  const forkById = new Map((input.architectureForkCandidates ?? []).map((c) => [c.id, c]));
  const reuseById = new Map((input.reuseCandidates ?? []).map((c) => [c.id, c]));
  const fragmentById = new Map((input.contextFragments ?? []).map((c) => [c.id, c]));

  if (
    (semantic.criticalGap != null && !gapById.has(semantic.criticalGap.id)) ||
    (semantic.architectureFork != null && !forkById.has(semantic.architectureFork.id)) ||
    (semantic.reuseCandidate != null && !reuseById.has(semantic.reuseCandidate)) ||
    semantic.contextRelevance.some((entry) => !fragmentById.has(entry.id))
  ) {
    return fallback("unknown-id", forcedSkillIds);
  }

  if (
    new Set(semantic.skillCandidates).size !== semantic.skillCandidates.length ||
    new Set(semantic.contextRelevance.map((entry) => entry.id)).size !==
      semantic.contextRelevance.length
  ) {
    return fallback("malformed-response", forcedSkillIds);
  }

  const forced = new Set(forcedSkillIds);
  const optionalSkillIds = semantic.skillCandidates.filter((id) => !forced.has(id));
  if (optionalSkillIds.length > MAX_OPTIONAL_SKILL_CANDIDATES) {
    return fallback("malformed-response", forcedSkillIds);
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
    riskDimensions: semantic.riskDimensions,
    contextRelevance: semantic.contextRelevance,
  };

  return { status: "ok", signals, forcedSkillIds };
}
