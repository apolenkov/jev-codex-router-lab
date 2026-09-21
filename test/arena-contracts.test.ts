import assert from "node:assert/strict";
import test from "node:test";
import type { ArenaContestantInput, ArenaResult } from "../src/arena-contracts.js";
import {
  normalizeArenaResult,
  parseArenaCases,
  parseArenaGold,
  parseArenaManifest,
} from "../src/arena-contracts.js";

const skillEntry = (id: string) => ({
  id,
  description: `Synthetic arena skill ${id}.`,
  excerpt: `Excerpt for ${id}.`,
  contextTokens: 120,
});

const SKILL_IDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
const manifestJson = { skills: SKILL_IDS.map(skillEntry) };

const STRATA = ["bug", "function", "plan", "research", "review"] as const;

const buildCasesJson = () => {
  const cases: Record<string, unknown>[] = [];
  for (const stratum of STRATA) {
    for (let k = 0; k < 12; k += 1) {
      const index = cases.length;
      cases.push({
        id: `case-${String(index + 1).padStart(3, "0")}`,
        familyId: `fam-${stratum}-${Math.floor(k / 3)}`,
        language: k < 6 ? "ru" : "en",
        stratum,
        source: "synthetic",
        risk: k === 0 ? "high" : "standard",
        taskText: `Synthetic arena task ${index + 1}.`,
        explicitSkillIds: k === 0 ? ["delta"] : [],
        requiredSkillIds: k === 0 ? ["epsilon"] : [],
      });
    }
  }
  return cases;
};

const OPTIONAL_SIZES = [
  ...Array<number>(15).fill(0),
  ...Array<number>(22).fill(1),
  ...Array<number>(15).fill(2),
  ...Array<number>(8).fill(3),
];

const routeFor = (size: number): string[] =>
  ["alpha", "beta", "gamma"].slice(0, size);

const buildGoldJson = (casesJson: readonly Record<string, unknown>[]) => ({
  provenance: {
    rubricVersion: "arena-rubric-1",
    labelerRoles: ["labeler-a", "labeler-b"],
    adjudicatorRole: "adjudicator",
  },
  records: casesJson.map((entry, index) => {
    const required = entry.requiredSkillIds as string[];
    return {
      caseId: entry.id,
      acceptedRoutes: [routeFor(OPTIONAL_SIZES[index] ?? 0)],
      mandatorySkillIds: [...required],
      forbiddenSkillIds: ["zeta"],
    };
  }),
});

const manifest = parseArenaManifest(manifestJson);
const casesJson = buildCasesJson();
const cases = parseArenaCases({ cases: casesJson }, manifest);
const goldJson = buildGoldJson(casesJson);

test("parseArenaManifest accepts a closed manifest with frozen contextTokens", () => {
  assert.equal(manifest.skills.length, SKILL_IDS.length);
  assert.deepEqual(
    manifest.skills[0],
    { id: "alpha", description: "Synthetic arena skill alpha.", excerpt: "Excerpt for alpha.", contextTokens: 120 },
  );
});

test("parseArenaManifest rejects entries with extra or missing keys", () => {
  const extra = { skills: [{ ...skillEntry("alpha"), version: 1 }] };
  const missing = { skills: [{ id: "alpha", description: "d", excerpt: "e" }] };
  assert.throws(() => parseArenaManifest(extra));
  assert.throws(() => parseArenaManifest(missing));
  assert.throws(() => parseArenaManifest({ skills: manifestJson.skills, name: "x" }));
});

test("parseArenaManifest rejects non-integer contextTokens and duplicate ids", () => {
  assert.throws(() =>
    parseArenaManifest({ skills: [{ ...skillEntry("alpha"), contextTokens: 1.5 }] }));
  assert.throws(() =>
    parseArenaManifest({ skills: [{ ...skillEntry("alpha"), contextTokens: -1 }] }));
  assert.throws(() =>
    parseArenaManifest({ skills: [skillEntry("alpha"), skillEntry("alpha")] }));
});

test("parseArenaCases accepts the frozen 60-case corpus", () => {
  assert.equal(cases.length, 60);
  const first = cases[0];
  assert.equal(first?.id, "case-001");
  assert.equal(first?.stratum, "bug");
  assert.equal(first?.risk, "high");
  assert.deepEqual(first?.forcedSkillIds, ["delta", "epsilon"]);
});

test("parseArenaCases rejects wrong count, duplicate ids, and bad enums", () => {
  assert.throws(() => parseArenaCases({ cases: casesJson.slice(0, 59) }, manifest));
  const dup = casesJson.map((entry) => ({ ...entry }));
  dup[1] = { ...dup[1], id: "case-001" };
  assert.throws(() => parseArenaCases({ cases: dup }, manifest));
  const badStratum = casesJson.map((entry) => ({ ...entry }));
  badStratum[0] = { ...badStratum[0], stratum: "operate" };
  assert.throws(() => parseArenaCases({ cases: badStratum }, manifest));
  const badSource = casesJson.map((entry) => ({ ...entry }));
  badSource[0] = { ...badSource[0], source: "imported" };
  assert.throws(() => parseArenaCases({ cases: badSource }, manifest));
});

test("parseArenaCases rejects unbalanced language and family language conflicts", () => {
  const unbalanced = casesJson.map((entry) => ({ ...entry }));
  unbalanced[59] = { ...unbalanced[59], language: "ru", familyId: "fam-solo" };
  assert.throws(() => parseArenaCases({ cases: unbalanced }, manifest));
  const conflict = casesJson.map((entry) => ({ ...entry }));
  conflict[1] = { ...conflict[1], language: "en" };
  assert.throws(() => parseArenaCases({ cases: conflict }, manifest));
});

test("parseArenaCases rejects unknown explicit or required skill ids", () => {
  const bad = casesJson.map((entry) => ({ ...entry }));
  bad[5] = { ...bad[5], explicitSkillIds: ["not-a-skill"] };
  assert.throws(() => parseArenaCases({ cases: bad }, manifest));
});

test("parseArenaGold accepts gold with routes, mandatory, forbidden, and provenance", () => {
  const gold = parseArenaGold(goldJson, cases, manifest);
  assert.equal(gold.records.length, 60);
  assert.equal(gold.provenance.labelerRoles.length, 2);
  const forcedRecord = gold.records[0];
  assert.deepEqual(forcedRecord?.mandatorySkillIds, ["epsilon"]);
  assert.deepEqual(forcedRecord?.forbiddenSkillIds, ["zeta"]);
});

test("parseArenaGold rejects mandatory ids outside the forced set", () => {
  const bad = buildGoldJson(casesJson);
  bad.records[1] = { ...bad.records[1]!, mandatorySkillIds: ["alpha"] };
  assert.throws(() => parseArenaGold(bad, cases, manifest));
});

test("parseArenaGold rejects forbidden ids overlapping accepted routes or forced", () => {
  const overlapAccepted = buildGoldJson(casesJson);
  overlapAccepted.records[15] = { ...overlapAccepted.records[15]!, forbiddenSkillIds: ["alpha"] };
  assert.throws(() => parseArenaGold(overlapAccepted, cases, manifest));
  const overlapForced = buildGoldJson(casesJson);
  overlapForced.records[0] = { ...overlapForced.records[0]!, forbiddenSkillIds: ["delta"] };
  assert.throws(() => parseArenaGold(overlapForced, cases, manifest));
});

test("parseArenaGold rejects forced ids, oversize, and duplicate accepted routes", () => {
  const forcedRoute = buildGoldJson(casesJson);
  forcedRoute.records[0] = { ...forcedRoute.records[0]!, acceptedRoutes: [["delta"]] };
  assert.throws(() => parseArenaGold(forcedRoute, cases, manifest));
  const oversize = buildGoldJson(casesJson);
  oversize.records[15] = { ...oversize.records[15]!, acceptedRoutes: [["alpha", "beta", "gamma", "delta"]] };
  assert.throws(() => parseArenaGold(oversize, cases, manifest));
  const duplicate = buildGoldJson(casesJson);
  duplicate.records[15] = { ...duplicate.records[15]!, acceptedRoutes: [["alpha"], ["alpha"]] };
  assert.throws(() => parseArenaGold(duplicate, cases, manifest));
});

test("parseArenaGold rejects zero-skill cases with extra accepted routes", () => {
  const bad = buildGoldJson(casesJson);
  bad.records[0] = { ...bad.records[0]!, acceptedRoutes: [[], ["beta"]] };
  assert.throws(() => parseArenaGold(bad, cases, manifest));
});

test("parseArenaGold rejects a wrong optional-skill distribution", () => {
  const bad = buildGoldJson(casesJson);
  bad.records[0] = { ...bad.records[0]!, acceptedRoutes: [["beta"]] };
  assert.throws(() => parseArenaGold(bad, cases, manifest));
});

test("parseArenaGold rejects missing labels or adjudication provenance", () => {
  const oneLabeler = {
    ...goldJson,
    provenance: { rubricVersion: "arena-rubric-1", labelerRoles: ["labeler-a"], adjudicatorRole: "adjudicator" },
  };
  assert.throws(() => parseArenaGold(oneLabeler, cases, manifest));
  const noAdjudicator = {
    ...goldJson,
    provenance: { rubricVersion: "arena-rubric-1", labelerRoles: ["labeler-a", "labeler-b"], adjudicatorRole: "" },
  };
  assert.throws(() => parseArenaGold(noAdjudicator, cases, manifest));
  const recordsOnly = { records: goldJson.records };
  assert.throws(() => parseArenaGold(recordsOnly, cases, manifest));
});

const arenaInput: ArenaContestantInput = {
  caseId: "case-001",
  taskText: "Synthetic arena task 1.",
  skills: manifest.skills,
  explicitSkillIds: ["delta"],
  requiredSkillIds: ["epsilon"],
};

test("normalizeArenaResult keeps an ok route sorted with null telemetry", () => {
  const result: ArenaResult = normalizeArenaResult(
    { contestantId: "rules", status: "ok", selectedSkillIds: ["gamma", "alpha", "delta"] },
    arenaInput,
  );
  assert.deepEqual(result, {
    caseId: "case-001",
    contestantId: "rules",
    status: "ok",
    selectedSkillIds: ["alpha", "delta", "gamma"],
    reason: null,
    inputTokens: null,
    outputTokens: null,
    latencyMs: null,
    costUsd: null,
  });
});

test("normalizeArenaResult does not count forced skills toward the three-skill cap", () => {
  const result = normalizeArenaResult(
    {
      contestantId: "jev",
      status: "ok",
      selectedSkillIds: ["delta", "epsilon", "alpha", "beta", "gamma"],
      inputTokens: 10,
      outputTokens: 4,
      latencyMs: 12.5,
      costUsd: 0.001,
    },
    arenaInput,
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.selectedSkillIds, ["alpha", "beta", "delta", "epsilon", "gamma"]);
  assert.equal(result.inputTokens, 10);
  assert.equal(result.outputTokens, 4);
  assert.equal(result.latencyMs, 12.5);
  assert.equal(result.costUsd, 0.001);
});

test("normalizeArenaResult converts duplicate ids to error", () => {
  const result = normalizeArenaResult(
    { contestantId: "codex", status: "ok", selectedSkillIds: ["alpha", "alpha"] },
    arenaInput,
  );
  assert.equal(result.status, "error");
  assert.equal(result.reason, "duplicate-skill-id");
  assert.deepEqual(result.selectedSkillIds, []);
});

test("normalizeArenaResult converts unknown ids to error", () => {
  const result = normalizeArenaResult(
    { contestantId: "codex", status: "ok", selectedSkillIds: ["not-a-skill"] },
    arenaInput,
  );
  assert.equal(result.status, "error");
  assert.equal(result.reason, "unknown-skill-id");
});

test("normalizeArenaResult converts more than three optional skills to error", () => {
  const result = normalizeArenaResult(
    { contestantId: "jev", status: "ok", selectedSkillIds: ["alpha", "beta", "gamma", "zeta"] },
    arenaInput,
  );
  assert.equal(result.status, "error");
  assert.equal(result.reason, "too-many-optional-skills");
});

test("normalizeArenaResult converts an ok status without a route to error", () => {
  const result = normalizeArenaResult({ contestantId: "jev", status: "ok" }, arenaInput);
  assert.equal(result.status, "error");
  assert.equal(result.reason, "invalid-route");
});

test("normalizeArenaResult passes abstain and error reasons through", () => {
  const abstain = normalizeArenaResult(
    { contestantId: "jev", status: "abstain", reason: "low-confidence" },
    arenaInput,
  );
  assert.equal(abstain.status, "abstain");
  assert.equal(abstain.reason, "low-confidence");
  assert.deepEqual(abstain.selectedSkillIds, []);
  const error = normalizeArenaResult(
    { contestantId: "codex", status: "error", reason: "fixture-missing" },
    arenaInput,
  );
  assert.equal(error.status, "error");
  assert.equal(error.reason, "fixture-missing");
});
