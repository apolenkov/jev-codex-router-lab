import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Fetch } from "@typesafe-ai/sdk";
import {
  parsePass1SelectionArtifact,
  PASS1_THRESHOLD_GRID,
} from "../src/pass1-threshold-selector.js";
import { runPass1ThresholdCli } from "../src/pass1-threshold-cli.js";

const FIXTURE_FILES = [
  "pass1-calibration-cases.json",
  "pass1-evaluation-cases.json",
  "pass1-corpus-manifest.json",
] as const;

const sha256Hex = (contents: string): string =>
  createHash("sha256").update(contents).digest("hex");

const synthesizeAnswers = (
  questions: Record<string, unknown>,
): Record<string, unknown> => {
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    const typed = question as { type: string; criteria?: Record<string, unknown> };
    if (typed.type === "noul") {
      answers[id] = { type: "noul", noul: 0.2 };
      continue;
    }
    const candidates = Object.keys(typed.criteria ?? {});
    answers[id] = {
      type: "choice",
      choice: candidates[0],
      confidence: 0.9,
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

const fakeFetch: Fetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body)) as {
    questions: Record<string, unknown>;
  };
  return new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      usage: { input_tokens: 100, output_tokens: 10 },
      answers: synthesizeAnswers(body.questions),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

const makeTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pass1-threshold-cli-"));
  await mkdir(join(root, "fixtures"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "artifacts"), { recursive: true });
  for (const name of FIXTURE_FILES) {
    await copyFile(join("fixtures", name), join(root, "fixtures", name));
  }
  await copyFile("src/questions.ts", join(root, "src", "questions.ts"));
  return root;
};

const collectOptions = (root: string) => ({
  repositoryRoot: root,
  env: { TYPESAFE_API_KEY: "test-key" } as NodeJS.ProcessEnv,
  fetch: fakeFetch,
});

test("usage errors exit 2 before any filesystem or network work", async () => {
  for (const argv of [
    [],
    ["--split"],
    ["--split", "bogus"],
    ["--split", "calibration", "extra"],
    ["--offline-select"],
    ["--unknown", "x"],
  ]) {
    const result = await runPass1ThresholdCli(argv, {
      repositoryRoot: "/nonexistent-root-for-cli-test",
      env: {},
    });
    assert.equal(result.exitCode, 2, JSON.stringify(argv));
    assert.equal(result.error, "invalid CLI usage");
  }
});

test("calibration collection requires TYPESAFE_API_KEY", async () => {
  const root = await makeTempRoot();
  try {
    const result = await runPass1ThresholdCli(["--split", "calibration"], {
      repositoryRoot: root,
      env: {},
      fetch: fakeFetch,
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.error, "missing TYPESAFE_API_KEY");
    assert.deepEqual(await readdir(join(root, "artifacts")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("calibration collection writes bounded evidence and selects offline", async (t) => {
  const root = await makeTempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const collect = await runPass1ThresholdCli(["--split", "calibration"], collectOptions(root));
  assert.equal(collect.exitCode, 0, collect.error);
  assert.equal(collect.summary?.mode, "collect");
  assert.equal(collect.summary?.split, "calibration");
  assert.equal(collect.summary?.status, "complete");
  assert.equal(collect.summary?.collected, 56);
  assert.equal(collect.summary?.attempts, 56);
  assert.equal(typeof collect.summary?.spentUsd, "number");

  const evidenceDir = join(root, "artifacts", "pass1-threshold-evidence-calibration");
  const names = await readdir(evidenceDir);
  assert.equal(names.filter((n) => /^case-CAL-\d{3}\.json$/.test(n)).length, 56);
  assert.ok(names.includes("manifest.json"));
  assert.ok(names.includes("summary.json"));

  const select = await runPass1ThresholdCli(
    ["--offline-select", "pass1-threshold-evidence-calibration"],
    collectOptions(root),
  );
  assert.equal(select.exitCode, 0, select.error);
  assert.equal(select.summary?.mode, "select");
  assert.ok(
    PASS1_THRESHOLD_GRID.some(
      (tuple) =>
        tuple.floor === select.summary?.selected?.floor &&
        tuple.lo === select.summary?.selected?.lo &&
        tuple.hi === select.summary?.selected?.hi,
    ),
  );

  const artifactRaw = await readFile(
    join(root, "artifacts", "pass1-threshold-selection.json"),
    "utf8",
  );
  const artifact = parsePass1SelectionArtifact(artifactRaw);
  assert.equal(artifact.table.length, PASS1_THRESHOLD_GRID.length);
  const corpusRaw = await readFile(
    join(root, "fixtures", "pass1-calibration-cases.json"),
    "utf8",
  );
  assert.equal(artifact.inputs.corpusFileSha256, sha256Hex(corpusRaw));
  assert.equal(artifact.inputs.questionBuilderSha256, sha256Hex(readFileSync("src/questions.ts", "utf8")));
});

test("evidence directories are create-once", async (t) => {
  const root = await makeTempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await runPass1ThresholdCli(["--split", "calibration"], collectOptions(root));
  assert.equal(first.exitCode, 0, first.error);
  const second = await runPass1ThresholdCli(["--split", "calibration"], collectOptions(root));
  assert.equal(second.exitCode, 2);
  assert.equal(second.error, "evidence path unavailable");
});

test("evaluation requires the frozen selection artifact", async (t) => {
  const root = await makeTempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await runPass1ThresholdCli(["--split", "evaluation"], collectOptions(root));
  assert.equal(result.exitCode, 2);
  assert.equal(result.error, "missing selection artifact");
});

test("an aborted calibration run resumes once in place", async (t) => {
  const root = await makeTempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const failOnce: Fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      state: { echo: { taskId: string } };
    };
    if (body.state.echo.taskId === "CAL-004") {
      return new Response("upstream error", { status: 500 });
    }
    return fakeFetch(input, init);
  };
  const first = await runPass1ThresholdCli(["--split", "calibration"], {
    repositoryRoot: root,
    env: { TYPESAFE_API_KEY: "test-key" } as NodeJS.ProcessEnv,
    fetch: failOnce,
  });
  assert.equal(first.exitCode, 2);
  assert.equal(first.summary?.status, "incomplete");
  assert.equal(first.summary?.collected, 3);
  assert.equal(first.summary?.attempts, 4);

  const resumed = await runPass1ThresholdCli(
    ["--split", "calibration", "--resume"],
    collectOptions(root),
  );
  assert.equal(resumed.exitCode, 0, resumed.error);
  assert.equal(resumed.summary?.status, "complete");
  assert.equal(resumed.summary?.collected, 56);
  assert.equal(resumed.summary?.attempts, 57);

  const evidenceDir = join(root, "artifacts", "pass1-threshold-evidence-calibration");
  const manifest = JSON.parse(
    await readFile(join(evidenceDir, "manifest.json"), "utf8"),
  ) as { resumedFrom?: { attempts: number; spentUsd: number } };
  assert.equal(manifest.resumedFrom?.attempts, 4);
  assert.equal(typeof manifest.resumedFrom?.spentUsd, "number");
  const case4 = JSON.parse(
    await readFile(join(evidenceDir, "case-CAL-004.json"), "utf8"),
  ) as { outcome: string };
  assert.equal(case4.outcome, "collected");

  const secondResume = await runPass1ThresholdCli(
    ["--split", "calibration", "--resume"],
    collectOptions(root),
  );
  assert.equal(secondResume.exitCode, 2);
});

test("offline select rejects missing and incomplete evidence", async (t) => {
  const root = await makeTempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const missing = await runPass1ThresholdCli(
    ["--offline-select", "no-such-dir"],
    collectOptions(root),
  );
  assert.equal(missing.exitCode, 2);
  assert.equal(missing.error, "evidence path unavailable");

  const collect = await runPass1ThresholdCli(["--split", "calibration"], collectOptions(root));
  assert.equal(collect.exitCode, 0, collect.error);
  const escape = await runPass1ThresholdCli(
    ["--offline-select", "../outside"],
    collectOptions(root),
  );
  assert.equal(escape.exitCode, 2);
  assert.equal(escape.error, "evidence path unavailable");
});
