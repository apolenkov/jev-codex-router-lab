export type TaskType = "explain" | "research" | "plan" | "diagnose" | "change" | "review" | "operate";
export type RiskDimension = "security" | "data-loss" | "public-contract" | "migration" | "user-behavior";
export type FallbackReason = "invalid-input" | "service-error" | "malformed-response" | "stale-decision" | "unknown-id" | "low-confidence";

export const MAX_OPTIONAL_SKILL_CANDIDATES = 3;

export interface RouterInput {
  taskId: string;
  taskRevision: number;
  taskText: string;
  policyVersion: string;
  catalogHash: string;
  explicitSkillIds: readonly string[];
  requiredSkillIds: readonly string[];
  skills: readonly { id: string; description: string; excerpt: string }[];
  criticalGapCandidates?: readonly { id: string; fact: string; blocks: string }[];
  architectureForkCandidates?: readonly { id: string; alternatives: readonly string[]; tradeoff: string }[];
  reuseCandidates?: readonly { id: string; summary: string }[];
  contextFragments?: readonly { id: string; summary: string; protected?: boolean }[];
}

export interface AdvisorySignals {
  taskType: TaskType;
  skillCandidates: readonly string[];
  criticalGap: null | { id: string; fact: string; blocks: string };
  reuseCandidate: string | null;
  architectureFork: null | { id: string; alternatives: readonly string[]; tradeoff: string };
  riskDimensions: Readonly<Record<RiskDimension, number>>;
  contextRelevance: readonly { id: string; probability: number }[];
}

export interface SemanticEcho {
  taskId: string;
  taskRevision: number;
  policyVersion: string;
  catalogHash: string;
}

export interface SemanticResponse extends AdvisorySignals {
  echo: SemanticEcho;
}

export interface PrecheckedInput extends RouterInput {
  forcedSkillIds: readonly string[];
  protectedContextIds: readonly string[];
}

export type RouterDecision =
  | { status: "ok"; signals: AdvisorySignals; forcedSkillIds: readonly string[] }
  | { status: "fallback"; reason: FallbackReason; forcedSkillIds: readonly string[] };
