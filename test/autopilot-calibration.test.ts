import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  baselinesOf,
  bodyOf,
  cellOf,
  criteriaOf,
  gridOf,
  halfOf,
  holdoutOf,
  KevDownError,
  M_GRID,
  readPick,
  renderReport,
  runCalibration,
  scoredOf,
  selectCell,
  stateOf,
  stripHint,
  T_GRID,
  verdictOf,
  wilsonLow,
  type Row,
  type Scored,
} from "../arena/autopilot/calibrate.js";
import { extractLines, newShared, type Pair } from "../arena/autopilot/extract.js";

// ---------------------------------------------------------------- extract

const line = (value: unknown): string => JSON.stringify(value);
const user = (text: string): string => line({ type: "user", timestamp: "t0", message: { role: "user", content: text } });
const assistantText = (text: string): string =>
  line({ type: "assistant", timestamp: "t1", message: { content: [{ type: "text", text }] } });
const ask = (id: string, questions: unknown[]): string =>
  line({
    type: "assistant",
    timestamp: "t2",
    message: { content: [{ type: "tool_use", id, name: "AskUserQuestion", input: { questions } }] },
  });
const result = (id: string, toolUseResult: unknown, isError = false): string =>
  line({
    type: "user",
    timestamp: "t3",
    message: { content: [{ type: "tool_result", tool_use_id: id, ...(isError ? { is_error: true } : {}) }] },
    toolUseResult,
  });
const opts = (...labels: string[]): { label: string; description: string }[] =>
  labels.map((label) => ({ label, description: `about ${label}` }));

test("extract keeps single-choice answered pairs and counts every skip reason", () => {
  const shared = newShared();
  const q1 = { question: "Which db?", options: opts("Postgres (Recommended)", "SQLite"), multiSelect: false };
  const q2 = { question: "Which flags?", options: opts("a", "b"), multiSelect: true };
  const q3 = { question: "Which name?", options: opts("x", "y"), multiSelect: false };
  extractLines(
    [
      user("Build the importer"),
      assistantText("I looked at the options."),
      ask("c1", [q1, q2]),
      result("c1", { questions: [q1, q2], answers: { "Which db?": "SQLite", "Which flags?": "a, b" } }),
      user("later owner message must not leak"),
      assistantText("later assistant text must not leak"),
      ask("c2", [q3]),
      result("c2", { questions: [q3], answers: { "Which name?": "my own text" } }),
      ask("c3", [q1]),
      result("c3", { questions: [q1], answers: { "Which db?": "SQLite" }, afkTimeoutMs: 1000 }),
      ask("c4", [q3]),
      result("c4", "Error: The user doesn't want to proceed", true),
      ask("c5", [q1]),
      "not json",
      ask("c6", [q1]),
      result("c6", { questions: [q1], answers: { "Which db?": "SQLite" } }),
    ],
    "session-a",
    shared,
  );
  const { stats, pairs } = shared;
  assert.equal(stats.calls, 6);
  assert.equal(stats.questions, 7);
  assert.deepEqual(stats.skipped, {
    error: 1,
    afk: 1,
    no_result: 1,
    multiSelect: 1,
    unanswered: 0,
    free_text: 1,
    duplicate: 1,
  });
  assert.equal(pairs.length, 1);
  const pair = pairs[0] as Pair;
  assert.equal(pair.goal, "Build the importer");
  assert.equal(pair.tail, "I looked at the options.");
  assert.deepEqual(pair.answer, { idx: 1, label: "SQLite" });
  assert.equal(pair.recommendedIdx, 0);
  assert.equal(pair.sessionId, "session-a");
});

test("extract context comes only from lines before the tool_use", () => {
  const shared = newShared();
  const q = { question: "Pick?", options: opts("one", "two"), multiSelect: false };
  extractLines(
    [
      user("<system-reminder>not a goal</system-reminder>"),
      user("first goal"),
      line({ type: "user", isMeta: true, message: { content: "meta note" } }),
      assistantText("x".repeat(3000)),
      ask("c1", [q]),
      user("TWO-SECRET-FOLLOWUP"),
      result("c1", { questions: [q], answers: { "Pick?": "two" } }),
    ],
    "s",
    shared,
  );
  const pair = shared.pairs[0] as Pair;
  assert.equal(pair.goal, "first goal");
  assert.equal(pair.tail.length, 2000);
  assert.equal(JSON.stringify(pair).includes("TWO-SECRET-FOLLOWUP"), false);
});

// ---------------------------------------------------------------- analytics

test("wilsonLow matches the textbook interval", () => {
  assert.equal(wilsonLow(0, 0), 0);
  assert.ok(Math.abs(wilsonLow(9, 10) - 0.5958) < 1e-3);
  assert.ok(Math.abs(wilsonLow(50, 50) - 0.9287) < 1e-3);
});

const scored = (items: [p1: number, margin: number, hit: boolean, session?: string][]): Scored[] =>
  items.map(([p1, margin, hit, sessionId = "s"]) => ({ sessionId, p1, margin, hit }));

test("cells count auto picks by p1 and margin, with exact boundaries", () => {
  const rows = scored([
    [0.9, 0.8, true],
    [0.6, 0.2, true],
    [0.6, 0.1, false],
    [0.5, 0.0, false],
  ]);
  const cell = cellOf(rows, 0.6, 0.1);
  assert.equal(cell.auto, 3);
  assert.equal(cell.coverage, 0.75);
  assert.ok(Math.abs((cell.agreement ?? 0) - 2 / 3) < 1e-9);
  assert.equal(cellOf(rows, 0.95, 0).auto, 0);
  assert.equal(cellOf(rows, 0.95, 0).agreement, null);
  assert.equal(gridOf(rows).length, T_GRID.length * M_GRID.length);
});

test("selectCell takes the passing cell with the most coverage, then the higher agreement", () => {
  // 10 rows: 5 sure and right, 5 unsure and half right.
  const rows = scored([
    ...Array.from({ length: 5 }, (): [number, number, boolean] => [0.95, 0.9, true]),
    [0.6, 0.2, true],
    [0.6, 0.2, false],
    [0.6, 0.2, true],
    [0.6, 0.2, false],
    [0.6, 0.2, true],
  ]);
  const picked = selectCell(gridOf(rows));
  assert.ok(picked !== null);
  assert.equal(picked.auto, 5);
  assert.equal(picked.agreement, 1);
  assert.equal(picked.coverage, 0.5);
  assert.equal(selectCell(gridOf(scored([[0.9, 0.8, false]]))), null);
});

test("halves are deterministic and hold-out evaluates on the other half", () => {
  assert.equal(halfOf("abc"), halfOf("abc"));
  const sessions = Array.from({ length: 40 }, (_, i) => `session-${i}`);
  const halves = new Set(sessions.map(halfOf));
  assert.deepEqual([...halves].sort(), [0, 1]);
  const rows = sessions.flatMap((session) =>
    scored([
      [0.95, 0.9, true, session],
      [0.95, 0.9, true, session],
      [0.6, 0.1, false, session],
    ]),
  );
  const directions = holdoutOf(rows);
  assert.equal(directions.length, 2);
  for (const direction of directions) {
    assert.ok(direction.selected !== null);
    assert.equal(direction.test?.agreement, 1);
    assert.equal(direction.confirmed, true);
    assert.equal(direction.nTrain + direction.nTest, rows.length);
  }
});

const row = (over: Partial<Row>): Row => ({
  id: "r",
  variant: "asis",
  sessionId: "s",
  nOptions: 3,
  ownerIdx: 0,
  pickIdx: 0,
  p1: 0.9,
  p2: 0.05,
  margin: 0.85,
  recommendedIdx: null,
  latencyMs: 100,
  ...over,
});

test("baselines: recommended, first, majority and Kev top-1", () => {
  const rows = [
    row({ ownerIdx: 0, recommendedIdx: 0, pickIdx: 0 }),
    row({ ownerIdx: 1, recommendedIdx: 0, pickIdx: 1 }),
    row({ ownerIdx: 1, recommendedIdx: null, pickIdx: 0 }),
    row({ ownerIdx: 2, recommendedIdx: null, pickIdx: 2 }),
  ];
  const base = baselinesOf(rows);
  assert.deepEqual(base.recommended, { pairs: 2, agreement: 0.5 });
  assert.equal(base.first, 0.25);
  assert.deepEqual(base.majority, { idx: 1, agreement: 0.5 });
  assert.equal(base.kevTop1, 0.75);
  assert.equal(baselinesOf([]).recommended.agreement, null);
});

test("verdict: hint when no cell passes, auto but fragile on thin evidence", () => {
  assert.equal(verdictOf([row({ pickIdx: 1 }), row({ pickIdx: 1 })]).kind, "hint");
  const sure = Array.from({ length: 10 }, (_, i) => row({ sessionId: `s${i}` }));
  const verdict = verdictOf(sure);
  assert.equal(verdict.kind, "auto");
  assert.equal(verdict.fragile, true); // Wilson low of 10/10 is about 0.72
  assert.deepEqual(scoredOf(sure).map((item) => item.hit), Array(10).fill(true));
});

// ---------------------------------------------------------------- request

const pair = (over: Partial<Pair> = {}): Pair => ({
  id: "p1",
  sessionId: "sess",
  ts: "t",
  question: "Which db?",
  options: [
    { label: "Postgres (Recommended)", description: "robust" },
    { label: "SQLite", description: "" },
    { label: "SQLite", description: "again" },
  ],
  answer: { idx: 1, label: "SQLite" },
  recommendedIdx: 0,
  goal: "ship it",
  tail: "done so far",
  ...over,
});

test("request: hint stripped, duplicate labels indexed, state keeps the question", () => {
  assert.equal(stripHint("Postgres (Recommended)"), "Postgres");
  assert.equal(stripHint("Да (Рекомендую)"), "Да");
  const asis = criteriaOf(pair(), "asis");
  assert.deepEqual(asis.keys, ["Postgres (Recommended)", "SQLite", "SQLite #3"]);
  assert.equal(asis.criteria["SQLite"], "SQLite");
  assert.equal(asis.criteria["SQLite #3"], "again");
  assert.deepEqual(criteriaOf(pair(), "stripped").keys, ["Postgres", "SQLite", "SQLite #3"]);

  const long = stateOf(pair({ goal: "g".repeat(500), tail: "t".repeat(9000) }));
  assert.equal(long.length, 8000);
  assert.ok(long.endsWith("Question: Which db?"));
  const sent = JSON.parse(bodyOf(pair(), "stripped").body) as { questions: { pick: { type: string } }; model: string };
  assert.equal(sent.model, "kev-latest");
  assert.equal(sent.questions.pick.type, "choice");
});

test("readPick takes the argmax and the runner-up, and rejects odd shapes", () => {
  const body = { answers: { pick: { probabilities: { a: 0.2, b: 0.5, c: 0.3 } } } };
  assert.deepEqual(readPick(body, ["a", "b", "c"]), { pickIdx: 1, p1: 0.5, p2: 0.3 });
  assert.throws(() => readPick({}, ["a"]), /probabilities/);
  assert.throws(() => readPick(body, ["a", "zzz"]), /cover every option/);
});

// ---------------------------------------------------------------- run

const listen = (server: Server): Promise<string> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });

const stubKev = (calls: { count: number }): Server =>
  createServer((request, response) => {
    if (request.method === "GET") {
      response.end(JSON.stringify({ models: [{ name: "kev-latest", description: "stub model", run: "stub@1" }] }));
      return;
    }
    let text = "";
    request.on("data", (chunk: Buffer) => (text += chunk.toString()));
    request.on("end", () => {
      calls.count += 1;
      const body = JSON.parse(text) as { questions: { pick: { criteria: Record<string, string> } } };
      const keys = Object.keys(body.questions.pick.criteria);
      const probabilities = Object.fromEntries(keys.map((key, i) => [key, i === 0 ? 0.8 : 0.2 / (keys.length - 1)]));
      response.end(JSON.stringify({ answers: { pick: { probabilities } }, latency_ms: 12 }));
    });
  });

test("runCalibration scores both variants, resumes from rows, and writes an aggregate-only report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-calib-"));
  const resultsDir = mkdtempSync(join(tmpdir(), "autopilot-results-"));
  const corpus = Array.from({ length: 4 }, (_, i) =>
    pair({
      id: `p${i}`,
      sessionId: `sess-${i}`,
      question: `PRIVATE-QUESTION-${i}`,
      options: [
        { label: "First (Recommended)", description: "PRIVATE-DESCRIPTION" },
        { label: "Second", description: "d" },
      ],
      answer: { idx: i % 2, label: "x" },
    }),
  );
  writeFileSync(join(dir, "corpus.jsonl"), corpus.map((item) => `${JSON.stringify(item)}\n`).join(""));
  const calls = { count: 0 };
  const server = stubKev(calls);
  const url = await listen(server);
  try {
    const first = await runCalibration({ dir, kevUrl: url, resultsDir, date: "2000-01-01" });
    assert.equal(calls.count, 8);
    assert.equal(first.input.rows.asis.length, 4);
    assert.equal(first.input.rows.stripped.length, 4);
    assert.equal(first.input.rows.asis[0]?.latencyMs, 12);

    await runCalibration({ dir, kevUrl: url, resultsDir, date: "2000-01-01" });
    assert.equal(calls.count, 8, "a second run re-asks nothing");

    const report = readFileSync(first.reportPath, "utf8");
    assert.ok(report.startsWith("# Autopilot calibration 2000-01-01"));
    assert.ok(report.includes("stub@1"));
    for (const secret of ["PRIVATE-QUESTION", "PRIVATE-DESCRIPTION", "sess-", dir]) {
      assert.equal(report.includes(secret), false, `report leaks ${secret}`);
    }
    assert.equal(renderReport(first.input), report);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("runCalibration fails clearly when Kev is down", async () => {
  const server = createServer();
  const url = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  const dir = mkdtempSync(join(tmpdir(), "autopilot-calib-"));
  await assert.rejects(
    runCalibration({ dir, kevUrl: url, resultsDir: dir, date: "2000-01-01" }),
    (error: unknown) => error instanceof KevDownError && /never starts a server/.test(error.message),
  );
});
