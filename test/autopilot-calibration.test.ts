import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  baselinesOf,
  bodyOf,
  cellOf,
  criteriaOf,
  fpOf,
  gridOf,
  halfOf,
  holdoutOf,
  kevInfoOf,
  keysOf,
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
import { extractLines, newShared, writeCorpus, type Pair } from "../arena/autopilot/extract.js";

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
  fp: "fp",
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

const stubKev = (calls: { count: number; run?: string; failFrom?: number; bodies?: string[] }): Server =>
  createServer((request, response) => {
    if (request.method === "GET") {
      response.end(
        JSON.stringify({ models: [{ name: "kev-latest", description: "SECRET-MODEL-DESCRIPTION", run: calls.run ?? "stub@1" }] }),
      );
      return;
    }
    let text = "";
    request.on("data", (chunk: Buffer) => (text += chunk.toString()));
    request.on("end", () => {
      calls.count += 1;
      calls.bodies?.push(text);
      if (calls.failFrom !== undefined && calls.count >= calls.failFrom) {
        response.statusCode = 500;
        response.end("{}");
        return;
      }
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
    for (const secret of ["PRIVATE-QUESTION", "PRIVATE-DESCRIPTION", "SECRET-MODEL-DESCRIPTION", "sess-", dir]) {
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

// ---------------------------------------------------------------- review fixes

const withKev = async (
  calls: { count: number; run?: string; failFrom?: number; bodies?: string[] },
  body: (url: string) => Promise<void>,
): Promise<void> => {
  const server = stubKev(calls);
  const url = await listen(server);
  try {
    await body(url);
  } finally {
    server.closeAllConnections();
    server.close();
  }
};

const syntheticCorpus = (n: number, tag = "Q"): Pair[] =>
  Array.from({ length: n }, (_, i) =>
    pair({
      id: `p${i}`,
      sessionId: `sess-${i}`,
      question: `${tag}-${i}`,
      options: [
        { label: "First (Recommended)", description: "d1" },
        { label: "Second", description: "d2" },
      ],
      answer: { idx: 0, label: "First (Recommended)" },
    }),
  );

const rowsOf = (dir: string, variant: string): Row[] =>
  readFileSync(join(dir, `rows-${variant}.jsonl`), "utf8")
    .split("\n")
    .filter((text) => text !== "")
    .map((text) => JSON.parse(text) as Row);

test("rows carry a fingerprint; stale rows (gone pair, other request, other Kev run) are dropped and re-asked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-calib-"));
  const resultsDir = mkdtempSync(join(tmpdir(), "autopilot-results-"));
  const corpus = syntheticCorpus(3);
  writeCorpus(dir, corpus);
  const calls = { count: 0, run: "rev-1" };
  await withKev(calls, async (url) => {
    await runCalibration({ dir, kevUrl: url, resultsDir, date: "2000-01-01" });
    assert.equal(calls.count, 6);
    const asis = rowsOf(dir, "asis");
    assert.equal(asis[0]?.fp, fpOf(bodyOf(corpus[0] as Pair, "asis").body, "rev-1"));
    assert.notEqual(asis[0]?.fp, rowsOf(dir, "stripped")[0]?.fp);

    // Same corpus and revision: nothing is re-asked.
    await runCalibration({ dir, kevUrl: url, resultsDir, date: "2000-01-01" });
    assert.equal(calls.count, 6);

    // p2 changes its question (same id), p1 leaves the corpus: p2 is re-asked, p1's row is gone from the file.
    const next = [corpus[0] as Pair, { ...(corpus[2] as Pair), question: "changed" }];
    writeCorpus(dir, next);
    await runCalibration({ dir, kevUrl: url, resultsDir, date: "2000-01-01" });
    assert.equal(calls.count, 8, "only the changed pair is re-asked, once per variant");
    for (const variant of ["asis", "stripped"]) {
      assert.deepEqual(rowsOf(dir, variant).map((item) => item.id).sort(), ["p0", "p2"]);
    }

    // Another Kev revision invalidates every row.
    calls.run = "rev-2";
    await runCalibration({ dir, kevUrl: url, resultsDir, date: "2000-01-01" });
    assert.equal(calls.count, 12);
    assert.ok(rowsOf(dir, "asis").every((item) => item.fp === fpOf(bodyOf(next[item.id === "p0" ? 0 : 1] as Pair, "asis").body, "rev-2")));
  });
});

test("stripped removes the hint from labels and descriptions, leaves state alone", () => {
  const hinted = pair({
    question: "Pick (Recommended)?",
    tail: "I suggest B (Recommended)",
    options: [
      { label: "A (Recommended)", description: "Best (Recommended) choice" },
      { label: "B (Рекомендую)", description: "(Рекомендуется)" },
    ],
  });
  const stripped = criteriaOf(hinted, "stripped");
  assert.deepEqual(stripped.keys, ["A", "B"]);
  assert.deepEqual(stripped.criteria, { A: "Best choice", B: "B" });
  assert.deepEqual(criteriaOf(hinted, "asis").criteria, {
    "A (Recommended)": "Best (Recommended) choice",
    "B (Рекомендую)": "(Рекомендуется)",
  });
  const state = JSON.parse(bodyOf(hinted, "stripped").body) as { state: string };
  assert.ok(state.state.includes("Pick (Recommended)?") && state.state.includes("B (Recommended)"));
});

test("criteria keys are unique against all labels and generated keys, and match the option count", () => {
  assert.deepEqual(keysOf(["A", "A", "A #2"]), ["A", "A #3", "A #2"]);
  assert.deepEqual(keysOf(["A", "A #2", "A"]), ["A", "A #2", "A #3"]);
  for (const labels of [["A", "A", "A #2"], ["A", "A #2", "A"], ["A", "A", "A", "A #2", "A #3"], ["", "", ""], ["x", "x #1", "x"]]) {
    const keys = keysOf(labels);
    assert.equal(new Set(keys).size, labels.length, JSON.stringify(labels));
    labels.forEach((label, index) => {
      // a plain label is never renamed unless it is a repeat
      if (labels.indexOf(label) === index) assert.equal(keys[index], label);
    });
    assert.deepEqual(keys, keysOf(labels), "stable");
  }
  const crowded = pair({
    options: ["A", "A", "A #2", "A (Recommended)"].map((label) => ({ label, description: label })),
  });
  for (const variant of ["asis", "stripped"] as const) {
    const { keys, criteria } = criteriaOf(crowded, variant);
    assert.equal(keys.length, 4);
    assert.equal(Object.keys(criteria).length, 4);
  }
});

test("an incomplete run writes no report and fails with the unscored count; a rerun resumes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-calib-"));
  const resultsDir = mkdtempSync(join(tmpdir(), "autopilot-results-"));
  writeCorpus(dir, syntheticCorpus(3));
  const calls: { count: number; failFrom?: number } = { count: 0, failFrom: 5 };
  await withKev(calls, async (url) => {
    // asis: 3 ok; stripped: 1 ok, then 2 fail -> 2 unscored
    await assert.rejects(
      runCalibration({ dir, kevUrl: url, resultsDir, date: "2000-01-01" }),
      /^Error: 2 pairs unscored; rerun to resume$/,
    );
    assert.equal(existsSync(join(resultsDir, "calibration-2000-01-01.md")), false);
    delete calls.failFrom;
    const done = await runCalibration({ dir, kevUrl: url, resultsDir, date: "2000-01-01" });
    assert.equal(done.input.rows.stripped.length, 3);
    assert.equal(calls.count, 8, "the rerun asks only the 2 missing pairs");
  });
});

test("Kev metadata: only a well-formed run revision reaches the report, never the model description", async () => {
  await withKev({ count: 0, run: "ok.rev/1@x-2_3" }, async (url) => assert.deepEqual(await kevInfoOf(url), { run: "ok.rev/1@x-2_3" }));
  for (const run of ["bad run", "x".repeat(121), "# injected\nline", ""]) {
    await withKev({ count: 0, run }, async (url) => assert.deepEqual(await kevInfoOf(url), { run: "unknown" }));
  }
});

test("private state is owner-only, also when it already exists with loose modes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-calib-"));
  const resultsDir = mkdtempSync(join(tmpdir(), "autopilot-results-"));
  const mode = (path: string): number => statSync(path).mode & 0o777;
  chmodSync(dir, 0o755);
  writeFileSync(join(dir, "corpus.jsonl"), "", { mode: 0o644 });
  writeCorpus(dir, syntheticCorpus(2));
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(join(dir, "corpus.jsonl")), 0o600);

  const fresh = join(dir, "nested", "state");
  writeCorpus(fresh, syntheticCorpus(1));
  assert.equal(mode(fresh), 0o700);

  writeFileSync(join(dir, "rows-asis.jsonl"), "", { mode: 0o644 });
  chmodSync(dir, 0o755);
  await withKev({ count: 0, failFrom: 4 }, async (url) => {
    await assert.rejects(runCalibration({ dir, kevUrl: url, resultsDir, date: "2000-01-01" }), /unscored/);
  });
  assert.equal(mode(dir), 0o700);
  for (const name of ["rows-asis.jsonl", "rows-stripped.jsonl", "errors.jsonl"]) {
    assert.equal(mode(join(dir, name)), 0o600, name);
  }
});
