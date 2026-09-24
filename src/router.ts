import type {
  FallbackReason,
  PrecheckedInput,
  RouterDecision,
  RouterInput,
  SemanticResponse,
} from "./contracts.js";
import { PolicyError, postcheck, precheck } from "./policy.js";
import {
  SemanticGatewayError,
  type Pass1Result,
  type PassMetadata,
  type SemanticGateway,
} from "./semantic-gateway.js";

export type GatewayPass = "pass1" | "pass2";

export interface PassTelemetry {
  pass: GatewayPass;
  latencyMs: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  retryCount?: number;
}

export interface RouteTelemetry {
  passes: readonly PassTelemetry[];
  totalLatencyMs: number;
}

export interface RouteExecution {
  decision: RouterDecision;
  telemetry: RouteTelemetry;
}

const FALLBACK_REASONS: ReadonlySet<FallbackReason> = new Set([
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

const isNonNegativeFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const elapsed = (started: number): number =>
  Math.max(0, performance.now() - started);

const fallback = (
  reason: FallbackReason,
  forcedSkillIds: readonly string[],
  protectedContextIds: readonly string[],
): RouterDecision => ({ status: "fallback", reason, forcedSkillIds, protectedContextIds });

const forcedSkillsFrom = (input: unknown): readonly string[] => {
  if (!isRecord(input)) {
    return [];
  }
  const explicit = Array.isArray(input.explicitSkillIds)
    ? input.explicitSkillIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  const required = Array.isArray(input.requiredSkillIds)
    ? input.requiredSkillIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  return [...new Set([...explicit, ...required])];
};

const protectedContextsFrom = (input: unknown): readonly string[] => {
  if (!isRecord(input) || !Array.isArray(input.contextFragments)) {
    return [];
  }
  const ids: string[] = [];
  for (const fragment of input.contextFragments) {
    if (
      isRecord(fragment) &&
      fragment.protected === true &&
      typeof fragment.id === "string" &&
      fragment.id.trim().length > 0
    ) {
      ids.push(fragment.id);
    }
  }
  return [...new Set(ids)];
};

const reasonFrom = (error: unknown): FallbackReason => {
  if (
    error instanceof SemanticGatewayError &&
    FALLBACK_REASONS.has(error.reason)
  ) {
    return error.reason;
  }
  return "service-error";
};

const semanticFrom = (result: Pass1Result): SemanticResponse => ({
  echo: result.echo,
  taskType: result.taskType,
  skillCandidates: result.skillCandidates,
  criticalGap: result.criticalGap,
  reuseCandidate: result.reuseCandidate,
  architectureFork: result.architectureFork,
  riskDimensions: result.riskDimensions,
  contextRelevance: result.contextRelevance,
});

const passTelemetry = (
  pass: GatewayPass,
  value: unknown,
): PassTelemetry => {
  if (!isRecord(value) || !isRecord(value.metadata)) {
    throw new SemanticGatewayError("malformed-response");
  }
  const metadata = value.metadata as Record<string, unknown> & Partial<PassMetadata>;
  if (
    typeof metadata.model !== "string" ||
    metadata.model.trim().length === 0 ||
    !Number.isInteger(metadata.inputTokens) ||
    !isNonNegativeFinite(metadata.inputTokens) ||
    !Number.isInteger(metadata.outputTokens) ||
    !isNonNegativeFinite(metadata.outputTokens) ||
    !isNonNegativeFinite(metadata.latencyMs)
  ) {
    throw new SemanticGatewayError("malformed-response");
  }

  const base: PassTelemetry = {
    pass,
    model: metadata.model,
    inputTokens: metadata.inputTokens,
    outputTokens: metadata.outputTokens,
    latencyMs: metadata.latencyMs,
  };
  if (!Object.hasOwn(metadata, "retryCount")) {
    return base;
  }
  if (!Number.isInteger(metadata.retryCount) || !isNonNegativeFinite(metadata.retryCount)) {
    throw new SemanticGatewayError("malformed-response");
  }
  return { ...base, retryCount: metadata.retryCount };
};

const callPass = async <T>(
  pass: GatewayPass,
  operation: () => Promise<T>,
  observations: PassTelemetry[],
): Promise<T> => {
  const started = performance.now();
  try {
    const result = await operation();
    observations.push(passTelemetry(pass, result));
    return result;
  } catch (error) {
    observations.push(
      error instanceof SemanticGatewayError && error.metadata !== undefined
        ? passTelemetry(pass, { metadata: error.metadata })
        : { pass, latencyMs: elapsed(started) },
    );
    throw error;
  }
};

const finish = (
  decision: RouterDecision,
  passes: readonly PassTelemetry[],
  started: number,
): RouteExecution => ({
  decision,
  telemetry: { passes, totalLatencyMs: elapsed(started) },
});

export async function routeWithTelemetry(
  input: RouterInput,
  gateway: SemanticGateway,
): Promise<RouteExecution> {
  const started = performance.now();
  const passes: PassTelemetry[] = [];
  let checked: PrecheckedInput;

  try {
    checked = precheck(input);
  } catch (error) {
    const reason = error instanceof PolicyError ? "invalid-input" : "service-error";
    return finish(
      fallback(reason, forcedSkillsFrom(input), protectedContextsFrom(input)),
      passes,
      started,
    );
  }

  try {
    const first = await callPass("pass1", () => gateway.pass1(checked), passes);
    const firstSemantic = semanticFrom(first);
    const preliminary = postcheck(checked, firstSemantic);
    if (preliminary.status === "fallback") {
      return finish(preliminary, passes, started);
    }

    const shortlist = preliminary.signals.skillCandidates;
    if (shortlist.length === 0) {
      return finish(preliminary, passes, started);
    }

    const second = await callPass(
      "pass2",
      () => gateway.pass2(checked, shortlist),
      passes,
    );
    const decision = postcheck(checked, {
      ...firstSemantic,
      skillCandidates: second.skillCandidates,
    });
    return finish(decision, passes, started);
  } catch (error) {
    return finish(
      fallback(reasonFrom(error), checked.forcedSkillIds, checked.protectedContextIds),
      passes,
      started,
    );
  }
}

export async function route(
  input: RouterInput,
  gateway: SemanticGateway,
): Promise<RouterDecision> {
  return (await routeWithTelemetry(input, gateway)).decision;
}
