import assert from "node:assert/strict";
import test from "node:test";
import type {
  FallbackReason,
  RouterInput,
  SemanticResponse,
} from "../src/contracts.js";
import {
  SemanticGatewayError,
  type Pass1Result,
  type Pass2Result,
  type SemanticGateway,
} from "../src/semantic-gateway.js";
import { route, routeWithTelemetry } from "../src/router.js";
import { buildReport } from "../src/telemetry.js";
import { TypeSafeGateway } from "../src/typesafe-gateway.js";

const validInput: RouterInput = {
  taskId: "synthetic-router-001",
  taskRevision: 1,
  taskText: "DO-NOT-LOG synthetic task body",
  policyVersion: "policy-test-1",
  catalogHash: "sha256:test-catalog",
  explicitSkillIds: ["brainstorming", "typesafe-ai"],
  requiredSkillIds: ["a", "b"],
  skills: [
    { id: "brainstorming", description: "DO-NOT-LOG description", excerpt: "DO-NOT-LOG excerpt" },
    { id: "typesafe-ai", description: "Synthetic type-safe advice", excerpt: "Synthetic excerpt" },
    { id: "a", description: "Synthetic skill a", excerpt: "Synthetic excerpt a" },
    { id: "b", description: "Synthetic skill b", excerpt: "Synthetic excerpt b" },
    { id: "c", description: "Synthetic optional skill c", excerpt: "Synthetic excerpt c" },
    { id: "d", description: "Synthetic optional skill d", excerpt: "Synthetic excerpt d" },
  ],
  criticalGapCandidates: [],
  architectureForkCandidates: [],
  reuseCandidates: [],
  contextFragments: [],
};

const semantic = (
  skillCandidates: readonly string[] = [],
): SemanticResponse => ({
  echo: {
    taskId: validInput.taskId,
    taskRevision: validInput.taskRevision,
    policyVersion: validInput.policyVersion,
    catalogHash: validInput.catalogHash,
  },
  taskType: "change",
  skillCandidates,
  criticalGap: null,
  reuseCandidate: null,
  architectureFork: null,
  riskDimensions: {
    security: 0.1,
    "data-loss": 0.2,
    "public-contract": 0.3,
    migration: 0.4,
    "user-behavior": 0.5,
  },
  contextRelevance: [],
});

const pass1 = (
  skillCandidates: readonly string[] = [],
  metadata: Pass1Result["metadata"] = {
    model: "jev-test",
    inputTokens: 100,
    outputTokens: 20,
    latencyMs: 12,
  },
): Pass1Result => ({ ...semantic(skillCandidates), metadata });

const pass2 = (
  skillCandidates: readonly string[],
  metadata: Pass2Result["metadata"] = {
    model: "jev-test",
    inputTokens: 10,
    outputTokens: 5,
    latencyMs: 4,
  },
): Pass2Result => ({ skillCandidates, metadata });

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

const forcedSkills = ["brainstorming", "typesafe-ai", "a", "b"];

test("route preserves every uncapped forced skill when an unknown gateway error is thrown", async () => {
  const gateway: SemanticGateway = {
    pass1: async () => { throw new Error("DO-NOT-LOG provider payload"); },
    pass2: async () => { assert.fail("pass2 must not be called"); },
  };

  const decision = await route(validInput, gateway);

  assert.deepEqual(decision, {
    status: "fallback",
    reason: "service-error",
    forcedSkillIds: forcedSkills,
    protectedContextIds: [],
  });
  assert.equal(JSON.stringify(decision).includes("DO-NOT-LOG"), false);
});

test("route skips pass2 when pass1 proposes no optional skill", async () => {
  const calls: string[] = [];
  const gateway: SemanticGateway = {
    pass1: async () => {
      calls.push("pass1");
      return pass1();
    },
    pass2: async () => {
      calls.push("pass2");
      return pass2([]);
    },
  };

  const decision = await route(validInput, gateway);

  assert.equal(decision.status, "ok");
  assert.deepEqual(calls, ["pass1"]);
});

test("route combines a successful two-pass result before postcheck", async () => {
  const calls: string[] = [];
  const gateway: SemanticGateway = {
    pass1: async () => {
      calls.push("pass1");
      return pass1(["c", "d"]);
    },
    pass2: async (_input, shortlist) => {
      calls.push(`pass2:${shortlist.join(",")}`);
      return pass2(["d"]);
    },
  };

  const decision = await route(validInput, gateway);

  assert.deepEqual(calls, ["pass1", "pass2:c,d"]);
  assert.equal(decision.status, "ok");
  if (decision.status !== "ok") {
    assert.fail("expected an ok decision");
  }
  assert.deepEqual(decision.signals.skillCandidates, ["d"]);
  assert.deepEqual(decision.forcedSkillIds, forcedSkills);
});

test("route maps every typed gateway reason without losing forced skills", async () => {
  const reasons: readonly FallbackReason[] = [
    "invalid-input",
    "service-error",
    "malformed-response",
    "stale-decision",
    "unknown-id",
    "low-confidence",
  ];

  for (const reason of reasons) {
    const gateway: SemanticGateway = {
      pass1: async () => { throw new SemanticGatewayError(reason); },
      pass2: async () => { assert.fail("pass2 must not be called"); },
    };
    const decision = await route(validInput, gateway);
    assert.deepEqual(decision, {
      status: "fallback",
      reason,
      forcedSkillIds: forcedSkills,
      protectedContextIds: [],
    });
  }
});

test("route maps malformed, stale, and unknown pass1 results through postcheck", async () => {
  const cases: readonly [SemanticResponse, FallbackReason][] = [
    [{ ...semantic(["c"]), taskType: "invalid" } as unknown as SemanticResponse, "malformed-response"],
    [{ ...semantic(["c"]), echo: { ...semantic().echo, taskRevision: 99 } }, "stale-decision"],
    [semantic(["not-allowlisted"]), "unknown-id"],
  ];

  for (const [response, reason] of cases) {
    let pass2Calls = 0;
    const gateway: SemanticGateway = {
      pass1: async () => ({ ...response, metadata: pass1().metadata }),
      pass2: async () => {
        pass2Calls += 1;
        return pass2([]);
      },
    };
    const decision = await route(validInput, gateway);
    assert.deepEqual(decision, {
      status: "fallback",
      reason,
      forcedSkillIds: forcedSkills,
      protectedContextIds: [],
    });
    assert.equal(pass2Calls, 0);
  }
});

test("route rejects a gateway result that omits a nullable signal", async () => {
  const missingReuseCandidate: Partial<Pass1Result> = { ...pass1() };
  delete missingReuseCandidate.reuseCandidate;
  const decision = await route(validInput, {
    pass1: async () => missingReuseCandidate as unknown as Pass1Result,
    pass2: async () => { assert.fail("pass2 must not be called"); },
  });
  const serialized = JSON.stringify(decision);

  assert.deepEqual(decision, {
    status: "fallback",
    reason: "malformed-response",
    forcedSkillIds: forcedSkills,
    protectedContextIds: [],
  });
  assert.equal(serialized.includes('"status":"ok"'), false);
  assert.equal(serialized.includes('"signals"'), false);
});

test("route returns invalid-input before the gateway and preserves valid forced IDs", async () => {
  let calls = 0;
  const gateway: SemanticGateway = {
    pass1: async () => {
      calls += 1;
      return pass1();
    },
    pass2: async () => {
      calls += 1;
      return pass2([]);
    },
  };

  const decision = await route({ ...validInput, taskRevision: 0 }, gateway);

  assert.deepEqual(decision, {
    status: "fallback",
    reason: "invalid-input",
    forcedSkillIds: forcedSkills,
    protectedContextIds: [],
  });
  assert.equal(calls, 0);
});

test("route rejects oversized task text and skill excerpts before an SDK call", async () => {
  const protectedContext = [
    { id: "ctx-protected", summary: "DO-NOT-SEND protected body", protected: true as const },
  ];
  const oversizedInputs: readonly RouterInput[] = [
    { ...validInput, taskText: "t".repeat(8_001), contextFragments: protectedContext },
    {
      ...validInput,
      skills: validInput.skills.map((skill, index) =>
        index === 0 ? { ...skill, excerpt: "x".repeat(4_001) } : skill),
      contextFragments: protectedContext,
    },
  ];

  for (const oversizedInput of oversizedInputs) {
    let sdkCalls = 0;
    const decision = await route(oversizedInput, new TypeSafeGateway({
      systemOne: async () => {
        sdkCalls += 1;
        return {};
      },
    }));

    assert.deepEqual(decision, {
      status: "fallback",
      reason: "invalid-input",
      forcedSkillIds: forcedSkills,
      protectedContextIds: ["ctx-protected"],
    });
    assert.equal(sdkCalls, 0);
    assert.equal(JSON.stringify(decision).includes("DO-NOT-SEND"), false);
  }
});

test("route preserves protected context IDs in ok and fallback decisions", async () => {
  const inputWithProtectedContext: RouterInput = {
    ...validInput,
    contextFragments: [
      { id: "ctx-protected", summary: "DO-NOT-SEND protected body", protected: true },
      { id: "ctx-public", summary: "Synthetic public context." },
    ],
  };
  const ok = await route(inputWithProtectedContext, {
    pass1: async () => pass1(),
    pass2: async () => { assert.fail("pass2 must not be called"); },
  });
  const fallback = await route(inputWithProtectedContext, {
    pass1: async () => { throw new SemanticGatewayError("service-error"); },
    pass2: async () => { assert.fail("pass2 must not be called"); },
  });

  assert.equal(ok.status, "ok");
  assert.deepEqual(ok.protectedContextIds, ["ctx-protected"]);
  assert.deepEqual(fallback, {
    status: "fallback",
    reason: "service-error",
    forcedSkillIds: forcedSkills,
    protectedContextIds: ["ctx-protected"],
  });
  assert.equal(JSON.stringify(ok).includes("DO-NOT-SEND"), false);
  assert.equal(JSON.stringify(fallback).includes("DO-NOT-SEND"), false);
});

test("metadata report contains only accounting fields and uses null for unconfigured cost", async () => {
  const execution = await routeWithTelemetry(validInput, {
    pass1: async () => pass1(["c"]),
    pass2: async () => pass2(["c"]),
  });
  const report = buildReport(execution.decision, execution.telemetry, {});
  const serialized = JSON.stringify(report);

  assert.equal(report.status, "ok");
  assert.equal(report.callCount, 2);
  assert.equal(report.inputTokens, 110);
  assert.equal(report.outputTokens, 25);
  assert.equal(report.cacheStatus, "not-used");
  assert.equal(report.costUsd, null);
  assert.equal(report.costReason, "price-not-configured");
  assert.equal("retryCount" in report, false);
  assert.deepEqual(report.passes, [
    { pass: "pass1", model: "jev-test", inputTokens: 100, outputTokens: 20, latencyMs: 12 },
    { pass: "pass2", model: "jev-test", inputTokens: 10, outputTokens: 5, latencyMs: 4 },
  ]);
  assert.equal(Number.isFinite(report.totalLatencyMs), true);
  assert.equal(report.totalLatencyMs >= 0, true);
  assert.equal(serialized.includes("DO-NOT-LOG"), false);
  assert.equal(serialized.includes("synthetic-router-001"), false);
  assert.equal(serialized.includes("brainstorming"), false);
});

test("low-confidence pass2 fallback retains validated provider metadata for reporting", async () => {
  const pass2Gateway = new TypeSafeGateway({
    systemOne: async () => ({
      model: "jev-low-confidence",
      usage: { input_tokens: 10, output_tokens: 5 },
      answers: {
        echo_task_id: echoAnswer(validInput.taskId),
        echo_task_revision: echoAnswer(String(validInput.taskRevision)),
        echo_policy_version: echoAnswer(validInput.policyVersion),
        echo_catalog_hash: echoAnswer(validInput.catalogHash),
        skill_ranking: choiceAnswer("c", { c: 0.8, none: 0.2 }, 0.49),
        skill_fit_0: { type: "noul", noul: 0.9 },
      },
    }),
  });
  const execution = await routeWithTelemetry(validInput, {
    pass1: async () => pass1(["c"]),
    pass2: (checked, shortlist) => pass2Gateway.pass2(checked, shortlist),
  });
  const report = buildReport(execution.decision, execution.telemetry, {
    TYPESAFE_INPUT_USD_PER_MILLION: "2",
    TYPESAFE_OUTPUT_USD_PER_MILLION: "8",
  });

  assert.deepEqual(execution.decision, {
    status: "fallback",
    reason: "low-confidence",
    forcedSkillIds: forcedSkills,
    protectedContextIds: [],
  });
  assert.equal(execution.telemetry.passes.length, 2);
  assert.equal(execution.telemetry.passes[1]!.model, "jev-low-confidence");
  assert.equal(execution.telemetry.passes[1]!.inputTokens, 10);
  assert.equal(execution.telemetry.passes[1]!.outputTokens, 5);
  assert.equal(Number.isFinite(execution.telemetry.passes[1]!.latencyMs), true);
  assert.equal(report.callCount, 2);
  assert.equal(report.inputTokens, 110);
  assert.equal(report.outputTokens, 25);
  assert.equal(report.costUsd, 0.00042);
  assert.equal(JSON.stringify(report).includes(validInput.taskText), false);
});

test("pre-envelope malformed responses do not fabricate provider metadata", async () => {
  const execution = await routeWithTelemetry(validInput, new TypeSafeGateway({
    systemOne: async () => ({ model: "jev-test", answers: {}, usage: undefined }),
  }));
  const report = buildReport(execution.decision, execution.telemetry, {
    TYPESAFE_INPUT_USD_PER_MILLION: "2",
    TYPESAFE_OUTPUT_USD_PER_MILLION: "8",
  });

  assert.equal(execution.decision.status, "fallback");
  assert.deepEqual(Object.keys(execution.telemetry.passes[0]!).sort(), ["latencyMs", "pass"]);
  assert.equal(report.inputTokens, null);
  assert.equal(report.outputTokens, null);
  assert.equal(report.costUsd, null);
  assert.equal(report.costReason, "usage-not-observable");
});

test("metadata report calculates cost only from two valid non-negative prices", async () => {
  const execution = await routeWithTelemetry(validInput, {
    pass1: async () => pass1(),
    pass2: async () => { assert.fail("pass2 must not be called"); },
  });

  const priced = buildReport(execution.decision, execution.telemetry, {
    TYPESAFE_INPUT_USD_PER_MILLION: "2",
    TYPESAFE_OUTPUT_USD_PER_MILLION: "8",
  });
  assert.equal(priced.costUsd, 0.00036);
  assert.equal("costReason" in priced, false);

  for (const prices of [
    { TYPESAFE_INPUT_USD_PER_MILLION: "", TYPESAFE_OUTPUT_USD_PER_MILLION: "8" },
    { TYPESAFE_INPUT_USD_PER_MILLION: "2", TYPESAFE_OUTPUT_USD_PER_MILLION: "NaN" },
    { TYPESAFE_INPUT_USD_PER_MILLION: "-1", TYPESAFE_OUTPUT_USD_PER_MILLION: "8" },
    { TYPESAFE_INPUT_USD_PER_MILLION: "2" },
  ]) {
    const report = buildReport(execution.decision, execution.telemetry, prices);
    assert.equal(report.costUsd, null);
    assert.equal(report.costReason, "price-not-configured");
  }
});

test("retry count appears only when the gateway exposes it", async () => {
  const execution = await routeWithTelemetry(validInput, {
    pass1: async () => pass1([], {
      model: "jev-test",
      inputTokens: 1,
      outputTokens: 2,
      latencyMs: 3,
      retryCount: 2,
    } as Pass1Result["metadata"] & { retryCount: number }),
    pass2: async () => { assert.fail("pass2 must not be called"); },
  });
  const report = buildReport(execution.decision, execution.telemetry, {});

  assert.equal(report.retryCount, 2);
  assert.equal(report.passes[0]?.retryCount, 2);
});

test("configured prices do not turn zero observed passes into zero cost", () => {
  const report = buildReport(
    {
      status: "fallback",
      reason: "service-error",
      forcedSkillIds: ["brainstorming"],
      protectedContextIds: [],
    },
    { passes: [], totalLatencyMs: 0 },
    {
      TYPESAFE_INPUT_USD_PER_MILLION: "2",
      TYPESAFE_OUTPUT_USD_PER_MILLION: "8",
    },
  );

  assert.equal(report.callCount, 0);
  assert.equal(report.inputTokens, null);
  assert.equal(report.outputTokens, null);
  assert.equal(report.costUsd, null);
  assert.equal(report.costReason, "usage-not-observable");
});

test("non-finite calculated cost is reported as cost-overflow", () => {
  const report = buildReport(
    {
      status: "fallback",
      reason: "service-error",
      forcedSkillIds: [],
      protectedContextIds: [],
    },
    {
      passes: [{
        pass: "pass1",
        latencyMs: 1,
        model: "jev-test",
        inputTokens: Number.MAX_VALUE,
        outputTokens: 0,
      }],
      totalLatencyMs: 1,
    },
    {
      TYPESAFE_INPUT_USD_PER_MILLION: String(Number.MAX_VALUE),
      TYPESAFE_OUTPUT_USD_PER_MILLION: "0",
    },
  );

  assert.equal(report.costUsd, null);
  assert.equal(report.costReason, "cost-overflow");
});
