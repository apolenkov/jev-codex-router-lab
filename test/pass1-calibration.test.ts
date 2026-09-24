import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Fetch } from "@typesafe-ai/sdk";
import {
  CALIBRATION_MODEL,
  CalibrationError,
  DEFAULT_CALIBRATION_CORPUS_PATH,
  loadCalibrationCorpus,
  type CalibrationCheckpoint,
  type CalibrationCheckpointStore,
  type CalibrationCorpus,
} from "../src/calibration-runner.js";
import {
  collectPass1Evidence,
  createPass1CollectionTransport,
  createPass1EvidenceSink,
  PASS1_CASE_ORDER,
  PASS1_COLLECTION_LIMITS,
  PASS1_CORPUS_FILE_SHA256,
  PASS1_QUESTION_BUILDER_SHA256,
  type Pass1CaseRecord,
  type Pass1CollectionManifest,
  type Pass1CollectionSummaryFile,
  type Pass1EvidenceSink,
} from "../src/pass1-calibration-collector.js";
import {
  createPass1CheckpointStore,
  runPass1CalibrationCli,
} from "../src/pass1-calibration-cli.js";
import { PASS1_THRESHOLDS_ENV } from "../src/pass1-thresholds.js";
import { precheck } from "../src/policy.js";
import { buildPass1Request } from "../src/questions.js";
import {
  SemanticGatewayError,
  type SystemOneClientPort,
} from "../src/semantic-gateway.js";
import {
  parsePass1Observations,
  TypeSafeGateway,
} from "../src/typesafe-gateway.js";

const TEST_PASS1_POLICY = JSON.stringify({
  choiceConfidenceMin: 0.5,
  noulUncertaintyLower: 0.4,
  noulUncertaintyUpper: 0.6,
});

const PASS1_QUESTION_IDS = new Set([
  "echo_task_id",
  "echo_task_revision",
  "echo_policy_version",
  "echo_catalog_hash",
  "task_type",
  "skill_candidates",
  "critical_gap",
  "reuse_candidate",
  "architecture_fork",
  "context_relevance",
  "risk_security",
  "risk_data_loss",
  "risk_public_contract",
  "risk_migration",
  "risk_user_behavior",
]);

const fileSha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

interface SynthesizedQuestion {
  readonly type: string;
  readonly criteria?: Record<string, unknown>;
}

const synthesizeAnswers = (
  questions: Readonly<Record<string, unknown>>,
  options: { readonly confidence?: number; readonly noul?: number } = {},
): Record<string, unknown> => {
  const confidence = options.confidence ?? 0.9;
  const noul = options.noul ?? 0.2;
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    const typed = question as SynthesizedQuestion;
    if (typed.type === "noul") {
      answers[id] = { type: "noul", noul };
      continue;
    }
    const candidates = Object.keys(typed.criteria ?? {});
    const selected = candidates[0]!;
    answers[id] = {
      type: "choice",
      choice: selected,
      confidence,
      probabilities: Object.fromEntries(
        candidates.map((candidate, index) => [
          candidate,
          index === 0 ? 0.9 : 0.1 / Math.max(1, candidates.length - 1),
        ]),
      ),
    };
  }
  return answers;
};

const envelope = (
  answers: Record<string, unknown>,
  inputTokens = 100,
): Record<string, unknown> => ({
  model: CALIBRATION_MODEL,
  usage: { input_tokens: inputTokens, output_tokens: 10 },
  answers,
});

const fakePass1Fetch = (
  overrides: {
    readonly onCase?: (caseId: string, body: Record<string, unknown>) => void;
    readonly mutateAnswers?: (
      caseId: string,
      answers: Record<string, unknown>,
    ) => void;
    readonly confidence?: number;
    readonly noul?: number;
    readonly respond?: (caseId: string) => Response | undefined;
    readonly inFlight?: { count: number; max: number };
    readonly requests?: string[];
  } = {},
): Fetch => async (_input, init) => {
  const body = JSON.parse(String(init?.body)) as {
    state: { echo: { taskId: string } };
    questions: Record<string, unknown>;
  };
  const caseId = body.state.echo.taskId;
  overrides.requests?.push(caseId);
  if (overrides.inFlight !== undefined) {
    overrides.inFlight.count += 1;
    overrides.inFlight.max = Math.max(overrides.inFlight.max, overrides.inFlight.count);
  }
  try {
    for (const id of Object.keys(body.questions)) {
      if (!PASS1_QUESTION_IDS.has(id)) {
        throw new Error(`unexpected non-pass-1 question ${id}`);
      }
    }
    const injected = overrides.respond?.(caseId);
    if (injected !== undefined) {
      return injected;
    }
    overrides.onCase?.(caseId, body);
    const answers = synthesizeAnswers(body.questions, {
      ...(overrides.confidence === undefined ? {} : { confidence: overrides.confidence }),
      ...(overrides.noul === undefined ? {} : { noul: overrides.noul }),
    });
    overrides.mutateAnswers?.(caseId, answers);
    return new Response(JSON.stringify(envelope(answers)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } finally {
    if (overrides.inFlight !== undefined) {
      overrides.inFlight.count -= 1;
    }
  }
};

const memoryCheckpointStore = (): {
  readonly store: CalibrationCheckpointStore;
  readonly snapshots: CalibrationCheckpoint[];
} => {
  let current: CalibrationCheckpoint | null = null;
  const snapshots: CalibrationCheckpoint[] = [];
  return {
    snapshots,
    store: {
      claim: async (checkpoint) => {
        if (current !== null) return false;
        current = structuredClone(checkpoint);
        snapshots.push(structuredClone(checkpoint));
        return true;
      },
      write: async (checkpoint) => {
        current = structuredClone(checkpoint);
        snapshots.push(structuredClone(checkpoint));
      },
    },
  };
};

const memorySink = (): {
  readonly sink: Pass1EvidenceSink;
  readonly manifest: { value: Pass1CollectionManifest | null };
  readonly cases: Map<string, Pass1CaseRecord>;
  readonly summary: { value: Pass1CollectionSummaryFile | null };
} => {
  const manifest: { value: Pass1CollectionManifest | null } = { value: null };
  const cases = new Map<string, Pass1CaseRecord>();
  const summary: { value: Pass1CollectionSummaryFile | null } = { value: null };
  return {
    manifest,
    cases,
    summary,
    sink: {
      writeManifest: async (value) => {
        if (manifest.value !== null) {
          throw new CalibrationError("evidence-exists");
        }
        manifest.value = structuredClone(value);
      },
      writeCaseRecord: async (caseId, record) => {
        cases.set(caseId, structuredClone(record));
      },
      writeSummary: async (value) => {
        summary.value = structuredClone(value);
      },
    },
  };
};

const calibrationReason = (reason: string) => (error: unknown): boolean =>
  error instanceof Error &&
  error.name === "CalibrationError" &&
  (error as CalibrationError).reason === reason;

const loadCorpus = (): CalibrationCorpus =>
  loadCalibrationCorpus(DEFAULT_CALIBRATION_CORPUS_PATH);

const collectWithMemorySink = async (
  corpus: CalibrationCorpus,
  fetch: Fetch,
  options: { readonly accounting?: { attempts: number; spentUsd: number } } = {},
) => {
  const checkpoint = memoryCheckpointStore();
  const sink = memorySink();
  const transport = await createPass1CollectionTransport({
    apiKey: "test-key",
    corpus,
    fetch,
    checkpoint: checkpoint.store,
    ...(options.accounting === undefined ? {} : { accounting: options.accounting }),
  });
  const result = await collectPass1Evidence({
    corpus,
    corpusFileSha256: PASS1_CORPUS_FILE_SHA256,
    questionBuilderSha256: PASS1_QUESTION_BUILDER_SHA256,
    transport,
    sink: sink.sink,
  });
  return { result, sink, checkpoint };
};

test("frozen pins match the current corpus file and question builder", () => {
  assert.equal(
    fileSha256("fixtures/calibration-corpus.json"),
    PASS1_CORPUS_FILE_SHA256,
  );
  assert.equal(fileSha256("src/questions.ts"), PASS1_QUESTION_BUILDER_SHA256);
  assert.deepEqual([...PASS1_CASE_ORDER], [
    "C1", "C2", "C3", "C4", "C5", "C6", "H1", "H2",
  ]);
  assert.deepEqual(PASS1_COLLECTION_LIMITS, {
    maxAttempts: 8,
    spendCapUsd: 0.021504,
    requestReserveUsd: 0.002688,
  });
});

test("structural pass-1 parsing preserves numeric evidence without confidence gating", async () => {
  const corpus = loadCorpus();
  const checked = precheck(corpus.cases[0]!.input);
  const request = buildPass1Request(checked);
  const answers = synthesizeAnswers(request.questions, {
    confidence: 0.4,
    noul: 0.5,
  });

  const observations = parsePass1Observations(answers, checked);

  assert.equal(observations.echo.taskId, "C1");
  assert.equal(observations.taskType.choice, "explain");
  assert.equal(observations.taskType.confidence, 0.4);
  assert.equal(
    observations.taskType.probabilities.explain,
    0.9,
  );
  assert.equal(observations.skillCandidates?.confidence, 0.4);
  assert.equal(observations.criticalGap?.choice, "gap-reproduction");
  assert.equal(observations.reuseCandidate?.choice, "reuse-parser-tests");
  assert.equal(observations.architectureFork?.choice, "fork-parser");
  assert.equal(observations.contextRelevance?.choice, "ctx-parser-contract");
  assert.equal(observations.riskDimensions.security, 0.5);
  assert.equal(observations.riskDimensions["user-behavior"], 0.5);

  const client: SystemOneClientPort = {
    systemOne: async () => envelope(answers),
  };
  await assert.rejects(
    new TypeSafeGateway(client, {
      [PASS1_THRESHOLDS_ENV]: TEST_PASS1_POLICY,
    }).pass1(checked),
    (error: unknown) =>
      error instanceof SemanticGatewayError && error.reason === "low-confidence",
  );
});

test("structural pass-1 parsing tolerates omitted optional questions", () => {
  const corpus = loadCorpus();
  const source = corpus.cases[0]!.input;
  const checked = precheck({
    ...source,
    criticalGapCandidates: [],
    architectureForkCandidates: [],
    reuseCandidates: [],
    contextFragments: [],
  });
  const request = buildPass1Request(checked);
  const answers = synthesizeAnswers(request.questions);

  const observations = parsePass1Observations(answers, checked);

  assert.equal("critical_gap" in request.questions, false);
  assert.equal(observations.criticalGap, null);
  assert.equal(observations.reuseCandidate, null);
  assert.equal(observations.architectureFork, null);
  assert.equal(observations.contextRelevance, null);
  assert.notEqual(observations.skillCandidates, null);
});

test("structural pass-1 parsing rejects stale echoes and malformed or unknown answers", () => {
  const corpus = loadCorpus();
  const checked = precheck(corpus.cases[0]!.input);
  const request = buildPass1Request(checked);
  const valid = synthesizeAnswers(request.questions);
  const withAnswer = (name: string, answer: unknown) => ({
    ...valid,
    [name]: answer,
  });

  assert.throws(
    () => parsePass1Observations(
      withAnswer("echo_task_id", {
        type: "choice",
        choice: "stale-task",
        confidence: 1,
        probabilities: { "stale-task": 1, none: 0 },
      }),
      checked,
    ),
    (error: unknown) =>
      error instanceof SemanticGatewayError && error.reason === "stale-decision",
  );
  assert.throws(
    () => parsePass1Observations(
      withAnswer("task_type", {
        type: "choice",
        choice: "invented",
        confidence: 0.9,
        probabilities: { invented: 0.9, explain: 0.1 },
      }),
      checked,
    ),
    (error: unknown) =>
      error instanceof SemanticGatewayError &&
      error.reason === "malformed-response",
  );
  assert.throws(
    () => parsePass1Observations(
      withAnswer("skill_candidates", {
        type: "choice",
        choice: "invented",
        confidence: 0.9,
        probabilities: {
          "test-driven-development": 0.4,
          brainstorming: 0.2,
          "writing-plans": 0.2,
          invented: 0.15,
          none: 0.05,
        },
      }),
      checked,
    ),
    (error: unknown) =>
      error instanceof SemanticGatewayError && error.reason === "unknown-id",
  );
  assert.throws(
    () => parsePass1Observations(
      withAnswer("risk_security", { type: "noul", noul: 1.5 }),
      checked,
    ),
    (error: unknown) =>
      error instanceof SemanticGatewayError &&
      error.reason === "malformed-response",
  );
});

test("pass-1 collection transport refuses a ninth attempt and an over-cap reservation", async () => {
  const corpus = loadCorpus();
  let calls = 0;
  const fetch: Fetch = async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  };

  const atAttemptCap = await createPass1CollectionTransport({
    apiKey: "test-key",
    corpus,
    fetch,
    checkpoint: memoryCheckpointStore().store,
    accounting: { attempts: PASS1_COLLECTION_LIMITS.maxAttempts, spentUsd: 0 },
  });
  const request = buildPass1Request(precheck(corpus.cases[0]!.input));
  await assert.rejects(
    atAttemptCap.systemOne(request),
    calibrationReason("attempt-cap"),
  );

  const overSpendCap = await createPass1CollectionTransport({
    apiKey: "test-key",
    corpus,
    fetch,
    checkpoint: memoryCheckpointStore().store,
    accounting: {
      attempts: 0,
      spentUsd:
        PASS1_COLLECTION_LIMITS.spendCapUsd -
        PASS1_COLLECTION_LIMITS.requestReserveUsd +
        0.000001,
    },
  });
  await assert.rejects(
    overSpendCap.systemOne(request),
    calibrationReason("spend-cap"),
  );
  assert.equal(calls, 0);
});

test("pass-1 collection limits are internal and cannot be overridden", async () => {
  const corpus = loadCorpus();
  let calls = 0;
  const transport = await createPass1CollectionTransport({
    apiKey: "test-key",
    corpus,
    fetch: async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    },
    checkpoint: memoryCheckpointStore().store,
    accounting: { attempts: 8, spentUsd: 0 },
    limits: { maxAttempts: 100, spendCapUsd: 100, requestReserveUsd: 1 },
  } as never);

  await assert.rejects(
    transport.systemOne(buildPass1Request(precheck(corpus.cases[0]!.input))),
    calibrationReason("attempt-cap"),
  );
  assert.equal(calls, 0);
});

test("pass-1 collection transport reserves per request and never retries or follows redirects", async () => {
  const corpus = loadCorpus();
  const scenarios: readonly [string, Fetch][] = [
    ["provider-error", async () => new Response("{}", { status: 429 })],
    ["provider-error", async () => new Response("{}", { status: 500 })],
    ["redirect", async () => new Response(null, {
      status: 302,
      headers: { location: "https://invalid.example/redirect" },
    })],
  ];

  for (const [reason, fetch] of scenarios) {
    let calls = 0;
    const checkpoint = memoryCheckpointStore();
    const transport = await createPass1CollectionTransport({
      apiKey: "test-key",
      corpus,
      checkpoint: checkpoint.store,
      fetch: async (input, init) => {
        calls += 1;
        return fetch(input, init);
      },
    });
    const request = buildPass1Request(precheck(corpus.cases[0]!.input));
    await assert.rejects(transport.systemOne(request), calibrationReason(reason));
    assert.equal(calls, 1);
    assert.equal(transport.accounting().attempts, 1);
    assert.equal(transport.accounting().terminal, true);
    assert.deepEqual(
      checkpoint.snapshots.map(({ phase }) => phase),
      ["active", "reserved", "terminal"],
    );
    assert.equal(
      checkpoint.snapshots[1]?.accounting.reservedUsd,
      PASS1_COLLECTION_LIMITS.requestReserveUsd,
    );
  }
});

test("collection records only closed typed evidence for every frozen case in order", async () => {
  const corpus = loadCorpus();
  const inFlight = { count: 0, max: 0 };
  const requests: string[] = [];
  let manifestWritten = false;
  const fetch = fakePass1Fetch({
    inFlight,
    requests,
    onCase: () => {
      assert.equal(manifestWritten, true);
    },
  });
  const checkpoint = memoryCheckpointStore();
  const sink = memorySink();
  const wrappedSink: Pass1EvidenceSink = {
    writeManifest: async (manifest) => {
      manifestWritten = true;
      await sink.sink.writeManifest(manifest);
    },
    writeCaseRecord: sink.sink.writeCaseRecord,
    writeSummary: sink.sink.writeSummary,
  };
  const transport = await createPass1CollectionTransport({
    apiKey: "test-key",
    corpus,
    fetch,
    checkpoint: checkpoint.store,
  });

  const result = await collectPass1Evidence({
    corpus,
    corpusFileSha256: PASS1_CORPUS_FILE_SHA256,
    questionBuilderSha256: PASS1_QUESTION_BUILDER_SHA256,
    transport,
    sink: wrappedSink,
  });

  assert.equal(result.status, "complete");
  assert.equal(result.failure, null);
  assert.deepEqual(requests, [...PASS1_CASE_ORDER]);
  assert.equal(inFlight.max, 1);
  assert.equal(result.accounting.attempts, 8);
  assert.equal(result.accounting.terminal, true);
  assert.equal(
    result.accounting.spentUsd,
    8 * 100 * 0.042 / 1_000_000,
  );
  assert.equal(checkpoint.snapshots.at(-1)?.phase, "complete");

  const manifest = sink.manifest.value;
  assert.equal(manifest?.kind, "pass1-confidence-evidence");
  assert.equal(manifest?.corpusFileSha256, PASS1_CORPUS_FILE_SHA256);
  assert.equal(manifest?.questionBuilderSha256, PASS1_QUESTION_BUILDER_SHA256);
  assert.equal(manifest?.model, CALIBRATION_MODEL);
  assert.equal(manifest?.sdk, "@typesafe-ai/sdk@0.6.0");
  assert.deepEqual(manifest?.caseOrder, [...PASS1_CASE_ORDER]);
  assert.deepEqual(manifest?.groups["provisional-analysis"], [
    "C1", "C2", "C3", "C4", "C5", "C6",
  ]);
  assert.deepEqual(manifest?.groups["exposed-secondary"], ["H1", "H2"]);
  assert.match(manifest?.labelStatus["provisional-analysis"] ?? "", /provisional/);
  assert.match(manifest?.labelStatus["exposed-secondary"] ?? "", /not hidden/i);
  assert.equal(manifest?.limits.maxAttempts, 8);
  assert.equal(manifest?.limits.spendCapUsd, 0.021504);
  assert.equal(manifest?.limits.requestReserveUsd, 0.002688);
  assert.equal(manifest?.limits.retries, 0);
  assert.ok((manifest?.claimLimits.length ?? 0) > 0);

  assert.equal(result.records.length, 8);
  for (const record of result.records) {
    assert.equal(record.outcome, "collected");
    assert.equal(record.metadata?.model, CALIBRATION_MODEL);
  }
  const first = result.records[0]!;
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes(corpus.cases[0]!.input.taskText), false);
  assert.equal(serialized.includes("ctx-private-build-log"), false);
  assert.equal(serialized.includes("Protected synthetic build detail"), false);
  assert.equal(serialized.includes("test-key"), false);
  assert.equal(serialized.includes("echo_"), false);
  assert.equal(serialized.includes("expected"), false);
  const answers = (first as { answers: Record<string, unknown> }).answers;
  assert.equal((answers.task_type as { type: string }).type, "choice");
  assert.equal(typeof (answers.task_type as { confidence: number }).confidence, "number");
  assert.equal((answers.risk_security as { type: string }).type, "noul");
  assert.deepEqual(Object.keys(first).sort(), [
    "answers",
    "attempts",
    "caseId",
    "costUsd",
    "group",
    "metadata",
    "outcome",
    "schemaVersion",
  ]);

  assert.equal(sink.summary.value?.status, "complete");
  assert.equal(sink.summary.value?.cases.length, 8);
  assert.equal(sink.summary.value?.accounting.attempts, 8);
});

test("collection stops on the first terminal provider failure and keeps prior records", async () => {
  const corpus = loadCorpus();
  const requests: string[] = [];
  const fetch = fakePass1Fetch({
    requests,
    respond: (caseId) =>
      caseId === "C3" ? new Response("{}", { status: 500 }) : undefined,
  });

  const { result, sink, checkpoint } = await collectWithMemorySink(corpus, fetch);

  assert.equal(result.status, "terminal");
  assert.deepEqual(requests, ["C1", "C2", "C3"]);
  assert.equal(result.failure?.caseId, "C3");
  assert.equal(result.failure?.error, "provider-error");
  assert.equal(result.records.length, 3);
  assert.equal(result.records[2]?.outcome, "failed");
  assert.equal((result.records[2] as { error: string }).error, "provider-error");
  assert.equal(result.records[2]?.attempts, 3);
  assert.equal(result.accounting.attempts, 3);
  assert.equal(result.accounting.terminal, true);
  assert.equal(checkpoint.snapshots.at(-1)?.phase, "terminal");
  assert.equal(sink.cases.size, 3);
  assert.equal(sink.summary.value?.status, "terminal");
});

test("a malformed provider answer records a bounded error and consumes the attempt", async () => {
  const corpus = loadCorpus();
  const fetch = fakePass1Fetch({
    mutateAnswers: (caseId, answers) => {
      if (caseId === "C2") {
        answers.task_type = {
          type: "choice",
          choice: "invented",
          confidence: 0.9,
          probabilities: { invented: 0.9, explain: 0.1 },
        };
      }
    },
  });

  const { result, sink } = await collectWithMemorySink(corpus, fetch);

  assert.equal(result.status, "terminal");
  assert.equal(result.records.length, 2);
  const failed = result.records[1]!;
  assert.equal(failed.outcome, "failed");
  assert.equal((failed as { error: string }).error, "malformed-response");
  assert.equal(failed.attempts, 2);
  assert.equal(failed.metadata?.model, CALIBRATION_MODEL);
  assert.equal((failed as { costUsd: number }).costUsd > 0, true);
  const persisted = sink.cases.get("C2");
  assert.equal(persisted?.outcome, "failed");
  assert.equal(JSON.stringify(persisted).includes("invented"), false);
  assert.equal(JSON.stringify(persisted).includes("answers"), false);
});

test("collection refuses mismatched fingerprints before writing or dispatching", async () => {
  const corpus = loadCorpus();
  let calls = 0;
  const transport = await createPass1CollectionTransport({
    apiKey: "test-key",
    corpus,
    fetch: async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    },
    checkpoint: memoryCheckpointStore().store,
  });
  const sink = memorySink();

  await assert.rejects(
    collectPass1Evidence({
      corpus,
      corpusFileSha256: "0".repeat(64),
      questionBuilderSha256: PASS1_QUESTION_BUILDER_SHA256,
      transport,
      sink: sink.sink,
    }),
    calibrationReason("fingerprint-mismatch"),
  );
  assert.equal(calls, 0);
  assert.equal(sink.manifest.value, null);
  assert.equal(sink.cases.size, 0);
});

test("collection does not need pass-1 thresholds and never invokes the gated route", async () => {
  const corpus = loadCorpus();
  const checked = precheck(corpus.cases[0]!.input);

  await assert.rejects(
    new TypeSafeGateway(
      {
        systemOne: async () => {
          throw new Error("must not be called");
        },
      },
      {},
    ).pass1(checked),
    (error: unknown) =>
      error instanceof SemanticGatewayError &&
      error.reason === "uncalibrated-thresholds",
  );

  const { result } = await collectWithMemorySink(corpus, fakePass1Fetch());
  assert.equal(result.status, "complete");
});

const makeRepositoryFixture = async (t: TestContext): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "jev-pass1-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "fixtures"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "artifacts"));
  await writeFile(
    join(root, "fixtures", "calibration-corpus.json"),
    readFileSync("fixtures/calibration-corpus.json"),
  );
  await writeFile(
    join(root, "src", "questions.ts"),
    readFileSync("src/questions.ts"),
  );
  return root;
};

test("pass-1 CLI rejects arguments and refuses to run without an API key", async (t) => {
  const root = await makeRepositoryFixture(t);
  let calls = 0;
  const fetch: Fetch = async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  };

  const badArgs = await runPass1CalibrationCli(["--verbose"], {
    repositoryRoot: root,
    env: { TYPESAFE_API_KEY: "test-key" },
    fetch,
  });
  assert.equal(badArgs.exitCode, 2);
  assert.equal(badArgs.error, "invalid CLI usage");

  const noKey = await runPass1CalibrationCli([], {
    repositoryRoot: root,
    env: {},
    fetch,
  });
  assert.equal(noKey.exitCode, 2);
  assert.equal(noKey.error, "missing TYPESAFE_API_KEY");
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(join(root, "artifacts")), []);
});

test("pass-1 CLI writes single-use closed evidence under the ignored directory", async (t) => {
  const root = await makeRepositoryFixture(t);
  const requests: string[] = [];
  const result = await runPass1CalibrationCli([], {
    repositoryRoot: root,
    env: { TYPESAFE_API_KEY: "test-key" },
    fetch: fakePass1Fetch({ requests }),
  });

  assert.equal(result.exitCode, 0, result.error);
  assert.equal(result.summary?.status, "complete");
  assert.equal(result.summary?.collectedCases, 8);
  assert.equal(result.summary?.attempts, 8);
  assert.deepEqual(requests, [...PASS1_CASE_ORDER]);

  const evidenceDir = join(root, "artifacts", "pass1-calibration");
  const names = (await readdir(evidenceDir)).sort();
  assert.deepEqual(names, [
    "case-C1.json",
    "case-C2.json",
    "case-C3.json",
    "case-C4.json",
    "case-C5.json",
    "case-C6.json",
    "case-H1.json",
    "case-H2.json",
    "checkpoint.json",
    "manifest.json",
    "summary.json",
  ]);
  for (const name of names) {
    assert.equal((await stat(join(evidenceDir, name))).mode & 0o777, 0o600);
  }

  const manifest = JSON.parse(
    await readFile(join(evidenceDir, "manifest.json"), "utf8"),
  ) as Pass1CollectionManifest;
  assert.equal(manifest.corpusFileSha256, PASS1_CORPUS_FILE_SHA256);
  assert.equal(manifest.questionBuilderSha256, PASS1_QUESTION_BUILDER_SHA256);
  const caseFile = JSON.parse(
    await readFile(join(evidenceDir, "case-C1.json"), "utf8"),
  ) as Record<string, unknown>;
  const corpus = loadCorpus();
  assert.equal(JSON.stringify(caseFile).includes(corpus.cases[0]!.input.taskText), false);
  assert.equal(JSON.stringify(caseFile).includes("test-key"), false);
  const summary = JSON.parse(
    await readFile(join(evidenceDir, "summary.json"), "utf8"),
  ) as Pass1CollectionSummaryFile;
  assert.equal(summary.status, "complete");
  assert.equal(summary.accounting.attempts, 8);

  const second = await runPass1CalibrationCli([], {
    repositoryRoot: root,
    env: { TYPESAFE_API_KEY: "test-key" },
    fetch: fakePass1Fetch({ requests }),
  });
  assert.equal(second.exitCode, 2);
  assert.deepEqual(requests, [...PASS1_CASE_ORDER]);
});

test("pass-1 CLI aborts when the artifacts parent is swapped mid-run", async (t) => {
  const root = await makeRepositoryFixture(t);
  const outside = await mkdtemp(join(tmpdir(), "jev-pass1-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));

  const requests: string[] = [];
  let swapped = false;
  const fetch = fakePass1Fetch({
    requests,
    onCase: () => {
      if (swapped) return;
      swapped = true;
      renameSync(join(root, "artifacts"), join(outside, "artifacts"));
      symlinkSync(join(outside, "artifacts"), join(root, "artifacts"));
    },
  });
  const result = await runPass1CalibrationCli([], {
    repositoryRoot: root,
    env: { TYPESAFE_API_KEY: "test-key" },
    fetch,
  });

  assert.equal(result.exitCode, 2);
  assert.deepEqual(requests, ["C1"]);
  assert.deepEqual(
    (await readdir(join(outside, "artifacts", "pass1-calibration"))).sort(),
    ["checkpoint.json", "manifest.json"],
  );
});

test("exclusive writer aborts before payload after an observed parent swap", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-pass1-swap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = await mkdtemp(join(tmpdir(), "jev-pass1-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const inner = join(root, "inner");
  await mkdir(inner);

  let calls = 0;
  const sink = createPass1EvidenceSink(inner, async () => {
    calls += 1;
    if (calls === 2) {
      // Move the directory after the exclusive open, before payload bytes.
      renameSync(inner, join(outside, "inner"));
      symlinkSync(join(outside, "inner"), inner);
      throw new CalibrationError("evidence-write");
    }
  });
  const manifest = {
    schemaVersion: 1,
    kind: "pass1-confidence-evidence",
  } as Pass1CollectionManifest;

  await assert.rejects(
    sink.writeManifest(manifest),
    calibrationReason("evidence-write"),
  );
  assert.deepEqual(await readdir(join(outside, "inner")), ["manifest.json"]);
  assert.equal((await stat(join(outside, "inner", "manifest.json"))).size, 0);
});

test("exclusive writer never unlinks a swapped foreign destination", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-pass1-swap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = await mkdtemp(join(tmpdir(), "jev-pass1-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const inner = join(root, "inner");
  await mkdir(inner);
  const victim = join(outside, "victim.txt");
  await writeFile(victim, "precious");

  let swapped = false;
  const sink = createPass1EvidenceSink(inner, async () => {
    if (swapped) return;
    try {
      await stat(join(inner, "manifest.json"));
    } catch {
      return;
    }
    rmSync(join(inner, "manifest.json"));
    symlinkSync(victim, join(inner, "manifest.json"));
    swapped = true;
    throw new CalibrationError("evidence-write");
  });
  const manifest = {
    schemaVersion: 1,
    kind: "pass1-confidence-evidence",
  } as Pass1CollectionManifest;

  await assert.rejects(
    sink.writeManifest(manifest),
    calibrationReason("evidence-write"),
  );
  assert.equal(swapped, true);
  assert.equal(await readFile(victim, "utf8"), "precious");
});

test("exclusive writer preserves a foreign regular file swapped into the destination", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jev-pass1-foreign-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = join(directory, "manifest.json");
  const foreign = join(directory, "foreign.json");
  await writeFile(foreign, "precious");

  let swapped = false;
  const sink = createPass1EvidenceSink(directory, async () => {
    if (swapped) return;
    try {
      await stat(destination);
    } catch {
      return;
    }
    renameSync(destination, join(directory, "owned.moved.json"));
    renameSync(foreign, destination);
    swapped = true;
    throw new CalibrationError("evidence-write");
  });
  const manifest = {
    schemaVersion: 1,
    kind: "pass1-confidence-evidence",
  } as Pass1CollectionManifest;

  await assert.rejects(
    sink.writeManifest(manifest),
    calibrationReason("evidence-write"),
  );
  assert.equal(swapped, true);
  assert.equal(await readFile(destination, "utf8"), "precious");
});

test("checkpoint store preserves foreign data when its parent is swapped", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-pass1-swap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = await mkdtemp(join(tmpdir(), "jev-pass1-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const directory = join(root, "pass1-calibration");
  await mkdir(directory);
  const checkpoint: CalibrationCheckpoint = {
    schemaVersion: 1,
    corpusFingerprint: "0".repeat(64),
    phase: "active",
    accounting: { attempts: 0, spentUsd: 0, reservedUsd: 0, terminal: false },
    failureReason: null,
  };

  let calls = 0;
  const store = createPass1CheckpointStore(
    join(directory, "checkpoint.json"),
    async () => {
      calls += 1;
      if (calls === 3) {
        // Swap the parent after writing through the claimed file handle.
        renameSync(directory, join(outside, "evidence"));
        symlinkSync(join(outside, "evidence"), directory);
        throw new CalibrationError("evidence-write");
      }
    },
  );
  try {
    await assert.rejects(store.claim(checkpoint), calibrationReason("evidence-write"));
    assert.deepEqual(await readdir(join(outside, "evidence")), ["checkpoint.json"]);
    assert.deepEqual(await readdir(directory), ["checkpoint.json"]);
  } finally {
    await store.close();
  }
});

test("pass-1 checkpoint writes through its claimed file without replacing a foreign file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jev-pass1-checkpoint-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "checkpoint.json");
  const moved = join(directory, "owned.moved.json");
  const initial: CalibrationCheckpoint = {
    schemaVersion: 1,
    corpusFingerprint: "0".repeat(64),
    phase: "active",
    accounting: { attempts: 0, spentUsd: 0, reservedUsd: 0, terminal: false },
    failureReason: null,
  };
  const store = createPass1CheckpointStore(path, async () => undefined);
  try {
    assert.equal(await store.claim(initial), true);
    renameSync(path, moved);
    await writeFile(path, "foreign");
    await store.write({
      ...initial,
      accounting: { ...initial.accounting, attempts: 1 },
    });
    assert.equal(await readFile(path, "utf8"), "foreign");
    assert.equal(JSON.parse(await readFile(moved, "utf8")).accounting.attempts, 1);
  } finally {
    await store.close();
  }
});

test("exclusive evidence writer refuses to replace an existing artifact", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jev-pass1-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sink = createPass1EvidenceSink(directory);
  const manifest = { schemaVersion: 1, kind: "pass1-confidence-evidence" } as Pass1CollectionManifest;

  await sink.writeManifest(manifest);
  await assert.rejects(
    sink.writeManifest(manifest),
    calibrationReason("evidence-exists"),
  );
  await assert.rejects(
    sink.writeCaseRecord("C9", { schemaVersion: 1 } as Pass1CaseRecord),
    calibrationReason("invalid-case-id"),
  );
});
