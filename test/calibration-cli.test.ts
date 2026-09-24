import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { Fetch } from "@typesafe-ai/sdk";
import { runCalibrationCli, type CalibrationCliOptions } from "../src/calibration-cli.js";
import {
  CALIBRATION_MODEL,
  createCalibrationTransport,
  loadCalibrationCorpus,
} from "../src/calibration-runner.js";
import type { RouterInput } from "../src/contracts.js";
import { PASS1_THRESHOLDS_ENV } from "../src/pass1-thresholds.js";

const TEST_PASS1_POLICY = JSON.stringify({
  choiceConfidenceMin: 0.5,
  noulUncertaintyLower: 0.4,
  noulUncertaintyUpper: 0.6,
});
const TEST_PASS1_BAND = { lower: 0.4, upper: 0.6 } as const;
process.env[PASS1_THRESHOLDS_ENV] = TEST_PASS1_POLICY;

const testEnv = (apiKey: string): NodeJS.ProcessEnv => ({
  TYPESAFE_API_KEY: apiKey,
  [PASS1_THRESHOLDS_ENV]: TEST_PASS1_POLICY,
});

const withGlobalPass1Policy = async (
  value: string | undefined,
  run: () => Promise<void>,
): Promise<void> => {
  const previous = process.env[PASS1_THRESHOLDS_ENV];
  if (value === undefined) {
    delete process.env[PASS1_THRESHOLDS_ENV];
  } else {
    process.env[PASS1_THRESHOLDS_ENV] = value;
  }
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env[PASS1_THRESHOLDS_ENV];
    } else {
      process.env[PASS1_THRESHOLDS_ENV] = previous;
    }
  }
};

const confidentRiskValue = (range: { min: number; max: number }): number =>
  range.min < TEST_PASS1_BAND.lower
    ? range.min
    : range.max > TEST_PASS1_BAND.upper
      ? range.max
      : (range.min + range.max) / 2;

const setupRoot = async (t: test.TestContext): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "jev-calibration-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "artifacts"));
  return root;
};

const copyFixtures = async (root: string): Promise<void> => {
  await mkdir(join(root, "fixtures"));
  for (const name of ["calibration-corpus.json", "two-pass-smoke-input.json"]) {
    await writeFile(
      join(root, "fixtures", name),
      await readFile(resolve("fixtures", name), "utf8"),
      "utf8",
    );
  }
};

const calibrationFetch = (
  corpus: ReturnType<typeof loadCalibrationCorpus>,
): Fetch => async (_input, init) => {
  const body = JSON.parse(String(init?.body)) as {
    state: { echo: { taskId: string }; skills: { id: string }[] };
    questions: Record<string, { type: string; criteria?: Record<string, unknown> }>;
  };
  const corpusCase = corpus.cases.find(({ id }) => id === body.state.echo.taskId);
  const expected = corpusCase?.expected ?? {
    taskType: "diagnose" as const,
    skillCandidates: ["test-driven-development"],
    criticalGapId: null,
    reuseCandidateId: null,
    architectureForkId: null,
    riskDimensions: Object.fromEntries([
      "security", "data-loss", "public-contract", "migration", "user-behavior",
    ].map((id) => [id, { min: 0.1, max: 0.1 }])) as Record<
      "security" | "data-loss" | "public-contract" | "migration" | "user-behavior",
      { min: number; max: number }
    >,
    contextRelevance: [],
  };
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(body.questions)) {
    if (question.type === "noul") {
      if (id.startsWith("risk_")) {
        const dimension = id.slice(5).replaceAll("_", "-") as
          keyof typeof expected.riskDimensions;
        const range = expected.riskDimensions[dimension];
        answers[id] = { type: "noul", noul: confidentRiskValue(range) };
      } else {
        const skill = body.state.skills[Number(id.slice("skill_fit_".length))]!.id;
        answers[id] = {
          type: "noul",
          noul: expected.skillCandidates.includes(skill) ? 0.9 : 0.1,
        };
      }
      continue;
    }
    const options = Object.keys(question.criteria ?? {});
    const selected = id.startsWith("echo_") ? options[0]!
      : id === "task_type" ? expected.taskType
        : id === "skill_candidates"
          ? expected.skillCandidates[0] ?? options.find((option) => option !== "none")!
          : id === "skill_ranking"
            ? expected.skillCandidates[0] ?? "none"
          : id === "critical_gap" ? expected.criticalGapId ?? "none"
            : id === "reuse_candidate" ? expected.reuseCandidateId ?? "none"
              : id === "architecture_fork" ? expected.architectureForkId ?? "none"
                : id === "context_relevance"
                  ? expected.contextRelevance[0]?.id ?? "none"
                  : "none";
    answers[id] = {
      type: "choice",
      choice: selected,
      confidence: 0.9,
      probabilities: Object.fromEntries(options.map((option) => [
        option,
        option === selected ? 0.9 : 0.1 / Math.max(1, options.length - 1),
      ])),
    };
  }
  return new Response(JSON.stringify({
    model: CALIBRATION_MODEL,
    usage: { input_tokens: 100, output_tokens: 10 },
    answers,
  }), { status: 200, headers: { "content-type": "application/json" } });
};

const guardedOptions = (root: string) => {
  let factoryCalls = 0;
  let fetchCalls = 0;
  const options: CalibrationCliOptions = {
    repositoryRoot: root,
    env: testEnv("test-key"),
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("network must not be reached");
    },
    createTransport: async (transportOptions) => {
      factoryCalls += 1;
      return createCalibrationTransport(transportOptions);
    },
  };
  return { options, calls: () => ({ factoryCalls, fetchCalls }) };
};

test("calibration CLI rejects usage and a missing key before client or network", async (t) => {
  const root = await setupRoot(t);
  const guarded = guardedOptions(root);

  const invalidUsage = await runCalibrationCli(["--unexpected"], guarded.options);
  const missingKey = await runCalibrationCli([], {
    ...guarded.options,
    env: { [PASS1_THRESHOLDS_ENV]: TEST_PASS1_POLICY },
  });

  assert.deepEqual(invalidUsage, { exitCode: 2, error: "invalid CLI usage" });
  assert.deepEqual(missingKey, { exitCode: 2, error: "missing TYPESAFE_API_KEY" });
  assert.deepEqual(guarded.calls(), { factoryCalls: 0, fetchCalls: 0 });
});

test("calibration CLI fails closed on a missing or invalid pass-1 policy before key access", async (t) => {
  const root = await setupRoot(t);

  for (const policy of [undefined, "not-json"]) {
    let factoryCalls = 0;
    let fetchCalls = 0;
    let keyReads = 0;
    const env = new Proxy(
      { TYPESAFE_API_KEY: "test-key" } as Record<string, string | undefined>,
      {
        get: (target, property) => {
          if (property === "TYPESAFE_API_KEY") keyReads += 1;
          return target[property as keyof typeof target];
        },
      },
    );
    if (policy !== undefined) env[PASS1_THRESHOLDS_ENV] = policy;

    const result = await runCalibrationCli([], {
      repositoryRoot: root,
      env,
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("network must not be reached");
      },
      createTransport: async (transportOptions) => {
        factoryCalls += 1;
        return createCalibrationTransport(transportOptions);
      },
    });

    assert.deepEqual(result, { exitCode: 2, error: "uncalibrated-thresholds" });
    assert.equal(keyReads, 0);
    assert.equal(factoryCalls, 0);
    assert.equal(fetchCalls, 0);
  }
});

test("calibration CLI refuses either evidence collision before client or network", async (t) => {
  for (const name of ["calibration-report.json", "calibration-checkpoint.json"]) {
    const root = await setupRoot(t);
    await writeFile(join(root, "artifacts", name), "prior evidence", "utf8");
    const guarded = guardedOptions(root);

    const result = await runCalibrationCli([], guarded.options);

    assert.deepEqual(result, { exitCode: 2, error: "evidence path unavailable" });
    assert.deepEqual(guarded.calls(), { factoryCalls: 0, fetchCalls: 0 });
  }
});

test("calibration CLI refuses a symlinked artifacts parent before client", async (t) => {
  const root = await setupRoot(t);
  const outside = await mkdtemp(join(tmpdir(), "jev-calibration-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await rm(join(root, "artifacts"), { recursive: true });
  await symlink(outside, join(root, "artifacts"));
  const guarded = guardedOptions(root);

  const result = await runCalibrationCli([], guarded.options);

  assert.deepEqual(result, { exitCode: 2, error: "evidence path unavailable" });
  assert.deepEqual(guarded.calls(), { factoryCalls: 0, fetchCalls: 0 });
});

test("calibration CLI rejects symlinked or drifted frozen fixtures before client", async (t) => {
  const sentinel = "PRIVATE-SENTINEL-MUST-NOT-LEAVE-FIXTURE";

  const symlinkRoot = await setupRoot(t);
  await copyFixtures(symlinkRoot);
  const outside = await mkdtemp(join(tmpdir(), "jev-private-fixture-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const driftedCorpus = JSON.parse(
    await readFile(resolve("fixtures/calibration-corpus.json"), "utf8"),
  ) as { cases: { input: { taskText: string } }[] };
  driftedCorpus.cases[0]!.input.taskText = sentinel;
  const outsideCorpus = join(outside, "calibration-corpus.json");
  await writeFile(outsideCorpus, JSON.stringify(driftedCorpus), "utf8");
  await rm(join(symlinkRoot, "fixtures/calibration-corpus.json"));
  await symlink(outsideCorpus, join(symlinkRoot, "fixtures/calibration-corpus.json"));
  const symlinked = guardedOptions(symlinkRoot);

  const symlinkResult = await runCalibrationCli([], symlinked.options);

  assert.equal(symlinkResult.exitCode, 2);
  assert.equal(JSON.stringify(symlinkResult).includes(sentinel), false);
  assert.deepEqual(symlinked.calls(), { factoryCalls: 0, fetchCalls: 0 });

  const driftRoot = await setupRoot(t);
  await copyFixtures(driftRoot);
  const driftedSmoke = JSON.parse(
    await readFile(resolve("fixtures/two-pass-smoke-input.json"), "utf8"),
  ) as { taskText: string };
  driftedSmoke.taskText = sentinel;
  await writeFile(
    join(driftRoot, "fixtures/two-pass-smoke-input.json"),
    JSON.stringify(driftedSmoke),
    "utf8",
  );
  const drifted = guardedOptions(driftRoot);

  const driftResult = await runCalibrationCli([], drifted.options);

  assert.equal(driftResult.exitCode, 2);
  assert.equal(JSON.stringify(driftResult).includes(sentinel), false);
  assert.deepEqual(drifted.calls(), { factoryCalls: 0, fetchCalls: 0 });
});

test("calibration CLI anchors evidence when artifacts path is swapped in factory", async (t) => {
  const root = await setupRoot(t);
  await copyFixtures(root);
  const outside = await mkdtemp(join(tmpdir(), "jev-artifacts-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  let factoryCalls = 0;
  let fetchCalls = 0;

  const result = await runCalibrationCli([], {
    repositoryRoot: root,
    env: testEnv("test-key"),
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("network must not be reached");
    },
    createTransport: async (transportOptions) => {
      factoryCalls += 1;
      await rename(join(root, "artifacts"), join(root, "artifacts-owned"));
      await symlink(outside, join(root, "artifacts"));
      return createCalibrationTransport(transportOptions);
    },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(factoryCalls, 1);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(await readdir(outside), []);
});

test("calibration CLI runs the fixed public transaction and returns summary only", async (t) => {
  const root = await setupRoot(t);
  await copyFixtures(root);
  const corpus = loadCalibrationCorpus(join(root, "fixtures/calibration-corpus.json"));
  const smoke = JSON.parse(
    await readFile(join(root, "fixtures/two-pass-smoke-input.json"), "utf8"),
  ) as RouterInput;
  const fetch = calibrationFetch(corpus);

  const result = await runCalibrationCli([], {
    repositoryRoot: root,
    env: testEnv("DO-NOT-LOG-KEY"),
    fetch,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.summary?.phase, "smoke-completed");
  assert.equal(result.summary?.attempts, 18);
  assert.equal(result.summary?.smokeStatus, "completed");
  const serializedSummary = JSON.stringify(result.summary);
  assert.equal(serializedSummary.includes("DO-NOT-LOG-KEY"), false);
  assert.equal(serializedSummary.includes(smoke.taskText), false);
  const report = await readFile(join(root, "artifacts/calibration-report.json"), "utf8");
  const checkpoint = await readFile(
    join(root, "artifacts/calibration-checkpoint.json"),
    "utf8",
  );
  assert.equal(report.includes(smoke.taskText), false);
  assert.equal(report.includes("DO-NOT-LOG-KEY"), false);
  assert.equal(JSON.parse(checkpoint).phase, "complete");
});

test("calibration CLI exits nonzero for a completed negative holdout result", async (t) => {
  const root = await setupRoot(t);
  await copyFixtures(root);
  const corpus = loadCalibrationCorpus(join(root, "fixtures/calibration-corpus.json"));
  const validFetch = calibrationFetch(corpus);
  const fetch: Fetch = async (input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      state: { echo: { taskId: string } };
      questions: Record<string, unknown>;
    };
    const response = await validFetch(input, init);
    if (request.state.echo.taskId !== "H1" || !("task_type" in request.questions)) {
      return response;
    }
    const body = await response.json() as {
      answers: { task_type: { choice: string } };
    };
    body.answers.task_type.choice = "review";
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await runCalibrationCli([], {
    repositoryRoot: root,
    env: testEnv("test-key"),
    fetch,
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.summary?.holdoutPass, false);
  assert.equal(result.summary?.smokeStatus, "skipped");
});

test("calibration CLI applies the supplied environment policy from preflight through the gateway", async (t) => {
  const root = await setupRoot(t);
  await copyFixtures(root);
  const corpus = loadCalibrationCorpus(join(root, "fixtures/calibration-corpus.json"));
  let keyReads = 0;
  const env = new Proxy(
    {
      TYPESAFE_API_KEY: "test-key",
      [PASS1_THRESHOLDS_ENV]: TEST_PASS1_POLICY,
    } as Record<string, string | undefined>,
    {
      get: (target, property) => {
        if (property === "TYPESAFE_API_KEY") keyReads += 1;
        return target[property as keyof typeof target];
      },
    },
  );

  await withGlobalPass1Policy(undefined, async () => {
    const result = await runCalibrationCli([], {
      repositoryRoot: root,
      env,
      fetch: calibrationFetch(corpus),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.summary?.phase, "smoke-completed");
  });
  assert.equal(keyReads, 1);
});

test("calibration CLI follows the supplied policy when it differs from a valid global policy", async (t) => {
  const root = await setupRoot(t);
  await copyFixtures(root);
  const corpus = loadCalibrationCorpus(join(root, "fixtures/calibration-corpus.json"));
  const strictGlobalPolicy = JSON.stringify({
    choiceConfidenceMin: 0.95,
    noulUncertaintyLower: 0.4,
    noulUncertaintyUpper: 0.6,
  });

  await withGlobalPass1Policy(strictGlobalPolicy, async () => {
    const result = await runCalibrationCli([], {
      repositoryRoot: root,
      env: testEnv("test-key"),
      fetch: calibrationFetch(corpus),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.summary?.phase, "smoke-completed");
  });
});

test("calibration CLI reads the policy once and uses the captured value", async (t) => {
  const root = await setupRoot(t);
  await copyFixtures(root);
  const corpus = loadCalibrationCorpus(join(root, "fixtures/calibration-corpus.json"));
  let policyReads = 0;
  let keyReads = 0;
  const env = new Proxy(
    { TYPESAFE_API_KEY: "test-key" } as Record<string, string | undefined>,
    {
      get: (target, property) => {
        if (property === PASS1_THRESHOLDS_ENV) {
          policyReads += 1;
          return policyReads === 1 ? TEST_PASS1_POLICY : "not-json";
        }
        if (property === "TYPESAFE_API_KEY") keyReads += 1;
        return target[property as keyof typeof target];
      },
    },
  );

  const result = await runCalibrationCli([], {
    repositoryRoot: root,
    env,
    fetch: calibrationFetch(corpus),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.summary?.phase, "smoke-completed");
  assert.equal(policyReads, 1);
  assert.equal(keyReads, 1);
});
