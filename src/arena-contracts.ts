import {
  MAX_OPTIONAL_SKILL_CANDIDATES,
  MAX_SEMANTIC_FIELD_CHARS,
  MAX_TASK_TEXT_CHARS,
} from "./contracts.js";

export type ArenaContestantId = "jev" | "codex" | "rules";
export type ArenaStatus = "ok" | "abstain" | "error";
export type ArenaStratum = "bug" | "function" | "plan" | "research" | "review";
export type ArenaLanguage = "ru" | "en";
export type ArenaSource = "synthetic" | "hard-negative" | "minimal-pair";
export type ArenaRisk = "standard" | "high";

export const ARENA_CASE_COUNT = 60;
export const ARENA_CASES_PER_LANGUAGE = 30;
export const ARENA_CASES_PER_STRATUM = 12;
export const ARENA_OPTIONAL_DISTRIBUTION: readonly number[] = [15, 22, 15, 8];

export interface ArenaSkillManifestEntry {
  id: string;
  description: string;
  excerpt: string;
  contextTokens: number;
}

export interface ArenaSkillManifest {
  skills: readonly ArenaSkillManifestEntry[];
}

export interface ArenaCase {
  id: string;
  familyId: string;
  language: ArenaLanguage;
  stratum: ArenaStratum;
  source: ArenaSource;
  risk: ArenaRisk;
  taskText: string;
  explicitSkillIds: readonly string[];
  requiredSkillIds: readonly string[];
  forcedSkillIds: readonly string[];
}

export interface ArenaGoldRecord {
  caseId: string;
  acceptedRoutes: readonly (readonly string[])[];
  mandatorySkillIds: readonly string[];
  forbiddenSkillIds: readonly string[];
}

export interface ArenaGoldProvenance {
  rubricVersion: string;
  labelerRoles: readonly string[];
  adjudicatorRole: string;
}

export interface ArenaGold {
  records: readonly ArenaGoldRecord[];
  provenance: ArenaGoldProvenance;
}

export interface ArenaContestantInput {
  caseId: string;
  taskText: string;
  skills: readonly ArenaSkillManifestEntry[];
  explicitSkillIds: readonly string[];
  requiredSkillIds: readonly string[];
}

export interface ArenaContestantResultInput {
  contestantId: ArenaContestantId;
  status: ArenaStatus;
  selectedSkillIds?: readonly string[];
  reason?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs?: number | null;
  costUsd?: number | null;
}

export interface ArenaResult {
  caseId: string;
  contestantId: ArenaContestantId;
  status: ArenaStatus;
  selectedSkillIds: readonly string[];
  reason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  costUsd: number | null;
}

const STATUSES: readonly string[] = ["ok", "abstain", "error"];
const LANGUAGES: readonly string[] = ["ru", "en"];
const STRATA: readonly string[] = ["bug", "function", "plan", "research", "review"];
const SOURCES: readonly string[] = ["synthetic", "hard-negative", "minimal-pair"];
const RISKS: readonly string[] = ["standard", "high"];

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

const sortedUnique = (ids: readonly string[]): string[] => [...new Set(ids)].sort();

const manifestIds = (manifest: ArenaSkillManifest): Set<string> =>
  new Set(manifest.skills.map((skill) => skill.id));

export function parseArenaManifest(value: unknown): ArenaSkillManifest {
  if (!isRecord(value) || !exactKeys(value, ["skills"]) || !Array.isArray(value.skills)) {
    throw new Error("invalid-arena-manifest");
  }
  const skills = value.skills.map((entry): ArenaSkillManifestEntry => {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ["id", "description", "excerpt", "contextTokens"]) ||
      !isNonEmptyString(entry.id) ||
      !isNonEmptyString(entry.description) ||
      entry.description.length > MAX_SEMANTIC_FIELD_CHARS ||
      !isNonEmptyString(entry.excerpt) ||
      entry.excerpt.length > MAX_SEMANTIC_FIELD_CHARS ||
      typeof entry.contextTokens !== "number" ||
      !Number.isInteger(entry.contextTokens) ||
      entry.contextTokens < 0
    ) {
      throw new Error("invalid-arena-manifest-entry");
    }
    return {
      id: entry.id,
      description: entry.description,
      excerpt: entry.excerpt,
      contextTokens: entry.contextTokens,
    };
  });
  if (!isUnique(skills.map((skill) => skill.id))) {
    throw new Error("duplicate-arena-skill-id");
  }
  return { skills };
}

export function parseArenaCases(
  value: unknown,
  manifest: ArenaSkillManifest,
): readonly ArenaCase[] {
  if (!isRecord(value) || !exactKeys(value, ["cases"]) || !Array.isArray(value.cases)) {
    throw new Error("invalid-arena-cases");
  }
  const known = manifestIds(manifest);
  const cases = value.cases.map((entry): ArenaCase => {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, [
        "id",
        "familyId",
        "language",
        "stratum",
        "source",
        "risk",
        "taskText",
        "explicitSkillIds",
        "requiredSkillIds",
      ]) ||
      !isNonEmptyString(entry.id) ||
      !isNonEmptyString(entry.familyId) ||
      !LANGUAGES.includes(entry.language as string) ||
      !STRATA.includes(entry.stratum as string) ||
      !SOURCES.includes(entry.source as string) ||
      !RISKS.includes(entry.risk as string) ||
      !isNonEmptyString(entry.taskText) ||
      entry.taskText.length > MAX_TASK_TEXT_CHARS ||
      !isStringArray(entry.explicitSkillIds) ||
      !isStringArray(entry.requiredSkillIds) ||
      !isUnique(entry.explicitSkillIds) ||
      !isUnique(entry.requiredSkillIds) ||
      entry.explicitSkillIds.some((id) => !known.has(id)) ||
      entry.requiredSkillIds.some((id) => !known.has(id))
    ) {
      throw new Error("invalid-arena-case");
    }
    return {
      id: entry.id,
      familyId: entry.familyId,
      language: entry.language as ArenaLanguage,
      stratum: entry.stratum as ArenaStratum,
      source: entry.source as ArenaSource,
      risk: entry.risk as ArenaRisk,
      taskText: entry.taskText,
      explicitSkillIds: sortedUnique(entry.explicitSkillIds),
      requiredSkillIds: sortedUnique(entry.requiredSkillIds),
      forcedSkillIds: sortedUnique([...entry.explicitSkillIds, ...entry.requiredSkillIds]),
    };
  });
  if (cases.length !== ARENA_CASE_COUNT) {
    throw new Error("invalid-arena-case-count");
  }
  if (!isUnique(cases.map((entry) => entry.id))) {
    throw new Error("duplicate-arena-case-id");
  }
  if (cases.filter((entry) => entry.language === "ru").length !== ARENA_CASES_PER_LANGUAGE) {
    throw new Error("invalid-arena-language-balance");
  }
  for (const stratum of STRATA) {
    if (cases.filter((entry) => entry.stratum === stratum).length !== ARENA_CASES_PER_STRATUM) {
      throw new Error("invalid-arena-stratum-balance");
    }
  }
  const families = new Map<string, { language: ArenaLanguage; stratum: ArenaStratum }>();
  for (const entry of cases) {
    const family = families.get(entry.familyId);
    if (family === undefined) {
      families.set(entry.familyId, { language: entry.language, stratum: entry.stratum });
    } else if (family.language !== entry.language || family.stratum !== entry.stratum) {
      throw new Error("invalid-arena-family");
    }
  }
  return cases;
}

export function parseArenaGold(
  value: unknown,
  cases: readonly ArenaCase[],
  manifest: ArenaSkillManifest,
): ArenaGold {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["records", "provenance"]) ||
    !Array.isArray(value.records) ||
    !isRecord(value.provenance) ||
    !exactKeys(value.provenance, ["rubricVersion", "labelerRoles", "adjudicatorRole"]) ||
    !isNonEmptyString(value.provenance.rubricVersion) ||
    !isStringArray(value.provenance.labelerRoles) ||
    value.provenance.labelerRoles.length !== 2 ||
    !isUnique(value.provenance.labelerRoles) ||
    value.provenance.labelerRoles.some((role) => role.length === 0) ||
    !isNonEmptyString(value.provenance.adjudicatorRole) ||
    value.provenance.labelerRoles.includes(value.provenance.adjudicatorRole)
  ) {
    throw new Error("invalid-arena-gold-provenance");
  }
  const provenance: ArenaGoldProvenance = {
    rubricVersion: value.provenance.rubricVersion,
    labelerRoles: [...value.provenance.labelerRoles],
    adjudicatorRole: value.provenance.adjudicatorRole,
  };
  const known = manifestIds(manifest);
  const byCaseId = new Map(cases.map((entry) => [entry.id, entry]));
  if (value.records.length !== cases.length) {
    throw new Error("invalid-arena-gold-records");
  }
  const seen = new Set<string>();
  const records = value.records.map((entry): ArenaGoldRecord => {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ["caseId", "acceptedRoutes", "mandatorySkillIds", "forbiddenSkillIds"]) ||
      !isNonEmptyString(entry.caseId) ||
      !Array.isArray(entry.acceptedRoutes) ||
      entry.acceptedRoutes.length === 0 ||
      !isStringArray(entry.mandatorySkillIds) ||
      !isStringArray(entry.forbiddenSkillIds)
    ) {
      throw new Error("invalid-arena-gold-record");
    }
    const arenaCase = byCaseId.get(entry.caseId);
    if (arenaCase === undefined || seen.has(entry.caseId)) {
      throw new Error("invalid-arena-gold-case-id");
    }
    seen.add(entry.caseId);
    const forced = new Set(arenaCase.forcedSkillIds);
    if (
      !isUnique(entry.forbiddenSkillIds) ||
      entry.forbiddenSkillIds.some((id) => !known.has(id) || forced.has(id))
    ) {
      throw new Error("invalid-arena-forbidden-skills");
    }
    const forbidden = new Set(entry.forbiddenSkillIds);
    const acceptedRoutes = entry.acceptedRoutes.map((route) => {
      if (
        !isStringArray(route) ||
        route.length > MAX_OPTIONAL_SKILL_CANDIDATES ||
        !isUnique(route) ||
        route.some((id) => !known.has(id) || forced.has(id) || forbidden.has(id))
      ) {
        throw new Error("invalid-arena-accepted-route");
      }
      return sortedUnique(route);
    });
    const serialized = new Set(acceptedRoutes.map((route) => JSON.stringify(route)));
    if (serialized.size !== acceptedRoutes.length) {
      throw new Error("duplicate-arena-accepted-route");
    }
    if (
      !isUnique(entry.mandatorySkillIds) ||
      entry.mandatorySkillIds.some((id) => !forced.has(id))
    ) {
      throw new Error("invalid-arena-mandatory-skills");
    }
    const largest = Math.max(...acceptedRoutes.map((route) => route.length));
    if (largest === 0 && acceptedRoutes.length !== 1) {
      throw new Error("invalid-arena-zero-skill-routes");
    }
    return {
      caseId: entry.caseId,
      acceptedRoutes,
      mandatorySkillIds: sortedUnique(entry.mandatorySkillIds),
      forbiddenSkillIds: sortedUnique(entry.forbiddenSkillIds),
    };
  });
  const distribution = [0, 0, 0, 0];
  for (const record of records) {
    const largest = Math.max(...record.acceptedRoutes.map((route) => route.length));
    distribution[largest] = (distribution[largest] ?? 0) + 1;
  }
  if (!ARENA_OPTIONAL_DISTRIBUTION.every((expected, index) => distribution[index] === expected)) {
    throw new Error("invalid-arena-skill-distribution");
  }
  return { records, provenance };
}

const observed = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function normalizeArenaResult(
  input: ArenaContestantResultInput,
  arenaInput: ArenaContestantInput,
): ArenaResult {
  const forced = new Set([...arenaInput.explicitSkillIds, ...arenaInput.requiredSkillIds]);
  const known = new Set(arenaInput.skills.map((skill) => skill.id));
  const base = {
    caseId: arenaInput.caseId,
    contestantId: input.contestantId,
    inputTokens: observed(input.inputTokens),
    outputTokens: observed(input.outputTokens),
    latencyMs: observed(input.latencyMs),
    costUsd: observed(input.costUsd),
  };
  const error = (reason: string): ArenaResult => ({
    ...base,
    status: "error",
    selectedSkillIds: [],
    reason,
  });
  if (!STATUSES.includes(input.status)) {
    return error("invalid-status");
  }
  if (input.status !== "ok") {
    return {
      ...base,
      status: input.status,
      selectedSkillIds: [],
      reason: isNonEmptyString(input.reason) ? input.reason : "unspecified",
    };
  }
  const route = input.selectedSkillIds;
  if (!isStringArray(route)) {
    return error("invalid-route");
  }
  if (!isUnique(route)) {
    return error("duplicate-skill-id");
  }
  if (route.some((id) => !known.has(id))) {
    return error("unknown-skill-id");
  }
  if (route.filter((id) => !forced.has(id)).length > MAX_OPTIONAL_SKILL_CANDIDATES) {
    return error("too-many-optional-skills");
  }
  return {
    ...base,
    status: "ok",
    selectedSkillIds: [...route].sort(),
    reason: null,
  };
}
