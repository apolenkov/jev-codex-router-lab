import assert from "node:assert/strict";
import test from "node:test";
import type { RouterInput, SemanticResponse } from "../src/contracts.js";
import { precheck, postcheck } from "../src/policy.js";

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
  contextRelevance: [{ id: "ctx-1", probability: 0.9 }],
};

test("precheck deduplicates explicit and required skills without dropping them", () => {
  const result = precheck({ ...validInput, explicitSkillIds: ["brainstorming"], requiredSkillIds: ["brainstorming", "typesafe-ai"] });
  assert.deepEqual(result.forcedSkillIds, ["brainstorming", "typesafe-ai"]);
});

test("precheck preserves more than three mandatory skills", () => {
  const result = precheck({ ...validInput, requiredSkillIds: ["a", "b", "c", "d"] });
  assert.deepEqual(result.forcedSkillIds, ["a", "b", "c", "d"]);
});

test("postcheck rejects semantic identifiers outside the allowlist", () => {
  assert.equal(postcheck(prechecked, { ...validSemantic, skillCandidates: ["unknown"] }).status, "fallback");
});
