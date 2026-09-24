import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import type { ArenaGoldRecord } from "../src/arena-contracts.js";
import {
  parseArenaCases,
  parseArenaGold,
  parseArenaManifest,
} from "../src/arena-contracts.js";
import { canonicalFingerprint } from "../src/calibration-runner.js";

const ARENA_FIXTURES = "fixtures/arena";
const RUBRIC_VERSION = "skill-routing-arena-gold-v1";
const rubricVersionMarker = `<!-- rubric-version: ${RUBRIC_VERSION} -->`;
const rubricText = readFileSync(`${ARENA_FIXTURES}/rubric-v1.md`, "utf8");

const readJson = (name: string): unknown =>
  JSON.parse(readFileSync(`${ARENA_FIXTURES}/${name}`, "utf8"));

const manifest = parseArenaManifest(readJson("skill-manifest.json"));
const cases = parseArenaCases(readJson("dev-cases.json"), manifest);
const GOLD_FILE = "dev-gold.json";
const loadGold = () => parseArenaGold(readJson(GOLD_FILE), cases, manifest);
const fingerprints = readJson("fingerprints.json") as Record<string, unknown>;

const manifestIds = new Set(manifest.skills.map((skill) => skill.id));
const casesById = new Map(cases.map((entry) => [entry.id, entry]));

const countBy = <T>(items: readonly T[], keyOf: (item: T) => string): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyOf(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

const largestAcceptedRouteSize = (record: ArenaGoldRecord): string =>
  String(Math.max(...record.acceptedRoutes.map((route) => route.length)));

const FORBIDDEN_PROSE_PATTERNS = [
  /\/Users\//,
  /\b[A-Za-z]:[\\/]/,
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /\b(?:sk|ghp|xox[baprs])-[A-Za-z0-9]/,
  /\bTASK-\d+\b/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
];

test("frozen corpus meets the approved denominators", () => {
  assert.equal(cases.length, 60);
  assert.deepEqual(countBy(cases, ({ language }) => language), { en: 30, ru: 30 });
  assert.deepEqual(countBy(cases, ({ stratum }) => stratum), {
    bug: 12,
    function: 12,
    plan: 12,
    research: 12,
    review: 12,
  });
  assert.deepEqual(countBy(loadGold().records, largestAcceptedRouteSize), {
    "0": 15,
    "1": 22,
    "2": 15,
    "3": 8,
  });
});

test("every case uses allowed source and risk classifications", () => {
  const sources = new Set(cases.map(({ source }) => source));
  const risks = new Set(cases.map(({ risk }) => risk));
  assert.deepEqual(
    [...sources].sort(),
    ["hard-negative", "minimal-pair", "synthetic"],
  );
  for (const risk of risks) {
    assert.ok(risk === "standard" || risk === "high");
  }
  assert.ok(risks.has("high"));
});

test("case ids are unique and families keep one language and stratum", () => {
  assert.equal(new Set(cases.map(({ id }) => id)).size, cases.length);
  const families = new Map<string, { language: string; stratum: string }>();
  for (const entry of cases) {
    const family = families.get(entry.familyId);
    if (family === undefined) {
      families.set(entry.familyId, { language: entry.language, stratum: entry.stratum });
    } else {
      assert.equal(family.language, entry.language);
      assert.equal(family.stratum, entry.stratum);
    }
  }
});

test("forced skills are the sorted unique union of explicit and required ids", () => {
  for (const entry of cases) {
    const expected = [...new Set([...entry.explicitSkillIds, ...entry.requiredSkillIds])].sort();
    assert.deepEqual([...entry.forcedSkillIds], expected);
    for (const id of entry.forcedSkillIds) {
      assert.ok(manifestIds.has(id));
    }
  }
});

test("gold records cover every case exactly once", () => {
  const gold = loadGold();
  assert.equal(gold.records.length, cases.length);
  assert.equal(new Set(gold.records.map(({ caseId }) => caseId)).size, cases.length);
  for (const record of gold.records) {
    assert.ok(casesById.has(record.caseId));
  }
});

test("accepted routes are unique sets of up to three non-forced, non-forbidden manifest skills", () => {
  for (const record of loadGold().records) {
    const arenaCase = casesById.get(record.caseId);
    assert.ok(arenaCase !== undefined);
    const forced = new Set(arenaCase.forcedSkillIds);
    const forbidden = new Set(record.forbiddenSkillIds);
    const serializedRoutes = new Set<string>();
    for (const route of record.acceptedRoutes) {
      assert.ok(route.length <= 3);
      assert.equal(new Set(route).size, route.length);
      for (const id of route) {
        assert.ok(manifestIds.has(id));
        assert.ok(!forced.has(id));
        assert.ok(!forbidden.has(id));
      }
      const serialized = JSON.stringify([...route].sort());
      assert.ok(!serializedRoutes.has(serialized));
      serializedRoutes.add(serialized);
    }
  }
});

test("mandatory skills stay inside the forced set and forbidden skills stay outside it", () => {
  for (const record of loadGold().records) {
    const arenaCase = casesById.get(record.caseId);
    assert.ok(arenaCase !== undefined);
    const forced = new Set(arenaCase.forcedSkillIds);
    for (const id of record.mandatorySkillIds) {
      assert.ok(forced.has(id));
    }
    for (const id of record.forbiddenSkillIds) {
      assert.ok(manifestIds.has(id));
      assert.ok(!forced.has(id));
    }
  }
});

test("zero-skill cases hold exactly the empty accepted route", () => {
  const zeroSkill = loadGold().records.filter(
    (record) => largestAcceptedRouteSize(record) === "0",
  );
  assert.equal(zeroSkill.length, 15);
  for (const record of zeroSkill) {
    assert.deepEqual(record.acceptedRoutes, [[]]);
  }
});

test("gold provenance carries stable roles and a rubric version only", () => {
  const gold = loadGold();
  assert.ok(rubricText.startsWith(`${rubricVersionMarker}\n`));
  assert.equal(gold.provenance.rubricVersion, RUBRIC_VERSION);
  assert.deepEqual(Object.keys(gold.provenance).sort(), [
    "adjudicatorRole",
    "labelerRoles",
    "rubricVersion",
  ]);
  assert.deepEqual(gold.provenance, {
    rubricVersion: RUBRIC_VERSION,
    labelerRoles: ["annotator-a", "annotator-b"],
    adjudicatorRole: "adjudicator",
  });
});

test("fixture prose stays public and synthetic", () => {
  const prose: string[] = [cases.map(({ taskText }) => taskText)].flat();
  for (const skill of manifest.skills) {
    prose.push(skill.description, skill.excerpt);
  }
  for (const text of prose) {
    for (const pattern of FORBIDDEN_PROSE_PATTERNS) {
      assert.ok(!pattern.test(text), `${pattern} found in fixture prose`);
    }
  }
});

test("pinned fingerprints equal canonical fingerprints of the parsed fixtures", () => {
  assert.deepEqual(Object.keys(fingerprints).sort(), [
    "cases",
    "codexReplay",
    "gold",
    "jevReplay",
    "rules",
    "schemaVersion",
    "skillManifest",
  ]);
  assert.equal(fingerprints.schemaVersion, 1);
  const fingerprintKeys = [
    "skillManifest",
    "cases",
    "gold",
    "rules",
    "jevReplay",
    "codexReplay",
  ] as const;
  for (const key of fingerprintKeys) {
    const value = fingerprints[key];
    assert.equal(typeof value, "string", key);
    assert.match(value as string, /^[0-9a-f]{64}$/, key);
  }
  assert.equal(fingerprints.skillManifest, canonicalFingerprint(manifest));
  assert.equal(fingerprints.cases, canonicalFingerprint(cases));
  assert.equal(fingerprints.rules, canonicalFingerprint(readJson("rules.json")));
  assert.equal(fingerprints.jevReplay, canonicalFingerprint(readJson("jev-replay.json")));
  assert.equal(
    fingerprints.codexReplay,
    canonicalFingerprint(readJson("codex-replay.json")),
  );
  // dev-gold.json is frozen by the coordinator; until it lands the pinned
  // gold hash stays a 64-zero placeholder and the equality check is skipped.
  if (existsSync(`${ARENA_FIXTURES}/${GOLD_FILE}`)) {
    assert.equal(fingerprints.gold, canonicalFingerprint(loadGold()));
  }
});
