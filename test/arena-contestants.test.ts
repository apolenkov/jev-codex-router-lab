import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseArenaCases,
  parseArenaManifest,
  type ArenaContestantInput,
} from "../src/arena-contracts.js";
import { canonicalFingerprint } from "../src/calibration-runner.js";
import type { PrecheckedInput, RouterInput } from "../src/contracts.js";
import { precheck } from "../src/policy.js";
import {
  SemanticGatewayError,
  type Pass1Result,
  type Pass2Result,
  type PassMetadata,
  type SemanticGateway,
} from "../src/semantic-gateway.js";
import {
  ARENA_POLICY_VERSION,
  ARENA_TASK_REVISION,
  ArenaReplayError,
  arenaContestantInput,
  createJevContestant,
  createJevReplayGateway,
  toArenaRouterInput,
} from "../src/arena-contestants.js";

const ARENA_FIXTURES = "fixtures/arena";
const readJson = (name: string): unknown =>
  JSON.parse(readFileSync(`${ARENA_FIXTURES}/${name}`, "utf8"));

const manifest = parseArenaManifest(readJson("skill-manifest.json"));
const arenaCases = parseArenaCases(readJson("dev-cases.json"), manifest);
const manifestFingerprint = canonicalFingerprint(manifest);

const caseById = (id: string) => {
  const entry = arenaCases.find((arenaCase) => arenaCase.id === id);
  assert.ok(entry !== undefined, `missing arena case ${id}`);
  return entry;
};

const inputFor = (id: string): ArenaContestantInput =>
  arenaContestantInput(caseById(id), manifest);

const miniManifest = parseArenaManifest({
  skills: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].map((id) => ({
    id,
    description: `Synthetic unit skill ${id}.`,
    excerpt: `Excerpt for ${id}.`,
    contextTokens: 100,
  })),
});

const miniInput = (overrides: Partial<ArenaContestantInput> = {}): ArenaContestantInput => ({
  caseId: "unit-1",
  taskText: "Synthetic unit task.",
  skills: miniManifest.skills,
  explicitSkillIds: ["delta"],
  requiredSkillIds: ["epsilon"],
  ...overrides,
});

const miniRouterInput = (): RouterInput => ({
  taskId: "unit-1",
  taskRevision: ARENA_TASK_REVISION,
  taskText: "Synthetic unit task.",
  policyVersion: ARENA_POLICY_VERSION,
  catalogHash: FINGERPRINT,
  explicitSkillIds: ["delta"],
  requiredSkillIds: ["epsilon"],
  skills: miniManifest.skills.map(({ id, description, excerpt }) => ({ id, description, excerpt })),
  criticalGapCandidates: [],
  architectureForkCandidates: [],
  reuseCandidates: [],
  contextFragments: [],
});

const unitMetadata: PassMetadata = {
  model: "stub-model",
  inputTokens: 10,
  outputTokens: 5,
  latencyMs: 7,
};

const pass1Ok = (input: PrecheckedInput, skillCandidates: readonly string[]): Pass1Result => ({
  echo: {
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    policyVersion: input.policyVersion,
    catalogHash: input.catalogHash,
  },
  taskType: "change",
  skillCandidates,
  criticalGap: null,
  reuseCandidate: null,
  architectureFork: null,
  riskDimensions: {
    security: 0.1,
    "data-loss": 0.1,
    "public-contract": 0.1,
    migration: 0.1,
    "user-behavior": 0.1,
  },
  contextRelevance: [],
  metadata: unitMetadata,
});

const pass2Ok = (skillCandidates: readonly string[]): Pass2Result => ({
  skillCandidates,
  metadata: { model: "stub-model", inputTokens: 4, outputTokens: 2, latencyMs: 3 },
});

const FINGERPRINT = "a".repeat(64);

test("arenaContestantInput projects only public case fields", () => {
  const input = inputFor("case-001");
  assert.deepEqual(Object.keys(input).sort(), [
    "caseId",
    "explicitSkillIds",
    "requiredSkillIds",
    "skills",
    "taskText",
  ]);
  assert.equal(input.caseId, "case-001");
  assert.equal(input.taskText, caseById("case-001").taskText);
  assert.deepEqual(input.skills, manifest.skills);
  assert.deepEqual(input.explicitSkillIds, ["test-driven-development"]);
  assert.deepEqual(input.requiredSkillIds, ["verification-before-completion"]);
});

test("toArenaRouterInput maps the case to a fixed input with empty non-skill candidates", () => {
  const routerInput = toArenaRouterInput(inputFor("case-001"), manifestFingerprint);
  assert.equal(routerInput.taskId, "case-001");
  assert.equal(routerInput.taskRevision, ARENA_TASK_REVISION);
  assert.equal(routerInput.policyVersion, ARENA_POLICY_VERSION);
  assert.equal(routerInput.catalogHash, manifestFingerprint);
  assert.equal(routerInput.taskText, caseById("case-001").taskText);
  assert.deepEqual(routerInput.explicitSkillIds, ["test-driven-development"]);
  assert.deepEqual(routerInput.requiredSkillIds, ["verification-before-completion"]);
  assert.deepEqual(routerInput.criticalGapCandidates, []);
  assert.deepEqual(routerInput.architectureForkCandidates, []);
  assert.deepEqual(routerInput.reuseCandidates, []);
  assert.deepEqual(routerInput.contextFragments, []);
  for (const skill of routerInput.skills) {
    assert.deepEqual(Object.keys(skill).sort(), ["description", "excerpt", "id"]);
  }
});

test("jev contestant routes through the injected gateway and unions forced and optional skills", async () => {
  const captured: { input?: PrecheckedInput; shortlist?: readonly string[] } = {};
  const gateway: SemanticGateway = {
    pass1: async (input) => {
      captured.input = input;
      return pass1Ok(input, ["alpha", "beta"]);
    },
    pass2: async (_input, shortlist) => {
      captured.shortlist = shortlist;
      return pass2Ok(["beta"]);
    },
  };
  const contestant = createJevContestant({ gateway, manifestFingerprint: FINGERPRINT });
  const result = await contestant.run(miniInput());

  assert.equal(result.status, "ok");
  assert.equal(result.contestantId, "jev");
  assert.deepEqual(result.selectedSkillIds, ["beta", "delta", "epsilon"]);
  assert.deepEqual(captured.input?.forcedSkillIds, ["delta", "epsilon"]);
  assert.deepEqual(captured.shortlist, ["alpha", "beta"]);
  assert.equal(result.inputTokens, 14);
  assert.equal(result.outputTokens, 7);
  assert.equal(result.latencyMs, 10);
  assert.equal(result.costUsd, null);
});

test("jev contestant maps router fallback to abstain and keeps the reason", async () => {
  const captured: { input?: PrecheckedInput } = {};
  const gateway: SemanticGateway = {
    pass1: async (input) => {
      captured.input = input;
      throw new SemanticGatewayError("low-confidence", unitMetadata);
    },
    pass2: async () => {
      assert.fail("pass2 must not be called");
    },
  };
  const contestant = createJevContestant({ gateway, manifestFingerprint: FINGERPRINT });
  const result = await contestant.run(miniInput());

  assert.equal(result.status, "abstain");
  assert.equal(result.reason, "low-confidence");
  assert.deepEqual(result.selectedSkillIds, []);
  // The case's forced skills remain identified through the checked input.
  assert.deepEqual(captured.input?.forcedSkillIds, ["delta", "epsilon"]);
  assert.equal(result.inputTokens, 10);
  assert.equal(result.outputTokens, 5);
  assert.equal(result.latencyMs, 7);
  assert.equal(result.costUsd, null);
});

test("jev contestant records null telemetry when no pass metadata was observed", async () => {
  const gateway: SemanticGateway = {
    pass1: async () => {
      throw new SemanticGatewayError("service-error");
    },
    pass2: async () => {
      assert.fail("pass2 must not be called");
    },
  };
  const contestant = createJevContestant({ gateway, manifestFingerprint: FINGERPRINT });
  const result = await contestant.run(miniInput());

  assert.equal(result.status, "abstain");
  assert.equal(result.reason, "service-error");
  assert.equal(result.inputTokens, null);
  assert.equal(result.outputTokens, null);
  assert.equal(result.latencyMs, null);
  assert.equal(result.costUsd, null);
});

test("jev contestant fails before routing without an injected gateway", () => {
  assert.throws(
    () =>
      createJevContestant({
        gateway: undefined as unknown as SemanticGateway,
        manifestFingerprint: FINGERPRINT,
      }),
    { message: "jev-gateway-required" },
  );
  assert.throws(
    () =>
      createJevContestant({
        gateway: {} as SemanticGateway,
        manifestFingerprint: FINGERPRINT,
      }),
    { message: "jev-gateway-required" },
  );
  assert.throws(
    () =>
      createJevContestant({
        gateway: {
          pass1: async () => pass1Ok(precheck(miniRouterInput()), []),
          pass2: "not-a-function",
        } as unknown as SemanticGateway,
        manifestFingerprint: FINGERPRINT,
      }),
    { message: "jev-gateway-required" },
  );
});

test("jev replay gateway rejects an unexpected case, pass, or shortlist", async () => {
  const replay = createJevReplayGateway(readJson("jev-replay.json"));

  const unknownCase = precheck({ ...miniRouterInput(), taskId: "case-999" });
  await assert.rejects(replay.pass1(unknownCase), ArenaReplayError);

  const noPass2Case = precheck(toArenaRouterInput(inputFor("case-003"), manifestFingerprint));
  await assert.rejects(replay.pass2(noPass2Case, ["systematic-debugging"]), ArenaReplayError);

  const shortlistCase = precheck(toArenaRouterInput(inputFor("case-001"), manifestFingerprint));
  await assert.rejects(replay.pass2(shortlistCase, ["brainstorming"]), ArenaReplayError);

  const recorded = await replay.pass2(shortlistCase, ["systematic-debugging"]);
  assert.deepEqual(recorded.skillCandidates, ["systematic-debugging"]);
});

test("jev replay gateway rejects a malformed fixture at construction", () => {
  assert.throws(() => createJevReplayGateway(null));
  assert.throws(() => createJevReplayGateway({ schemaVersion: 2, records: {} }));
  assert.throws(() =>
    createJevReplayGateway({ schemaVersion: 1, records: { "case-1": { pass1: { taskType: "change" } } } }));
  assert.throws(() =>
    createJevReplayGateway({
      schemaVersion: 1,
      records: { "case-1": { pass1: { error: "not-a-reason" } } },
    }));
});

test("jev replay contestant reproduces recorded outcomes for the frozen corpus", async () => {
  const contestant = createJevContestant({
    gateway: createJevReplayGateway(readJson("jev-replay.json")),
    manifestFingerprint,
  });
  const results = [];
  for (const arenaCase of arenaCases) {
    results.push(await contestant.run(arenaContestantInput(arenaCase, manifest)));
  }
  assert.equal(results.length, 60);
  const byId = new Map(results.map((result) => [result.caseId, result]));
  const expected: Record<string, { status: string; reason: string | null; route: readonly string[] }> = {
    "case-001": {
      status: "ok",
      reason: null,
      route: ["systematic-debugging", "test-driven-development", "verification-before-completion"],
    },
    "case-002": { status: "abstain", reason: "low-confidence", route: [] },
    "case-003": { status: "ok", reason: null, route: [] },
    "case-008": { status: "ok", reason: null, route: ["systematic-debugging"] },
    "case-022": { status: "abstain", reason: "service-error", route: [] },
    "case-030": { status: "ok", reason: null, route: ["brainstorming", "writing-plans"] },
    "case-033": { status: "abstain", reason: "low-confidence", route: [] },
    "case-043": { status: "abstain", reason: "stale-decision", route: [] },
    "case-050": { status: "abstain", reason: "malformed-response", route: [] },
    "case-053": { status: "abstain", reason: "low-confidence", route: [] },
  };
  for (const [caseId, expectation] of Object.entries(expected)) {
    const result = byId.get(caseId);
    assert.ok(result !== undefined, `missing result for ${caseId}`);
    assert.equal(result.status, expectation.status, `${caseId} status`);
    assert.equal(result.reason, expectation.reason, `${caseId} reason`);
    assert.deepEqual(result.selectedSkillIds, expectation.route, `${caseId} route`);
  }
  const serviceError = byId.get("case-022");
  assert.ok(serviceError !== undefined);
  assert.equal(serviceError.inputTokens, null);
  assert.equal(serviceError.outputTokens, null);
  assert.equal(serviceError.latencyMs, null);
  assert.equal(serviceError.costUsd, null);
});

test("two full jev replay runs are deeply equal", async () => {
  const runAll = async () => {
    const contestant = createJevContestant({
      gateway: createJevReplayGateway(readJson("jev-replay.json")),
      manifestFingerprint,
    });
    const results = [];
    for (const arenaCase of arenaCases) {
      results.push(await contestant.run(arenaContestantInput(arenaCase, manifest)));
    }
    return results;
  };
  const [first, second] = [await runAll(), await runAll()];
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
