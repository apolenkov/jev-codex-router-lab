import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Fetch } from "@typesafe-ai/sdk";
import {
  CALIBRATION_MODEL,
  CalibrationError,
  type CalibrationCheckpoint,
  type CalibrationCheckpointStore,
} from "../src/calibration-runner.js";
import {
  createPass1ThresholdEvidenceSink,
  createPass1ThresholdTransport,
  parsePass1AnnotatedCorpus,
  parsePass1CorpusManifest,
  parsePass1ThresholdCaseRecord,
  runPass1ThresholdCollection,
  PASS1_THRESHOLD_LIMITS,
  PASS1_THRESHOLD_TIMEOUT_MS,
  type Pass1AnnotatedCorpus,
  type Pass1CorpusSplit,
  type Pass1ThresholdCaseRecord,
  type Pass1ThresholdEvidenceManifest,
  type Pass1ThresholdEvidenceSink,
  type Pass1ThresholdEvidenceSummary,
} from "../src/pass1-threshold-runner.js";
import { buildPass1Request } from "../src/questions.js";

const CALIBRATION_CORPUS_PATH = "fixtures/pass1-calibration-cases.json";
const EVALUATION_CORPUS_PATH = "fixtures/pass1-evaluation-cases.json";
const CORPUS_MANIFEST_PATH = "fixtures/pass1-corpus-manifest.json";
const QUESTION_BUILDER_PATH = "src/questions.ts";

const fileSha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

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
      ...(overrides.confidence === undefined
        ? {}
        : { confidence: overrides.confidence }),
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
  readonly sink: Pass1ThresholdEvidenceSink;
  readonly manifest: { value: Pass1ThresholdEvidenceManifest | null };
  readonly cases: Map<string, Pass1ThresholdCaseRecord>;
  readonly summary: { value: Pass1ThresholdEvidenceSummary | null };
} => {
  const manifest: { value: Pass1ThresholdEvidenceManifest | null } = {
    value: null,
  };
  const cases = new Map<string, Pass1ThresholdCaseRecord>();
  const summary: { value: Pass1ThresholdEvidenceSummary | null } = {
    value: null,
  };
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

const loadCorpus = (split: Pass1CorpusSplit): Pass1AnnotatedCorpus =>
  parsePass1AnnotatedCorpus(
    readFileSync(
      split === "calibration" ? CALIBRATION_CORPUS_PATH : EVALUATION_CORPUS_PATH,
      "utf8",
    ),
    split,
  );

const loadPins = (split: Pass1CorpusSplit) => {
  const manifest = parsePass1CorpusManifest(
    readFileSync(CORPUS_MANIFEST_PATH, "utf8"),
  );
  return {
    corpusFileSha256: manifest.splits[split].sha256,
    questionBuilderSha256: manifest.questionBuilder.sha256,
  };
};

const collectWithMemorySink = async (
  corpus: Pass1AnnotatedCorpus,
  fetch: Fetch,
  split: Pass1CorpusSplit = "calibration",
) => {
  const checkpoint = memoryCheckpointStore();
  const sink = memorySink();
  const transport = await createPass1ThresholdTransport({
    apiKey: "test-key",
    corpus,
    fetch,
    checkpoint: checkpoint.store,
    limits: PASS1_THRESHOLD_LIMITS[split],
  });
  const pins = loadPins(split);
  const result = await runPass1ThresholdCollection({
    split,
    corpus,
    corpusPath: manifest0(split).path,
    pins,
    actual: {
      corpusFileSha256: fileSha256(manifest0(split).path),
      questionBuilderSha256: fileSha256(QUESTION_BUILDER_PATH),
    },
    transport,
    sink: sink.sink,
  });
  return { result, sink, checkpoint, transport };
};

const manifest0 = (split: Pass1CorpusSplit) =>
  parsePass1CorpusManifest(readFileSync(CORPUS_MANIFEST_PATH, "utf8")).splits[
    split
  ];

test("corpus manifest pins match the frozen corpus files and question builder", () => {
  const manifest = parsePass1CorpusManifest(
    readFileSync(CORPUS_MANIFEST_PATH, "utf8"),
  );
  assert.equal(manifest.splits.calibration.path, CALIBRATION_CORPUS_PATH);
  assert.equal(manifest.splits.evaluation.path, EVALUATION_CORPUS_PATH);
  assert.equal(manifest.questionBuilder.path, QUESTION_BUILDER_PATH);
  assert.equal(
    manifest.splits.calibration.sha256,
    fileSha256(CALIBRATION_CORPUS_PATH),
  );
  assert.equal(
    manifest.splits.evaluation.sha256,
    fileSha256(EVALUATION_CORPUS_PATH),
  );
  assert.equal(
    manifest.questionBuilder.sha256,
    fileSha256(QUESTION_BUILDER_PATH),
  );
  assert.equal(PASS1_THRESHOLD_TIMEOUT_MS, 120_000);
  assert.deepEqual(PASS1_THRESHOLD_LIMITS.calibration, {
    maxAttempts: 56,
    spendCapUsd: 0.25,
    requestReserveUsd: 0.002688,
  });
  assert.deepEqual(PASS1_THRESHOLD_LIMITS.evaluation, {
    maxAttempts: 28,
    spendCapUsd: 0.25,
    requestReserveUsd: 0.002688,
  });
});

test("corpus manifest parser rejects malformed manifests", () => {
  const valid = JSON.parse(readFileSync(CORPUS_MANIFEST_PATH, "utf8")) as Record<
    string,
    unknown
  >;
  const corrupt = (mutate: (value: Record<string, unknown>) => void): string => {
    const copy = structuredClone(valid);
    mutate(copy);
    return JSON.stringify(copy);
  };

  assert.throws(
    () => parsePass1CorpusManifest("not json"),
    calibrationReason("invalid-corpus-manifest"),
  );
  assert.throws(
    () =>
      parsePass1CorpusManifest(
        corrupt((value) => {
          delete value.hashes;
        }),
      ),
    calibrationReason("invalid-corpus-manifest"),
  );
  assert.throws(
    () =>
      parsePass1CorpusManifest(
        corrupt((value) => {
          (value.hashes as Record<string, unknown>).questionBuilder = {
            path: QUESTION_BUILDER_PATH,
            sha256: "not-a-sha",
          };
        }),
      ),
    calibrationReason("invalid-corpus-manifest"),
  );
  assert.throws(
    () =>
      parsePass1CorpusManifest(
        corrupt((value) => {
          ((value.hashes as Record<string, unknown>).splits as Record<
            string,
            unknown
          >).calibration = { path: "elsewhere.json" };
        }),
      ),
    calibrationReason("invalid-corpus-manifest"),
  );
});

test("annotated corpus parser exposes ordered cases with typed gold labels", () => {
  const corpus = loadCorpus("calibration");
  assert.equal(corpus.split, "calibration");
  assert.equal(corpus.cases.length, 56);
  assert.equal(corpus.cases[0]?.caseId, "CAL-001");
  assert.equal(corpus.cases.at(-1)?.caseId, "CAL-056");
  for (const corpusCase of corpus.cases) {
    assert.match(corpusCase.caseId, /^CAL-\d{3}$/);
    assert.equal(corpusCase.input.taskId, corpusCase.caseId);
  }
  const first = corpus.cases[0]!;
  assert.equal(first.labels.taskType.status, "resolved");
  assert.equal(first.labels.taskType.value, "diagnose");
  assert.deepEqual(first.labels.skillCandidates.value, [
    "skill-latency-regression-triage",
  ]);
  assert.equal(first.labels.criticalGap.value, null);
  assert.equal(first.labels.architectureFork.status, "not_queried");
  assert.equal(first.labels.riskDimensions["public-contract"].value, "positive");

  const evaluation = loadCorpus("evaluation");
  assert.equal(evaluation.split, "evaluation");
  assert.equal(evaluation.cases.length, 28);
  assert.equal(evaluation.cases[0]?.caseId, "EVAL-001");
});

test("annotated corpus parser rejects wrong split, size, and label drift", () => {
  const calibrationText = readFileSync(CALIBRATION_CORPUS_PATH, "utf8");
  assert.throws(
    () => parsePass1AnnotatedCorpus(calibrationText, "evaluation"),
    calibrationReason("invalid-corpus"),
  );
  const evaluationText = readFileSync(EVALUATION_CORPUS_PATH, "utf8");
  assert.throws(
    () => parsePass1AnnotatedCorpus(evaluationText, "calibration"),
    calibrationReason("invalid-corpus"),
  );
  assert.throws(
    () => parsePass1AnnotatedCorpus("not json", "calibration"),
    calibrationReason("invalid-corpus"),
  );

  const valid = JSON.parse(calibrationText) as {
    cases: Record<string, unknown>[];
  };
  const corrupt = (mutate: (value: {
    cases: Record<string, unknown>[];
  }) => void): string => {
    const copy = structuredClone(valid);
    mutate(copy);
    return JSON.stringify(copy);
  };
  assert.throws(
    () =>
      parsePass1AnnotatedCorpus(
        corrupt((value) => {
          value.cases.pop();
        }),
        "calibration",
      ),
    calibrationReason("invalid-corpus"),
  );
  assert.throws(
    () =>
      parsePass1AnnotatedCorpus(
        corrupt((value) => {
          value.cases[0]!.caseId = "ZZZ-999";
        }),
        "calibration",
      ),
    calibrationReason("invalid-corpus-case"),
  );
  assert.throws(
    () =>
      parsePass1AnnotatedCorpus(
        corrupt((value) => {
          const labels = value.cases[0]!.labels as Record<
            string,
            Record<string, unknown>
          >;
          labels.taskType = {
            status: "resolved",
            value: "invented",
            evidence: [],
          };
        }),
        "calibration",
      ),
    calibrationReason("invalid-corpus-label"),
  );
  assert.throws(
    () =>
      parsePass1AnnotatedCorpus(
        corrupt((value) => {
          const labels = value.cases[0]!.labels as Record<
            string,
            Record<string, unknown>
          >;
          labels.reuseCandidate = {
            status: "resolved",
            value: 42,
            evidence: [],
          };
        }),
        "calibration",
      ),
    calibrationReason("invalid-corpus-label"),
  );
  assert.throws(
    () =>
      parsePass1AnnotatedCorpus(
        corrupt((value) => {
          const labels = value.cases[0]!.labels as Record<
            string,
            unknown
          >;
          const risks = labels.riskDimensions as Record<
            string,
            Record<string, unknown>
          >;
          risks.security = { status: "resolved", value: "maybe", evidence: [] };
        }),
        "calibration",
      ),
    calibrationReason("invalid-corpus-label"),
  );
  assert.throws(
    () =>
      parsePass1AnnotatedCorpus(
        corrupt((value) => {
          const labels = value.cases[0]!.labels as Record<
            string,
            Record<string, unknown>
          >;
          labels.taskType = { status: "not_queried", value: "diagnose", evidence: [] };
        }),
        "calibration",
      ),
    calibrationReason("invalid-corpus-label"),
  );
  assert.throws(
    () =>
      parsePass1AnnotatedCorpus(
        corrupt((value) => {
          const input = value.cases[0]!.input as Record<string, unknown>;
          input.taskId = "OTHER-000";
        }),
        "calibration",
      ),
    calibrationReason("invalid-corpus-input"),
  );
});

test("threshold transport enforces attempt cap, spend cap, and counted attempts", async () => {
  const corpus = loadCorpus("calibration");
  let calls = 0;
  const fetch: Fetch = async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  };
  const request = buildPass1Request(corpus.cases[0]!.input);

  const atAttemptCap = await createPass1ThresholdTransport({
    apiKey: "test-key",
    corpus,
    fetch,
    checkpoint: memoryCheckpointStore().store,
    limits: PASS1_THRESHOLD_LIMITS.calibration,
    accounting: {
      attempts: PASS1_THRESHOLD_LIMITS.calibration.maxAttempts,
      spentUsd: 0,
    },
  });
  await assert.rejects(
    atAttemptCap.systemOne(request),
    calibrationReason("attempt-cap"),
  );

  const overSpendCap = await createPass1ThresholdTransport({
    apiKey: "test-key",
    corpus,
    fetch,
    checkpoint: memoryCheckpointStore().store,
    limits: PASS1_THRESHOLD_LIMITS.calibration,
    accounting: {
      attempts: 0,
      spentUsd:
        PASS1_THRESHOLD_LIMITS.calibration.spendCapUsd -
        PASS1_THRESHOLD_LIMITS.calibration.requestReserveUsd +
        0.000001,
    },
  });
  await assert.rejects(
    overSpendCap.systemOne(request),
    calibrationReason("spend-cap"),
  );
  assert.equal(calls, 0);
});

test("threshold transport aborts on terminal statuses and thrown fetch errors", async () => {
  const corpus = loadCorpus("calibration");
  const scenarios: readonly [string, Fetch][] = [
    ["provider-error", async () => new Response("{}", { status: 429 })],
    ["provider-error", async () => new Response("{}", { status: 500 })],
    ["provider-error", async () => {
      throw new Error("connection reset");
    }],
    ["redirect", async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://invalid.example/redirect" },
      })],
  ];
  for (const [reason, fetch] of scenarios) {
    let calls = 0;
    const checkpoint = memoryCheckpointStore();
    const transport = await createPass1ThresholdTransport({
      apiKey: "test-key",
      corpus,
      checkpoint: checkpoint.store,
      limits: PASS1_THRESHOLD_LIMITS.calibration,
      fetch: async (input, init) => {
        calls += 1;
        return fetch(input, init);
      },
    });
    const request = buildPass1Request(corpus.cases[0]!.input);
    await assert.rejects(transport.systemOne(request), calibrationReason(reason));
    assert.equal(calls, 1);
    assert.equal(transport.accounting().attempts, 1);
    assert.equal(transport.accounting().terminal, true);
    assert.deepEqual(
      checkpoint.snapshots.map(({ phase }) => phase),
      ["active", "reserved", "terminal"],
    );
  }
});

test("threshold transport honours the injected sdk client factory", async () => {
  const corpus = loadCorpus("calibration");
  let fetchCalls = 0;
  let clientCalls = 0;
  const request = buildPass1Request(corpus.cases[0]!.input);
  const answers = synthesizeAnswers(request.questions);
  const transport = await createPass1ThresholdTransport({
    apiKey: "test-key",
    corpus,
    limits: PASS1_THRESHOLD_LIMITS.calibration,
    checkpoint: memoryCheckpointStore().store,
    fetch: async (_input, init) => {
      fetchCalls += 1;
      const body = JSON.parse(String(init?.body)) as {
        state: { echo: { taskId: string } };
        questions: Record<string, unknown>;
      };
      assert.equal(body.state.echo.taskId, "CAL-001");
      return new Response(JSON.stringify(envelope(answers)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    createClient: ({ apiKey, fetch, timeoutMs }) => {
      assert.equal(apiKey, "test-key");
      assert.equal(timeoutMs, PASS1_THRESHOLD_TIMEOUT_MS);
      return {
        systemOne: async (systemOneRequest) => {
          clientCalls += 1;
          assert.equal(systemOneRequest.model, CALIBRATION_MODEL);
          const response = await fetch("https://invalid.example/v1/systemone", {
            method: "POST",
            body: JSON.stringify(systemOneRequest),
          });
          assert.equal(response.status, 200);
          return await response.json();
        },
      };
    },
  });

  const result = await transport.systemOne(request);
  assert.equal(clientCalls, 1);
  assert.equal(fetchCalls, 1);
  assert.equal(result.metadata.model, CALIBRATION_MODEL);
  assert.equal(result.metadata.inputTokens, 100);
  assert.equal(transport.accounting().attempts, 1);
});

test("collection records ordered closed evidence for every corpus case", async () => {
  const corpus = loadCorpus("calibration");
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
  const wrappedSink: Pass1ThresholdEvidenceSink = {
    writeManifest: async (manifest) => {
      manifestWritten = true;
      await sink.sink.writeManifest(manifest);
    },
    writeCaseRecord: sink.sink.writeCaseRecord,
    writeSummary: sink.sink.writeSummary,
  };
  const transport = await createPass1ThresholdTransport({
    apiKey: "test-key",
    corpus,
    fetch,
    checkpoint: checkpoint.store,
    limits: PASS1_THRESHOLD_LIMITS.calibration,
  });
  const pins = loadPins("calibration");
  const result = await runPass1ThresholdCollection({
    split: "calibration",
    corpus,
    corpusPath: CALIBRATION_CORPUS_PATH,
    pins,
    actual: {
      corpusFileSha256: fileSha256(CALIBRATION_CORPUS_PATH),
      questionBuilderSha256: fileSha256(QUESTION_BUILDER_PATH),
    },
    transport,
    sink: wrappedSink,
  });

  assert.equal(result.status, "complete");
  assert.equal(result.failure, null);
  assert.deepEqual(requests, corpus.cases.map(({ caseId }) => caseId));
  assert.equal(inFlight.max, 1);
  assert.equal(result.accounting.attempts, 56);
  assert.equal(result.accounting.terminal, true);
  assert.ok(
    Math.abs(result.accounting.spentUsd - 56 * 100 * 0.042 / 1_000_000) < 1e-9,
  );
  assert.equal(checkpoint.snapshots.at(-1)?.phase, "complete");

  const manifest = sink.manifest.value;
  assert.equal(manifest?.kind, "pass1-threshold-evidence");
  assert.equal(manifest?.split, "calibration");
  assert.equal(manifest?.corpusPath, CALIBRATION_CORPUS_PATH);
  assert.equal(manifest?.corpusFileSha256, pins.corpusFileSha256);
  assert.equal(
    manifest?.questionBuilderSha256,
    pins.questionBuilderSha256,
  );
  assert.equal(manifest?.model, CALIBRATION_MODEL);
  assert.equal(manifest?.sdk, "@typesafe-ai/sdk@0.6.0");
  assert.deepEqual(
    manifest?.caseOrder,
    corpus.cases.map(({ caseId }) => caseId),
  );
  assert.equal(manifest?.limits.maxAttempts, 56);
  assert.equal(manifest?.limits.spendCapUsd, 0.25);
  assert.equal(manifest?.limits.requestReserveUsd, 0.002688);
  assert.equal(manifest?.limits.timeoutMs, PASS1_THRESHOLD_TIMEOUT_MS);
  assert.equal(manifest?.limits.retries, 0);
  assert.equal(manifest?.limits.redirects, "manual");

  assert.equal(result.records.length, 56);
  for (const record of result.records) {
    assert.equal(record.outcome, "collected");
  }
  const first = result.records[0]!;
  assert.equal(first.caseId, "CAL-001");
  assert.equal(first.attempts, 1);
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes(corpus.cases[0]!.input.taskText), false);
  assert.equal(serialized.includes("test-key"), false);
  const collected = first as Extract<
    Pass1ThresholdCaseRecord,
    { outcome: "collected" }
  >;
  assert.equal(collected.answers.task_type?.type, "choice");
  assert.equal(collected.answers.risk_security?.type, "noul");
  assert.ok(collected.questionKeys.includes("task_type"));
  assert.ok(collected.questionKeys.includes("echo_task_id"));
  assert.equal(collected.metadata.model, CALIBRATION_MODEL);
  assert.equal(collected.metadata.inputTokens, 100);
  assert.ok(collected.metadata.latencyMs >= 0);
  assert.ok(collected.costUsd > 0);

  const summary = sink.summary.value;
  assert.equal(summary?.status, "complete");
  assert.equal(summary?.incomplete, false);
  assert.equal(summary?.cases.length, 56);
  assert.ok(
    summary?.cases.every(
      (entry) => entry.status === "collected",
    ),
  );
  assert.equal(summary?.accounting.attempts, 56);
});

test("a schema-invalid provider response is recorded and the run continues", async () => {
  const corpus = loadCorpus("calibration");
  const requests: string[] = [];
  const fetch = fakePass1Fetch({
    requests,
    mutateAnswers: (caseId, answers) => {
      if (caseId === "CAL-002") {
        answers.task_type = {
          type: "choice",
          choice: "invented",
          confidence: 0.9,
          probabilities: { invented: 0.9, explain: 0.1 },
        };
      }
      if (caseId === "CAL-004") {
        answers.risk_security = { type: "noul", noul: 1.5 };
      }
    },
  });

  const { result, sink } = await collectWithMemorySink(corpus, fetch);

  assert.equal(result.status, "complete");
  assert.equal(result.failure, null);
  assert.equal(requests.length, 56);
  const invalid = result.records[1]!;
  assert.equal(invalid.caseId, "CAL-002");
  assert.equal(invalid.outcome, "invalid-response");
  const invalidRecord = invalid as Extract<
    Pass1ThresholdCaseRecord,
    { outcome: "invalid-response" }
  >;
  assert.equal(invalidRecord.reason, "malformed-response");
  assert.equal(invalidRecord.attempts, 2);
  assert.equal(invalidRecord.metadata?.model, CALIBRATION_MODEL);
  assert.ok((invalidRecord.costUsd ?? 0) > 0);
  assert.equal(JSON.stringify(invalidRecord).includes("invented"), false);
  assert.equal(result.records[3]?.outcome, "invalid-response");
  assert.equal(result.records[2]?.outcome, "collected");
  assert.equal(result.records[4]?.outcome, "collected");

  const summary = sink.summary.value;
  assert.equal(summary?.status, "complete");
  assert.equal(
    summary?.cases.filter((entry) => entry.status === "invalid-response")
      .length,
    2,
  );
});

test("collection aborts on the first terminal failure and marks evidence incomplete", async () => {
  const corpus = loadCorpus("calibration");
  const requests: string[] = [];
  const fetch = fakePass1Fetch({
    requests,
    respond: (caseId) =>
      caseId === "CAL-003" ? new Response("{}", { status: 500 }) : undefined,
  });

  const { result, sink, checkpoint } = await collectWithMemorySink(
    corpus,
    fetch,
  );

  assert.equal(result.status, "incomplete");
  assert.deepEqual(requests, ["CAL-001", "CAL-002", "CAL-003"]);
  assert.equal(result.failure?.caseId, "CAL-003");
  assert.equal(result.failure?.error, "provider-error");
  assert.equal(result.records.length, 3);
  assert.equal(result.records[2]?.outcome, "failed");
  assert.equal(
    (result.records[2] as { error: string }).error,
    "provider-error",
  );
  assert.equal(result.accounting.terminal, true);
  assert.equal(checkpoint.snapshots.at(-1)?.phase, "terminal");
  assert.equal(sink.cases.size, 3);

  const summary = sink.summary.value;
  assert.equal(summary?.status, "incomplete");
  assert.equal(summary?.incomplete, true);
  assert.equal(summary?.cases.length, 56);
  assert.equal(
    summary?.cases.filter((entry) => entry.status === "aborted").length,
    53,
  );
  assert.equal(summary?.cases[2]?.status, "failed");
  assert.equal(summary?.cases[2]?.error, "provider-error");
});

test("collection refuses fingerprint drift before writing or dispatching", async () => {
  const corpus = loadCorpus("calibration");
  let calls = 0;
  const transport = await createPass1ThresholdTransport({
    apiKey: "test-key",
    corpus,
    fetch: async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    },
    checkpoint: memoryCheckpointStore().store,
    limits: PASS1_THRESHOLD_LIMITS.calibration,
  });
  const sink = memorySink();

  await assert.rejects(
    runPass1ThresholdCollection({
      split: "calibration",
      corpus,
      corpusPath: CALIBRATION_CORPUS_PATH,
      pins: {
        corpusFileSha256: "0".repeat(64),
        questionBuilderSha256: loadPins("calibration").questionBuilderSha256,
      },
      actual: {
        corpusFileSha256: fileSha256(CALIBRATION_CORPUS_PATH),
        questionBuilderSha256: fileSha256(QUESTION_BUILDER_PATH),
      },
      transport,
      sink: sink.sink,
    }),
    calibrationReason("fingerprint-mismatch"),
  );
  assert.equal(calls, 0);
  assert.equal(sink.manifest.value, null);
  assert.equal(sink.cases.size, 0);
});

test("collection refuses a transport bound to another corpus", async () => {
  const corpus = loadCorpus("calibration");
  const other = loadCorpus("evaluation");
  const transport = await createPass1ThresholdTransport({
    apiKey: "test-key",
    corpus: other,
    fetch: fakePass1Fetch(),
    checkpoint: memoryCheckpointStore().store,
    limits: PASS1_THRESHOLD_LIMITS.evaluation,
  });
  const sink = memorySink();
  const pins = loadPins("calibration");
  await assert.rejects(
    runPass1ThresholdCollection({
      split: "calibration",
      corpus,
      corpusPath: CALIBRATION_CORPUS_PATH,
      pins,
      actual: {
        corpusFileSha256: fileSha256(CALIBRATION_CORPUS_PATH),
        questionBuilderSha256: fileSha256(QUESTION_BUILDER_PATH),
      },
      transport,
      sink: sink.sink,
    }),
    calibrationReason("corpus-fingerprint-mismatch"),
  );
});

test("evidence sink writes create-once files and validates case file names", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jev-threshold-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sink = createPass1ThresholdEvidenceSink(directory);
  const manifest = {
    schemaVersion: 1,
    kind: "pass1-threshold-evidence",
  } as Pass1ThresholdEvidenceManifest;

  await sink.writeManifest(manifest);
  await assert.rejects(
    sink.writeManifest(manifest),
    calibrationReason("evidence-exists"),
  );
  await assert.rejects(
    sink.writeCaseRecord("X9", {
      schemaVersion: 1,
    } as Pass1ThresholdCaseRecord),
    calibrationReason("invalid-case-id"),
  );
  await sink.writeCaseRecord("CAL-001", {
    schemaVersion: 1,
  } as Pass1ThresholdCaseRecord);
  assert.equal(
    (await stat(join(directory, "case-CAL-001.json"))).mode & 0o777,
    0o600,
  );
});

test("case record parser round-trips collected and failed records", () => {
  const collected = {
    schemaVersion: 1,
    caseId: "CAL-001",
    outcome: "collected",
    questionKeys: ["task_type", "risk_security"],
    answers: {
      task_type: {
        type: "choice",
        choice: "diagnose",
        confidence: 0.9,
        probabilities: { diagnose: 0.9, none: 0.1 },
      },
      risk_security: { type: "noul", noul: 0.2 },
    },
    metadata: { model: CALIBRATION_MODEL, inputTokens: 1, outputTokens: 2, latencyMs: 3 },
    costUsd: 0.00001,
    attempts: 1,
  };
  const parsed = parsePass1ThresholdCaseRecord(collected);
  assert.equal(parsed.outcome, "collected");
  assert.equal(parsed.caseId, "CAL-001");

  const failed = {
    schemaVersion: 1,
    caseId: "CAL-002",
    outcome: "failed",
    error: "provider-error",
    attempts: 2,
  };
  assert.equal(parsePass1ThresholdCaseRecord(failed).outcome, "failed");

  const invalid = {
    schemaVersion: 1,
    caseId: "CAL-003",
    outcome: "invalid-response",
    reason: "malformed-response",
    questionKeys: ["task_type"],
    attempts: 3,
  };
  assert.equal(
    parsePass1ThresholdCaseRecord(invalid).outcome,
    "invalid-response",
  );

  for (const bad of [
    null,
    {},
    { ...collected, outcome: "aborted" },
    { ...collected, answers: { task_type: { type: "noul", noul: 2 } } },
    { ...failed, error: 7 },
  ]) {
    assert.throws(
      () => parsePass1ThresholdCaseRecord(bad),
      calibrationReason("invalid-evidence-record"),
    );
  }
});
