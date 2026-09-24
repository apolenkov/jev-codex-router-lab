import assert from "node:assert/strict";
import test from "node:test";
import { CalibrationError } from "../src/calibration-runner.js";
import type { ClosedAnswerEvidence } from "../src/calibration-runner.js";
import type { PrecheckedInput } from "../src/contracts.js";
import {
  parsePass1SelectionArtifact,
  scorePass1ThresholdCases,
  selectPass1Threshold,
  buildPass1SelectionArtifact,
  PASS1_SIGNAL_UNITS,
  PASS1_THRESHOLD_GRID,
  type Pass1ThresholdTuple,
} from "../src/pass1-threshold-selector.js";
import type {
  Pass1AnnotatedCase,
  Pass1AnnotatedCorpus,
  Pass1CaseLabels,
  Pass1GoldLeaf,
  Pass1ThresholdCaseRecord,
} from "../src/pass1-threshold-runner.js";

const calibrationReason = (reason: string) => (error: unknown): boolean =>
  error instanceof Error &&
  error.name === "CalibrationError" &&
  (error as CalibrationError).reason === reason;

const resolved = <T>(value: T | null): Pass1GoldLeaf<T> => ({
  status: "resolved",
  value,
});
const ambiguous = <T>(value: T | null = null): Pass1GoldLeaf<T> => ({
  status: "ambiguous",
  value,
});
const notQueried = <T>(): Pass1GoldLeaf<T> => ({
  status: "not_queried",
  value: null,
});

const baseLabels = (): Pass1CaseLabels => ({
  taskType: resolved("diagnose"),
  skillCandidates: resolved(["skill-a"]),
  criticalGap: resolved<string>(null),
  reuseCandidate: resolved<string>(null),
  architectureFork: resolved<string>(null),
  contextRelevance: resolved(["ctx-1"]),
  riskDimensions: {
    security: resolved("negative"),
    "data-loss": resolved("negative"),
    "public-contract": resolved("negative"),
    migration: resolved("negative"),
    "user-behavior": resolved("negative"),
  },
});

const stubInput = (caseId: string): PrecheckedInput => ({
  taskId: caseId,
  taskRevision: 1,
  taskText: "synthetic task text",
  policyVersion: "test-policy",
  catalogHash: "test-catalog",
  explicitSkillIds: [],
  requiredSkillIds: [],
  skills: [],
  forcedSkillIds: [],
  protectedContextIds: [],
});

const corpusOf = (
  entries: readonly (readonly [string, Pass1CaseLabels])[],
  split: "calibration" | "evaluation" = "calibration",
): Pass1AnnotatedCorpus => ({
  split,
  cases: entries.map(([caseId, labels]): Pass1AnnotatedCase => ({
    caseId,
    input: stubInput(caseId),
    labels,
  })),
});

const choice = (
  selected: string,
  confidence = 0.9,
): ClosedAnswerEvidence => ({
  type: "choice",
  choice: selected,
  confidence,
  probabilities: { [selected]: confidence },
});

const noul = (value: number): ClosedAnswerEvidence => ({
  type: "noul",
  noul: value,
});

const correctAnswers = (
  overrides: Record<string, ClosedAnswerEvidence> = {},
  confidence = 0.9,
): Record<string, ClosedAnswerEvidence> => ({
  task_type: choice("diagnose", confidence),
  skill_candidates: choice("skill-a", confidence),
  critical_gap: choice("none", confidence),
  reuse_candidate: choice("none", confidence),
  architecture_fork: choice("none", confidence),
  context_relevance: choice("ctx-1", confidence),
  risk_security: noul(0.2),
  risk_data_loss: noul(0.2),
  risk_public_contract: noul(0.2),
  risk_migration: noul(0.2),
  risk_user_behavior: noul(0.2),
  ...overrides,
});

const collected = (
  caseId: string,
  answers: Record<string, ClosedAnswerEvidence>,
  attempts = 1,
): Pass1ThresholdCaseRecord => ({
  schemaVersion: 1,
  caseId,
  outcome: "collected",
  questionKeys: Object.keys(answers),
  answers,
  metadata: { model: "jev-1.13.0", inputTokens: 1, outputTokens: 1, latencyMs: 1 },
  costUsd: 0.000001,
  attempts,
});

const invalidResponse = (caseId: string): Pass1ThresholdCaseRecord => ({
  schemaVersion: 1,
  caseId,
  outcome: "invalid-response",
  reason: "malformed-response",
  questionKeys: ["task_type"],
  attempts: 1,
});

const failed = (caseId: string): Pass1ThresholdCaseRecord => ({
  schemaVersion: 1,
  caseId,
  outcome: "failed",
  error: "provider-error",
  attempts: 1,
});

const rowOf = (
  selection: ReturnType<typeof selectPass1Threshold>,
  tuple: Pass1ThresholdTuple,
) =>
  selection.table.find(
    (row) =>
      row.floor === tuple.floor && row.lo === tuple.lo && row.hi === tuple.hi,
  )!;

test("the frozen grid is the pre-registered 10 by 3 by 3 lattice", () => {
  assert.equal(PASS1_THRESHOLD_GRID.length, 90);
  const floors = [...new Set(PASS1_THRESHOLD_GRID.map(({ floor }) => floor))];
  const los = [...new Set(PASS1_THRESHOLD_GRID.map(({ lo }) => lo))];
  const his = [...new Set(PASS1_THRESHOLD_GRID.map(({ hi }) => hi))];
  assert.deepEqual(floors, [
    0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95,
  ]);
  assert.deepEqual(los, [0.4, 0.44, 0.48]);
  assert.deepEqual(his, [0.52, 0.56, 0.6]);
  assert.deepEqual(PASS1_SIGNAL_UNITS, [
    "taskType",
    "skillCandidates",
    "criticalGap",
    "reuseCandidate",
    "architectureFork",
    "contextRelevance",
    "riskDimensions.security",
    "riskDimensions.data-loss",
    "riskDimensions.public-contract",
    "riskDimensions.migration",
    "riskDimensions.user-behavior",
  ]);
});

test("the gate accepts iff every choice meets floor and every noul clears the band", () => {
  const corpus = corpusOf([["CAL-001", baseLabels()]]);
  const boundary = collected("CAL-001", {
    task_type: choice("diagnose", 0.7),
    risk_security: noul(0.44),
    risk_data_loss: noul(0.56),
    risk_public_contract: noul(0.4),
    risk_migration: noul(0.6),
    risk_user_behavior: noul(0.2),
  });
  const selection = selectPass1Threshold(corpus, [boundary]);

  // confidence 0.70 rejects floors above 0.70; a noul inside the closed
  // band rejects only that band, so 0.44 fails [0.40, 0.52] but clears
  // [0.48, 0.52] together with the other boundary nouls.
  assert.equal(rowOf(selection, { floor: 0.7, lo: 0.4, hi: 0.52 }).accepted, 0);
  assert.equal(rowOf(selection, { floor: 0.7, lo: 0.48, hi: 0.52 }).accepted, 1);
  const wideEnough = selectPass1Threshold(corpus, [
    collected("CAL-001", {
      task_type: choice("diagnose", 0.7),
      risk_security: noul(0.39),
      risk_data_loss: noul(0.61),
      risk_public_contract: noul(0.2),
      risk_migration: noul(0.2),
      risk_user_behavior: noul(0.2),
    }),
  ]);
  assert.equal(
    rowOf(wideEnough, { floor: 0.7, lo: 0.4, hi: 0.52 }).accepted,
    1,
  );
  assert.equal(
    rowOf(wideEnough, { floor: 0.75, lo: 0.4, hi: 0.52 }).accepted,
    0,
  );
  assert.equal(
    rowOf(wideEnough, { floor: 0.7, lo: 0.4, hi: 0.52 }).coverage,
    1,
  );
});

test("scalar, set, nullable, and risk label comparisons follow the frozen rules", () => {
  const labels: Pass1CaseLabels = {
    taskType: resolved("plan"),
    skillCandidates: resolved(["skill-a", "skill-b"]),
    criticalGap: resolved("gap-1"),
    reuseCandidate: resolved<string>(null),
    architectureFork: resolved<string>(null),
    contextRelevance: resolved<readonly string[]>([]),
    riskDimensions: {
      security: resolved("positive"),
      "data-loss": resolved("negative"),
      "public-contract": resolved("positive"),
      migration: resolved("negative"),
      "user-behavior": resolved("positive"),
    },
  };
  const corpus = corpusOf([["CAL-001", labels]]);
  const record = collected("CAL-001", {
    task_type: choice("plan"),
    skill_candidates: choice("skill-b"),
    critical_gap: choice("gap-1"),
    reuse_candidate: choice("none"),
    architecture_fork: choice("none"),
    context_relevance: choice("none"),
    risk_security: noul(0.9),
    risk_data_loss: noul(0.1),
    risk_public_contract: noul(0.8),
    risk_migration: noul(0.5),
    risk_user_behavior: noul(0.7),
  });
  // noul 0.5 sits inside every frozen band, so the case is scored through a
  // wider off-grid band to exercise the 0.5-as-error rule on an accepted case.
  const tuple = { floor: 0.5, lo: 0.2, hi: 0.4 };
  const score = scorePass1ThresholdCases(corpus, [record], tuple);

  assert.equal(score.accepted, 1);
  assert.equal(score.perSignal.taskType.errors, 0);
  assert.equal(score.perSignal.skillCandidates.errors, 0);
  assert.equal(score.perSignal.criticalGap.errors, 0);
  assert.equal(score.perSignal.reuseCandidate.errors, 0);
  assert.equal(score.perSignal.contextRelevance.errors, 0);
  assert.equal(score.perSignal["riskDimensions.security"].errors, 0);
  // noul exactly 0.5 counts as an error even against a negative gold sign.
  assert.equal(score.perSignal["riskDimensions.migration"].errors, 1);
  assert.equal(score.totalErrors, 1);
});

test("mismatched answers count one error per signal", () => {
  const corpus = corpusOf([["CAL-001", baseLabels()]]);
  const record = collected("CAL-001", correctAnswers({
    task_type: choice("plan"),
    skill_candidates: choice("none"),
    critical_gap: choice("gap-9"),
    reuse_candidate: choice("reuse-9"),
    risk_security: noul(0.95),
  }));
  const score = scorePass1ThresholdCases(
    corpus,
    [record],
    { floor: 0.5, lo: 0.4, hi: 0.52 },
  );

  assert.equal(score.perSignal.taskType.errors, 1);
  assert.equal(score.perSignal.skillCandidates.errors, 1);
  assert.equal(score.perSignal.criticalGap.errors, 1);
  assert.equal(score.perSignal.reuseCandidate.errors, 1);
  assert.equal(score.perSignal["riskDimensions.security"].errors, 1);
  assert.equal(score.totalErrors, 5);
});

test("ambiguous and not_queried labels stay out of evaluable denominators", () => {
  const labels: Pass1CaseLabels = {
    ...baseLabels(),
    criticalGap: ambiguous(),
    reuseCandidate: notQueried(),
    architectureFork: ambiguous(),
    riskDimensions: {
      ...baseLabels().riskDimensions,
      security: ambiguous(),
    },
  };
  const corpus = corpusOf([["CAL-001", labels]]);
  const record = collected("CAL-001", correctAnswers({
    critical_gap: choice("gap-1"),
    risk_security: noul(0.95),
  }));
  const score = scorePass1ThresholdCases(
    corpus,
    [record],
    { floor: 0.5, lo: 0.4, hi: 0.52 },
  );

  assert.equal(score.perSignal.criticalGap.evaluable, 0);
  assert.equal(score.perSignal.criticalGap.errors, 0);
  assert.equal(score.perSignal.criticalGap.excluded, 1);
  assert.equal(score.perSignal.reuseCandidate.excluded, 1);
  assert.equal(score.perSignal["riskDimensions.security"].evaluable, 0);
  assert.equal(score.perSignal["riskDimensions.security"].errorRate, null);
  assert.equal(score.totalErrors, 0);
  assert.equal(score.accepted, 1);
});

test("invalid-response, failed, and missing records are rejected for every tuple", () => {
  const corpus = corpusOf([
    ["CAL-001", baseLabels()],
    ["CAL-002", baseLabels()],
    ["CAL-003", baseLabels()],
  ]);
  const records = [
    invalidResponse("CAL-001"),
    failed("CAL-002"),
  ];
  const score = scorePass1ThresholdCases(
    corpus,
    records,
    { floor: 0.5, lo: 0.4, hi: 0.52 },
  );

  assert.equal(score.accepted, 0);
  assert.equal(score.rejected, 3);
  assert.equal(score.invalidResponses, 1);
  assert.equal(score.uncollected, 2);
  assert.equal(score.totalErrors, 0);

  const selection = selectPass1Threshold(corpus, [
    invalidResponse("CAL-001"),
    failed("CAL-002"),
    collected("CAL-003", correctAnswers()),
  ]);
  assert.equal(
    rowOf(selection, { floor: 0.5, lo: 0.4, hi: 0.52 }).accepted,
    1,
  );
  assert.equal(
    rowOf(selection, { floor: 0.5, lo: 0.4, hi: 0.52 }).coverage,
    1 / 3,
  );
});

test("zero-error path selects the widest coverage then the strictest tuple", () => {
  const corpus = corpusOf([
    ["CAL-001", baseLabels()],
    ["CAL-002", baseLabels()],
  ]);
  const records = [
    collected("CAL-001", correctAnswers(), 1),
    collected("CAL-002", correctAnswers(), 2),
  ];
  const selection = selectPass1Threshold(corpus, records);

  assert.equal(selection.eligible, true);
  assert.equal(selection.tieBroken, false);
  // Every floor at or below 0.9 accepts both cases error-free; the chain
  // prefers the strictest floor, then the widest band.
  assert.deepEqual(selection.tuple, { floor: 0.9, lo: 0.4, hi: 0.6 });
});

test("zero-error coverage beats stricter floors with less coverage", () => {
  const labels = baseLabels();
  const corpus = corpusOf([
    ["CAL-001", labels],
    ["CAL-002", labels],
  ]);
  const records = [
    collected("CAL-001", correctAnswers({}, 1), 1),
    collected("CAL-002", correctAnswers({ task_type: choice("plan") }, 1), 2),
  ];
  const selection = selectPass1Threshold(corpus, records);

  // floor 0.95 rejects the erring case and stays zero-error at coverage 1/2;
  // lower floors accept it and collect one taskType error.
  assert.equal(selection.eligible, true);
  assert.deepEqual(selection.tuple, { floor: 0.95, lo: 0.4, hi: 0.6 });
  assert.equal(
    rowOf(selection, { floor: 0.95, lo: 0.4, hi: 0.6 }).coverage,
    0.5,
  );
});

test("fallback path minimizes total errors before coverage and strictness", () => {
  const corpus = corpusOf([
    ["CAL-001", baseLabels()],
    ["CAL-002", baseLabels()],
    ["CAL-003", baseLabels()],
  ]);
  const records = [
    // Accepted everywhere: wrong task type on every tuple.
    collected("CAL-001", correctAnswers({ task_type: choice("plan", 1) }, 1), 1),
    // Accepted everywhere: wrong risk sign on every tuple.
    collected(
      "CAL-002",
      correctAnswers(
        {
          task_type: choice("diagnose", 1),
          risk_security: noul(0.9),
        },
        1,
      ),
      2,
    ),
    // Accepted only at floors up to 0.6: three wrong signals.
    collected(
      "CAL-003",
      correctAnswers(
        {
          task_type: choice("plan", 0.6),
          skill_candidates: choice("none", 0.6),
          reuse_candidate: choice("reuse-9", 0.6),
        },
        1,
      ),
      3,
    ),
  ];
  const selection = selectPass1Threshold(corpus, records);

  assert.equal(selection.eligible, false);
  const selected = rowOf(selection, selection.tuple);
  // Floors above 0.6 reject the third case and hold two errors at
  // coverage 2/3; every looser tuple carries five.
  assert.equal(selected.totalErrors, 2);
  assert.equal(selected.coverage, 2 / 3);
  assert.deepEqual(selection.tuple, { floor: 0.95, lo: 0.4, hi: 0.6 });
});

test("fallback prefers coverage over strictness among equal error counts", () => {
  const corpus = corpusOf([
    ["CAL-001", baseLabels()],
    ["CAL-002", baseLabels()],
  ]);
  const records = [
    // Wrong task type, accepted everywhere: one error on all 90 tuples.
    collected("CAL-001", correctAnswers({ task_type: choice("plan", 1) }, 1), 1),
    // Correct, accepted only at floors up to 0.6.
    collected("CAL-002", correctAnswers({}, 0.6), 2),
  ];
  const selection = selectPass1Threshold(corpus, records);

  assert.equal(selection.eligible, false);
  // Every tuple carries exactly one error; coverage separates them.
  assert.deepEqual(selection.tuple, { floor: 0.6, lo: 0.4, hi: 0.6 });
  assert.equal(rowOf(selection, selection.tuple).coverage, 1);
});

test("tie-break prefers stricter floor, then wider band, then lexicographic", () => {
  const corpus = corpusOf([["CAL-001", baseLabels()]]);
  // One always-accepted always-wrong case makes every tuple identical on
  // errors and coverage, so the full preference chain decides.
  const records = [
    collected("CAL-001", correctAnswers({ task_type: choice("plan", 1) }, 1), 1),
  ];
  const selection = selectPass1Threshold(corpus, records);

  assert.equal(selection.eligible, false);
  for (const row of selection.table) {
    assert.equal(row.totalErrors, 1);
    assert.equal(row.coverage, 1);
  }
  // Stricter floor wins first, then wider band by lower lo then higher hi.
  assert.deepEqual(selection.tuple, { floor: 0.95, lo: 0.4, hi: 0.6 });
  assert.equal(selection.tieBroken, false);
});

test("a surviving tie reports all tied tuples and sets tie-broken", () => {
  const corpus = corpusOf([["CAL-001", baseLabels()]]);
  const records = [
    collected("CAL-001", correctAnswers({ task_type: choice("plan", 1) }, 1), 1),
  ];
  // A grid with a duplicated tuple leaves two rows tied through the whole
  // preference chain; the first lexicographic tuple is selected.
  const duplicated = { floor: 0.5, lo: 0.4, hi: 0.52 };
  const selection = selectPass1Threshold(corpus, records, [
    duplicated,
    duplicated,
    { floor: 0.5, lo: 0.44, hi: 0.52 },
  ]);

  assert.equal(selection.tieBroken, true);
  assert.deepEqual(selection.tiedTuples, [duplicated, duplicated]);
  assert.deepEqual(selection.tuple, duplicated);
});

test("selection artifact round-trips and validates its shape", () => {
  const corpus = corpusOf([["CAL-001", baseLabels()]]);
  const selection = selectPass1Threshold(corpus, [
    collected("CAL-001", correctAnswers(), 1),
  ]);
  const artifact = buildPass1SelectionArtifact(selection, {
    corpusFileSha256: "a".repeat(64),
    evaluationCorpusFileSha256: "b".repeat(64),
    questionBuilderSha256: "c".repeat(64),
    corpusFingerprint: "d".repeat(64),
    evidenceSha256: "e".repeat(64),
  });

  assert.equal(artifact.kind, "pass1-threshold-selection");
  assert.equal(artifact.schemaVersion, 1);
  assert.deepEqual(artifact.selected, selection.tuple);
  assert.equal(artifact.grid.size, 90);
  assert.equal(artifact.table.length, 90);
  assert.equal(artifact.inputs.corpusFileSha256, "a".repeat(64));

  const parsed = parsePass1SelectionArtifact(JSON.stringify(artifact));
  assert.deepEqual(parsed.selected, selection.tuple);
  assert.equal(parsed.table.length, 90);

  assert.throws(
    () => parsePass1SelectionArtifact("not json"),
    calibrationReason("invalid-selection-artifact"),
  );
  assert.throws(
    () =>
      parsePass1SelectionArtifact(
        JSON.stringify({ ...artifact, kind: "other" }),
      ),
    calibrationReason("invalid-selection-artifact"),
  );
  assert.throws(
    () =>
      parsePass1SelectionArtifact(
        JSON.stringify({
          ...artifact,
          selected: { floor: 0.51, lo: 0.4, hi: 0.6 },
        }),
      ),
    calibrationReason("invalid-selection-artifact"),
  );
  assert.throws(
    () =>
      parsePass1SelectionArtifact(
        JSON.stringify({
          ...artifact,
          inputs: { ...artifact.inputs, corpusFileSha256: "zz" },
        }),
      ),
    calibrationReason("invalid-selection-artifact"),
  );
});
