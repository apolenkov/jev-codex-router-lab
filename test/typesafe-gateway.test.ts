import assert from "node:assert/strict";
import test from "node:test";
import { APITimeoutError } from "@typesafe-ai/sdk";
import type { FallbackReason, RouterInput } from "../src/contracts.js";
import { precheck } from "../src/policy.js";
import {
  SemanticGatewayError,
  type SystemOneClientPort,
  type SystemOneRequest,
} from "../src/semantic-gateway.js";
import { TypeSafeGateway } from "../src/typesafe-gateway.js";

const routerInput: RouterInput = {
  taskId: "synthetic-task-002",
  taskRevision: 2,
  taskText: "Diagnose a synthetic queue retry regression.",
  policyVersion: "policy-2026-09-21.2",
  catalogHash: "sha256:synthetic-catalog-v2",
  explicitSkillIds: [],
  requiredSkillIds: [],
  skills: [
    { id: "a", description: "Diagnoses a synthetic service.", excerpt: "Synthetic diagnostic steps A." },
    { id: "b", description: "Reviews a synthetic change.", excerpt: "Synthetic review checklist B." },
    { id: "c", description: "Plans a synthetic migration.", excerpt: "Synthetic migration notes C." },
    { id: "d", description: "Explains a synthetic contract.", excerpt: "secret-value at /Users/wrk/private" },
  ],
  criticalGapCandidates: [
    { id: "gap-1", fact: "Synthetic retry ownership is unknown.", blocks: "A bounded retry decision." },
  ],
  architectureForkCandidates: [
    { id: "fork-1", alternatives: ["push", "pull"], tradeoff: "Latency versus simplicity." },
  ],
  reuseCandidates: [{ id: "reuse-1", summary: "Existing synthetic retry helper." }],
  contextFragments: [
    { id: "ctx-protected", summary: "secret-value at /Users/wrk/protected", protected: true },
    { id: "ctx-public", summary: "Public synthetic retry note." },
  ],
};

const input = precheck(routerInput);

const choiceAnswer = (
  selected: string,
  probabilities: Readonly<Record<string, number>>,
  confidence = 0.9,
): Record<string, unknown> => ({
  type: "choice",
  choice: selected,
  confidence,
  probabilities,
});

const echoAnswer = (value: string): Record<string, unknown> =>
  choiceAnswer(value, { [value]: 1, none: 0 }, 1);

const pass1Response = (): Record<string, unknown> => ({
  model: "jev-test-1",
  usage: { input_tokens: 101, output_tokens: 17 },
  answers: {
    echo_task_id: echoAnswer(routerInput.taskId),
    echo_task_revision: echoAnswer(String(routerInput.taskRevision)),
    echo_policy_version: echoAnswer(routerInput.policyVersion),
    echo_catalog_hash: echoAnswer(routerInput.catalogHash),
    task_type: choiceAnswer("diagnose", {
      explain: 0.02,
      research: 0.03,
      plan: 0.05,
      diagnose: 0.75,
      change: 0.05,
      review: 0.05,
      operate: 0.05,
    }),
    skill_candidates: choiceAnswer("a", { a: 0.45, b: 0.25, c: 0.15, d: 0.1, none: 0.05 }),
    critical_gap: choiceAnswer("gap-1", { "gap-1": 0.8, none: 0.2 }),
    reuse_candidate: choiceAnswer("reuse-1", { "reuse-1": 0.7, none: 0.3 }),
    architecture_fork: choiceAnswer("fork-1", { "fork-1": 0.6, none: 0.4 }),
    risk_security: { type: "noul", noul: 0.1 },
    risk_data_loss: { type: "noul", noul: 0.2 },
    risk_public_contract: { type: "noul", noul: 0.3 },
    risk_migration: { type: "noul", noul: 0.4 },
    risk_user_behavior: { type: "noul", noul: 0.5 },
    context_relevance: choiceAnswer("ctx-public", { "ctx-public": 0.8, none: 0.2 }),
  },
});

const pass2Response = (
  fits: readonly number[] = [0.9, 0.8, 0.7],
  choiceConfidence = 0.9,
): Record<string, unknown> => ({
  model: "jev-test-1",
  usage: { input_tokens: 47, output_tokens: 8 },
  answers: {
    echo_task_id: echoAnswer(routerInput.taskId),
    echo_task_revision: echoAnswer(String(routerInput.taskRevision)),
    echo_policy_version: echoAnswer(routerInput.policyVersion),
    echo_catalog_hash: echoAnswer(routerInput.catalogHash),
    skill_ranking: choiceAnswer("a", { a: 0.5, b: 0.3, c: 0.15, none: 0.05 }, choiceConfidence),
    skill_fit_0: { type: "noul", noul: fits[0] },
    skill_fit_1: { type: "noul", noul: fits[1] },
    skill_fit_2: { type: "noul", noul: fits[2] },
  },
});

const withPass1Answer = (name: string, answer: unknown): Record<string, unknown> => {
  const response = pass1Response();
  return {
    ...response,
    answers: { ...(response.answers as Record<string, unknown>), [name]: answer },
  };
};

class RecordingSystemOneClient implements SystemOneClientPort {
  readonly requests: SystemOneRequest[] = [];
  readonly #results: unknown[];

  constructor(...results: unknown[]) {
    this.#results = results;
  }

  async systemOne(request: SystemOneRequest): Promise<unknown> {
    this.requests.push(structuredClone(request));
    const result = this.#results.shift();
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }
}

const assertGatewayReason = async (
  operation: () => Promise<unknown>,
  reason: FallbackReason,
): Promise<void> => {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof SemanticGatewayError);
    assert.equal(error.reason, reason);
    assert.equal(error.message, reason);
    return true;
  });
};

test("pass1 sends bounded task evidence and omits excerpts and protected context", async () => {
  const client = new RecordingSystemOneClient(pass1Response());
  const result = await new TypeSafeGateway(client).pass1(input);

  assert.equal(client.requests.length, 1);
  assert.deepEqual(Object.keys(client.requests[0]!.questions).sort(), [
    "architecture_fork",
    "context_relevance",
    "critical_gap",
    "echo_catalog_hash",
    "echo_policy_version",
    "echo_task_id",
    "echo_task_revision",
    "reuse_candidate",
    "risk_data_loss",
    "risk_migration",
    "risk_public_contract",
    "risk_security",
    "risk_user_behavior",
    "skill_candidates",
    "task_type",
  ]);
  const request = client.requests[0]!;
  const state = request.state as Record<string, unknown>;
  const serialized = JSON.stringify(request);
  assert.equal(state.taskText, routerInput.taskText);
  assert.equal(serialized.includes(routerInput.taskText), true);
  assert.equal(JSON.stringify(request.questions).includes("state.taskText"), true);
  assert.equal(serialized.includes("secret-value"), false);
  assert.equal(serialized.includes("/Users/wrk/private"), false);
  assert.equal(serialized.includes("ctx-protected"), false);
  assert.equal(result.taskType, "diagnose");
  assert.deepEqual(result.skillCandidates, ["a", "b", "c"]);
  assert.deepEqual(result.criticalGap, routerInput.criticalGapCandidates![0]);
  assert.equal(result.reuseCandidate, "reuse-1");
  assert.deepEqual(result.architectureFork, routerInput.architectureForkCandidates![0]);
  assert.deepEqual(result.riskDimensions, {
    security: 0.1,
    "data-loss": 0.2,
    "public-contract": 0.3,
    migration: 0.4,
    "user-behavior": 0.5,
  });
  assert.deepEqual(result.contextRelevance, [{ id: "ctx-public", probability: 0.8 }]);
  assert.deepEqual(result.echo, {
    taskId: routerInput.taskId,
    taskRevision: routerInput.taskRevision,
    policyVersion: routerInput.policyVersion,
    catalogHash: routerInput.catalogHash,
  });
  assert.equal(result.metadata.model, "jev-test-1");
  assert.equal(result.metadata.inputTokens, 101);
  assert.equal(result.metadata.outputTokens, 17);
  assert.equal(Number.isFinite(result.metadata.latencyMs), true);
  assert.equal(result.metadata.latencyMs >= 0, true);
});

test("pass1 explicitly empties optional signal groups when no candidates are supplied", async () => {
  const sparseInput = precheck({
    ...routerInput,
    requiredSkillIds: ["a", "b", "c", "d"],
    criticalGapCandidates: [],
    architectureForkCandidates: [],
    reuseCandidates: [],
    contextFragments: [],
  });
  const response = pass1Response();
  const answers = { ...(response.answers as Record<string, unknown>) };
  delete answers.critical_gap;
  delete answers.reuse_candidate;
  delete answers.architecture_fork;
  delete answers.context_relevance;
  delete answers.skill_candidates;

  const client = new RecordingSystemOneClient({ ...response, answers });
  const result = await new TypeSafeGateway(client).pass1(sparseInput);

  assert.equal("critical_gap" in client.requests[0]!.questions, false);
  assert.equal("reuse_candidate" in client.requests[0]!.questions, false);
  assert.equal("architecture_fork" in client.requests[0]!.questions, false);
  assert.equal("context_relevance" in client.requests[0]!.questions, false);
  assert.equal("skill_candidates" in client.requests[0]!.questions, false);
  assert.deepEqual(result.skillCandidates, []);
  assert.equal(result.criticalGap, null);
  assert.equal(result.reuseCandidate, null);
  assert.equal(result.architectureFork, null);
  assert.deepEqual(result.contextRelevance, []);
});

test("pass2 can reject every shortlisted skill", async () => {
  const client = new RecordingSystemOneClient(pass2Response([0.39, 0.2, 0]));
  const result = await new TypeSafeGateway(client).pass2(input, ["a", "b", "c"]);

  assert.deepEqual(result.skillCandidates, []);
  assert.equal(client.requests.length, 1);
  assert.deepEqual(Object.keys(client.requests[0]!.questions).sort(), [
    "echo_catalog_hash",
    "echo_policy_version",
    "echo_task_id",
    "echo_task_revision",
    "skill_fit_0",
    "skill_fit_1",
    "skill_fit_2",
    "skill_ranking",
  ]);
  const request = client.requests[0]!;
  const state = request.state as Record<string, unknown>;
  const serialized = JSON.stringify(request);
  assert.equal(state.taskText, routerInput.taskText);
  assert.deepEqual(state.skills, routerInput.skills.slice(0, 3).map(
    ({ id, description, excerpt }) => ({ id, description, excerpt }),
  ));
  assert.equal(JSON.stringify(request.questions).includes("state.taskText"), true);
  assert.equal(JSON.stringify(request.questions).includes("state.skills"), true);
  assert.equal(serialized.includes("secret-value"), false);
  assert.equal(serialized.includes("/Users/wrk/private"), false);
  assert.equal(serialized.includes("ctx-protected"), false);
});

test("changing taskText changes the semantic state in both passes", async () => {
  const changedInput = precheck({
    ...routerInput,
    taskText: "Plan a synthetic queue retry migration.",
  });
  const originalClient = new RecordingSystemOneClient(pass1Response(), pass2Response());
  const changedClient = new RecordingSystemOneClient(pass1Response(), pass2Response());
  const originalGateway = new TypeSafeGateway(originalClient);
  const changedGateway = new TypeSafeGateway(changedClient);

  await originalGateway.pass1(input);
  await originalGateway.pass2(input, ["a", "b", "c"]);
  await changedGateway.pass1(changedInput);
  await changedGateway.pass2(changedInput, ["a", "b", "c"]);

  for (const index of [0, 1]) {
    const originalState = originalClient.requests[index]!.state as Record<string, unknown>;
    const changedState = changedClient.requests[index]!.state as Record<string, unknown>;
    assert.equal(originalState.taskText, routerInput.taskText);
    assert.equal(changedState.taskText, changedInput.taskText);
    assert.notDeepEqual(changedState, originalState);
  }
});

test("changing a shortlisted excerpt changes only the pass2 shortlisted evidence", async () => {
  const changedExcerpt = "Updated synthetic diagnostic steps A.";
  const changedInput = precheck({
    ...routerInput,
    skills: routerInput.skills.map((skill) =>
      skill.id === "a" ? { ...skill, excerpt: changedExcerpt } : skill),
  });
  const originalClient = new RecordingSystemOneClient(pass2Response());
  const changedClient = new RecordingSystemOneClient(pass2Response());

  await new TypeSafeGateway(originalClient).pass2(input, ["a", "b", "c"]);
  await new TypeSafeGateway(changedClient).pass2(changedInput, ["a", "b", "c"]);

  const original = JSON.stringify(originalClient.requests[0]!.state);
  const changed = JSON.stringify(changedClient.requests[0]!.state);
  assert.equal(original.includes(routerInput.skills[0]!.excerpt), true);
  assert.equal(changed.includes(changedExcerpt), true);
  assert.notEqual(changed, original);
  assert.equal(changed.includes("secret-value"), false);
  assert.equal(changed.includes("/Users/wrk/private"), false);
  assert.equal(changed.includes("ctx-protected"), false);
});

test("pass requests preserve semantic text at the documented bounds", async () => {
  const boundedInput = precheck({
    ...routerInput,
    taskText: "t".repeat(8_000),
    skills: routerInput.skills.map((skill, index) =>
      index === 0 ? { ...skill, description: "d".repeat(4_000), excerpt: "e".repeat(4_000) } : skill),
  });
  const client = new RecordingSystemOneClient(pass1Response(), pass2Response());
  const gateway = new TypeSafeGateway(client);

  await gateway.pass1(boundedInput);
  await gateway.pass2(boundedInput, ["a", "b", "c"]);

  const pass1State = client.requests[0]!.state as {
    taskText: string;
    skills: readonly { id: string; description: string }[];
  };
  const pass2State = client.requests[1]!.state as {
    taskText: string;
    skills: readonly { id: string; description: string; excerpt: string }[];
  };
  assert.equal(pass1State.taskText.length, 8_000);
  assert.equal(pass2State.taskText.length, 8_000);
  assert.equal(pass1State.skills[0]!.description.length, 4_000);
  assert.equal(pass2State.skills[0]!.description.length, 4_000);
  assert.equal(pass2State.skills[0]!.excerpt.length, 4_000);
});

test("pass2 reranks confident fits and drops confident non-fits", async () => {
  const response = pass2Response([0.2, 0.9, 0.8]);
  const answers = response.answers as Record<string, unknown>;
  answers.skill_ranking = choiceAnswer("c", { a: 0.1, b: 0.3, c: 0.55, none: 0.05 });

  const result = await new TypeSafeGateway(new RecordingSystemOneClient(response))
    .pass2(input, ["a", "b", "c"]);

  assert.deepEqual(result.skillCandidates, ["c", "b"]);
});

test("pass2 rejects a stale response echo", async () => {
  const response = pass2Response();
  response.answers = {
    ...(response.answers as Record<string, unknown>),
    echo_task_id: echoAnswer("stale-task"),
    echo_task_revision: echoAnswer(String(routerInput.taskRevision)),
    echo_policy_version: echoAnswer(routerInput.policyVersion),
    echo_catalog_hash: echoAnswer(routerInput.catalogHash),
  };

  await assertGatewayReason(
    () => new TypeSafeGateway(new RecordingSystemOneClient(response))
      .pass2(input, ["a", "b", "c"]),
    "stale-decision",
  );
});

test("reserved none identifiers are invalid input before an SDK call", async () => {
  const reservedInputs: RouterInput[] = [
    { ...routerInput, taskId: "none" },
    { ...routerInput, policyVersion: "none" },
    { ...routerInput, catalogHash: "none" },
    {
      ...routerInput,
      skills: [{ ...routerInput.skills[0]!, id: "none" }, ...routerInput.skills.slice(1)],
    },
    {
      ...routerInput,
      criticalGapCandidates: [{ ...routerInput.criticalGapCandidates![0]!, id: "none" }],
    },
    {
      ...routerInput,
      architectureForkCandidates: [{ ...routerInput.architectureForkCandidates![0]!, id: "none" }],
    },
    {
      ...routerInput,
      reuseCandidates: [{ ...routerInput.reuseCandidates![0]!, id: "none" }],
    },
    {
      ...routerInput,
      contextFragments: [{ id: "none", summary: "Synthetic public context." }],
    },
  ];

  for (const reservedInput of reservedInputs) {
    const client = new RecordingSystemOneClient(pass1Response());
    await assertGatewayReason(
      () => new TypeSafeGateway(client).pass1(precheck(reservedInput)),
      "invalid-input",
    );
    assert.equal(client.requests.length, 0);
  }

  const client = new RecordingSystemOneClient(pass2Response());
  await assertGatewayReason(
    () => new TypeSafeGateway(client).pass2(input, ["none"]),
    "invalid-input",
  );
  assert.equal(client.requests.length, 0);
});

test("pass2 rejects an unknown ID returned by the SDK", async () => {
  const response = pass2Response();
  const answers = response.answers as Record<string, unknown>;
  answers.skill_ranking = choiceAnswer(
    "invented",
    { a: 0.4, b: 0.2, c: 0.15, invented: 0.2, none: 0.05 },
  );

  await assertGatewayReason(
    () => new TypeSafeGateway(new RecordingSystemOneClient(response))
      .pass2(input, ["a", "b", "c"]),
    "unknown-id",
  );
});

test("pass2 rejects more than three, duplicate, and unknown shortlist IDs before a call", async () => {
  for (const [shortlist, reason] of [
    [["a", "b", "c", "d"], "malformed-response"],
    [["a", "a"], "malformed-response"],
    [["unknown"], "unknown-id"],
  ] as const) {
    const client = new RecordingSystemOneClient(pass2Response());
    await assertGatewayReason(() => new TypeSafeGateway(client).pass2(input, shortlist), reason);
    assert.equal(client.requests.length, 0);
  }
});

test("pass2 treats the inclusive Noul uncertainty boundaries as low confidence", async () => {
  for (const boundary of [0.4, 0.6]) {
    const client = new RecordingSystemOneClient(pass2Response([boundary, 0.8, 0.9]));
    await assertGatewayReason(
      () => new TypeSafeGateway(client).pass2(input, ["a", "b", "c"]),
      "low-confidence",
    );
  }
});

test("pass2 treats relative Choice confidence below 0.5 as low confidence", async () => {
  await assertGatewayReason(
    () => new TypeSafeGateway(new RecordingSystemOneClient(pass2Response([0.9, 0.8, 0.7], 0.49))).pass2(input, ["a", "b", "c"]),
    "low-confidence",
  );
});

test("pass1 and pass2 make exactly two client calls", async () => {
  const client = new RecordingSystemOneClient(pass1Response(), pass2Response());
  const gateway = new TypeSafeGateway(client);

  await gateway.pass1(input);
  await gateway.pass2(input, ["a", "b", "c"]);

  assert.equal(client.requests.length, 2);
});

test("malformed TypeSafe envelopes, answers, probabilities, and metadata are rejected", async () => {
  const cases: unknown[] = [
    { ...pass1Response(), model: "" },
    { ...pass1Response(), usage: undefined },
    { ...pass1Response(), usage: { input_tokens: -1, output_tokens: 1 } },
    withPass1Answer("task_type", { type: "noul", noul: 0.9 }),
    withPass1Answer("risk_security", { type: "noul", noul: Number.NaN }),
    withPass1Answer("risk_security", { type: "noul", noul: 1.01 }),
    withPass1Answer("task_type", choiceAnswer("diagnose", { diagnose: 1.1 })),
    withPass1Answer("unexpected", { type: "noul", noul: 0.5 }),
  ];

  for (const response of cases) {
    await assertGatewayReason(
      () => new TypeSafeGateway(new RecordingSystemOneClient(response)).pass1(input),
      "malformed-response",
    );
  }
});

test("unknown response IDs and stale echoes use typed safe errors", async () => {
  await assertGatewayReason(
    () => new TypeSafeGateway(new RecordingSystemOneClient(
      withPass1Answer(
        "skill_candidates",
        choiceAnswer("invented", { a: 0.4, b: 0.2, c: 0.1, d: 0.1, invented: 0.15, none: 0.05 }),
      ),
    )).pass1(input),
    "unknown-id",
  );

  await assertGatewayReason(
    () => new TypeSafeGateway(new RecordingSystemOneClient(
      withPass1Answer("echo_task_id", echoAnswer("stale-task")),
    )).pass1(input),
    "stale-decision",
  );
});

test("timeouts and service errors are typed without leaking the SDK error payload", async () => {
  for (const error of [
    new APITimeoutError(10_000),
    new Error("secret-value raw provider payload"),
  ]) {
    await assertGatewayReason(
      () => new TypeSafeGateway(new RecordingSystemOneClient(error)).pass1(input),
      "service-error",
    );
  }
});
