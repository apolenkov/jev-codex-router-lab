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
  symlink,
  unlink,
  writeFile,
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
  delay: async () => {},
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

test("repeated aborts resume in place until complete", async (t) => {
  const root = await makeTempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const failOn = (ids: ReadonlySet<string>): Fetch =>
    async (input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        state: { echo: { taskId: string } };
      };
      if (ids.has(body.state.echo.taskId)) {
        return new Response("upstream error", { status: 500 });
      }
      return fakeFetch(input, init);
    };

  const first = await runPass1ThresholdCli(["--split", "calibration"], {
    repositoryRoot: root,
    env: { TYPESAFE_API_KEY: "test-key" } as NodeJS.ProcessEnv,
    fetch: failOn(new Set(["CAL-004"])),
    delay: async () => {},
  });
  assert.equal(first.summary?.status, "incomplete");
  assert.equal(first.summary?.attempts, 4);

  const second = await runPass1ThresholdCli(["--split", "calibration", "--resume"], {
    repositoryRoot: root,
    env: { TYPESAFE_API_KEY: "test-key" } as NodeJS.ProcessEnv,
    fetch: failOn(new Set(["CAL-010"])),
    delay: async () => {},
  });
  assert.equal(second.summary?.status, "incomplete");
  assert.equal(second.summary?.attempts, 11);
  assert.equal(second.summary?.collected, 9);

  const third = await runPass1ThresholdCli(
    ["--split", "calibration", "--resume"],
    collectOptions(root),
  );
  assert.equal(third.exitCode, 0, third.error);
  assert.equal(third.summary?.status, "complete");
  assert.equal(third.summary?.collected, 56);
  assert.equal(third.summary?.attempts, 58);

  const evidenceDir = join(root, "artifacts", "pass1-threshold-evidence-calibration");
  const manifest = JSON.parse(
    await readFile(join(evidenceDir, "manifest.json"), "utf8"),
  ) as { resumeCount?: number };
  assert.equal(manifest.resumeCount, 2);
  const names = await readdir(evidenceDir);
  assert.equal(names.filter((n) => /^case-CAL-\d{3}\.json$/.test(n)).length, 56);
});

test("resumed run refuses attempts beyond the cumulative ceiling", async (t) => {
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
    delay: async () => {},
  });
  assert.equal(first.summary?.status, "incomplete");
  assert.equal(first.summary?.attempts, 4);

  const checkpointPath = join(
    root,
    "artifacts",
    "pass1-threshold-evidence-calibration",
    "checkpoint.json",
  );
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as {
    accounting: { attempts: number };
  };
  checkpoint.accounting.attempts = 79;
  await writeFile(checkpointPath, JSON.stringify(checkpoint));

  const resumed = await runPass1ThresholdCli(
    ["--split", "calibration", "--resume"],
    collectOptions(root),
  );
  assert.equal(resumed.summary?.status, "incomplete");
  assert.equal(resumed.summary?.attempts, 80);
  assert.equal(resumed.summary?.collected, 4);

  const stuck = await runPass1ThresholdCli(
    ["--split", "calibration", "--resume"],
    collectOptions(root),
  );
  assert.equal(stuck.summary?.status, "incomplete");
  assert.equal(stuck.summary?.attempts, 80);
});

test("an aborted evaluation replaces its incomplete report on resume", async (t) => {
  const root = await makeTempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const collect = await runPass1ThresholdCli(["--split", "calibration"], collectOptions(root));
  assert.equal(collect.exitCode, 0, collect.error);
  const select = await runPass1ThresholdCli(
    ["--offline-select", "pass1-threshold-evidence-calibration"],
    collectOptions(root),
  );
  assert.equal(select.exitCode, 0, select.error);

  const failOnce: Fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      state: { echo: { taskId: string } };
    };
    if (body.state.echo.taskId === "EVAL-002") {
      return new Response("upstream error", { status: 500 });
    }
    return fakeFetch(input, init);
  };
  const first = await runPass1ThresholdCli(["--split", "evaluation"], {
    repositoryRoot: root,
    env: { TYPESAFE_API_KEY: "test-key" } as NodeJS.ProcessEnv,
    fetch: failOnce,
    delay: async () => {},
  });
  assert.equal(first.summary?.status, "incomplete");

  const reportPath = join(root, "artifacts", "pass1-threshold-evaluation.json");
  const incomplete = JSON.parse(await readFile(reportPath, "utf8")) as {
    status: string;
    uncollected: number;
  };
  assert.equal(incomplete.status, "incomplete");
  assert.ok(incomplete.uncollected > 0);

  const resumed = await runPass1ThresholdCli(
    ["--split", "evaluation", "--resume"],
    collectOptions(root),
  );
  assert.equal(resumed.exitCode, 0, resumed.error);
  assert.equal(resumed.summary?.status, "complete");

  const complete = JSON.parse(await readFile(reportPath, "utf8")) as {
    status: string;
    uncollected: number;
    totalCases: number;
  };
  assert.equal(complete.status, "complete");
  assert.equal(complete.uncollected, 0);
  assert.equal(complete.totalCases, 28);
});

test("manifest paths cannot escape the repository root", async (t) => {
  const root = await makeTempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const manifestPath = join(root, "fixtures", "pass1-corpus-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    hashes: {
      splits: { calibration: { path: string } };
      questionBuilder: { path: string };
    };
  };
  let fetchCalls = 0;
  const countingFetch: Fetch = async (input, init) => {
    fetchCalls += 1;
    return fakeFetch(input, init);
  };
  const options = {
    repositoryRoot: root,
    env: { TYPESAFE_API_KEY: "test-key" } as NodeJS.ProcessEnv,
    fetch: countingFetch,
    delay: async () => {},
  };

  for (const escapePath of [
    "../escape.json",
    "../../outside.json",
    join(root, "..", "absolute-shaped.json"),
  ]) {
    manifest.hashes.splits.calibration.path = escapePath;
    await writeFile(manifestPath, JSON.stringify(manifest));
    const result = await runPass1ThresholdCli(["--split", "calibration"], options);
    assert.equal(result.exitCode, 2, escapePath);
    assert.equal(result.error, "invalid frozen input", escapePath);
  }

  manifest.hashes.splits.calibration.path =
    "fixtures/pass1-calibration-cases.json";
  manifest.hashes.questionBuilder.path = "../outside-questions.ts";
  await writeFile(manifestPath, JSON.stringify(manifest));
  const escaped = await runPass1ThresholdCli(["--split", "calibration"], options);
  assert.equal(escaped.exitCode, 2);
  assert.equal(escaped.error, "invalid frozen input");

  assert.equal(fetchCalls, 0);
});

test("a tampered selection artifact is refused before any provider call", async (t) => {
  const root = await makeTempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const collect = await runPass1ThresholdCli(["--split", "calibration"], collectOptions(root));
  assert.equal(collect.exitCode, 0, collect.error);
  const select = await runPass1ThresholdCli(
    ["--offline-select", "pass1-threshold-evidence-calibration"],
    collectOptions(root),
  );
  assert.equal(select.exitCode, 0, select.error);

  const artifactPath = join(root, "artifacts", "pass1-threshold-selection.json");
  const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as {
    selected: { floor: number; lo: number; hi: number };
  };
  const alternate = PASS1_THRESHOLD_GRID.find(
    (tuple) =>
      tuple.floor !== artifact.selected.floor ||
      tuple.lo !== artifact.selected.lo ||
      tuple.hi !== artifact.selected.hi,
  )!;
  artifact.selected = { ...alternate };
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2));

  let fetchCalls = 0;
  const countingFetch: Fetch = async (input, init) => {
    fetchCalls += 1;
    return fakeFetch(input, init);
  };
  const evaluation = await runPass1ThresholdCli(["--split", "evaluation"], {
    repositoryRoot: root,
    env: { TYPESAFE_API_KEY: "test-key" } as NodeJS.ProcessEnv,
    fetch: countingFetch,
    delay: async () => {},
  });
  assert.equal(evaluation.exitCode, 2);
  assert.equal(evaluation.error, "selection artifact not derived");
  assert.equal(fetchCalls, 0);
});

test("corpus drift refuses before creating any evidence state", async (t) => {
  const root = await makeTempRoot();
  t.after(() => rm(root, { recursive: true, force: true }));

  const corpusPath = join(root, "fixtures", "pass1-calibration-cases.json");
  const original = await readFile(corpusPath, "utf8");
  await writeFile(corpusPath, original.replace("CAL-001", "CAL-XX1"));

  let fetchCalls = 0;
  const countingFetch: Fetch = async (input, init) => {
    fetchCalls += 1;
    return fakeFetch(input, init);
  };
  const result = await runPass1ThresholdCli(["--split", "calibration"], {
    repositoryRoot: root,
    env: { TYPESAFE_API_KEY: "test-key" } as NodeJS.ProcessEnv,
    fetch: countingFetch,
    delay: async () => {},
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.error, "invalid frozen input");
  assert.equal(fetchCalls, 0);
  assert.deepEqual(await readdir(join(root, "artifacts")), []);
});

test("resume refuses shrunk accounting and symlinked evidence", async (t) => {
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
    delay: async () => {},
  });
  assert.equal(first.summary?.status, "incomplete");

  const evidenceDir = join(
    root,
    "artifacts",
    "pass1-threshold-evidence-calibration",
  );
  const checkpointPath = join(evidenceDir, "checkpoint.json");
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as {
    accounting: { attempts: number };
  };
  checkpoint.accounting.attempts = 1;
  await writeFile(checkpointPath, JSON.stringify(checkpoint));

  const shrunk = await runPass1ThresholdCli(
    ["--split", "calibration", "--resume"],
    collectOptions(root),
  );
  assert.equal(shrunk.exitCode, 2);
  assert.equal(shrunk.error, "invalid resume state");

  checkpoint.accounting.attempts = 4;
  await writeFile(checkpointPath, JSON.stringify(checkpoint));
  const outside = join(root, "outside-case.json");
  await writeFile(outside, "{}");
  const casePath = join(evidenceDir, "case-CAL-002.json");
  const original = await readFile(casePath, "utf8");
  await rm(casePath);
  await symlink(outside, casePath);

  const symlinked = await runPass1ThresholdCli(
    ["--split", "calibration", "--resume"],
    collectOptions(root),
  );
  assert.equal(symlinked.exitCode, 2);
  assert.equal(symlinked.error, "invalid resume state");

  await unlink(casePath);
  await writeFile(casePath, original);
  const resumed = await runPass1ThresholdCli(
    ["--split", "calibration", "--resume"],
    collectOptions(root),
  );
  assert.equal(resumed.exitCode, 0, resumed.error);
  assert.equal(resumed.summary?.status, "complete");
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
