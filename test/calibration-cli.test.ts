import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

const setupRoot = async (t: test.TestContext): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "jev-calibration-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "artifacts"));
  return root;
};

const guardedOptions = (root: string) => {
  let factoryCalls = 0;
  let fetchCalls = 0;
  const options: CalibrationCliOptions = {
    repositoryRoot: root,
    env: { TYPESAFE_API_KEY: "test-key" },
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
    env: {},
  });

  assert.deepEqual(invalidUsage, { exitCode: 2, error: "invalid CLI usage" });
  assert.deepEqual(missingKey, { exitCode: 2, error: "missing TYPESAFE_API_KEY" });
  assert.deepEqual(guarded.calls(), { factoryCalls: 0, fetchCalls: 0 });
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

test("calibration CLI runs the fixed public transaction and returns summary only", async (t) => {
  const root = await setupRoot(t);
  await mkdir(join(root, "fixtures"));
  for (const name of ["calibration-corpus.json", "two-pass-smoke-input.json"]) {
    await writeFile(
      join(root, "fixtures", name),
      await readFile(resolve("fixtures", name), "utf8"),
      "utf8",
    );
  }
  const corpus = loadCalibrationCorpus(join(root, "fixtures/calibration-corpus.json"));
  const smoke = JSON.parse(
    await readFile(join(root, "fixtures/two-pass-smoke-input.json"), "utf8"),
  ) as RouterInput;
  const fetch: Fetch = async (_input, init) => {
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
          answers[id] = { type: "noul", noul: (range.min + range.max) / 2 };
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

  const result = await runCalibrationCli([], {
    repositoryRoot: root,
    env: { TYPESAFE_API_KEY: "DO-NOT-LOG-KEY" },
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
