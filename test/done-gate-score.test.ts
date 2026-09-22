import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AUTO_ACCEPT_GRID,
  loadCorpus,
  loadResults,
  parseCaseResult,
  parseCorpusCase,
  runScoreCli,
  scoreResults,
  ScoreInputError,
  verifyManifest,
  type CaseResult,
  type ClaimResult,
  type CorpusCase,
} from "../arena/done-gate/score.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CORPUS_DIR = join(REPO_ROOT, "arena/done-gate/corpus");
const MANIFEST = join(REPO_ROOT, "arena/done-gate/manifest.sha256");
const SAMPLE_RESULTS = join(REPO_ROOT, "arena/done-gate/fixtures/results.sample.jsonl");

const corpusCase = (
  id: string,
  gold: readonly ("verified" | "contradicted" | "unsupported")[],
): CorpusCase => ({
  id,
  source: "synthetic",
  domain: "agent-report",
  tags: [],
  claims: gold.map((_, index) => `claim ${index}`),
  evidence: [{ id: "e1", text: "evidence text" }],
  gold,
});

const claimResult = (
  claimIndex: number,
  verdict: "verified" | "contradicted" | "unsupported",
  probability: number,
): ClaimResult => ({
  claimIndex,
  verdict,
  probabilities: {
    verified: verdict === "verified" ? probability : (1 - probability) / 2,
    contradicted: verdict === "contradicted" ? probability : (1 - probability) / 2,
    unsupported: verdict === "unsupported" ? probability : (1 - probability) / 2,
  },
  confidence: null,
  action: null,
});

const caseResult = (
  caseId: string,
  results: readonly ReturnType<typeof claimResult>[],
): CaseResult => ({ caseId, results });

test("the auto-accept grid is the declared ten-point sweep from 0.5 to 0.95", () => {
  assert.deepEqual(
    [...AUTO_ACCEPT_GRID],
    [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95],
  );
});

test("the frozen corpus parses with unique ids and aligned per-claim gold", () => {
  const cases = loadCorpus(CORPUS_DIR);
  assert.ok(cases.length >= 60, `expected >= 60 cases, got ${cases.length}`);
  const ids = new Set(cases.map((entry) => entry.id));
  assert.equal(ids.size, cases.length);
  for (const entry of cases) {
    assert.equal(entry.gold.length, entry.claims.length, entry.id);
    assert.ok(entry.claims.length > 0, entry.id);
    assert.ok(entry.evidence.length > 0, entry.id);
    assert.ok(["session", "synthetic"].includes(entry.source), entry.id);
  }
});

test("the frozen corpus keeps per-claim gold classes roughly balanced in thirds", () => {
  const cases = loadCorpus(CORPUS_DIR);
  const counts = { verified: 0, contradicted: 0, unsupported: 0 };
  let claims = 0;
  for (const entry of cases) {
    for (const verdict of entry.gold) {
      counts[verdict] += 1;
      claims += 1;
    }
  }
  for (const [verdict, count] of Object.entries(counts)) {
    const share = count / claims;
    assert.ok(
      share >= 0.25 && share <= 0.42,
      `${verdict} share ${share.toFixed(3)} out of thirds band`,
    );
  }
});

test("the manifest verifies the untouched corpus and catches edits and extra files", () => {
  assert.deepEqual(verifyManifest(MANIFEST, CORPUS_DIR), []);

  const dir = mkdtempSync(join(tmpdir(), "done-gate-manifest-"));
  const corpusDir = join(dir, "corpus");
  mkdirSync(corpusDir, { recursive: true });
  writeFileSync(join(corpusDir, "a.jsonl"), "{}\n");
  writeFileSync(join(corpusDir, "unlisted.jsonl"), "{}\n");
  const manifestPath = join(dir, "manifest.sha256");
  writeFileSync(manifestPath, `${"0".repeat(64)}  corpus/a.jsonl\n`);

  const problems = verifyManifest(manifestPath, corpusDir);
  assert.ok(problems.some((problem) => problem.includes("hash mismatch")));
  assert.ok(problems.some((problem) => problem.includes("unlisted corpus file corpus/unlisted.jsonl")));
});

test("scoring counts auto-accepted verified predictions against per-claim gold", () => {
  const cases = [
    corpusCase("A", ["verified"]),
    corpusCase("B", ["contradicted"]),
    corpusCase("C", ["verified", "contradicted"]),
    corpusCase("D", ["unsupported"]),
  ];
  const results = [
    caseResult("A", [claimResult(0, "verified", 0.9)]),
    caseResult("B", [claimResult(0, "verified", 0.6)]),
    caseResult("C", [claimResult(0, "unsupported", 0.8), claimResult(1, "contradicted", 0.7)]),
    caseResult("D", [claimResult(0, "verified", 0.55)]),
  ];
  const summary = scoreResults(cases, results, [0.5, 0.6, 0.95]);
  const [at05, at06, at095] = summary.rows;
  assert.ok(at05 && at06 && at095);

  // At 0.50: A accepted (TP), B accepted (FP), C0 not verified (FN),
  // C1 not verified (TN), D accepted (FP); C1 also caught as contradicted.
  assert.deepEqual(
    { tp: at05.tp, fp: at05.fp, fn: at05.fn, tn: at05.tn },
    { tp: 1, fp: 2, fn: 1, tn: 1 },
  );
  assert.equal(at05.precision, 1 / 3);
  assert.equal(at05.recall, 0.5);
  assert.equal(at05.fnRate, 0.5);
  assert.equal(at05.fpRate, 2 / 3);
  assert.equal(at05.contradictedTotal, 2);
  assert.equal(at05.contradictedCaught, 1);

  // Boundary is inclusive: B at p=0.6 is still auto-accepted at threshold 0.6.
  assert.deepEqual(
    { tp: at06.tp, fp: at06.fp, fn: at06.fn, tn: at06.tn },
    { tp: 1, fp: 1, fn: 1, tn: 2 },
  );

  // At 0.95 nothing is auto-accepted: precision is undefined, recall is 0.
  assert.deepEqual(
    { tp: at095.tp, fp: at095.fp, fn: at095.fn, tn: at095.tn },
    { tp: 0, fp: 0, fn: 2, tn: 3 },
  );
  assert.equal(at095.precision, null);
  assert.equal(at095.recall, 0);
  assert.equal(at095.fnRate, 1);
  assert.equal(at095.fpRate, 0);
  assert.equal(at095.contradictedRate, 0);

  assert.equal(summary.results.claimsScored, 5);
  assert.equal(summary.results.uncoveredCaseIds.length, 0);
});

test("results covering only a subset leave the rest reported as uncovered", () => {
  const cases = [corpusCase("A", ["verified"]), corpusCase("B", ["verified"])];
  const summary = scoreResults(cases, [caseResult("A", [claimResult(0, "verified", 0.9)])], [0.8]);
  assert.equal(summary.results.claimsScored, 1);
  assert.deepEqual(summary.results.uncoveredCaseIds, ["B"]);
});

test("join rejects unknown case ids and incomplete or out-of-range claim coverage", () => {
  const cases = [corpusCase("A", ["verified", "contradicted"])];
  assert.throws(
    () => scoreResults(cases, [caseResult("Z", [claimResult(0, "verified", 0.9)])]),
    (error: unknown) => error instanceof ScoreInputError && /unknown case_id Z/.test(error.message),
  );
  assert.throws(
    () => scoreResults(cases, [caseResult("A", [claimResult(0, "verified", 0.9)])]),
    (error: unknown) => error instanceof ScoreInputError && /coverage mismatch/.test(error.message),
  );
  assert.throws(
    () =>
      scoreResults(cases, [
        caseResult("A", [claimResult(0, "verified", 0.9), claimResult(2, "verified", 0.9)]),
      ]),
    (error: unknown) => error instanceof ScoreInputError && /coverage mismatch/.test(error.message),
  );
});

test("parsers reject malformed lines, misaligned gold, unknown verdicts and duplicate ids", () => {
  assert.throws(
    () => parseCorpusCase({ id: "x", source: "synthetic", domain: "d", claims: ["c"], evidence: [{ id: "e", text: "t" }], gold: [] }, "ctx"),
    ScoreInputError,
  );
  assert.throws(
    () => parseCorpusCase({ id: "x", source: "synthetic", domain: "d", claims: ["c"], evidence: [{ id: "e", text: "t" }], gold: ["yes"] }, "ctx"),
    ScoreInputError,
  );
  assert.throws(
    () => parseCorpusCase({ id: "x", source: "synthetic", domain: "d", claims: [], evidence: [{ id: "e", text: "t" }], gold: [] }, "ctx"),
    ScoreInputError,
  );
  assert.throws(
    () =>
      parseCaseResult(
        {
          case_id: "x",
          results: [
            { claim_index: 0, verdict: "verified", probabilities: { verified: 0.9, contradicted: 0.05, unsupported: 0.05 } },
            { claim_index: 0, verdict: "verified", probabilities: { verified: 0.9, contradicted: 0.05, unsupported: 0.05 } },
          ],
        },
        "ctx",
      ),
    (error: unknown) => error instanceof ScoreInputError && /duplicate/.test(error.message),
  );
  assert.throws(
    () =>
      parseCaseResult(
        { case_id: "x", results: [{ claim_index: 0, verdict: "verified", probabilities: { verified: 1.2, contradicted: 0, unsupported: 0 } }] },
        "ctx",
      ),
    ScoreInputError,
  );
});

test("the bundled sample fixture parses and covers full claim sets of its cases", () => {
  const cases = loadCorpus(CORPUS_DIR);
  const results = loadResults(SAMPLE_RESULTS);
  assert.equal(results.length, 12);
  const summary = scoreResults(cases, results, [0.8]);
  const row = summary.rows[0];
  assert.ok(row);
  // At 0.80 the hand-labelled sample has three auto-accepted verified claims,
  // no false accepts, and catches half of the gold-contradicted claims.
  assert.deepEqual(
    { tp: row.tp, fp: row.fp, fn: row.fn, tn: row.tn },
    { tp: 3, fp: 0, fn: 0, tn: 11 },
  );
  assert.equal(row.precision, 1);
  assert.equal(row.recall, 1);
  assert.equal(row.contradictedTotal, 8);
  assert.equal(row.contradictedCaught, 4);
});

test("the cli scores the frozen sample fixture and stays deterministic across runs", () => {
  const first = runScoreCli([], REPO_ROOT);
  assert.equal(first.exitCode, 0, first.error);
  assert.ok(first.output?.includes("done-gate calibration scoring"));
  assert.ok(first.output?.includes("corpus: 117 cases / 129 claims"));

  const second = runScoreCli([], REPO_ROOT);
  assert.deepEqual(second, first);

  const asJson = runScoreCli(["--json"], REPO_ROOT);
  assert.equal(asJson.exitCode, 0, asJson.error);
  const parsed = JSON.parse(asJson.output ?? "") as {
    rows: { threshold: number }[];
    corpus: { cases: number };
  };
  assert.equal(parsed.rows.length, AUTO_ACCEPT_GRID.length);
  assert.equal(parsed.corpus.cases, 117);
});

test("the cli fails closed on unknown flags, bad manifests and unmet coverage", () => {
  assert.equal(runScoreCli(["--nope"], REPO_ROOT).exitCode, 2);
  assert.equal(runScoreCli(["--require-all"], REPO_ROOT).exitCode, 2);
  assert.equal(
    runScoreCli(["--manifest", join(REPO_ROOT, "package.json")], REPO_ROOT).exitCode,
    2,
  );
  assert.equal(
    runScoreCli(["--results", join(REPO_ROOT, "does-not-exist.jsonl")], REPO_ROOT).exitCode,
    2,
  );
  assert.equal(runScoreCli(["--domain", "no-such-domain"], REPO_ROOT).exitCode, 2);
  const domain = runScoreCli(["--domain", "config"], REPO_ROOT);
  assert.equal(domain.exitCode, 0, domain.error);
  assert.ok(domain.output?.includes("2 cases scored"));
});

test("the compiled scorer needs no credential and never touches the network", () => {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.includes("TYPESAFE") || name.includes("VERCEL") || name.includes("AI_GATEWAY")) {
      delete environment[name];
    }
  }
  const denyNetwork = encodeURIComponent(`
    import http from "node:http";
    import https from "node:https";
    import net from "node:net";
    import tls from "node:tls";
    import { syncBuiltinESMExports } from "node:module";
    const deny = () => { throw new Error("scorer attempted network access"); };
    http.request = deny;
    http.get = deny;
    https.request = deny;
    https.get = deny;
    net.connect = deny;
    net.createConnection = deny;
    tls.connect = deny;
    globalThis.fetch = deny;
    syncBuiltinESMExports();
  `);
  const scorePath = fileURLToPath(new URL("../arena/done-gate/score.js", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", "--import", `data:text/javascript,${denyNetwork}`, scorePath],
    { cwd: REPO_ROOT, encoding: "utf8", env: environment },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("done-gate calibration scoring"));
  assert.ok(result.stdout.includes("threshold"));
});
