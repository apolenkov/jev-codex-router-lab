import assert from "node:assert/strict";
import test from "node:test";
import type { RouterInput, SemanticResponse } from "../src/contracts.js";
import { PolicyError, precheck, postcheck } from "../src/policy.js";

const validInput: RouterInput = {
  taskId: "synthetic-task-001",
  taskRevision: 1,
  taskText: "Synthetic lab task: summarize a fictional queue processor design.",
  policyVersion: "policy-2026-09-21.1",
  catalogHash: "sha256:synthetic-catalog-v1",
  explicitSkillIds: [],
  requiredSkillIds: [],
  skills: [
    { id: "brainstorming", description: "Synthetic skill: explores requirements.", excerpt: "Explore intent before code." },
    { id: "typesafe-ai", description: "Synthetic skill: typed judgments.", excerpt: "Use typed units of judgment." },
    { id: "a", description: "Synthetic skill a.", excerpt: "Excerpt a." },
    { id: "b", description: "Synthetic skill b.", excerpt: "Excerpt b." },
    { id: "c", description: "Synthetic skill c.", excerpt: "Excerpt c." },
    { id: "d", description: "Synthetic skill d.", excerpt: "Excerpt d." },
  ],
  criticalGapCandidates: [
    { id: "gap-1", fact: "synthetic missing fact", blocks: "synthetic blocked decision" },
  ],
  architectureForkCandidates: [
    { id: "fork-1", alternatives: ["push-model", "pull-model"], tradeoff: "latency vs simplicity" },
  ],
  reuseCandidates: [{ id: "reuse-1", summary: "existing synthetic throttler" }],
  contextFragments: [
    { id: "ctx-1", summary: "synthetic protected fragment", protected: true },
    { id: "ctx-2", summary: "synthetic ordinary fragment" },
  ],
};

const prechecked = precheck(validInput);

const validSemantic: SemanticResponse = {
  echo: {
    taskId: validInput.taskId,
    taskRevision: validInput.taskRevision,
    policyVersion: validInput.policyVersion,
    catalogHash: validInput.catalogHash,
  },
  taskType: "explain",
  skillCandidates: ["brainstorming"],
  criticalGap: null,
  reuseCandidate: null,
  architectureFork: null,
  riskDimensions: {
    security: 0.1,
    "data-loss": 0.1,
    "public-contract": 0.2,
    migration: 0.0,
    "user-behavior": 0.1,
  },
  contextRelevance: [{ id: "ctx-2", probability: 0.9 }],
};

test("precheck deduplicates explicit and required skills without dropping them", () => {
  const result = precheck({ ...validInput, explicitSkillIds: ["brainstorming"], requiredSkillIds: ["brainstorming", "typesafe-ai"] });
  assert.deepEqual(result.forcedSkillIds, ["brainstorming", "typesafe-ai"]);
});

test("precheck preserves more than three mandatory skills", () => {
  const result = precheck({ ...validInput, requiredSkillIds: ["a", "b", "c", "d"] });
  assert.deepEqual(result.forcedSkillIds, ["a", "b", "c", "d"]);
});

test("precheck rejects semantic text above the documented character limits", () => {
  const oversizedTask = "t".repeat(8_001);
  const oversizedField = "x".repeat(4_001);
  const cases: readonly RouterInput[] = [
    { ...validInput, taskText: oversizedTask },
    {
      ...validInput,
      skills: [{ ...validInput.skills[0]!, description: oversizedField }, ...validInput.skills.slice(1)],
    },
    {
      ...validInput,
      skills: [{ ...validInput.skills[0]!, excerpt: oversizedField }, ...validInput.skills.slice(1)],
    },
    {
      ...validInput,
      criticalGapCandidates: [{ id: "gap-1", fact: oversizedField, blocks: "bounded" }],
    },
    {
      ...validInput,
      architectureForkCandidates: [{ id: "fork-1", alternatives: [oversizedField], tradeoff: "bounded" }],
    },
    {
      ...validInput,
      reuseCandidates: [{ id: "reuse-1", summary: oversizedField }],
    },
    {
      ...validInput,
      contextFragments: [{ id: "ctx-2", summary: oversizedField }],
    },
  ];

  for (const candidate of cases) {
    assert.throws(() => precheck(candidate), PolicyError);
  }
});

test("postcheck rejects semantic identifiers outside the allowlist", () => {
  const decision = postcheck(prechecked, { ...validSemantic, skillCandidates: ["unknown"] });
  if (decision.status !== "fallback") {
    assert.fail("expected fallback decision");
  }
  assert.equal(decision.reason, "unknown-id");
  assert.deepEqual(decision.forcedSkillIds, prechecked.forcedSkillIds);
});

test("postcheck keeps protected context deterministic and rejects it as a semantic ID", () => {
  const decision = postcheck(prechecked, {
    ...validSemantic,
    contextRelevance: [{ id: "ctx-1", probability: 0.9 }],
  });

  assert.deepEqual(decision, {
    status: "fallback",
    reason: "unknown-id",
    forcedSkillIds: [],
    protectedContextIds: ["ctx-1"],
  });
});

test("precheck reports invalid-input for shape-invalid JSON input", () => {
  const cases: unknown[] = [
    null,
    "task text only",
    { ...validInput, taskId: 7 },
    { ...validInput, taskText: {} },
    { ...validInput, explicitSkillIds: "brainstorming" },
    { ...validInput, requiredSkillIds: [null] },
    { ...validInput, skills: "not-an-array" },
    { ...validInput, skills: [null] },
    { ...validInput, skills: [{ id: "brainstorming" }] },
    { ...validInput, criticalGapCandidates: { id: "gap-1" } },
    { ...validInput, architectureForkCandidates: [null] },
    { ...validInput, reuseCandidates: [{ id: "reuse-1" }] },
    { ...validInput, contextFragments: "ctx" },
    { ...validInput, contextFragments: [{ id: "ctx-9" }] },
  ];
  for (const bad of cases) {
    try {
      precheck(bad as RouterInput);
      assert.fail(`precheck accepted shape-invalid input: ${JSON.stringify(bad)}`);
    } catch (error) {
      assert.ok(error instanceof PolicyError, `expected PolicyError, got ${String(error)}`);
      assert.equal((error as PolicyError).reason, "invalid-input");
    }
  }
});

test("postcheck reports malformed-response for non-string semantic ids", () => {
  const cases: unknown[] = [
    null,
    { ...validSemantic, skillCandidates: [42] },
    { ...validSemantic, criticalGap: { id: 9, fact: "f", blocks: "b" } },
    { ...validSemantic, architectureFork: "fork-1" },
    { ...validSemantic, reuseCandidate: 3 },
    { ...validSemantic, contextRelevance: [{ id: 7, probability: 0.5 }] },
  ];
  for (const semantic of cases) {
    const decision = postcheck(prechecked, semantic as SemanticResponse);
    if (decision.status !== "fallback") {
      assert.fail(`expected fallback for ${JSON.stringify(semantic)}`);
    }
    assert.equal(decision.reason, "malformed-response");
  }
});

test("postcheck rejects every missing advisory signal property", () => {
  const requiredSignalKeys = [
    "reuseCandidate",
    "criticalGap",
    "architectureFork",
    "taskType",
    "skillCandidates",
    "riskDimensions",
    "contextRelevance",
  ] as const;

  for (const key of requiredSignalKeys) {
    const missing = { ...validSemantic } as unknown as Record<string, unknown>;
    Reflect.deleteProperty(missing, key);
    const decision = postcheck(prechecked, missing as unknown as SemanticResponse);
    assert.equal(decision.status, "fallback", `missing ${key}`);
    if (decision.status !== "fallback") {
      assert.fail(`expected fallback when ${key} is absent`);
    }
    assert.equal(decision.reason, "malformed-response", `missing ${key}`);
  }
});

test("postcheck rejects undefined nullable signal properties", () => {
  for (const key of ["criticalGap", "reuseCandidate", "architectureFork"] as const) {
    const decision = postcheck(prechecked, {
      ...validSemantic,
      [key]: undefined,
    } as unknown as SemanticResponse);
    assert.equal(decision.status, "fallback", `undefined ${key}`);
    if (decision.status !== "fallback") {
      assert.fail(`expected fallback when ${key} is undefined`);
    }
    assert.equal(decision.reason, "malformed-response", `undefined ${key}`);
  }
});

test("postcheck accepts explicitly null nullable signal properties", () => {
  const decision = postcheck(prechecked, {
    ...validSemantic,
    criticalGap: null,
    reuseCandidate: null,
    architectureFork: null,
  });

  if (decision.status !== "ok") {
    assert.fail("expected explicit null signal properties to remain valid");
  }
  assert.equal(decision.signals.criticalGap, null);
  assert.equal(decision.signals.reuseCandidate, null);
  assert.equal(decision.signals.architectureFork, null);
});

test("postcheck re-derives closed signal objects without model-added fields", () => {
  const decision = postcheck(prechecked, {
    ...validSemantic,
    riskDimensions: { ...validSemantic.riskDimensions, confidence: 1 },
    contextRelevance: [{ id: "ctx-2", probability: 0.9, note: "model-added" }],
  } as unknown as SemanticResponse);
  if (decision.status !== "ok") {
    assert.fail("expected ok decision");
  }
  assert.deepEqual(decision.signals.contextRelevance, [{ id: "ctx-2", probability: 0.9 }]);
  assert.deepEqual(
    Object.keys(decision.signals.riskDimensions).sort(),
    ["data-loss", "migration", "public-contract", "security", "user-behavior"],
  );
});
