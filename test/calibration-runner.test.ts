import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fetch } from "@typesafe-ai/sdk";
import { precheck } from "../src/policy.js";
import { buildPass1Request } from "../src/questions.js";
import {
  CALIBRATION_INPUT_USD_PER_MILLION,
  CALIBRATION_MAX_ATTEMPTS,
  CALIBRATION_MODEL,
  CALIBRATION_REQUEST_RESERVE_USD,
  CALIBRATION_SPEND_CAP_USD,
  DEFAULT_CALIBRATION_CORPUS_PATH,
  canonicalFingerprint,
  createAtomicCalibrationCheckpointStore,
  createCalibrationTransport,
  createAtomicCalibrationReportWriter,
  createCorpusGuard,
  loadCalibrationCorpus,
  runCalibrationExperiment,
  type CalibrationCheckpoint,
  type CalibrationCheckpointStore,
  type CalibrationError,
  type CalibrationReport,
} from "../src/calibration-runner.js";

test("canonical fingerprint ignores object insertion order but covers nested labels", () => {
  const left = { b: 1, a: { d: ["x", "y"], c: 2 } };
  const right = { a: { c: 2, d: ["x", "y"] }, b: 1 };

  assert.equal(canonicalFingerprint(left), canonicalFingerprint(right));
  assert.equal(
    canonicalFingerprint(left),
    "1f00e16d248461b3b5efe633951946772121fe89d625fe08c471ed0388f5b17d",
  );
});

test("corpus guard rejects a label mutation before another dispatch", () => {
  const corpus = { cases: [{ id: "C1", expected: { taskType: "diagnose" } }] };
  const guard = createCorpusGuard(corpus);
  corpus.cases[0]!.expected.taskType = "change";

  assert.throws(() => guard.assertUnchanged(), { name: "CalibrationError" });
});

test("the frozen corpus has six calibration and two holdout cases with complete labels", () => {
  const corpus = loadCalibrationCorpus(DEFAULT_CALIBRATION_CORPUS_PATH);

  assert.deepEqual(corpus.cases.map(({ id }) => id), [
    "C1", "C2", "C3", "C4", "C5", "C6", "H1", "H2",
  ]);
  assert.deepEqual(corpus.cases.map(({ set }) => set), [
    "calibration", "calibration", "calibration", "calibration",
    "calibration", "calibration", "holdout", "holdout",
  ]);
  for (const corpusCase of corpus.cases) {
    assert.equal(corpusCase.input.taskId, corpusCase.id);
    assert.ok(corpusCase.input.taskText.length > 0);
    assert.ok(corpusCase.input.skills.length >= 3);
    assert.equal(corpusCase.input.contextFragments?.some(({ protected: value }) => value), true);
    assert.deepEqual(
      Object.keys(corpusCase.expected.riskDimensions).sort(),
      ["data-loss", "migration", "public-contract", "security", "user-behavior"],
    );
    for (const range of Object.values(corpusCase.expected.riskDimensions)) {
      assert.ok(range.min >= 0 && range.min <= range.max && range.max <= 1);
    }
  }
  assert.equal(
    canonicalFingerprint(corpus),
    "85fdb0f1183f8fb42332d14f6396bc4a5fd32c079ea968f40a998975f7eb9fa3",
  );
});

test("corpus loader rejects more than one optional-skill label for a case", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jev-calibration-corpus-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "corpus.json");
  const corpus = JSON.parse(await readFile(DEFAULT_CALIBRATION_CORPUS_PATH, "utf8")) as {
    cases: { expected: { skillCandidates: string[] } }[];
  };
  corpus.cases[0]!.expected.skillCandidates = ["test-driven-development", "brainstorming"];
  await writeFile(path, JSON.stringify(corpus));

  assert.throws(() => loadCalibrationCorpus(path), calibrationReason("invalid-corpus-label"));
});

test("corpus loader rejects unknown expected and nested context-label fields", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jev-calibration-closed-corpus-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = JSON.parse(await readFile(DEFAULT_CALIBRATION_CORPUS_PATH, "utf8")) as {
    cases: {
      expected: Record<string, unknown> & {
        contextRelevance: (Record<string, unknown> & { id: string })[];
      };
    }[];
  };
  const mutations: readonly ((value: typeof source) => void)[] = [
    (value) => { value.cases[0]!.expected.unboundedPrompt = "must not persist"; },
    (value) => { value.cases[0]!.expected.contextRelevance[0]!.extra = "must not persist"; },
  ];

  for (const [index, mutate] of mutations.entries()) {
    const value = structuredClone(source);
    mutate(value);
    const path = join(directory, `corpus-${index}.json`);
    await writeFile(path, JSON.stringify(value));
    assert.throws(
      () => loadCalibrationCorpus(path),
      calibrationReason("invalid-corpus-label"),
    );
  }
});

const successResponse = (inputTokens = 100): Response => new Response(JSON.stringify({
  model: "jev-1.13.0",
  usage: { input_tokens: inputTokens, output_tokens: 12 },
  answers: { verdict: { type: "noul", noul: 0.9 } },
}), { status: 200, headers: { "content-type": "application/json" } });

const oneQuestion = {
  state: "Synthetic public state.",
  questions: { verdict: { type: "noul" as const, instructions: "Is it valid?" } },
};

const calibrationReason = (reason: string) => (error: unknown): boolean =>
  error instanceof Error &&
  error.name === "CalibrationError" &&
  (error as CalibrationError).reason === reason;

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

const createTestTransport = (
  options: Omit<Parameters<typeof createCalibrationTransport>[0], "checkpoint">,
) => createCalibrationTransport({
  ...options,
  checkpoint: memoryCheckpointStore().store,
});

test("real SDK transport pins Jev, disables redirect following, and settles actual usage", async () => {
  const corpus = loadCalibrationCorpus(DEFAULT_CALIBRATION_CORPUS_PATH);
  let body: Record<string, unknown> | undefined;
  let redirect: RequestInit["redirect"];
  const fetch: Fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    redirect = init?.redirect;
    return successResponse();
  };
  const transport = await createTestTransport({ apiKey: "test-key", corpus, fetch });

  const result = await transport.systemOne(oneQuestion);

  assert.equal(body?.model, CALIBRATION_MODEL);
  assert.equal(redirect, "manual");
  assert.equal(result.metadata.model, CALIBRATION_MODEL);
  assert.equal(result.costUsd, 100 * CALIBRATION_INPUT_USD_PER_MILLION / 1_000_000);
  assert.deepEqual(transport.accounting(), {
    attempts: 1,
    spentUsd: result.costUsd,
    reservedUsd: 0,
    terminal: false,
  });
});

test("real SDK transport rejects a corpus mutation before another fetch attempt", async () => {
  const corpus = loadCalibrationCorpus(DEFAULT_CALIBRATION_CORPUS_PATH);
  let calls = 0;
  const transport = await createTestTransport({
    apiKey: "test-key",
    corpus,
    fetch: async () => {
      calls += 1;
      return successResponse();
    },
  });
  await transport.systemOne(oneQuestion);
  (corpus.cases[0]!.expected as { taskType: string }).taskType = "change";

  await assert.rejects(
    transport.systemOne(oneQuestion),
    calibrationReason("corpus-mutated"),
  );
  assert.equal(calls, 1);
  assert.equal(transport.accounting().attempts, 1);
  assert.equal(transport.accounting().terminal, true);
});

test("pass-one request through the real SDK excludes protected context", async () => {
  const corpus = loadCalibrationCorpus(DEFAULT_CALIBRATION_CORPUS_PATH);
  const corpusCase = corpus.cases[0]!;
  let serializedBody = "";
  const fetch: Fetch = async (_input, init) => {
    serializedBody = String(init?.body);
    const request = JSON.parse(serializedBody) as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      const typed = question as { type: string; criteria?: Record<string, unknown> };
      if (typed.type === "noul") return [id, { type: "noul", noul: 0.1 }];
      const options = Object.keys(typed.criteria ?? {});
      return [id, {
        type: "choice",
        choice: options[0],
        confidence: 0.9,
        probabilities: Object.fromEntries(options.map((option, index) => [option, index === 0 ? 1 : 0])),
      }];
    }));
    return new Response(JSON.stringify({
      model: CALIBRATION_MODEL,
      usage: { input_tokens: 10, output_tokens: 0 },
      answers,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const transport = await createTestTransport({ apiKey: "test-key", corpus, fetch });

  await transport.systemOne(buildPass1Request(precheck(corpusCase.input)));

  assert.equal(serializedBody.includes("ctx-private-build-log"), false);
  assert.equal(serializedBody.includes("Protected synthetic build detail"), false);
});

test("real SDK transport never retries 429, 500, timeout, or redirect", async () => {
  const corpus = loadCalibrationCorpus(DEFAULT_CALIBRATION_CORPUS_PATH);
  const scenarios: readonly [string, Fetch][] = [
    ["provider-error", async () => new Response("{}", { status: 429 })],
    ["provider-error", async () => new Response("{}", { status: 500 })],
    ["timeout", async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })],
    ["redirect", async () => new Response(null, {
      status: 302,
      headers: { location: "https://invalid.example/redirect" },
    })],
  ];

  for (const [reason, fetch] of scenarios) {
    let calls = 0;
    const countedFetch: Fetch = async (input, init) => {
      calls += 1;
      return fetch(input, init);
    };
    const transport = await createTestTransport({
      apiKey: "test-key",
      corpus,
      fetch: countedFetch,
      timeoutMs: 2,
    });
    await assert.rejects(transport.systemOne(oneQuestion), calibrationReason(reason));
    assert.equal(calls, 1);
    assert.equal(transport.accounting().attempts, 1);
    assert.equal(transport.accounting().terminal, true);
  }
});

test("unknown usage terminates after one actual SDK attempt", async () => {
  const corpus = loadCalibrationCorpus(DEFAULT_CALIBRATION_CORPUS_PATH);
  let calls = 0;
  const fetch: Fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      model: CALIBRATION_MODEL,
      answers: { verdict: { type: "noul", noul: 0.9 } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const transport = await createTestTransport({ apiKey: "test-key", corpus, fetch });

  await assert.rejects(transport.systemOne(oneQuestion), calibrationReason("unknown-accounting"));
  await assert.rejects(transport.systemOne(oneQuestion), calibrationReason("terminal"));
  assert.equal(calls, 1);
});

test("durable terminal checkpoint prevents restart after an early provider failure", async () => {
  const corpus = loadCalibrationCorpus(DEFAULT_CALIBRATION_CORPUS_PATH);
  const checkpoint = memoryCheckpointStore();
  let calls = 0;
  const transport = await createCalibrationTransport({
    apiKey: "test-key",
    corpus,
    checkpoint: checkpoint.store,
    fetch: async () => {
      calls += 1;
      return new Response("{}", { status: 500 });
    },
  });

  await assert.rejects(transport.systemOne(oneQuestion), calibrationReason("provider-error"));
  assert.deepEqual(checkpoint.snapshots.map(({ phase }) => phase), [
    "active", "reserved", "terminal",
  ]);
  assert.equal(checkpoint.snapshots.at(-1)?.accounting.attempts, 1);
  assert.equal(
    checkpoint.snapshots.at(-1)?.accounting.reservedUsd,
    CALIBRATION_REQUEST_RESERVE_USD,
  );

  await assert.rejects(
    createCalibrationTransport({
      apiKey: "test-key",
      corpus,
      checkpoint: checkpoint.store,
      fetch: async () => {
        calls += 1;
        return successResponse();
      },
    }),
    calibrationReason("checkpoint-exists"),
  );
  assert.equal(calls, 1);
});

test("request 19 and a reservation over the spend cap are rejected before SDK fetch", async () => {
  const corpus = loadCalibrationCorpus(DEFAULT_CALIBRATION_CORPUS_PATH);
  let calls = 0;
  const fetch: Fetch = async () => {
    calls += 1;
    return successResponse(0);
  };
  const atAttemptCap = await createTestTransport({
    apiKey: "test-key",
    corpus,
    fetch,
    accounting: { attempts: CALIBRATION_MAX_ATTEMPTS, spentUsd: 0 },
  });
  await assert.rejects(atAttemptCap.systemOne(oneQuestion), calibrationReason("attempt-cap"));

  const overSpendCap = await createTestTransport({
    apiKey: "test-key",
    corpus,
    fetch,
    accounting: {
      attempts: 0,
      spentUsd: CALIBRATION_SPEND_CAP_USD - CALIBRATION_REQUEST_RESERVE_USD + 0.000001,
    },
  });
  await assert.rejects(overSpendCap.systemOne(oneQuestion), calibrationReason("spend-cap"));
  assert.equal(calls, 0);
});

test("transport rejects runtime model and price overrides before SDK fetch", async () => {
  const corpus = loadCalibrationCorpus(DEFAULT_CALIBRATION_CORPUS_PATH);
  let calls = 0;
  const fetch: Fetch = async () => {
    calls += 1;
    return successResponse();
  };

  for (const override of [
    { model: "jev-latest" },
    { inputPriceUsdPerMillion: 0 },
  ]) {
    const transport = await createTestTransport({ apiKey: "test-key", corpus, fetch });
    await assert.rejects(
      transport.systemOne({ ...oneQuestion, ...override } as never),
      calibrationReason("runtime-override"),
    );
  }
  assert.equal(calls, 0);
});

const choiceEvidence = (
  options: readonly string[],
  selected: string,
): Record<string, unknown> => ({
  type: "choice",
  choice: selected,
  confidence: 0.9,
  probabilities: Object.fromEntries(options.map((option) => [
    option,
    option === selected ? 0.9 : 0.1 / Math.max(1, options.length - 1),
  ])),
});

const midpoint = ({ min, max }: { min: number; max: number }): number => (min + max) / 2;

const experimentFetch = (
  corpus: ReturnType<typeof loadCalibrationCorpus>,
  beforeRequest?: (caseId: string) => void,
): Fetch => async (_input, init) => {
  const body = JSON.parse(String(init?.body)) as {
    state: Record<string, unknown>;
    questions: Record<string, { type: string; criteria?: Record<string, unknown> }>;
  };
  const echo = body.state.echo as { taskId: string };
  const corpusCase = corpus.cases.find(({ id }) => id === echo.taskId)!;
  beforeRequest?.(corpusCase.id);
  const answers: Record<string, unknown> = {};
  const skills = body.state.skills as { id: string }[];

  for (const [id, question] of Object.entries(body.questions)) {
    if (question.type === "noul") {
      if (id.startsWith("risk_")) {
        const dimension = id.slice("risk_".length).replaceAll("_", "-") as
          keyof typeof corpusCase.expected.riskDimensions;
        answers[id] = { type: "noul", noul: midpoint(corpusCase.expected.riskDimensions[dimension]) };
      } else {
        const index = Number(id.slice("skill_fit_".length));
        const skillId = skills[index]!.id;
        answers[id] = {
          type: "noul",
          noul: corpusCase.expected.skillCandidates.includes(skillId) ? 0.9 : 0.1,
        };
      }
      continue;
    }

    const options = Object.keys(question.criteria ?? {});
    let selected: string;
    if (id.startsWith("echo_")) {
      selected = options[0]!;
    } else if (id === "task_type") {
      selected = corpusCase.expected.taskType;
    } else if (id === "skill_candidates") {
      selected = corpusCase.expected.skillCandidates[0] ?? options.find((option) => option !== "none")!;
    } else if (id === "skill_ranking") {
      selected = corpusCase.expected.skillCandidates[0] ?? "none";
    } else if (id === "critical_gap") {
      selected = corpusCase.expected.criticalGapId ?? "none";
    } else if (id === "reuse_candidate") {
      selected = corpusCase.expected.reuseCandidateId ?? "none";
    } else if (id === "architecture_fork") {
      selected = corpusCase.expected.architectureForkId ?? "none";
    } else if (id === "context_relevance") {
      selected = corpusCase.expected.contextRelevance[0]?.id ?? "none";
    } else {
      throw new Error(`unexpected question ${id}`);
    }
    answers[id] = choiceEvidence(options, selected);
  }

  return new Response(JSON.stringify({
    model: CALIBRATION_MODEL,
    usage: { input_tokens: 100, output_tokens: 10 },
    answers,
  }), { status: 200, headers: { "content-type": "application/json" } });
};

test("runner persists closed calibration records and selected tuple before untouched holdout", async () => {
  const corpus = loadCalibrationCorpus(DEFAULT_CALIBRATION_CORPUS_PATH);
  const persisted: CalibrationReport[] = [];
  let holdoutStarted = false;
  const fetch = experimentFetch(corpus, (caseId) => {
    if (caseId.startsWith("H")) {
      holdoutStarted = true;
      assert.equal(persisted.at(-1)?.phase, "tuple-selected");
      assert.deepEqual(persisted.at(-1)?.selectedTuple, {
        rankingMin: 0.6,
        lower: 0.35,
        upper: 0.65,
      });
    } else {
      assert.equal(holdoutStarted, false);
    }
  });
  const transport = await createTestTransport({ apiKey: "test-key", corpus, fetch });

  const report = await runCalibrationExperiment({
    corpus,
    transport,
    writeReport: async (snapshot) => {
      persisted.push(structuredClone(snapshot));
    },
  });

  assert.deepEqual(persisted.map(({ phase }) => phase), [
    "calibration-records",
    "tuple-selected",
    "holdout-complete",
  ]);
  assert.equal(persisted[0]!.calibration.cases.length, 6);
  assert.equal(persisted[0]!.selectedTuple, null);
  assert.equal(report.holdout?.pass, true);
  assert.equal(report.accounting.terminal, true);
  assert.equal(persisted.at(-1)?.accounting.terminal, true);
  assert.deepEqual(persisted.at(-1)?.accounting, report.accounting);
  assert.equal(report.holdout?.cases.length, 2);
  assert.equal(report.accounting.attempts, 16);
  assert.equal(report.calibration.denominator, 6);
  assert.equal(report.holdout?.denominator, 2);
  assert.equal(report.calibration.evaluations?.length, 15);
  for (const evaluation of report.calibration.evaluations ?? []) {
    assert.equal(evaluation.metrics.exactMatchCount, 6);
    assert.equal(evaluation.metrics.shortlistRecallCount, 6);
    assert.equal(evaluation.metrics.fallbackCount, 0);
    assert.equal(evaluation.metrics.falsePositiveCount, 0);
    assert.equal(evaluation.metrics.falseNegativeCount, 0);
    assert.ok(evaluation.metrics.minimumBoundaryMargin >= 0);
  }

  const serialized = JSON.stringify(report);
  for (const corpusCase of corpus.cases) {
    assert.equal(serialized.includes(corpusCase.input.taskText), false);
    for (const fragment of corpusCase.input.contextFragments ?? []) {
      if (fragment.protected === true) {
        assert.equal(serialized.includes(fragment.summary), false);
      }
    }
  }
  assert.equal(serialized.includes("test-key"), false);
  assert.equal(serialized.includes("raw provider"), false);
});

test("runner rejects a final-response corpus mutation even when transport guards a clone", async () => {
  const corpus = loadCalibrationCorpus(DEFAULT_CALIBRATION_CORPUS_PATH);
  const transportCorpus = structuredClone(corpus);
  const persisted: CalibrationReport[] = [];
  let h2Calls = 0;
  const fetch = experimentFetch(corpus, (caseId) => {
    if (caseId === "H2" && ++h2Calls === 2) {
      (corpus.cases[7]!.expected as { taskType: string }).taskType = "plan";
    }
  });
  const transport = await createTestTransport({
    apiKey: "test-key",
    corpus: transportCorpus,
    fetch,
  });

  await assert.rejects(
    runCalibrationExperiment({
      corpus,
      transport,
      writeReport: async (snapshot) => { persisted.push(structuredClone(snapshot)); },
    }),
    calibrationReason("corpus-mutated"),
  );
  assert.equal(persisted.at(-1)?.phase, "tuple-selected");
});

test("post-transport label rejection persists a terminal checkpoint", async () => {
  const corpus = loadCalibrationCorpus(DEFAULT_CALIBRATION_CORPUS_PATH);
  const checkpoint = memoryCheckpointStore();
  const validFetch = experimentFetch(corpus);
  let first = true;
  const fetch: Fetch = async (input, init) => {
    const response = await validFetch(input, init);
    if (!first) return response;
    first = false;
    const body = await response.json() as {
      answers: Record<string, Record<string, unknown>>;
    };
    body.answers.task_type!.choice = "review";
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const transport = await createCalibrationTransport({
    apiKey: "test-key",
    corpus,
    checkpoint: checkpoint.store,
    fetch,
  });

  await assert.rejects(
    runCalibrationExperiment({ corpus, transport, writeReport: async () => undefined }),
    calibrationReason("pass1-label-mismatch"),
  );
  assert.deepEqual(checkpoint.snapshots.map(({ phase }) => phase), [
    "active", "reserved", "active", "terminal",
  ]);
  assert.equal(checkpoint.snapshots.at(-1)?.failureReason, "post-transport-validation");
  assert.equal(checkpoint.snapshots.at(-1)?.accounting.attempts, 1);
});

test("holdout labels and results cannot change the selected tuple", async () => {
  const selectedTuple = async (h1: "diagnose" | "review", h2: "change" | "plan") => {
    const corpus = loadCalibrationCorpus(DEFAULT_CALIBRATION_CORPUS_PATH);
    (corpus.cases[6]!.expected as { taskType: string }).taskType = h1;
    (corpus.cases[7]!.expected as { taskType: string }).taskType = h2;
    const transport = await createTestTransport({
      apiKey: "test-key",
      corpus,
      fetch: experimentFetch(corpus),
    });
    const report = await runCalibrationExperiment({
      corpus,
      transport,
      writeReport: async () => undefined,
    });
    assert.equal(report.holdout?.pass, true);
    return report.selectedTuple;
  };

  assert.deepEqual(
    await selectedTuple("review", "plan"),
    await selectedTuple("diagnose", "change"),
  );
});

test("atomic report writer replaces a prior phase without leaving temporary files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jev-calibration-report-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "report.json");
  const write = createAtomicCalibrationReportWriter(path);
  const first = { schemaVersion: 1, phase: "calibration-records" } as CalibrationReport;
  const second = { schemaVersion: 1, phase: "tuple-selected" } as CalibrationReport;

  await write(first);
  await write(second);

  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), second);
  assert.deepEqual(await readdir(directory), ["report.json"]);
});

test("atomic checkpoint store claims once and replaces accounting", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jev-calibration-checkpoint-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "checkpoint.json");
  const store = createAtomicCalibrationCheckpointStore(path);
  const active: CalibrationCheckpoint = {
    schemaVersion: 1,
    corpusFingerprint: "a".repeat(64),
    phase: "active",
    accounting: { attempts: 0, spentUsd: 0, reservedUsd: 0, terminal: false },
    failureReason: null,
  };
  const accounted: CalibrationCheckpoint = {
    ...active,
    accounting: { attempts: 1, spentUsd: 0.0000042, reservedUsd: 0, terminal: false },
  };

  assert.equal(await store.claim(active), true);
  assert.equal(await store.claim(active), false);
  await store.write(accounted);

  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), accounted);
  assert.deepEqual(await readdir(directory), ["checkpoint.json"]);
});

test("atomic checkpoint claim permits only one concurrent transport and dispatch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "jev-calibration-claim-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "checkpoint.json");
  const corpus = loadCalibrationCorpus(DEFAULT_CALIBRATION_CORPUS_PATH);
  let calls = 0;
  const fetch: Fetch = async () => {
    calls += 1;
    return successResponse();
  };

  const results = await Promise.allSettled([
    createCalibrationTransport({
      apiKey: "test-key",
      corpus,
      fetch,
      checkpoint: createAtomicCalibrationCheckpointStore(path),
    }),
    createCalibrationTransport({
      apiKey: "test-key",
      corpus,
      fetch,
      checkpoint: createAtomicCalibrationCheckpointStore(path),
    }),
  ]);
  const transports = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : []);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []);

  await Promise.all(transports.map((transport) => transport.systemOne(oneQuestion)));
  assert.equal(transports.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(calibrationReason("checkpoint-exists")(failures[0]), true);
  assert.equal(calls, 1);
  const persisted = JSON.parse(await readFile(path, "utf8")) as CalibrationCheckpoint;
  assert.equal(persisted.accounting.attempts, 1);
  assert.equal(persisted.accounting.reservedUsd, 0);
});
