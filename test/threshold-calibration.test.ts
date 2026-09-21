import assert from "node:assert/strict";
import test from "node:test";
import type { RouterInput } from "../src/contracts.js";
import { precheck } from "../src/policy.js";
import {
  SemanticGatewayError,
  type SystemOneClientPort,
} from "../src/semantic-gateway.js";
import {
  DEFAULT_PASS2_THRESHOLDS,
  evaluatePass2,
  evaluateThresholdGrid,
  PASS2_THRESHOLD_GRID,
  selectThreshold,
  type CalibrationCase,
  type ParsedPass2,
} from "../src/threshold-calibration.js";
import { parsePass2Record, TypeSafeGateway } from "../src/typesafe-gateway.js";

const routerInput: RouterInput = {
  taskId: "calibration-task-1",
  taskRevision: 1,
  taskText: "Synthetic calibration task.",
  policyVersion: "policy-2026-09-21.2",
  catalogHash: "sha256:synthetic-catalog-v2",
  explicitSkillIds: [],
  requiredSkillIds: [],
  skills: [
    { id: "a", description: "Synthetic skill A.", excerpt: "Synthetic excerpt A." },
    { id: "b", description: "Synthetic skill B.", excerpt: "Synthetic excerpt B." },
    { id: "c", description: "Synthetic skill C.", excerpt: "Synthetic excerpt C." },
  ],
};

const input = precheck(routerInput);
const SHORTLIST = ["a", "b", "c"];

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

const pass2Answers = (
  fits: readonly number[],
  confidence = 0.9,
  choice = "a",
  probabilities: Readonly<Record<string, number>> = { a: 0.5, b: 0.3, c: 0.15, none: 0.05 },
): Record<string, unknown> => ({
  echo_task_id: echoAnswer(routerInput.taskId),
  echo_task_revision: echoAnswer(String(routerInput.taskRevision)),
  echo_policy_version: echoAnswer(routerInput.policyVersion),
  echo_catalog_hash: echoAnswer(routerInput.catalogHash),
  skill_ranking: choiceAnswer(choice, probabilities, confidence),
  skill_fit_0: { type: "noul", noul: fits[0] },
  skill_fit_1: { type: "noul", noul: fits[1] },
  skill_fit_2: { type: "noul", noul: fits[2] },
});

const ranking = (
  choice: string,
  confidence: number,
  probabilities: Readonly<Record<string, number>> = { a: 0.5, b: 0.3, c: 0.15, none: 0.05 },
): ParsedPass2["ranking"] => ({ choice, confidence, probabilities });

const record = (overrides: Partial<ParsedPass2> = {}): ParsedPass2 => ({
  shortlist: [...SHORTLIST],
  ranking: ranking("a", 0.9),
  ranked: [...SHORTLIST],
  fits: [0.9, 0.8, 0.7],
  ...overrides,
});

const calibrationCase = (
  caseId: string,
  rec: ParsedPass2,
  expectedSkillIds: readonly string[],
): CalibrationCase => ({ caseId, record: rec, expectedSkillIds });

test("the declared grid is the deterministic cross product of five ranking minimums and three Noul bands", () => {
  assert.deepEqual([...PASS2_THRESHOLD_GRID], [
    { rankingMin: 0.4, lower: 0.35, upper: 0.65 },
    { rankingMin: 0.4, lower: 0.4, upper: 0.6 },
    { rankingMin: 0.4, lower: 0.45, upper: 0.55 },
    { rankingMin: 0.45, lower: 0.35, upper: 0.65 },
    { rankingMin: 0.45, lower: 0.4, upper: 0.6 },
    { rankingMin: 0.45, lower: 0.45, upper: 0.55 },
    { rankingMin: 0.5, lower: 0.35, upper: 0.65 },
    { rankingMin: 0.5, lower: 0.4, upper: 0.6 },
    { rankingMin: 0.5, lower: 0.45, upper: 0.55 },
    { rankingMin: 0.55, lower: 0.35, upper: 0.65 },
    { rankingMin: 0.55, lower: 0.4, upper: 0.6 },
    { rankingMin: 0.55, lower: 0.45, upper: 0.55 },
    { rankingMin: 0.6, lower: 0.35, upper: 0.65 },
    { rankingMin: 0.6, lower: 0.4, upper: 0.6 },
    { rankingMin: 0.6, lower: 0.45, upper: 0.55 },
  ]);
  assert.deepEqual(DEFAULT_PASS2_THRESHOLDS, { rankingMin: 0.5, lower: 0.4, upper: 0.6 });
});

test("evaluatePass2 reproduces the default ranking minimum and inclusive Noul band", () => {
  const below = evaluatePass2(
    record({ ranking: ranking("a", 0.49) }),
    DEFAULT_PASS2_THRESHOLDS,
  );
  assert.equal(below.status, "low-confidence");

  const at = evaluatePass2(
    record({ ranking: ranking("a", 0.5) }),
    DEFAULT_PASS2_THRESHOLDS,
  );
  assert.equal(at.status, "ok");

  for (const boundary of [0.4, 0.6]) {
    assert.equal(
      evaluatePass2(record({ fits: [boundary, 0.8, 0.9] }), DEFAULT_PASS2_THRESHOLDS).status,
      "low-confidence",
    );
  }
});

test("evaluatePass2 silently drops fits below the band and accepts fits above it", () => {
  const evaluation = evaluatePass2(
    record({ fits: [0.39, 0.61, 0.7] }),
    DEFAULT_PASS2_THRESHOLDS,
  );
  assert.deepEqual(evaluation, { status: "ok", skillCandidates: ["b", "c"] });
});

test("evaluatePass2 returns an empty candidate list for a none ranking after band checks", () => {
  const noneRanking = ranking("none", 0.9, { a: 0.3, b: 0.3, c: 0.3, none: 0.1 });
  assert.deepEqual(
    evaluatePass2(record({ ranking: noneRanking, fits: [0.9, 0.9, 0.9] }), DEFAULT_PASS2_THRESHOLDS),
    { status: "ok", skillCandidates: [] },
  );
  assert.equal(
    evaluatePass2(record({ ranking: noneRanking, fits: [0.5, 0.9, 0.9] }), DEFAULT_PASS2_THRESHOLDS)
      .status,
    "low-confidence",
  );
});

test("evaluatePass2 preserves the provider ranking order over accepted fits", () => {
  const rec = record({
    ranking: ranking("c", 0.9, { a: 0.1, b: 0.3, c: 0.55, none: 0.05 }),
    ranked: ["c", "b", "a"],
    fits: [0.2, 0.9, 0.8],
  });
  assert.deepEqual(evaluatePass2(rec, DEFAULT_PASS2_THRESHOLDS), {
    status: "ok",
    skillCandidates: ["c", "b"],
  });
});

test("the closed parser retains validated fits when ranking confidence is below the default minimum", () => {
  const answers = pass2Answers([0.9, 0.8, 0.7], 0.1);
  const rec = parsePass2Record(answers, input, SHORTLIST);

  assert.equal(rec.ranking.confidence, 0.1);
  assert.deepEqual([...rec.fits], [0.9, 0.8, 0.7]);
  assert.deepEqual([...rec.shortlist], SHORTLIST);
  assert.deepEqual([...rec.ranked], ["a", "b", "c"]);
  assert.equal(evaluatePass2(rec, DEFAULT_PASS2_THRESHOLDS).status, "low-confidence");
  assert.equal(
    evaluatePass2(rec, { rankingMin: 0.05, lower: 0.4, upper: 0.6 }).status,
    "ok",
  );
});

test("the closed parser validates every fit before any threshold decision", () => {
  const answers = pass2Answers([0.9, 0.8, 0.7], 0.1);
  answers.skill_fit_2 = { type: "noul", noul: 1.5 };

  assert.throws(
    () => parsePass2Record(answers, input, SHORTLIST),
    (error: unknown) =>
      error instanceof SemanticGatewayError && error.reason === "malformed-response",
  );
});

test("the closed parser rejects unexpected or missing answer keys without the envelope", () => {
  const extra = { ...pass2Answers([0.9, 0.8, 0.7]), skill_fit_3: { type: "noul", noul: 0.9 } };
  const missing = pass2Answers([0.9, 0.8, 0.7]);
  delete missing.skill_fit_1;
  const singleSkill = pass2Answers([0.9, 0.8, 0.7]);

  for (const [answers, shortlist] of [
    [extra, SHORTLIST],
    [missing, SHORTLIST],
    [singleSkill, ["a"]],
  ] as const) {
    assert.throws(
      () => parsePass2Record(answers, input, shortlist),
      (error: unknown) =>
        error instanceof SemanticGatewayError && error.reason === "malformed-response",
    );
  }
});

test("the adapter decision equals the pure evaluator at the default tuple", async () => {
  const answers = pass2Answers(
    [0.2, 0.9, 0.8],
    0.9,
    "c",
    { a: 0.1, b: 0.3, c: 0.55, none: 0.05 },
  );
  const client: SystemOneClientPort = {
    systemOne: async () => ({
      model: "jev-test-1",
      usage: { input_tokens: 47, output_tokens: 8 },
      answers,
    }),
  };

  const result = await new TypeSafeGateway(client).pass2(input, SHORTLIST);
  const evaluation = evaluatePass2(
    parsePass2Record(answers, input, SHORTLIST),
    DEFAULT_PASS2_THRESHOLDS,
  );

  assert.equal(evaluation.status, "ok");
  assert.deepEqual(result.skillCandidates, ["c", "b"]);
  assert.deepEqual(result.skillCandidates, evaluation.skillCandidates);
});

test("evaluateThresholdGrid scores every declared tuple on every calibration case", () => {
  const cases = [
    calibrationCase("C1", record(), ["a", "b", "c"]),
    calibrationCase("C2", record({ fits: [0.8, 0.1, 0.1] }), ["a"]),
  ];
  const evaluations = evaluateThresholdGrid(cases);

  assert.equal(evaluations.length, PASS2_THRESHOLD_GRID.length);
  assert.deepEqual(
    evaluations.map((evaluation) => evaluation.thresholds),
    [...PASS2_THRESHOLD_GRID],
  );
  for (const evaluation of evaluations) {
    assert.deepEqual(
      evaluation.cases.map((result) => result.caseId),
      ["C1", "C2"],
    );
  }
});

test("selection resolves all-qualifying ties by highest ranking minimum then highest upper boundary", () => {
  const selected = selectThreshold([calibrationCase("C1", record(), ["a", "b", "c"])]);

  assert.ok(selected);
  assert.deepEqual(selected.thresholds, { rankingMin: 0.6, lower: 0.35, upper: 0.65 });
  assert.equal(selected.qualifies, true);
});

test("selection resolves partial-band ties by highest upper boundary", () => {
  const rec = record({ fits: [0.9, 0.62, 0.1] });
  const selected = selectThreshold([calibrationCase("C1", rec, ["a", "b"])]);

  assert.ok(selected);
  assert.deepEqual(selected.thresholds, { rankingMin: 0.6, lower: 0.4, upper: 0.6 });
});

test("selection keeps the highest ranking minimum that every calibration case still satisfies", () => {
  const rec = record({ ranking: ranking("a", 0.52), fits: [0.9, 0.62, 0.1] });
  const selected = selectThreshold([calibrationCase("C1", rec, ["a", "b"])]);

  assert.ok(selected);
  assert.deepEqual(selected.thresholds, { rankingMin: 0.5, lower: 0.4, upper: 0.6 });
});

test("a tuple with a false positive does not qualify", () => {
  const rec = record({ fits: [0.9, 0.56, 0.1] });
  const evaluations = evaluateThresholdGrid([calibrationCase("C1", rec, ["a"])]);

  const narrowest = evaluations.filter((evaluation) => evaluation.thresholds.upper === 0.55);
  assert.equal(narrowest.length, 5);
  for (const evaluation of narrowest) {
    const result = evaluation.cases[0]!;
    assert.equal(result.status, "ok");
    assert.deepEqual([...result.skillCandidates], ["a", "b"]);
    assert.deepEqual([...result.falsePositives], ["b"]);
    assert.equal(result.exactMatch, false);
    assert.equal(evaluation.qualifies, false);
  }

  for (const evaluation of evaluations.filter((entry) => entry.thresholds.upper !== 0.55)) {
    assert.equal(evaluation.cases[0]!.status, "low-confidence");
    assert.equal(evaluation.qualifies, false);
  }
  assert.equal(selectThreshold([calibrationCase("C1", rec, ["a"])]), null);
});

test("a tuple that misses a labeled skill does not qualify and no selection is made", () => {
  const rec = record({ fits: [0.9, 0.8, 0.1] });
  const cases = [calibrationCase("C1", rec, ["a", "b", "c"])];
  const evaluations = evaluateThresholdGrid(cases);

  assert.ok(evaluations.every((evaluation) => !evaluation.qualifies));
  assert.ok(
    evaluations.every((evaluation) =>
      evaluation.cases.every((result) => result.exactMatch === false)),
  );
  assert.equal(selectThreshold(cases), null);
});

test("selection preserves the provider shortlist and deterministic invariants", () => {
  const rec = record({ fits: [0.9, 0.62, 0.1] });
  const evaluations = evaluateThresholdGrid([calibrationCase("C1", rec, ["a", "b"])]);

  for (const evaluation of evaluations) {
    const result = evaluation.cases[0]!;
    assert.equal(result.invariantsHold, true);
    assert.ok(result.skillCandidates.every((id) => rec.shortlist.includes(id)));
    assert.equal(new Set(result.skillCandidates).size, result.skillCandidates.length);
    assert.deepEqual(
      [...result.skillCandidates],
      rec.ranked.filter((id) => result.skillCandidates.includes(id)),
    );
  }
});

test("selection fails closed when no calibration records are provided", () => {
  assert.equal(selectThreshold([]), null);
});

test("selection depends only on the calibration records provided", () => {
  const c1 = calibrationCase("C1", record({ fits: [0.9, 0.62, 0.1] }), ["a", "b"]);
  const confident = selectThreshold([c1]);
  assert.ok(confident);
  assert.deepEqual(confident.thresholds, { rankingMin: 0.6, lower: 0.4, upper: 0.6 });

  const c2 = calibrationCase(
    "C2",
    record({ ranking: ranking("a", 0.52), fits: [0.8, 0.1, 0.1] }),
    ["a"],
  );
  const combined = selectThreshold([c1, c2]);
  assert.ok(combined);
  assert.deepEqual(combined.thresholds, { rankingMin: 0.5, lower: 0.4, upper: 0.6 });
  assert.deepEqual(selectThreshold([c1, c2]), combined);
});
