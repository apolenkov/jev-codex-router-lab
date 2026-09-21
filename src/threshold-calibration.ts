import { NONE } from "./questions.js";

export interface Pass2Thresholds {
  readonly rankingMin: number;
  readonly lower: number;
  readonly upper: number;
}

export const DEFAULT_PASS2_THRESHOLDS: Pass2Thresholds = {
  rankingMin: 0.5,
  lower: 0.4,
  upper: 0.6,
};

export interface ParsedPass2 {
  readonly shortlist: readonly string[];
  readonly ranking: {
    readonly choice: string;
    readonly confidence: number;
    readonly probabilities: Readonly<Record<string, number>>;
  };
  readonly ranked: readonly string[];
  readonly fits: readonly number[];
}

export type Pass2Evaluation =
  | { readonly status: "ok"; readonly skillCandidates: readonly string[] }
  | { readonly status: "low-confidence" };

export function evaluatePass2(
  record: ParsedPass2,
  thresholds: Pass2Thresholds,
): Pass2Evaluation {
  if (record.ranking.confidence < thresholds.rankingMin) {
    return { status: "low-confidence" };
  }
  if (
    record.fits.some(
      (probability) => probability >= thresholds.lower && probability <= thresholds.upper,
    )
  ) {
    return { status: "low-confidence" };
  }
  if (record.ranking.choice === NONE) {
    return { status: "ok", skillCandidates: [] };
  }
  const accepted = new Set(
    record.shortlist.filter((_, index) => record.fits[index]! > thresholds.upper),
  );
  return {
    status: "ok",
    skillCandidates: record.ranked.filter((id) => accepted.has(id)),
  };
}

const RANKING_MINIMUMS: readonly number[] = [0.4, 0.45, 0.5, 0.55, 0.6];

const NOUL_BANDS: readonly { readonly lower: number; readonly upper: number }[] = [
  { lower: 0.35, upper: 0.65 },
  { lower: 0.4, upper: 0.6 },
  { lower: 0.45, upper: 0.55 },
];

export const PASS2_THRESHOLD_GRID: readonly Pass2Thresholds[] = RANKING_MINIMUMS.flatMap(
  (rankingMin) => NOUL_BANDS.map((band) => ({ rankingMin, ...band })),
);

export interface CalibrationCase {
  readonly caseId: string;
  readonly record: ParsedPass2;
  readonly expectedSkillIds: readonly string[];
}

export interface CalibrationCaseResult {
  readonly caseId: string;
  readonly status: "ok" | "low-confidence";
  readonly skillCandidates: readonly string[];
  readonly expectedSkillIds: readonly string[];
  readonly exactMatch: boolean;
  readonly falsePositives: readonly string[];
  readonly invariantsHold: boolean;
}

export interface TupleEvaluation {
  readonly thresholds: Pass2Thresholds;
  readonly qualifies: boolean;
  readonly cases: readonly CalibrationCaseResult[];
}

const scoreCase = (
  thresholds: Pass2Thresholds,
  calibrationCase: CalibrationCase,
): CalibrationCaseResult => {
  const evaluation = evaluatePass2(calibrationCase.record, thresholds);
  const candidates = evaluation.status === "ok" ? evaluation.skillCandidates : [];
  const expected = new Set(calibrationCase.expectedSkillIds);
  const actual = new Set(candidates);
  const falsePositives = candidates.filter((id) => !expected.has(id));
  const shortlist = new Set(calibrationCase.record.shortlist);
  const ranked = new Set(calibrationCase.record.ranked);
  const invariantsHold =
    calibrationCase.record.fits.length === calibrationCase.record.shortlist.length &&
    calibrationCase.record.ranked.length === calibrationCase.record.shortlist.length &&
    ranked.size === calibrationCase.record.ranked.length &&
    calibrationCase.record.ranked.every((id) => shortlist.has(id)) &&
    candidates.every((id) => shortlist.has(id)) &&
    actual.size === candidates.length;
  return {
    caseId: calibrationCase.caseId,
    status: evaluation.status,
    skillCandidates: candidates,
    expectedSkillIds: calibrationCase.expectedSkillIds,
    exactMatch:
      evaluation.status === "ok" &&
        actual.size === expected.size &&
        candidates.every((id) => expected.has(id)),
    falsePositives,
    invariantsHold,
  };
};

export function evaluateThresholdGrid(
  cases: readonly CalibrationCase[],
): TupleEvaluation[] {
  return PASS2_THRESHOLD_GRID.map((thresholds) => {
    const results = cases.map((calibrationCase) => scoreCase(thresholds, calibrationCase));
    return {
      thresholds,
      qualifies:
        results.length > 0 &&
        results.every(
          (result) =>
            result.exactMatch && result.falsePositives.length === 0 && result.invariantsHold,
        ),
      cases: results,
    };
  });
}

export function selectThreshold(
  cases: readonly CalibrationCase[],
): TupleEvaluation | null {
  if (cases.length === 0) {
    return null;
  }
  const qualifying = evaluateThresholdGrid(cases)
    .filter((evaluation) => evaluation.qualifies)
    .sort(
      (left, right) =>
        right.thresholds.rankingMin - left.thresholds.rankingMin ||
        right.thresholds.upper - left.thresholds.upper ||
        left.thresholds.lower - right.thresholds.lower,
    );
  return qualifying[0] ?? null;
}
