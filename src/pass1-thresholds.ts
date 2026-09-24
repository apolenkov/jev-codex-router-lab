export const PASS1_THRESHOLDS_ENV = "JEV_PASS1_THRESHOLDS_JSON";

export interface Pass1Thresholds {
  readonly choiceConfidenceMin: number;
  readonly noulUncertaintyLower: number;
  readonly noulUncertaintyUpper: number;
}

const PASS1_THRESHOLD_KEYS = [
  "choiceConfidenceMin",
  "noulUncertaintyLower",
  "noulUncertaintyUpper",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isProbability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

export const parsePass1Thresholds = (
  value: string | undefined,
): Pass1Thresholds | null => {
  if (value === undefined) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== PASS1_THRESHOLD_KEYS.length ||
    !PASS1_THRESHOLD_KEYS.every((key) => Object.hasOwn(parsed, key))
  ) {
    return null;
  }
  const { choiceConfidenceMin, noulUncertaintyLower, noulUncertaintyUpper } =
    parsed;
  if (
    !isProbability(choiceConfidenceMin) ||
    !isProbability(noulUncertaintyLower) ||
    !isProbability(noulUncertaintyUpper) ||
    noulUncertaintyLower >= 0.5 ||
    noulUncertaintyUpper <= 0.5
  ) {
    return null;
  }
  return { choiceConfidenceMin, noulUncertaintyLower, noulUncertaintyUpper };
};
