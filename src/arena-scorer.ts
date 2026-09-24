import type {
  ArenaCase,
  ArenaContestantId,
  ArenaGold,
  ArenaGoldRecord,
  ArenaResult,
  ArenaSkillManifest,
  ArenaStatus,
} from "./arena-contracts.js";

export const ARENA_CONTESTANT_ORDER: readonly ArenaContestantId[] = ["jev", "codex", "rules"];

const STATUSES: readonly ArenaStatus[] = ["ok", "abstain", "error"];

export interface ArenaCaseScore {
  readonly caseId: string;
  readonly contestantId: ArenaContestantId;
  readonly status: ArenaStatus;
  readonly effectiveRoute: readonly string[];
  readonly optionalSelection: readonly string[];
  readonly correct: boolean;
  readonly closestAcceptedRoute: readonly string[];
  readonly falsePositives: readonly string[];
  readonly falseNegatives: readonly string[];
  readonly missedMandatorySkillIds: readonly string[];
  readonly forbiddenHitSkillIds: readonly string[];
}

export interface ArenaObservedMetric {
  readonly observations: number;
  readonly sum: number;
  readonly p50: number;
  readonly p95: number;
}

export interface ArenaContestantAggregates {
  readonly accuracy: number | null;
  readonly ok: number;
  readonly abstain: number;
  readonly error: number;
  readonly mandatoryMisses: number;
  readonly highRiskMandatoryMisses: number;
  readonly forbiddenHits: number;
  readonly zeroSkillFalsePositiveRate: number | null;
  readonly microPrecision: number | null;
  readonly microRecall: number | null;
  readonly autonomousCoverage: number | null;
  readonly contextTokens: number;
  readonly inputTokens: ArenaObservedMetric | null;
  readonly outputTokens: ArenaObservedMetric | null;
  readonly latencyMs: ArenaObservedMetric | null;
  readonly costUsd: ArenaObservedMetric | null;
}

export interface ArenaContestantScore {
  readonly contestantId: ArenaContestantId;
  readonly denominator: number;
  readonly aggregates: ArenaContestantAggregates;
  readonly cases: readonly ArenaCaseScore[];
}

export interface ArenaJevCodexFallback {
  readonly replacedCases: number;
  readonly accuracy: number | null;
  readonly mandatoryMisses: number;
  readonly highRiskMandatoryMisses: number;
}

export interface ArenaScoreboard {
  readonly schemaVersion: 1;
  readonly scope: "development";
  readonly contestants: readonly ArenaContestantScore[];
  readonly jevWithCodexFallback: ArenaJevCodexFallback;
}

const sortedCopy = (ids: readonly string[]): string[] => [...ids].sort();

const serializeRoute = (route: readonly string[]): string => JSON.stringify(sortedCopy(route));

// The closest accepted route minimizes |FP|+|FN|, then yields the fewest false
// negatives, then has the lexicographically smallest sorted-ID serialization.
const closestAcceptedRoute = (
  optionalSelection: ReadonlySet<string>,
  acceptedRoutes: readonly (readonly string[])[],
): readonly string[] => {
  let best: readonly string[] | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestNegatives = Number.POSITIVE_INFINITY;
  let bestSerialization = "";
  for (const route of acceptedRoutes) {
    const accepted = new Set(route);
    let falsePositives = 0;
    let falseNegatives = 0;
    for (const id of optionalSelection) {
      if (!accepted.has(id)) falsePositives += 1;
    }
    for (const id of accepted) {
      if (!optionalSelection.has(id)) falseNegatives += 1;
    }
    const distance = falsePositives + falseNegatives;
    const serialization = serializeRoute(route);
    if (
      best === null ||
      distance < bestDistance ||
      (distance === bestDistance && falseNegatives < bestNegatives) ||
      (distance === bestDistance &&
        falseNegatives === bestNegatives &&
        serialization < bestSerialization)
    ) {
      best = route;
      bestDistance = distance;
      bestNegatives = falseNegatives;
      bestSerialization = serialization;
    }
  }
  if (best === null) {
    throw new Error("invalid-arena-gold");
  }
  return sortedCopy(best);
};

const isExactMatch = (
  optionalSelection: ReadonlySet<string>,
  serializedSelection: string,
  acceptedRoutes: readonly (readonly string[])[],
): boolean =>
  acceptedRoutes.some((route) => {
    if (route.length !== optionalSelection.size) return false;
    return serializeRoute(route) === serializedSelection;
  });

const effectiveRouteOf = (result: ArenaResult): readonly string[] =>
  result.status === "ok" ? sortedCopy(result.selectedSkillIds) : [];

const optionalSelectionOf = (
  effectiveRoute: readonly string[],
  forced: ReadonlySet<string>,
): readonly string[] => effectiveRoute.filter((id) => !forced.has(id));

const scoreCase = (
  arenaCase: ArenaCase,
  result: ArenaResult,
  goldRecord: ArenaGoldRecord,
): ArenaCaseScore => {
  const effectiveRoute = effectiveRouteOf(result);
  const effective = new Set(effectiveRoute);
  const forced = new Set(arenaCase.forcedSkillIds);
  const optionalSelection = optionalSelectionOf(effectiveRoute, forced);
  const optional = new Set(optionalSelection);
  const closest = closestAcceptedRoute(optional, goldRecord.acceptedRoutes);
  const closestSet = new Set(closest);
  const serializedSelection = JSON.stringify(optionalSelection);
  return {
    caseId: arenaCase.id,
    contestantId: result.contestantId,
    status: result.status,
    effectiveRoute,
    optionalSelection,
    correct: result.status === "ok" &&
      isExactMatch(optional, serializedSelection, goldRecord.acceptedRoutes),
    closestAcceptedRoute: closest,
    falsePositives: optionalSelection.filter((id) => !closestSet.has(id)),
    falseNegatives: closest.filter((id) => !optional.has(id)),
    missedMandatorySkillIds: goldRecord.mandatorySkillIds.filter((id) => !effective.has(id)),
    forbiddenHitSkillIds: goldRecord.forbiddenSkillIds.filter((id) => effective.has(id)),
  };
};

const isZeroSkillRecord = (record: ArenaGoldRecord): boolean =>
  record.acceptedRoutes.length === 1 && (record.acceptedRoutes[0]?.length ?? -1) === 0;

// Nearest rank: sorted[Math.ceil(p * n) - 1] for a non-empty observation list.
const nearestRank = (sortedValues: readonly number[], p: number): number => {
  const index = Math.ceil(p * sortedValues.length) - 1;
  const value = sortedValues[index];
  if (value === undefined) {
    throw new Error("invalid-arena-observations");
  }
  return value;
};

const summarizeObservations = (values: readonly number[]): ArenaObservedMetric | null => {
  if (values.length === 0) return null;
  const sortedValues = [...values].sort((left, right) => left - right);
  let sum = 0;
  for (const value of sortedValues) sum += value;
  return {
    observations: sortedValues.length,
    sum,
    p50: nearestRank(sortedValues, 0.5),
    p95: nearestRank(sortedValues, 0.95),
  };
};

const aggregate = (
  arenaCases: readonly ArenaCase[],
  caseScores: readonly ArenaCaseScore[],
  goldByCaseId: ReadonlyMap<string, ArenaGoldRecord>,
  resultsByCaseId: ReadonlyMap<string, ArenaResult>,
  contextTokensById: ReadonlyMap<string, number>,
): ArenaContestantAggregates => {
  const scoreByCaseId = new Map(caseScores.map((entry) => [entry.caseId, entry]));
  let correct = 0;
  let ok = 0;
  let abstain = 0;
  let error = 0;
  let mandatoryMisses = 0;
  let highRiskMandatoryMisses = 0;
  let forbiddenHits = 0;
  let zeroSkillCases = 0;
  let zeroSkillFalsePositives = 0;
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let contextTokens = 0;
  const inputTokens: number[] = [];
  const outputTokens: number[] = [];
  const latencyMs: number[] = [];
  const costUsd: number[] = [];
  for (const arenaCase of arenaCases) {
    const entry = scoreByCaseId.get(arenaCase.id);
    const result = resultsByCaseId.get(arenaCase.id);
    const goldRecord = goldByCaseId.get(arenaCase.id);
    if (entry === undefined || result === undefined || goldRecord === undefined) {
      throw new Error("invalid-arena-runs");
    }
    if (entry.correct) correct += 1;
    if (result.status === "ok") ok += 1;
    if (result.status === "abstain") abstain += 1;
    if (result.status === "error") error += 1;
    mandatoryMisses += entry.missedMandatorySkillIds.length;
    if (arenaCase.risk === "high") {
      highRiskMandatoryMisses += entry.missedMandatorySkillIds.length;
    }
    forbiddenHits += entry.forbiddenHitSkillIds.length;
    if (isZeroSkillRecord(goldRecord)) {
      zeroSkillCases += 1;
      if (entry.falsePositives.length > 0) zeroSkillFalsePositives += 1;
    }
    truePositives += entry.optionalSelection.length - entry.falsePositives.length;
    falsePositives += entry.falsePositives.length;
    falseNegatives += entry.falseNegatives.length;
    for (const id of entry.effectiveRoute) {
      contextTokens += contextTokensById.get(id) ?? 0;
    }
    if (result.inputTokens !== null) inputTokens.push(result.inputTokens);
    if (result.outputTokens !== null) outputTokens.push(result.outputTokens);
    if (result.latencyMs !== null) latencyMs.push(result.latencyMs);
    if (result.costUsd !== null) costUsd.push(result.costUsd);
  }
  const denominator = arenaCases.length;
  const ratio = (numerator: number, divisor: number): number | null =>
    divisor === 0 ? null : numerator / divisor;
  return {
    accuracy: ratio(correct, denominator),
    ok,
    abstain,
    error,
    mandatoryMisses,
    highRiskMandatoryMisses,
    forbiddenHits,
    zeroSkillFalsePositiveRate: ratio(zeroSkillFalsePositives, zeroSkillCases),
    microPrecision: ratio(truePositives, truePositives + falsePositives),
    microRecall: ratio(truePositives, truePositives + falseNegatives),
    autonomousCoverage: ratio(ok, denominator),
    contextTokens,
    inputTokens: summarizeObservations(inputTokens),
    outputTokens: summarizeObservations(outputTokens),
    latencyMs: summarizeObservations(latencyMs),
    costUsd: summarizeObservations(costUsd),
  };
};

const indexRuns = (
  contestantId: ArenaContestantId,
  results: readonly ArenaResult[],
  caseIds: ReadonlySet<string>,
): Map<string, ArenaResult> => {
  const byCaseId = new Map<string, ArenaResult>();
  for (const result of results) {
    if (
      result === null ||
      typeof result !== "object" ||
      result.contestantId !== contestantId ||
      typeof result.caseId !== "string" ||
      !caseIds.has(result.caseId) ||
      byCaseId.has(result.caseId) ||
      !STATUSES.includes(result.status) ||
      !Array.isArray(result.selectedSkillIds) ||
      result.selectedSkillIds.some((id) => typeof id !== "string")
    ) {
      throw new Error("invalid-arena-runs");
    }
    byCaseId.set(result.caseId, result);
  }
  if (byCaseId.size !== caseIds.size) {
    throw new Error("invalid-arena-runs");
  }
  return byCaseId;
};

const jevCodexFallback = (
  arenaCases: readonly ArenaCase[],
  goldByCaseId: ReadonlyMap<string, ArenaGoldRecord>,
  jevRuns: ReadonlyMap<string, ArenaResult>,
  codexRuns: ReadonlyMap<string, ArenaResult>,
): ArenaJevCodexFallback => {
  let replacedCases = 0;
  let correct = 0;
  let mandatoryMisses = 0;
  let highRiskMandatoryMisses = 0;
  for (const arenaCase of arenaCases) {
    const jevResult = jevRuns.get(arenaCase.id);
    const codexResult = codexRuns.get(arenaCase.id);
    const goldRecord = goldByCaseId.get(arenaCase.id);
    if (jevResult === undefined || codexResult === undefined || goldRecord === undefined) {
      throw new Error("invalid-arena-runs");
    }
    const replaced = jevResult.status === "abstain" && codexResult.status === "ok";
    if (replaced) replacedCases += 1;
    const effectiveRoute = replaced
      ? effectiveRouteOf(codexResult)
      : effectiveRouteOf(jevResult);
    const effective = new Set(effectiveRoute);
    const forced = new Set(arenaCase.forcedSkillIds);
    const optionalSelection = optionalSelectionOf(effectiveRoute, forced);
    const optional = new Set(optionalSelection);
    const isOk = replaced || jevResult.status === "ok";
    if (
      isOk &&
      isExactMatch(optional, JSON.stringify(optionalSelection), goldRecord.acceptedRoutes)
    ) {
      correct += 1;
    }
    const missed = goldRecord.mandatorySkillIds.filter((id) => !effective.has(id)).length;
    mandatoryMisses += missed;
    if (arenaCase.risk === "high") {
      highRiskMandatoryMisses += missed;
    }
  }
  return {
    replacedCases,
    accuracy: arenaCases.length === 0 ? null : correct / arenaCases.length,
    mandatoryMisses,
    highRiskMandatoryMisses,
  };
};

export function scoreArena(input: {
  manifest: ArenaSkillManifest;
  cases: readonly ArenaCase[];
  gold: ArenaGold;
  runs: Readonly<Record<ArenaContestantId, readonly ArenaResult[]>>;
}): ArenaScoreboard {
  const arenaCases = [...input.cases].sort((left, right) => left.id.localeCompare(right.id));
  const caseIds = new Set(arenaCases.map((arenaCase) => arenaCase.id));
  if (caseIds.size !== arenaCases.length) {
    throw new Error("invalid-arena-cases");
  }
  const goldByCaseId = new Map(input.gold.records.map((record) => [record.caseId, record]));
  for (const arenaCase of arenaCases) {
    if (!goldByCaseId.has(arenaCase.id)) {
      throw new Error("invalid-arena-gold");
    }
  }
  const contextTokensById = new Map(
    input.manifest.skills.map((skill) => [skill.id, skill.contextTokens]),
  );
  const runsByContestant = new Map<string, Map<string, ArenaResult>>();
  for (const contestantId of ARENA_CONTESTANT_ORDER) {
    const results = input.runs[contestantId];
    if (!Array.isArray(results)) {
      throw new Error("invalid-arena-runs");
    }
    runsByContestant.set(contestantId, indexRuns(contestantId, results, caseIds));
  }
  const contestants = ARENA_CONTESTANT_ORDER.map((contestantId): ArenaContestantScore => {
    const resultsByCaseId = runsByContestant.get(contestantId);
    if (resultsByCaseId === undefined) {
      throw new Error("invalid-arena-runs");
    }
    const caseScores = arenaCases.map((arenaCase) => {
      const result = resultsByCaseId.get(arenaCase.id);
      const goldRecord = goldByCaseId.get(arenaCase.id);
      if (result === undefined || goldRecord === undefined) {
        throw new Error("invalid-arena-runs");
      }
      return scoreCase(arenaCase, result, goldRecord);
    });
    return {
      contestantId,
      denominator: arenaCases.length,
      aggregates: aggregate(
        arenaCases,
        caseScores,
        goldByCaseId,
        resultsByCaseId,
        contextTokensById,
      ),
      cases: caseScores,
    };
  });
  const jevRuns = runsByContestant.get("jev");
  const codexRuns = runsByContestant.get("codex");
  if (jevRuns === undefined || codexRuns === undefined) {
    throw new Error("invalid-arena-runs");
  }
  return {
    schemaVersion: 1,
    scope: "development",
    contestants,
    jevWithCodexFallback: jevCodexFallback(arenaCases, goldByCaseId, jevRuns, codexRuns),
  };
}
