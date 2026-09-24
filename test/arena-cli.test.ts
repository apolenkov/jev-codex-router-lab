import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  parseArenaCases,
  parseArenaGold,
  parseArenaManifest,
  type ArenaContestantId,
  type ArenaResult,
} from "../src/arena-contracts.js";
import type { ArenaContestant } from "../src/arena-contestants.js";
import { runArenaCli } from "../src/arena-cli.js";
import { scoreArena, type ArenaScoreboard } from "../src/arena-scorer.js";
import { canonicalFingerprint, canonicalJson } from "../src/calibration-runner.js";

const ARENA_FIXTURES = "fixtures/arena";
const FIXTURE_NAMES = [
  "skill-manifest.json",
  "dev-cases.json",
  "dev-gold.json",
  "rules.json",
  "jev-replay.json",
  "codex-replay.json",
  "fingerprints.json",
] as const;

const readJson = (name: string): unknown =>
  JSON.parse(readFileSync(join(ARENA_FIXTURES, name), "utf8"));

const createdRoots: string[] = [];
after(() => {
  for (const root of createdRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

const makeRepository = (): string => {
  const root = mkdtempSync(join(tmpdir(), "arena-cli-test-"));
  createdRoots.push(root);
  mkdirSync(join(root, "fixtures", "arena"), { recursive: true });
  for (const name of FIXTURE_NAMES) {
    copyFileSync(join(ARENA_FIXTURES, name), join(root, "fixtures", "arena", name));
  }
  return root;
};

const listFiles = (root: string, directory: string): string[] => {
  const entries: string[] = [];
  const walk = (relative: string): void => {
    for (const name of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const path = join(relative, name.name);
      if (name.isDirectory()) walk(path);
      else entries.push(path);
    }
  };
  walk("");
  return entries.sort();
};

const readRunRecords = (path: string): ArenaResult[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ArenaResult);

const expectedCaseOrder = (): string[] => {
  const manifest = parseArenaManifest(readJson("skill-manifest.json"));
  const cases = parseArenaCases(readJson("dev-cases.json"), manifest);
  return cases.map((arenaCase) => arenaCase.id).sort();
};

test("the arena command writes the exact artifact tree with canonical bytes", async () => {
  const root = makeRepository();
  const result = await runArenaCli([], { repositoryRoot: root });
  assert.equal(result.exitCode, 0);
  assert.ok(result.runDirectory !== undefined);
  assert.match(result.runDirectory, /^artifacts\/arena\/dev-[0-9a-f]{12}$/);
  const runDir = join(root, result.runDirectory);
  assert.deepEqual(listFiles(root, runDir), [
    "cases.json",
    "gold.json",
    "manifest.json",
    join("runs", "codex.jsonl"),
    join("runs", "jev.jsonl"),
    join("runs", "rules.jsonl"),
    "scoreboard.json",
  ]);

  const pinned = readJson("fingerprints.json") as Record<string, unknown>;
  const manifestArtifact = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
  assert.equal(manifestArtifact.schemaVersion, 1);
  assert.equal(manifestArtifact.scope, "development");
  for (const key of ["skillManifest", "cases", "gold", "rules", "jevReplay", "codexReplay"]) {
    assert.equal(manifestArtifact.fingerprints[key], pinned[key], key);
  }
  assert.match(manifestArtifact.combinedFingerprint, /^[0-9a-f]{64}$/);

  for (const name of ["manifest.json", "cases.json", "gold.json", "scoreboard.json"]) {
    const serialized = readFileSync(join(runDir, name), "utf8");
    assert.equal(serialized, `${canonicalJson(JSON.parse(serialized))}\n`, `${name} canonical`);
  }

  const caseOrder = expectedCaseOrder();
  for (const contestantId of ["jev", "codex", "rules"] as const) {
    const lines = readFileSync(join(runDir, "runs", `${contestantId}.jsonl`), "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    assert.equal(lines.length, 60, contestantId);
    const records = lines.map((line) => {
      assert.equal(line, canonicalJson(JSON.parse(line)), `${contestantId} line canonical`);
      return JSON.parse(line) as ArenaResult;
    });
    assert.deepEqual(records.map((record) => record.caseId), caseOrder, contestantId);
    for (const record of records) {
      assert.equal(record.contestantId, contestantId);
      assert.ok(["ok", "abstain", "error"].includes(record.status));
    }
  }

  const scoreboard = JSON.parse(readFileSync(join(runDir, "scoreboard.json"), "utf8")) as ArenaScoreboard;
  assert.equal(scoreboard.schemaVersion, 1);
  assert.equal(scoreboard.scope, "development");
  assert.deepEqual(
    scoreboard.contestants.map((entry) => entry.contestantId),
    ["jev", "codex", "rules"],
  );
  for (const entry of scoreboard.contestants) {
    assert.equal(entry.denominator, 60);
    assert.deepEqual(entry.cases.map((item) => item.caseId), caseOrder);
  }
});

test("scoreboard derives from the recorded run files", async () => {
  const root = makeRepository();
  const result = await runArenaCli([], { repositoryRoot: root });
  assert.equal(result.exitCode, 0);
  assert.ok(result.runDirectory !== undefined);
  const runDir = join(root, result.runDirectory);

  const manifest = parseArenaManifest(readJson("skill-manifest.json"));
  const cases = parseArenaCases(readJson("dev-cases.json"), manifest);
  const gold = parseArenaGold(readJson("dev-gold.json"), cases, manifest);
  const recorded = Object.fromEntries(
    (["jev", "codex", "rules"] as const).map((contestantId) => [
      contestantId,
      readRunRecords(join(runDir, "runs", `${contestantId}.jsonl`)),
    ]),
  ) as Record<ArenaContestantId, ArenaResult[]>;
  const expected = scoreArena({ manifest, cases, gold, runs: recorded });
  const written = JSON.parse(readFileSync(join(runDir, "scoreboard.json"), "utf8"));
  assert.deepEqual(written, expected);
});

test("a second run over unchanged inputs is byte-identical", async () => {
  const root = makeRepository();
  const first = await runArenaCli([], { repositoryRoot: root });
  assert.equal(first.exitCode, 0);
  assert.ok(first.runDirectory !== undefined);
  const runDir = join(root, first.runDirectory);
  const before = new Map(
    listFiles(root, runDir).map((path) => [path, readFileSync(join(runDir, path), "utf8")]),
  );
  const second = await runArenaCli([], { repositoryRoot: root });
  assert.equal(second.exitCode, 0);
  assert.equal(second.runDirectory, first.runDirectory);
  const after = new Map(
    listFiles(root, runDir).map((path) => [path, readFileSync(join(runDir, path), "utf8")]),
  );
  assert.deepEqual(after, before);
});

test("a conflicting existing artifact fails without overwrite", async () => {
  const root = makeRepository();
  const first = await runArenaCli([], { repositoryRoot: root });
  assert.equal(first.exitCode, 0);
  assert.ok(first.runDirectory !== undefined);
  const runDir = join(root, first.runDirectory);

  for (const target of [join("runs", "codex.jsonl"), "scoreboard.json", "manifest.json"]) {
    const path = join(runDir, target);
    const original = readFileSync(path, "utf8");
    writeFileSync(path, `${original}x`);
    const conflict = await runArenaCli([], { repositoryRoot: root });
    assert.equal(conflict.exitCode, 2, target);
    assert.equal(conflict.error, "arena-artifact-conflict", target);
    assert.equal(readFileSync(path, "utf8"), `${original}x`, `${target} unchanged`);
    writeFileSync(path, original);
  }
});

test("a frozen-input fingerprint mismatch fails before any contestant runs", async () => {
  const root = makeRepository();
  const pinnedPath = join(root, "fixtures", "arena", "fingerprints.json");
  const pinned = JSON.parse(readFileSync(pinnedPath, "utf8")) as Record<string, string>;
  pinned.cases = pinned.cases === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
  writeFileSync(pinnedPath, `${JSON.stringify(pinned, null, 2)}\n`);

  let invoked = false;
  const result = await runArenaCli([], {
    repositoryRoot: root,
    createContestants: (): readonly ArenaContestant[] => {
      invoked = true;
      return [];
    },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.error, "arena-fingerprint-mismatch");
  assert.equal(invoked, false);
  assert.equal(existsSync(join(root, "artifacts")), false);

  const corrupted = makeRepository();
  const casesPath = join(corrupted, "fixtures", "arena", "dev-cases.json");
  const casesDoc = JSON.parse(readFileSync(casesPath, "utf8")) as {
    cases: { taskText: string }[];
  };
  casesDoc.cases[0]!.taskText = `${casesDoc.cases[0]!.taskText} tampered`;
  writeFileSync(casesPath, `${JSON.stringify(casesDoc)}\n`);
  const second = await runArenaCli([], { repositoryRoot: corrupted });
  assert.equal(second.exitCode, 2);
  assert.equal(second.error, "arena-fingerprint-mismatch");
  assert.equal(existsSync(join(corrupted, "artifacts")), false);
});

test("a missing or malformed frozen input fails before any contestant runs", async () => {
  const missing = makeRepository();
  writeFileSync(join(missing, "fixtures", "arena", "dev-gold.json"), "not-json");
  const first = await runArenaCli([], { repositoryRoot: missing });
  assert.equal(first.exitCode, 2);
  assert.equal(first.error, "invalid-arena-fixtures");
  assert.equal(existsSync(join(missing, "artifacts")), false);
});

test("artifacts carry no wall-clock, random, or verdict fields", async () => {
  const root = makeRepository();
  const result = await runArenaCli([], { repositoryRoot: root });
  assert.equal(result.exitCode, 0);
  assert.ok(result.runDirectory !== undefined);
  const runDir = join(root, result.runDirectory);
  const forbiddenKey = /time|date|uuid|random|winner|verdict|production/i;
  const checkKeys = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) checkKeys(entry);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        assert.ok(!forbiddenKey.test(key), `forbidden key ${key}`);
        checkKeys(entry);
      }
    }
  };
  for (const name of ["manifest.json", "cases.json", "gold.json", "scoreboard.json"]) {
    checkKeys(JSON.parse(readFileSync(join(runDir, name), "utf8")));
  }
});

test("the arena command rejects arguments", async () => {
  const root = makeRepository();
  const result = await runArenaCli(["--force"], { repositoryRoot: root });
  assert.equal(result.exitCode, 2);
  assert.equal(result.error, "invalid-arena-usage");
});

test("the combined fingerprint is stable across repositories", async () => {
  const first = makeRepository();
  const second = makeRepository();
  const [a, b] = [
    await runArenaCli([], { repositoryRoot: first }),
    await runArenaCli([], { repositoryRoot: second }),
  ];
  assert.equal(a.exitCode, 0);
  assert.equal(b.exitCode, 0);
  assert.equal(a.runDirectory, b.runDirectory);
  const manifestA = JSON.parse(
    readFileSync(join(first, a.runDirectory as string, "manifest.json"), "utf8"),
  );
  const expectedCombined = canonicalFingerprint({
    cases: manifestA.fingerprints.cases,
    codexReplay: manifestA.fingerprints.codexReplay,
    gold: manifestA.fingerprints.gold,
    jevReplay: manifestA.fingerprints.jevReplay,
    rules: manifestA.fingerprints.rules,
    skillManifest: manifestA.fingerprints.skillManifest,
  });
  assert.equal(manifestA.combinedFingerprint, expectedCombined);
  assert.equal(a.runDirectory, `artifacts/arena/dev-${expectedCombined.slice(0, 12)}`);
});
