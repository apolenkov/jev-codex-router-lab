import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  RunLiveError,
  parseArgs,
  runLive,
  utcDateStamp,
  type RunLiveDeps,
} from "../arena/done-gate/run-live.js";

const createdRoots: string[] = [];

after(() => {
  for (const root of createdRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

const CASES_JSONL = [
  JSON.stringify({
    id: "case-a",
    source: "synthetic",
    domain: "agent-report",
    tags: [],
    claims: ["claim alpha"],
    evidence: [{ id: "e1", text: "evidence alpha" }],
    gold: ["verified"],
  }),
  JSON.stringify({
    id: "case-b",
    source: "synthetic",
    domain: "agent-report",
    tags: [],
    claims: ["claim beta"],
    evidence: [{ id: "e1", text: "evidence beta" }],
    gold: ["contradicted"],
  }),
].join("\n");

const makeWorkspace = (): { corpus: string; results: string; errors: string } => {
  const root = mkdtempSync(join(tmpdir(), "run-live-test-"));
  createdRoots.push(root);
  const corpus = join(root, "corpus");
  mkdirSync(corpus);
  writeFileSync(join(corpus, "cases.jsonl"), `${CASES_JSONL}\n`, "utf8");
  return {
    corpus,
    results: join(root, "results.jsonl"),
    errors: join(root, "errors.jsonl"),
  };
};

const makeOptions = (workspace: { corpus: string; results: string; errors: string }, extra: { limit?: number; maxCalls?: number } = {}) =>
  ({
    corpus: workspace.corpus,
    results: workspace.results,
    errors: workspace.errors,
    model: "jev-1.13.0",
    maxCalls: extra.maxCalls ?? 150,
    maxInputTokens: 200_000,
    limit: extra.limit ?? null,
  });

const withApiKey = (run: () => Promise<void>): Promise<void> => {
  const saved = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "test-key";
  return run().finally(() => {
    if (saved === undefined) {
      delete process.env.TYPESAFE_API_KEY;
    } else {
      process.env.TYPESAFE_API_KEY = saved;
    }
  });
};

const fetchReturning = (status: number, body: unknown): { fetch: NonNullable<RunLiveDeps["fetch"]>; attempts: () => number } => {
  let count = 0;
  const fetch = async (): Promise<Response> => {
    count += 1;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, attempts: () => count };
};

const okResponse = {
  model: "jev-1.13.0",
  answers: {
    relation_claim0: {
      type: "choice",
      choice: "supports",
      confidence: 0.9,
      probabilities: { supports: 0.9, contradicts: 0.05, says_nothing: 0.05 },
    },
  },
  usage: { input_tokens: 10, output_tokens: 5 },
};

test("parseArgs resolves defaults and flags", () => {
  const parsed = parseArgs(["--limit", "3"], "/repo");
  assert.equal(parsed.limit, 3);
  assert.equal(parsed.maxCalls, 150);
  assert.match(parsed.results, /live-\d{4}-\d{2}-\d{2}\.jsonl$/);
  assert.match(parsed.errors, /live-\d{4}-\d{2}-\d{2}\.errors\.jsonl$/);
  assert.throws(() => parseArgs(["--limit", "0"], "/repo"), RunLiveError);
});

test("utcDateStamp formats UTC date", () => {
  assert.equal(utcDateStamp(new Date("2026-09-24T12:34:56Z")), "2026-09-24");
});

test("one counted call is one HTTP attempt on a retryable status", () =>
  withApiKey(async () => {
    const workspace = makeWorkspace();
    const { fetch, attempts } = fetchReturning(429, { error: "slow down" });
    const summary = await runLive(makeOptions(workspace, { limit: 1 }), { fetch });
    assert.equal(attempts(), 1);
    assert.equal(summary.calls, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.ok, 0);
  }));

test("--max-calls budget counts real attempts, not logical calls", () =>
  withApiKey(async () => {
    const workspace = makeWorkspace();
    const { fetch, attempts } = fetchReturning(503, { error: "unavailable" });
    const summary = await runLive(makeOptions(workspace, { maxCalls: 1 }), { fetch });
    assert.equal(attempts(), 1);
    assert.equal(summary.calls, 1);
    assert.equal(summary.stoppedBy, "max-calls");
  }));

test("provider error bodies stay out of the errors file and console", () =>
  withApiKey(async () => {
    const workspace = makeWorkspace();
    const marker = "provider-body-secret-marker";
    const { fetch } = fetchReturning(500, { error: { message: marker } });
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await runLive(makeOptions(workspace, { limit: 1 }), { fetch });
    } finally {
      console.log = original;
    }
    const entry = JSON.parse(readFileSync(workspace.errors, "utf8").trim()) as { error: string };
    assert.match(entry.error, /status=500/);
    assert.ok(!entry.error.includes(marker), `errors file leaked provider body: ${entry.error}`);
    for (const line of logs) {
      assert.ok(!line.includes(marker), `console leaked provider body: ${line}`);
    }
  }));

test("successful call records the mapped row and usage", () =>
  withApiKey(async () => {
    const workspace = makeWorkspace();
    const { fetch, attempts } = fetchReturning(200, okResponse);
    const summary = await runLive(makeOptions(workspace, { limit: 1 }), { fetch });
    assert.equal(attempts(), 1);
    assert.equal(summary.ok, 1);
    assert.equal(summary.inputTokens, 10);
    const row = JSON.parse(readFileSync(workspace.results, "utf8").trim()) as {
      case_id: string;
      results: { verdict: string; confidence: number }[];
    };
    assert.equal(row.case_id, "case-a");
    const first = row.results[0];
    assert.ok(first !== undefined);
    assert.equal(first.verdict, "verified");
    assert.equal(first.confidence, 0.9);
  }));

test("bounded error keeps RunLiveError context but not foreign Error payloads", () =>
  withApiKey(async () => {
    const workspace = makeWorkspace();
    const marker = "foreign-payload-marker";
    const fetch = async (): Promise<Response> => {
      throw new Error(marker);
    };
    await runLive(makeOptions(workspace, { limit: 1 }), { fetch });
    const entry = JSON.parse(readFileSync(workspace.errors, "utf8").trim()) as { error: string };
    assert.equal(entry.error, "APIConnectionError");
    assert.ok(!entry.error.includes(marker));
  }));
