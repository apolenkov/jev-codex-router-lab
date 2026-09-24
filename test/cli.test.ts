import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { RouterInput } from "../src/contracts.js";
import {
  SemanticGatewayError,
  type SemanticGateway,
} from "../src/semantic-gateway.js";
import { runCli, type CliOptions } from "../src/cli.js";

const validInput: RouterInput = {
  taskId: "synthetic-cli-001",
  taskRevision: 1,
  taskText: "DO-NOT-LOG CLI task body",
  policyVersion: "policy-cli-test-1",
  catalogHash: "sha256:cli-test-catalog",
  explicitSkillIds: ["brainstorming"],
  requiredSkillIds: [],
  skills: [
    { id: "brainstorming", description: "Synthetic required skill", excerpt: "DO-NOT-LOG skill body" },
  ],
  criticalGapCandidates: [],
  architectureForkCandidates: [],
  reuseCandidates: [],
  contextFragments: [],
};

const okGateway = (): SemanticGateway => ({
  pass1: async () => ({
    echo: {
      taskId: validInput.taskId,
      taskRevision: validInput.taskRevision,
      policyVersion: validInput.policyVersion,
      catalogHash: validInput.catalogHash,
    },
    taskType: "change",
    skillCandidates: [],
    criticalGap: null,
    reuseCandidate: null,
    architectureFork: null,
    riskDimensions: {
      security: 0,
      "data-loss": 0,
      "public-contract": 0,
      migration: 0,
      "user-behavior": 0,
    },
    contextRelevance: [],
    metadata: {
      model: "jev-cli-test",
      inputTokens: 7,
      outputTokens: 3,
      latencyMs: 2,
    },
  }),
  pass2: async () => { assert.fail("pass2 must not be called"); },
});

const setupRepository = async (t: test.TestContext): Promise<{
  root: string;
  inputPath: string;
}> => {
  const root = await mkdtemp(join(tmpdir(), "jev-cli-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const inputPath = join(root, "input.json");
  await writeFile(inputPath, JSON.stringify(validInput), "utf8");
  return { root, inputPath };
};

test("CLI returns an ok decision and writes a metadata-only in-repository report", async (t) => {
  const { root } = await setupRepository(t);
  await mkdir(join(root, "reports"));
  let factoryCalls = 0;

  const result = await runCli(
    ["--input", "input.json", "--report", "reports/result.json"],
    {
      cwd: root,
      repositoryRoot: root,
      createGateway: () => {
        factoryCalls += 1;
        return okGateway();
      },
      env: {},
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.decision?.status, "ok");
  assert.equal(factoryCalls, 1);
  const rawReport = await readFile(join(root, "reports/result.json"), "utf8");
  const report = JSON.parse(rawReport) as Record<string, unknown>;
  assert.equal(report.status, "ok");
  assert.equal(report.callCount, 1);
  assert.equal(report.cacheStatus, "not-used");
  assert.equal(rawReport.includes("DO-NOT-LOG"), false);
  assert.equal(rawReport.includes("synthetic-cli-001"), false);
  assert.equal(rawReport.includes("brainstorming"), false);
});

test("CLI keeps service fallback on exit 0 and never exposes the exception", async (t) => {
  const { root } = await setupRepository(t);

  const result = await runCli(["--input", "input.json"], {
    cwd: root,
    repositoryRoot: root,
    createGateway: () => ({
      pass1: async () => { throw new Error("DO-NOT-LOG transport details"); },
      pass2: async () => { assert.fail("pass2 must not be called"); },
    }),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.decision, {
    status: "fallback",
    reason: "service-error",
    forcedSkillIds: ["brainstorming"],
    protectedContextIds: [],
  });
  assert.equal(JSON.stringify(result).includes("DO-NOT-LOG"), false);
});

test("CLI keeps a gateway factory's typed reason instead of collapsing it to service-error", async (t) => {
  const { root } = await setupRepository(t);

  const result = await runCli(["--input", "input.json"], {
    cwd: root,
    repositoryRoot: root,
    createGateway: () => {
      throw new SemanticGatewayError("uncalibrated-thresholds");
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.decision, {
    status: "fallback",
    reason: "uncalibrated-thresholds",
    forcedSkillIds: ["brainstorming"],
    protectedContextIds: [],
  });
});

test("synthetic smoke fixture keeps the required skill and metadata report body-free on fallback", async (t) => {
  const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
  const fixturePath = join(repositoryRoot, "fixtures/smoke-input.json");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as RouterInput;
  const root = await mkdtemp(join(tmpdir(), "jev-smoke-fixture-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const input: RouterInput = {
    ...fixture,
    contextFragments: [
      { id: "synthetic-context-001", summary: "Synthetic context body must stay out of metadata." },
    ],
  };
  const inputPath = join(root, "input.json");
  await writeFile(inputPath, JSON.stringify(input), "utf8");

  const result = await runCli(
    ["--input", inputPath, "--report", "report.json"],
    {
      cwd: root,
      repositoryRoot: root,
      createGateway: () => ({
        pass1: async () => { throw new Error("synthetic service failure"); },
        pass2: async () => { assert.fail("pass2 must not be called"); },
      }),
      env: {},
    },
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.decision, {
    status: "fallback",
    reason: "service-error",
    forcedSkillIds: ["systematic-debugging"],
    protectedContextIds: [],
  });

  const rawReport = await readFile(join(root, "report.json"), "utf8");
  const report = JSON.parse(rawReport) as Record<string, unknown>;
  assert.equal(report.status, "fallback");
  assert.equal(report.callCount, 1);
  assert.equal(rawReport.includes(input.taskText), false);
  for (const skill of input.skills) {
    assert.equal(rawReport.includes(skill.description), false);
    assert.equal(rawReport.includes(skill.excerpt), false);
  }
  for (const context of input.contextFragments ?? []) {
    assert.equal(rawReport.includes(context.summary), false);
  }
});

test("CLI rejects usage, invalid JSON, and invalid input before constructing a client", async (t) => {
  const { root } = await setupRepository(t);
  await writeFile(join(root, "invalid.json"), "{not-json", "utf8");
  await writeFile(join(root, "invalid-shape.json"), JSON.stringify({ ...validInput, taskRevision: 0 }), "utf8");

  const cases: readonly string[][] = [
    [],
    ["--input"],
    ["--input", "input.json", "--input", "input.json"],
    ["--input", "input.json", "--report", "one.json", "--report", "two.json"],
    ["--input", "input.json", "--unknown", "value"],
    ["--input", "input.json", "--api-key", "secret"],
    ["--input", "invalid.json"],
    ["--input", "invalid-shape.json"],
  ];

  for (const argv of cases) {
    let factoryCalls = 0;
    const result = await runCli(argv, {
      cwd: root,
      repositoryRoot: root,
      createGateway: () => {
        factoryCalls += 1;
        return okGateway();
      },
    });
    assert.equal(result.exitCode, 2, argv.join(" "));
    assert.equal(result.decision, undefined, argv.join(" "));
    assert.equal(factoryCalls, 0, argv.join(" "));
  }
});

test("CLI rejects every reserved none identifier before constructing a client", async (t) => {
  const { root } = await setupRepository(t);
  const reservedInputs: readonly RouterInput[] = [
    { ...validInput, taskId: "none" },
    { ...validInput, policyVersion: "none" },
    { ...validInput, catalogHash: "none" },
    {
      ...validInput,
      explicitSkillIds: ["none"],
      skills: [{ ...validInput.skills[0]!, id: "none" }],
    },
    {
      ...validInput,
      criticalGapCandidates: [{ id: "none", fact: "Synthetic fact", blocks: "Synthetic decision" }],
    },
    {
      ...validInput,
      architectureForkCandidates: [{ id: "none", alternatives: ["a", "b"], tradeoff: "Synthetic tradeoff" }],
    },
    {
      ...validInput,
      reuseCandidates: [{ id: "none", summary: "Synthetic candidate" }],
    },
    {
      ...validInput,
      contextFragments: [{ id: "none", summary: "Synthetic fragment" }],
    },
  ];

  for (const [index, input] of reservedInputs.entries()) {
    const inputName = `reserved-${index}.json`;
    await writeFile(join(root, inputName), JSON.stringify(input), "utf8");
    let factoryCalls = 0;
    const result = await runCli(["--input", inputName], {
      cwd: root,
      repositoryRoot: root,
      createGateway: () => {
        factoryCalls += 1;
        return okGateway();
      },
    });

    assert.equal(result.exitCode, 2);
    assert.equal(result.decision, undefined);
    assert.equal(result.error, "invalid input");
    assert.equal(factoryCalls, 0);
  }
});

test("CLI rejects lexical, canonical, and inode input/report identity before constructing a client", async (t) => {
  const cases: { root: string; input: string; report: string; expected: string }[] = [];

  const lexical = await setupRepository(t);
  cases.push({
    root: lexical.root,
    input: "input.json",
    report: "input.json",
    expected: await readFile(lexical.inputPath, "utf8"),
  });

  const canonical = await setupRepository(t);
  await symlink("input.json", join(canonical.root, "input-link.json"));
  cases.push({
    root: canonical.root,
    input: "input-link.json",
    report: "input.json",
    expected: await readFile(canonical.inputPath, "utf8"),
  });

  const inodeAlias = await setupRepository(t);
  await link(inodeAlias.inputPath, join(inodeAlias.root, "report-hardlink.json"));
  cases.push({
    root: inodeAlias.root,
    input: "input.json",
    report: "report-hardlink.json",
    expected: await readFile(inodeAlias.inputPath, "utf8"),
  });

  for (const identityCase of cases) {
    let factoryCalls = 0;
    const result = await runCli(
      ["--input", identityCase.input, "--report", identityCase.report],
      {
        cwd: identityCase.root,
        repositoryRoot: identityCase.root,
        createGateway: () => {
          factoryCalls += 1;
          return okGateway();
        },
      },
    );

    assert.equal(result.exitCode, 2);
    assert.equal(result.decision, undefined);
    assert.equal(result.error, "invalid report path");
    assert.equal(factoryCalls, 0);
    assert.equal(
      await readFile(join(identityCase.root, identityCase.input), "utf8"),
      identityCase.expected,
    );
  }
});

test("CLI rejects lexical and symlink report escapes before constructing a client", async (t) => {
  const { root } = await setupRepository(t);
  const outside = await mkdtemp(join(tmpdir(), "jev-cli-outside-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, "linked-outside"));

  for (const reportPath of ["../escape.json", "linked-outside/escape.json"]) {
    let factoryCalls = 0;
    const result = await runCli(["--input", "input.json", "--report", reportPath], {
      cwd: root,
      repositoryRoot: root,
      createGateway: () => {
        factoryCalls += 1;
        return okGateway();
      },
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.decision, undefined);
    assert.equal(factoryCalls, 0);
  }
  await assert.rejects(readFile(join(dirname(root), "escape.json"), "utf8"));
  await assert.rejects(readFile(join(outside, "escape.json"), "utf8"));
});

test("CLI rejects an existing report directory before constructing a client", async (t) => {
  const { root } = await setupRepository(t);
  await mkdir(join(root, "report-directory"));
  let factoryCalls = 0;

  const result = await runCli(["--input", "input.json", "--report", "report-directory"], {
    cwd: root,
    repositoryRoot: root,
    createGateway: () => {
      factoryCalls += 1;
      return okGateway();
    },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.decision, undefined);
  assert.equal(result.error, "invalid report path");
  assert.equal(factoryCalls, 0);
});

test("CLI rejects an existing regular report before constructing a client", async (t) => {
  const { root } = await setupRepository(t);
  const reportPath = join(root, "report.json");
  await writeFile(reportPath, "prior report", "utf8");
  let factoryCalls = 0;

  const result = await runCli(["--input", "input.json", "--report", "report.json"], {
    cwd: root,
    repositoryRoot: root,
    createGateway: () => {
      factoryCalls += 1;
      return okGateway();
    },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.decision, undefined);
  assert.equal(result.error, "invalid report path");
  assert.equal(factoryCalls, 0);
  assert.equal(await readFile(reportPath, "utf8"), "prior report");
});

test("CLI reads and identifies input through one handle across a pathname swap", async (t) => {
  const { root } = await setupRepository(t);
  const movedInputPath = join(root, "opened-input.json");
  const originalInput = await readFile(join(root, "input.json"), "utf8");
  let factoryCalls = 0;
  const options = {
    cwd: root,
    repositoryRoot: root,
    createGateway: () => {
      factoryCalls += 1;
      return okGateway();
    },
    inputIo: {
      fstat: async (handle: FileHandle) => {
        const openedStats = await handle.stat();
        await rename(join(root, "input.json"), movedInputPath);
        await writeFile(join(root, "input.json"), "{replacement-is-not-json", "utf8");
        return openedStats;
      },
    },
  } as CliOptions & {
    inputIo: { fstat: (handle: FileHandle) => ReturnType<FileHandle["stat"]> };
  };

  const result = await runCli(
    ["--input", "input.json", "--report", "opened-input.json"],
    options,
  );

  assert.equal(result.exitCode, 2);
  assert.equal(result.decision, undefined);
  assert.equal(result.error, "invalid report path");
  assert.equal(factoryCalls, 0);
  assert.equal(await readFile(movedInputPath, "utf8"), originalInput);
});

test("CLI leaves its new empty report for manual removal when post-open fstat fails", async (t) => {
  const { root } = await setupRepository(t);
  const reportPath = join(root, "report.json");
  let factoryCalls = 0;
  const options = {
    cwd: root,
    repositoryRoot: root,
    createGateway: () => {
      factoryCalls += 1;
      return okGateway();
    },
    reportIo: {
      fstat: async () => { throw new Error("injected fstat failure"); },
    },
  } as CliOptions & {
    reportIo: { fstat: (handle: FileHandle) => Promise<never> };
  };

  const result = await runCli(["--input", "input.json", "--report", "report.json"], options);

  assert.equal(result.exitCode, 2);
  assert.equal(result.decision, undefined);
  assert.equal(
    result.error,
    "unable to write report; incomplete report file may require manual removal",
  );
  assert.equal(factoryCalls, 0);
  assert.equal(await readFile(reportPath, "utf8"), "");
  assert.deepEqual((await readdir(root)).filter((name) => name.includes(".tmp-")), []);
});

test("CLI leaves a partial create-once report on write failure without changing existing data", async (t) => {
  const { root, inputPath } = await setupRepository(t);
  const reportPath = join(root, "report.json");
  const existingPath = join(root, "existing-data.txt");
  const originalInput = await readFile(inputPath, "utf8");
  await writeFile(existingPath, "existing data must stay unchanged", "utf8");
  let writes = 0;
  const options = {
    cwd: root,
    repositoryRoot: root,
    createGateway: okGateway,
    reportIo: {
      write: async (
        handle: FileHandle,
        buffer: Buffer,
        offset: number,
        _length: number,
        position: number,
      ): Promise<number> => {
        writes += 1;
        if (writes > 1) {
          throw new Error("injected partial-write failure");
        }
        return (await handle.write(buffer, offset, 1, position)).bytesWritten;
      },
    },
  } as CliOptions & {
    reportIo: {
      write: (
        handle: FileHandle,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => Promise<number>;
    };
  };

  const result = await runCli(["--input", "input.json", "--report", "report.json"], options);

  assert.equal(result.exitCode, 2);
  assert.equal(result.decision, undefined);
  assert.equal(
    result.error,
    "unable to write report; incomplete report file may require manual removal",
  );
  assert.equal(writes, 2);
  assert.equal((await readFile(reportPath)).byteLength, 1);
  assert.equal(await readFile(inputPath, "utf8"), originalInput);
  assert.equal(await readFile(existingPath, "utf8"), "existing data must stay unchanged");
  assert.deepEqual((await readdir(root)).filter((name) => name.includes(".tmp-")), []);
});

test("CLI keeps writing through the opened report when its parent path is swapped", async (t) => {
  const { root } = await setupRepository(t);
  const reportParent = join(root, "reports");
  const movedParent = join(root, "reports-moved");
  const outside = await mkdtemp(join(tmpdir(), "jev-cli-parent-outside-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));
  await mkdir(reportParent);
  await writeFile(join(outside, "report.json"), "outside report", "utf8");
  let reportExistedBeforeGateway = false;
  let observedEntries: string[] = [];
  const baseGateway = okGateway();

  const result = await runCli(
    ["--input", "input.json", "--report", "reports/report.json"],
    {
      cwd: root,
      repositoryRoot: root,
      createGateway: () => ({
        pass1: async (input) => {
          observedEntries = await readdir(reportParent);
          reportExistedBeforeGateway = await readFile(
            join(reportParent, "report.json"),
            "utf8",
          ).then(() => true, () => false);
          await rename(reportParent, movedParent);
          await symlink(outside, reportParent);
          return baseGateway.pass1(input);
        },
        pass2: baseGateway.pass2.bind(baseGateway),
      }),
    },
  );

  assert.equal(reportExistedBeforeGateway, true);
  assert.deepEqual(observedEntries, ["report.json"]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.decision?.status, "ok");
  const report = JSON.parse(await readFile(join(movedParent, "report.json"), "utf8")) as {
    status: string;
  };
  assert.equal(report.status, "ok");
  assert.equal(await readFile(join(outside, "report.json"), "utf8"), "outside report");
  assert.deepEqual((await readdir(outside)).filter((name) => name.includes(".tmp-")), []);
});

test("compiled CLI prints exactly one fallback decision JSON and exits 0 without a live key", async (t) => {
  const { inputPath } = await setupRepository(t);
  const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const pass1Policy = JSON.stringify({
    choiceConfidenceMin: 0.5,
    noulUncertaintyLower: 0.4,
    noulUncertaintyUpper: 0.6,
  });
  const cases: readonly [{ [key: string]: string | undefined }, string][] = [
    [
      { TYPESAFE_API_KEY: "", JEV_PASS1_THRESHOLDS_JSON: undefined },
      "uncalibrated-thresholds",
    ],
    [
      { TYPESAFE_API_KEY: "", JEV_PASS1_THRESHOLDS_JSON: pass1Policy },
      "service-error",
    ],
  ];

  for (const [overrides, reason] of cases) {
    const env = { ...process.env };
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete env[name];
      } else {
        env[name] = value;
      }
    }
    const result = spawnSync(process.execPath, [cliPath, "--input", inputPath], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env,
    });

    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]!), {
      status: "fallback",
      reason,
      forcedSkillIds: ["brainstorming"],
      protectedContextIds: [],
    });
    assert.equal(result.stderr, "");
  }
});

test("compiled CLI exits 2 with no decision for invalid local JSON", async (t) => {
  const { root } = await setupRepository(t);
  const inputPath = join(root, "bad.json");
  await writeFile(inputPath, "not-json", "utf8");
  const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

  const result = spawnSync(process.execPath, [cliPath, "--input", inputPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "invalid JSON input\n");
});
