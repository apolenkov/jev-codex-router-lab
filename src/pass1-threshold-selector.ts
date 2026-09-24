import {
  CalibrationError,
  type ClosedAnswerEvidence,
} from "./calibration-runner.js";
import type { RiskDimension } from "./contracts.js";
import { NONE } from "./questions.js";
import type {
  Pass1AnnotatedCorpus,
  Pass1CaseLabels,
  Pass1GoldLeaf,
  Pass1ThresholdCaseCollected,
  Pass1ThresholdCaseRecord,
} from "./pass1-threshold-runner.js";

export interface Pass1ThresholdTuple {
  readonly floor: number;
  readonly lo: number;
  readonly hi: number;
}

export const PASS1_THRESHOLD_FLOORS = [
  0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95,
] as const;
export const PASS1_THRESHOLD_LOS = [0.4, 0.44, 0.48] as const;
export const PASS1_THRESHOLD_HIS = [0.52, 0.56, 0.6] as const;

export const PASS1_THRESHOLD_GRID: readonly Pass1ThresholdTuple[] =
  PASS1_THRESHOLD_FLOORS.flatMap((floor) =>
    PASS1_THRESHOLD_LOS.flatMap((lo) =>
      PASS1_THRESHOLD_HIS.map((hi) => ({ floor, lo, hi }))
    )
  );

export const PASS1_SIGNAL_UNITS = [
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
] as const;

export type Pass1SignalUnit = (typeof PASS1_SIGNAL_UNITS)[number];

export type Pass1RiskUnit = `riskDimensions.${RiskDimension}`;
export type Pass1ChoiceUnit = Exclude<Pass1SignalUnit, Pass1RiskUnit>;

const RISK_UNIT_PREFIX = "riskDimensions.";

const isRiskUnit = (unit: Pass1SignalUnit): unit is Pass1RiskUnit =>
  unit.startsWith(RISK_UNIT_PREFIX);

const RISK_ANSWER_KEYS: Readonly<Record<RiskDimension, string>> = {
  security: "risk_security",
  "data-loss": "risk_data_loss",
  "public-contract": "risk_public_contract",
  migration: "risk_migration",
  "user-behavior": "risk_user_behavior",
};

const CHOICE_ANSWER_KEYS: Readonly<Record<Pass1ChoiceUnit, string>> = {
  taskType: "task_type",
  skillCandidates: "skill_candidates",
  criticalGap: "critical_gap",
  reuseCandidate: "reuse_candidate",
  architectureFork: "architecture_fork",
  contextRelevance: "context_relevance",
};

export interface Pass1SignalScore {
  readonly evaluable: number;
  readonly errors: number;
  readonly errorRate: number | null;
  readonly excluded: number;
}

export interface Pass1TupleRow {
  readonly floor: number;
  readonly lo: number;
  readonly hi: number;
  readonly accepted: number;
  readonly coverage: number;
  readonly perSignal: Readonly<Record<Pass1SignalUnit, Pass1SignalScore>>;
  readonly totalErrors: number;
}

export interface Pass1ThresholdCaseScore {
  readonly tuple: Pass1ThresholdTuple;
  readonly totalCases: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly invalidResponses: number;
  readonly uncollected: number;
  readonly perSignal: Readonly<Record<Pass1SignalUnit, Pass1SignalScore>>;
  readonly totalErrors: number;
}

const isAccepted = (
  record: Pass1ThresholdCaseRecord,
  tuple: Pass1ThresholdTuple,
): record is Pass1ThresholdCaseCollected =>
  record.outcome === "collected" &&
  Object.values(record.answers).every((answer) =>
    answer.type === "choice"
      ? answer.confidence >= tuple.floor
      : answer.noul < tuple.lo || answer.noul > tuple.hi
  );

type SignalOutcome = "correct" | "error" | "excluded";

const scalarOutcome = (
  leaf: Pass1GoldLeaf<string>,
  answer: ClosedAnswerEvidence | undefined,
): SignalOutcome => {
  if (leaf.status !== "resolved") {
    return "excluded";
  }
  if (answer?.type !== "choice") {
    return "error";
  }
  return leaf.value === null
    ? answer.choice === NONE ? "correct" : "error"
    : answer.choice === leaf.value ? "correct" : "error";
};

const setOutcome = (
  leaf: Pass1GoldLeaf<readonly string[]>,
  answer: ClosedAnswerEvidence | undefined,
): SignalOutcome => {
  if (leaf.status !== "resolved") {
    return "excluded";
  }
  if (answer?.type !== "choice") {
    return "error";
  }
  const gold = leaf.value ?? [];
  return gold.length === 0
    ? answer.choice === NONE ? "correct" : "error"
    : gold.includes(answer.choice) ? "correct" : "error";
};

const taskTypeOutcome = (
  leaf: Pass1CaseLabels["taskType"],
  answer: ClosedAnswerEvidence | undefined,
): SignalOutcome => {
  if (leaf.status !== "resolved") {
    return "excluded";
  }
  return answer?.type === "choice" && answer.choice === leaf.value
    ? "correct"
    : "error";
};

const riskOutcome = (
  leaf: Pass1GoldLeaf<"positive" | "negative">,
  answer: ClosedAnswerEvidence | undefined,
): SignalOutcome => {
  if (leaf.status !== "resolved") {
    return "excluded";
  }
  if (answer?.type !== "noul" || answer.noul === 0.5) {
    return "error";
  }
  return (answer.noul > 0.5) === (leaf.value === "positive")
    ? "correct"
    : "error";
};

const compareSignal = (
  unit: Pass1SignalUnit,
  answers: Readonly<Record<string, ClosedAnswerEvidence>>,
  labels: Pass1CaseLabels,
): SignalOutcome => {
  if (isRiskUnit(unit)) {
    const dimension = unit.slice(RISK_UNIT_PREFIX.length) as RiskDimension;
    return riskOutcome(
      labels.riskDimensions[dimension],
      answers[RISK_ANSWER_KEYS[dimension]],
    );
  }
  switch (unit) {
    case "taskType":
      return taskTypeOutcome(
        labels.taskType,
        answers[CHOICE_ANSWER_KEYS.taskType],
      );
    case "skillCandidates":
      return setOutcome(
        labels.skillCandidates,
        answers[CHOICE_ANSWER_KEYS.skillCandidates],
      );
    case "contextRelevance":
      return setOutcome(
        labels.contextRelevance,
        answers[CHOICE_ANSWER_KEYS.contextRelevance],
      );
    case "criticalGap":
      return scalarOutcome(
        labels.criticalGap,
        answers[CHOICE_ANSWER_KEYS.criticalGap],
      );
    case "reuseCandidate":
      return scalarOutcome(
        labels.reuseCandidate,
        answers[CHOICE_ANSWER_KEYS.reuseCandidate],
      );
    case "architectureFork":
      return scalarOutcome(
        labels.architectureFork,
        answers[CHOICE_ANSWER_KEYS.architectureFork],
      );
  }
};

const emptySignalScore = (): {
  evaluable: number;
  errors: number;
  excluded: number;
} => ({ evaluable: 0, errors: 0, excluded: 0 });

const finalizeSignalScore = (
  score: { evaluable: number; errors: number; excluded: number },
): Pass1SignalScore => ({
  evaluable: score.evaluable,
  errors: score.errors,
  errorRate: score.evaluable === 0 ? null : score.errors / score.evaluable,
  excluded: score.excluded,
});

export const scorePass1ThresholdCases = (
  corpus: Pass1AnnotatedCorpus,
  records: readonly Pass1ThresholdCaseRecord[],
  tuple: Pass1ThresholdTuple,
): Pass1ThresholdCaseScore => {
  const recordById = new Map(records.map((record) => [record.caseId, record]));
  const accumulators = new Map<Pass1SignalUnit, ReturnType<typeof emptySignalScore>>(
    PASS1_SIGNAL_UNITS.map((unit) => [unit, emptySignalScore()]),
  );
  let accepted = 0;
  let invalidResponses = 0;
  let uncollected = 0;
  let totalErrors = 0;

  for (const corpusCase of corpus.cases) {
    const record = recordById.get(corpusCase.caseId);
    if (record === undefined || !isAccepted(record, tuple)) {
      if (record?.outcome === "invalid-response") {
        invalidResponses += 1;
      }
      if (record === undefined || record.outcome === "failed") {
        uncollected += 1;
      }
      continue;
    }
    accepted += 1;
    const answers = record.answers;
    for (const unit of PASS1_SIGNAL_UNITS) {
      const outcome = compareSignal(unit, answers, corpusCase.labels);
      const accumulator = accumulators.get(unit)!;
      if (outcome === "excluded") {
        accumulator.excluded += 1;
      } else {
        accumulator.evaluable += 1;
        if (outcome === "error") {
          accumulator.errors += 1;
          totalErrors += 1;
        }
      }
    }
  }

  return {
    tuple,
    totalCases: corpus.cases.length,
    accepted,
    rejected: corpus.cases.length - accepted,
    invalidResponses,
    uncollected,
    perSignal: Object.fromEntries(
      PASS1_SIGNAL_UNITS.map((unit) => [
        unit,
        finalizeSignalScore(accumulators.get(unit)!),
      ]),
    ) as Readonly<Record<Pass1SignalUnit, Pass1SignalScore>>,
    totalErrors,
  };
};

export interface Pass1ThresholdSelection {
  readonly tuple: Pass1ThresholdTuple;
  readonly eligible: boolean;
  readonly tieBroken: boolean;
  readonly tiedTuples: readonly Pass1ThresholdTuple[];
  readonly table: readonly Pass1TupleRow[];
}

const lexicographic = (
  left: Pass1ThresholdTuple,
  right: Pass1ThresholdTuple,
): number =>
  left.floor - right.floor || left.lo - right.lo || left.hi - right.hi;

export const selectPass1Threshold = (
  corpus: Pass1AnnotatedCorpus,
  records: readonly Pass1ThresholdCaseRecord[],
  grid: readonly Pass1ThresholdTuple[] = PASS1_THRESHOLD_GRID,
): Pass1ThresholdSelection => {
  const table: Pass1TupleRow[] = grid.map((tuple) => {
    const score = scorePass1ThresholdCases(corpus, records, tuple);
    return {
      floor: tuple.floor,
      lo: tuple.lo,
      hi: tuple.hi,
      accepted: score.accepted,
      coverage: score.totalCases === 0
        ? 0
        : score.accepted / score.totalCases,
      perSignal: score.perSignal,
      totalErrors: score.totalErrors,
    };
  });

  const eligible = table.filter(
    (row) => row.totalErrors === 0 && row.coverage > 0,
  );
  const pool = eligible.length > 0 ? eligible : table;
  const keyOf = eligible.length > 0
    ? (row: Pass1TupleRow) => [-row.coverage, -row.floor, row.lo, -row.hi]
    : (row: Pass1TupleRow) => [
      row.totalErrors,
      -row.coverage,
      -row.floor,
      row.lo,
      -row.hi,
    ];
  const compareKeys = (left: number[], right: number[]): number => {
    for (let index = 0; index < left.length; index += 1) {
      const delta = left[index]! - right[index]!;
      if (delta !== 0) {
        return delta;
      }
    }
    return 0;
  };

  let best = pool[0];
  for (const row of pool) {
    if (compareKeys(keyOf(row), keyOf(best!)) < 0) {
      best = row;
    }
  }
  if (best === undefined) {
    throw new CalibrationError("empty-threshold-grid");
  }
  const tied = pool.filter(
    (row) => compareKeys(keyOf(row), keyOf(best)) === 0,
  );
  const selected = [...tied].sort(lexicographic)[0]!;
  return {
    tuple: { floor: selected.floor, lo: selected.lo, hi: selected.hi },
    eligible: eligible.length > 0,
    tieBroken: tied.length > 1,
    tiedTuples: tied.map(({ floor, lo, hi }) => ({ floor, lo, hi })),
    table,
  };
};

export const PASS1_SELECTION_ARTIFACT_KIND = "pass1-threshold-selection";

export interface Pass1SelectionInputs {
  readonly corpusFileSha256: string;
  readonly evaluationCorpusFileSha256: string;
  readonly questionBuilderSha256: string;
  readonly corpusFingerprint: string;
  readonly evidenceSha256: string;
}

export interface Pass1ThresholdSelectionArtifact {
  readonly schemaVersion: 1;
  readonly kind: typeof PASS1_SELECTION_ARTIFACT_KIND;
  readonly inputs: Pass1SelectionInputs;
  readonly grid: {
    readonly floors: readonly number[];
    readonly los: readonly number[];
    readonly his: readonly number[];
    readonly size: number;
  };
  readonly selected: Pass1ThresholdTuple;
  readonly eligible: boolean;
  readonly tieBroken: boolean;
  readonly tiedTuples: readonly Pass1ThresholdTuple[];
  readonly table: readonly Pass1TupleRow[];
}

export const buildPass1SelectionArtifact = (
  selection: Pass1ThresholdSelection,
  inputs: Pass1SelectionInputs,
): Pass1ThresholdSelectionArtifact => ({
  schemaVersion: 1,
  kind: PASS1_SELECTION_ARTIFACT_KIND,
  inputs,
  grid: {
    floors: [...PASS1_THRESHOLD_FLOORS],
    los: [...PASS1_THRESHOLD_LOS],
    his: [...PASS1_THRESHOLD_HIS],
    size: PASS1_THRESHOLD_GRID.length,
  },
  selected: { ...selection.tuple },
  eligible: selection.eligible,
  tieBroken: selection.tieBroken,
  tiedTuples: selection.tiedTuples.map((tuple) => ({ ...tuple })),
  table: selection.table,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const onThresholdGrid = (
  floor: number,
  lo: number,
  hi: number,
): boolean =>
  PASS1_THRESHOLD_GRID.some(
    (tuple) => tuple.floor === floor && tuple.lo === lo && tuple.hi === hi,
  );

const isGridTuple = (value: unknown): value is Pass1ThresholdTuple =>
  isRecord(value) &&
  exactKeys(value, ["floor", "lo", "hi"]) &&
  typeof value.floor === "number" &&
  typeof value.lo === "number" &&
  typeof value.hi === "number" &&
  onThresholdGrid(value.floor, value.lo, value.hi);

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
};

const parseTupleRow = (value: unknown): Pass1TupleRow => {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "floor",
      "lo",
      "hi",
      "accepted",
      "coverage",
      "perSignal",
      "totalErrors",
    ]) ||
    typeof value.floor !== "number" ||
    typeof value.lo !== "number" ||
    typeof value.hi !== "number" ||
    !onThresholdGrid(value.floor, value.lo, value.hi) ||
    !Number.isInteger(value.accepted) ||
    (value.accepted as number) < 0 ||
    typeof value.coverage !== "number" ||
    !Number.isFinite(value.coverage) ||
    value.coverage < 0 ||
    value.coverage > 1 ||
    !Number.isInteger(value.totalErrors) ||
    (value.totalErrors as number) < 0 ||
    !isRecord(value.perSignal) ||
    !exactKeys(value.perSignal, PASS1_SIGNAL_UNITS)
  ) {
    throw new CalibrationError("invalid-selection-artifact");
  }
  for (const unit of PASS1_SIGNAL_UNITS) {
    const score = value.perSignal[unit];
    if (
      !isRecord(score) ||
      !exactKeys(score, ["evaluable", "errors", "errorRate", "excluded"]) ||
      !Number.isInteger(score.evaluable) ||
      (score.evaluable as number) < 0 ||
      !Number.isInteger(score.errors) ||
      (score.errors as number) < 0 ||
      !Number.isInteger(score.excluded) ||
      (score.excluded as number) < 0 ||
      !(score.errorRate === null ||
        (typeof score.errorRate === "number" &&
          Number.isFinite(score.errorRate) &&
          score.errorRate >= 0 &&
          score.errorRate <= 1))
    ) {
      throw new CalibrationError("invalid-selection-artifact");
    }
  }
  return {
    floor: value.floor,
    lo: value.lo,
    hi: value.hi,
    accepted: value.accepted as number,
    coverage: value.coverage,
    perSignal: value.perSignal as unknown as Readonly<
      Record<Pass1SignalUnit, Pass1SignalScore>
    >,
    totalErrors: value.totalErrors as number,
  };
};

export const parsePass1SelectionArtifact = (
  serialized: string,
): Pass1ThresholdSelectionArtifact => {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new CalibrationError("invalid-selection-artifact");
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "kind",
      "inputs",
      "grid",
      "selected",
      "eligible",
      "tieBroken",
      "tiedTuples",
      "table",
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== PASS1_SELECTION_ARTIFACT_KIND ||
    !isRecord(value.inputs) ||
    !exactKeys(value.inputs, [
      "corpusFileSha256",
      "evaluationCorpusFileSha256",
      "questionBuilderSha256",
      "corpusFingerprint",
      "evidenceSha256",
    ]) ||
    !Object.values(value.inputs).every(
      (entry) => typeof entry === "string" && SHA256_PATTERN.test(entry),
    ) ||
    !isRecord(value.grid) ||
    !exactKeys(value.grid, ["floors", "los", "his", "size"]) ||
    !Array.isArray(value.grid.floors) ||
    !Array.isArray(value.grid.los) ||
    !Array.isArray(value.grid.his) ||
    value.grid.size !== PASS1_THRESHOLD_GRID.length ||
    !isGridTuple(value.selected) ||
    typeof value.eligible !== "boolean" ||
    typeof value.tieBroken !== "boolean" ||
    !Array.isArray(value.tiedTuples) ||
    !value.tiedTuples.every(isGridTuple) ||
    !Array.isArray(value.table) ||
    value.table.length !== PASS1_THRESHOLD_GRID.length
  ) {
    throw new CalibrationError("invalid-selection-artifact");
  }
  const table = value.table.map(parseTupleRow);
  const inputs = value.inputs as Record<string, string>;
  return {
    schemaVersion: 1,
    kind: PASS1_SELECTION_ARTIFACT_KIND,
    inputs: {
      corpusFileSha256: inputs.corpusFileSha256!,
      evaluationCorpusFileSha256: inputs.evaluationCorpusFileSha256!,
      questionBuilderSha256: inputs.questionBuilderSha256!,
      corpusFingerprint: inputs.corpusFingerprint!,
      evidenceSha256: inputs.evidenceSha256!,
    },
    grid: {
      floors: value.grid.floors as number[],
      los: value.grid.los as number[],
      his: value.grid.his as number[],
      size: PASS1_THRESHOLD_GRID.length,
    },
    selected: {
      floor: value.selected.floor,
      lo: value.selected.lo,
      hi: value.selected.hi,
    },
    eligible: value.eligible,
    tieBroken: value.tieBroken,
    tiedTuples: value.tiedTuples.map((tuple) => ({
      floor: (tuple as Pass1ThresholdTuple).floor,
      lo: (tuple as Pass1ThresholdTuple).lo,
      hi: (tuple as Pass1ThresholdTuple).hi,
    })),
    table,
  };
};
