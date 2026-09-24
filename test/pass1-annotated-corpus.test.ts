import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { RouterInput } from "../src/contracts.js";
import { precheck } from "../src/policy.js";
import { buildPass1Request } from "../src/questions.js";

// Test-local validator for the synthetic pass-1 annotated corpus. There is no
// production validator: this file is the closed enforcement contract for
// fixtures/pass1-annotation-guide.md (guide version pass1-label-guide-v1).

const GUIDE_VERSION = "pass1-label-guide-v1";
const SCHEMA_VERSION = "pass1-annotated-corpus-v1";
const GUIDE_PATH = "fixtures/pass1-annotation-guide.md";
const QUESTION_BUILDER_PATH = "src/questions.ts";

const TASK_TYPES = [
  "explain",
  "research",
  "plan",
  "diagnose",
  "change",
  "review",
  "operate",
] as const;

const RISK_DIMENSIONS = [
  "security",
  "data-loss",
  "public-contract",
  "migration",
  "user-behavior",
] as const;

const TOP_LABEL_KEYS = [
  "taskType",
  "skillCandidates",
  "criticalGap",
  "reuseCandidate",
  "architectureFork",
  "contextRelevance",
  "riskDimensions",
] as const;

const SIGNAL_UNITS = [
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

const OPTIONAL_QUESTION: Readonly<Record<string, string>> = {
  skillCandidates: "skill_candidates",
  criticalGap: "critical_gap",
  reuseCandidate: "reuse_candidate",
  architectureFork: "architecture_fork",
  contextRelevance: "context_relevance",
};

type SplitName = "pilot" | "calibration" | "evaluation";

const SPLIT_CASE_PATTERN: Readonly<Record<SplitName, RegExp>> = {
  pilot: /^P\d{2}$/,
  calibration: /^CAL-\d{3}$/,
  evaluation: /^EVAL-\d{3}$/,
};

const SPLIT_FILE: Readonly<
  Record<SplitName, { path: string; count: number }>
> = {
  pilot: { path: "fixtures/pass1-rubric-pilot.json", count: 14 },
  calibration: { path: "fixtures/pass1-calibration-cases.json", count: 56 },
  evaluation: { path: "fixtures/pass1-evaluation-cases.json", count: 28 },
};

const LEGACY_CORPUS_PATH = "fixtures/calibration-corpus.json";

const EXPOSED_ID_PATTERN = /^(C[1-6]|H[1-2])$/;
const FAMILY_PATTERN = /^fam-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

type Errors = string[];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const nonEmptyString = (value: unknown): value is string =>
  isString(value) && value.trim().length > 0;

const expectKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  where: string,
  errors: Errors,
): void => {
  const actual = Object.keys(value).sort().join(",");
  const wanted = [...expected].sort().join(",");
  if (actual !== wanted) {
    errors.push(`${where}: expected exactly keys [${wanted}] but found [${actual}]`);
  }
};

const sameValue = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) {
    const left = a.map((entry) => JSON.stringify(entry)).sort();
    const right = b.map((entry) => JSON.stringify(entry)).sort();
    return left.length === right.length && left.every((entry, index) => entry === right[index]);
  }
  return JSON.stringify(a) === JSON.stringify(b);
};

interface LeafParts {
  status: unknown;
  value: unknown;
  evidence: unknown;
}

const leafParts = (leaf: unknown): LeafParts | null => {
  if (!isRecord(leaf)) {
    return null;
  }
  return { status: leaf.status, value: leaf.value, evidence: leaf.evidence };
};

const leafEquals = (actual: LeafParts, expected: LeafParts): boolean =>
  JSON.stringify([actual.status, actual.value, actual.evidence]) ===
  JSON.stringify([expected.status, expected.value, expected.evidence]);

interface CaseRecord {
  caseId: string;
  familyId: string;
  input: RouterInput;
  labels: Record<string, unknown>;
  annotations: { labels: Record<string, unknown> }[];
  adjudication: { disagreements: unknown[] };
}

type SpanTarget =
  | { kind: "substring"; texts: string[] }
  | { kind: "verbatim"; values: string[] };

interface VisibleState {
  echo: Record<string, unknown>;
  taskText: string;
  forcedSkillIds: readonly string[];
  skills: readonly { id: string; description: string }[];
  criticalGaps: readonly { id: string; fact: string; blocks: string }[];
  reuseCandidates: readonly { id: string; summary: string }[];
  architectureForks: readonly { id: string; alternatives: readonly string[]; tradeoff: string }[];
  contextFragments: readonly { id: string; summary: string }[];
}

const queriedUnitsOf = (input: RouterInput): Set<string> => {
  const questions = buildPass1Request(precheck(input)).questions;
  const queried = new Set<string>([
    "taskType",
    "riskDimensions.security",
    "riskDimensions.data-loss",
    "riskDimensions.public-contract",
    "riskDimensions.migration",
    "riskDimensions.user-behavior",
  ]);
  for (const [unit, question] of Object.entries(OPTIONAL_QUESTION)) {
    if (Object.hasOwn(questions, question)) {
      queried.add(unit);
    }
  }
  return queried;
};

const spanTargetFor = (state: VisibleState, path: string): SpanTarget | null => {
  if (path === "state.taskText") {
    return { kind: "substring", texts: [state.taskText] };
  }
  if (path === "state.forcedSkillIds") {
    return { kind: "verbatim", values: [...state.forcedSkillIds] };
  }
  const skill = /^state\.skills\[([^\]]+)\]\.(id|description)$/.exec(path);
  if (skill) {
    const entry = state.skills.find((candidate) => candidate.id === skill[1]);
    if (!entry) {
      return null;
    }
    return skill[2] === "id"
      ? { kind: "verbatim", values: [entry.id] }
      : { kind: "substring", texts: [entry.description] };
  }
  const gap = /^state\.criticalGaps\[([^\]]+)\]\.(id|fact|blocks)$/.exec(path);
  if (gap) {
    const entry = state.criticalGaps.find((candidate) => candidate.id === gap[1]);
    if (!entry) {
      return null;
    }
    return gap[2] === "id"
      ? { kind: "verbatim", values: [entry.id] }
      : { kind: "substring", texts: [gap[2] === "fact" ? entry.fact : entry.blocks] };
  }
  const reuse = /^state\.reuseCandidates\[([^\]]+)\]\.(id|summary)$/.exec(path);
  if (reuse) {
    const entry = state.reuseCandidates.find((candidate) => candidate.id === reuse[1]);
    if (!entry) {
      return null;
    }
    return reuse[2] === "id"
      ? { kind: "verbatim", values: [entry.id] }
      : { kind: "substring", texts: [entry.summary] };
  }
  const fork = /^state\.architectureForks\[([^\]]+)\]\.(id|alternatives|tradeoff)$/.exec(path);
  if (fork) {
    const entry = state.architectureForks.find((candidate) => candidate.id === fork[1]);
    if (!entry) {
      return null;
    }
    if (fork[2] === "id") {
      return { kind: "verbatim", values: [entry.id] };
    }
    return fork[2] === "alternatives"
      ? { kind: "substring", texts: [...entry.alternatives] }
      : { kind: "substring", texts: [entry.tradeoff] };
  }
  const fragment = /^state\.contextFragments\[([^\]]+)\]\.(id|summary)$/.exec(path);
  if (fragment) {
    const entry = state.contextFragments.find((candidate) => candidate.id === fragment[1]);
    if (!entry) {
      return null;
    }
    return fragment[2] === "id"
      ? { kind: "verbatim", values: [entry.id] }
      : { kind: "substring", texts: [entry.summary] };
  }
  return null;
};

// Evidence may cite only fields visible to the question that owns the signal:
// task text for task type and the five risk dimensions, and the matching
// candidate group otherwise. state.forcedSkillIds is visible to the optional
// skill question as context and is admitted there as an id-verbatim span.
const EVIDENCE_PREFIX: Readonly<Record<string, readonly string[]>> = {
  taskType: ["state.taskText"],
  skillCandidates: ["state.taskText", "state.forcedSkillIds", "state.skills["],
  criticalGap: ["state.taskText", "state.criticalGaps["],
  reuseCandidate: ["state.taskText", "state.reuseCandidates["],
  architectureFork: ["state.taskText", "state.architectureForks["],
  contextRelevance: ["state.taskText", "state.contextFragments["],
  "riskDimensions.security": ["state.taskText"],
  "riskDimensions.data-loss": ["state.taskText"],
  "riskDimensions.public-contract": ["state.taskText"],
  "riskDimensions.migration": ["state.taskText"],
  "riskDimensions.user-behavior": ["state.taskText"],
};

const evidenceListFor = (leaf: LeafParts, where: string, errors: Errors): unknown[] => {
  if (!Array.isArray(leaf.evidence)) {
    errors.push(`${where}: evidence must be an array`);
    return [];
  }
  return leaf.evidence;
};

const checkEvidence = (
  unit: string,
  evidence: unknown[],
  state: VisibleState,
  where: string,
  errors: Errors,
): void => {
  const allowed = EVIDENCE_PREFIX[unit] ?? [];
  for (const [index, raw] of evidence.entries()) {
    const entryWhere = `${where} evidence[${index}]`;
    if (!isRecord(raw)) {
      errors.push(`${entryWhere}: evidence entry must be an object`);
      continue;
    }
    expectKeys(raw, ["path", "span"], entryWhere, errors);
    const { path, span } = raw;
    if (!nonEmptyString(path) || !nonEmptyString(span)) {
      errors.push(`${entryWhere}: path and span must be non-empty strings`);
      continue;
    }
    if (!allowed.some((prefix) => path === prefix || path.startsWith(prefix))) {
      errors.push(`${entryWhere}: path ${path} is not visible evidence for ${unit}`);
      continue;
    }
    const target = spanTargetFor(state, path);
    if (target === null) {
      errors.push(`${entryWhere}: path ${path} does not resolve in the model-visible state`);
      continue;
    }
    if (target.kind === "verbatim") {
      if (!target.values.includes(span)) {
        errors.push(`${entryWhere}: span is not a verbatim id of ${path}`);
      }
    } else if (!target.texts.some((text) => text.includes(span))) {
      errors.push(`${entryWhere}: span is not an exact substring of ${path}`);
    }
  }
};

const checkValue = (
  unit: string,
  value: unknown,
  state: VisibleState,
  where: string,
  errors: Errors,
): void => {
  const nonForced = new Set(state.skills.map((skill) => skill.id));
  const fragments = new Set(state.contextFragments.map((fragment) => fragment.id));
  const idOf = (group: readonly { id: string }[]): Set<string> =>
    new Set(group.map((entry) => entry.id));
  switch (unit) {
    case "taskType":
      if (!isString(value) || !(TASK_TYPES as readonly string[]).includes(value)) {
        errors.push(`${where}: taskType value must be one of ${TASK_TYPES.join(", ")}`);
      }
      return;
    case "riskDimensions.security":
    case "riskDimensions.data-loss":
    case "riskDimensions.public-contract":
    case "riskDimensions.migration":
    case "riskDimensions.user-behavior":
      if (value !== "positive" && value !== "negative") {
        errors.push(`${where}: risk value must be positive or negative when resolved`);
      }
      return;
    case "skillCandidates": {
      if (value === null) {
        return;
      }
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        !value.every((entry) => isString(entry) && nonForced.has(entry)) ||
        new Set(value).size !== value.length
      ) {
        errors.push(
          `${where}: skillCandidates value must be null or a unique non-empty subset of non-forced skill ids`,
        );
      }
      return;
    }
    case "contextRelevance": {
      if (value === null) {
        return;
      }
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        !value.every((entry) => isString(entry) && fragments.has(entry)) ||
        new Set(value).size !== value.length
      ) {
        errors.push(
          `${where}: contextRelevance value must be null or a unique non-empty subset of public fragment ids`,
        );
      }
      return;
    }
    case "criticalGap":
    case "reuseCandidate":
    case "architectureFork": {
      if (value === null) {
        return;
      }
      const group =
        unit === "criticalGap"
          ? state.criticalGaps
          : unit === "reuseCandidate"
            ? state.reuseCandidates
            : state.architectureForks;
      if (!isString(value) || !idOf(group).has(value)) {
        errors.push(`${where}: ${unit} value must be null or a supplied candidate id`);
      }
      return;
    }
    default:
      errors.push(`${where}: unknown signal unit ${unit}`);
  }
};

const checkLeaf = (
  leaf: unknown,
  unit: string,
  state: VisibleState,
  queried: Set<string>,
  kind: "final" | "annotator",
  where: string,
  errors: Errors,
): void => {
  if (!isRecord(leaf)) {
    errors.push(`${where}: label must be an object`);
    return;
  }
  expectKeys(
    leaf,
    kind === "final"
      ? ["status", "value", "evidence"]
      : ["status", "value", "evidence", "rationale"],
    where,
    errors,
  );
  const parts = leafParts(leaf);
  if (!parts) {
    return;
  }
  const { status, value } = parts;
  if (status !== "resolved" && status !== "ambiguous" && status !== "not_queried") {
    errors.push(`${where}: status must be resolved, ambiguous, or not_queried`);
    return;
  }
  const isQueried = queried.has(unit);
  if (status === "not_queried" && isQueried) {
    errors.push(`${where}: ${unit} was queried but is marked not_queried`);
  }
  if (status !== "not_queried" && !isQueried) {
    errors.push(`${where}: ${unit} was never queried but is not marked not_queried`);
  }
  const evidence = evidenceListFor(parts, where, errors);
  if (status === "not_queried") {
    if (value !== null || evidence.length !== 0) {
      errors.push(`${where}: not_queried needs a null value and empty evidence`);
    }
    return;
  }
  if (status === "ambiguous") {
    if (value !== null) {
      errors.push(`${where}: ambiguous needs a null value and is never a negative label`);
    }
    checkEvidence(unit, evidence, state, where, errors);
    return;
  }
  if (evidence.length === 0) {
    errors.push(`${where}: resolved needs at least one evidence entry, including for a null value`);
  }
  checkValue(unit, value, state, where, errors);
  checkEvidence(unit, evidence, state, where, errors);
  if (kind === "annotator" && !nonEmptyString(leaf.rationale)) {
    errors.push(`${where}: annotator label needs a non-empty rationale`);
  }
};

const leafOf = (
  labels: Record<string, unknown>,
  unit: string,
): unknown => {
  if (unit.startsWith("riskDimensions.")) {
    const risks = labels.riskDimensions;
    return isRecord(risks) ? risks[unit.slice("riskDimensions.".length)] : undefined;
  }
  return labels[unit];
};

const checkLabels = (
  labels: unknown,
  state: VisibleState,
  queried: Set<string>,
  kind: "final" | "annotator",
  where: string,
  errors: Errors,
): void => {
  if (!isRecord(labels)) {
    errors.push(`${where}: labels must be an object`);
    return;
  }
  expectKeys(labels, TOP_LABEL_KEYS, where, errors);
  const risks = labels.riskDimensions;
  if (!isRecord(risks)) {
    errors.push(`${where}: riskDimensions must be an object`);
  } else {
    expectKeys(risks, RISK_DIMENSIONS, `${where} riskDimensions`, errors);
  }
  for (const unit of SIGNAL_UNITS) {
    checkLeaf(leafOf(labels, unit), unit, state, queried, kind, `${where} ${unit}`, errors);
  }
};

const unionEvidence = (a: unknown[], b: unknown[]): unknown[] => {
  const seen = new Set<string>();
  const merged: unknown[] = [];
  for (const entry of [...a, ...b]) {
    const key = JSON.stringify(entry);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
};

const evidenceSetEquals = (a: unknown[], b: unknown[]): boolean => {
  const canonical = (entries: unknown[]): string =>
    entries.map((entry) => JSON.stringify(entry)).sort().join("|");
  return canonical(a) === canonical(b);
};

const checkAdjudication = (
  record: CaseRecord,
  raw: unknown,
  where: string,
  errors: Errors,
): void => {
  if (!isRecord(raw)) {
    errors.push(`${where}: adjudication must be an object`);
    return;
  }
  expectKeys(raw, ["adjudicatorId", "method", "model", "guideVersion", "disagreements"], where, errors);
  if (!nonEmptyString(raw.adjudicatorId)) {
    errors.push(`${where}: adjudicatorId must be a non-empty string`);
  }
  if (raw.method !== "human" && raw.method !== "model-assisted") {
    errors.push(`${where}: adjudicator method must be human or model-assisted`);
  } else if (raw.method === "model-assisted" ? !nonEmptyString(raw.model) : raw.model !== null) {
    errors.push(`${where}: adjudicator model must be a non-empty string iff model-assisted`);
  }
  if (raw.guideVersion !== GUIDE_VERSION) {
    errors.push(`${where}: adjudication must be labeled under ${GUIDE_VERSION}`);
  }
  if (!Array.isArray(raw.disagreements)) {
    errors.push(`${where}: disagreements must be an array`);
    return;
  }

  const byUnit = new Map<string, Record<string, unknown>>();
  for (const [index, entry] of raw.disagreements.entries()) {
    const entryWhere = `${where} disagreements[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${entryWhere}: disagreement must be an object`);
      continue;
    }
    expectKeys(entry, ["signal", "annotatorA", "annotatorB", "outcome", "explanation"], entryWhere, errors);
    const { signal, outcome, explanation } = entry;
    if (!isString(signal) || !(SIGNAL_UNITS as readonly string[]).includes(signal)) {
      errors.push(`${entryWhere}: signal must name a known signal unit`);
      continue;
    }
    if (byUnit.has(signal)) {
      errors.push(`${entryWhere}: duplicate disagreement entry for ${signal}`);
    }
    byUnit.set(signal, entry);
    for (const side of ["annotatorA", "annotatorB"] as const) {
      const quoted = entry[side];
      if (!isRecord(quoted)) {
        errors.push(`${entryWhere}: ${side} must quote the annotation`);
        continue;
      }
      expectKeys(quoted, ["status", "value"], `${entryWhere} ${side}`, errors);
    }
    if (outcome !== "adopt-a" && outcome !== "adopt-b" && outcome !== "ambiguous") {
      errors.push(`${entryWhere}: outcome must be adopt-a, adopt-b, or ambiguous`);
    }
    if (!nonEmptyString(explanation)) {
      errors.push(`${entryWhere}: explanation must be a non-empty string`);
    }
  }

  const [first, second] = record.annotations;
  if (!first || !second) {
    return;
  }
  const finalLabels = record.labels;
  for (const unit of SIGNAL_UNITS) {
    const unitWhere = `${where} ${unit}`;
    const a = leafParts(leafOf(first.labels, unit));
    const b = leafParts(leafOf(second.labels, unit));
    const f = leafParts(leafOf(finalLabels, unit));
    if (!a || !b || !f) {
      continue;
    }
    const agreed = isString(a.status) && a.status === b.status && sameValue(a.value, b.value);
    const entry = byUnit.get(unit);
    if (agreed) {
      if (entry) {
        errors.push(`${unitWhere}: unexpected disagreement entry for an agreed label`);
      }
      if (!leafEquals(f, a)) {
        errors.push(`${unitWhere}: final label must equal the adopted (first) annotation on agreement`);
      }
      continue;
    }
    if (!entry) {
      errors.push(`${unitWhere}: missing disagreement entry for differing annotations`);
      continue;
    }
    const quotedA = leafParts(entry.annotatorA);
    const quotedB = leafParts(entry.annotatorB);
    if (quotedA && (quotedA.status !== a.status || !sameValue(quotedA.value, a.value))) {
      errors.push(`${unitWhere}: disagreement entry must quote annotator A verbatim`);
    }
    if (quotedB && (quotedB.status !== b.status || !sameValue(quotedB.value, b.value))) {
      errors.push(`${unitWhere}: disagreement entry must quote annotator B verbatim`);
    }
    if (entry.outcome === "adopt-a") {
      if (!leafEquals(f, a)) {
        errors.push(`${unitWhere}: adopt-a outcome must carry annotator A's label`);
      }
    } else if (entry.outcome === "adopt-b") {
      if (!leafEquals(f, b)) {
        errors.push(`${unitWhere}: adopt-b outcome must carry annotator B's label`);
      }
    } else if (entry.outcome === "ambiguous") {
      const expected = unionEvidence(
        evidenceListFor(a, unitWhere, []),
        evidenceListFor(b, unitWhere, []),
      );
      if (
        f.status !== "ambiguous" ||
        f.value !== null ||
        !Array.isArray(f.evidence) ||
        !evidenceSetEquals(f.evidence, expected)
      ) {
        errors.push(
          `${unitWhere}: an unresolvable disagreement must end as ambiguous with the competing spans`,
        );
      }
    }
  }
};

const checkInputShape = (value: unknown, where: string, errors: Errors): RouterInput | null => {
  if (!isRecord(value)) {
    errors.push(`${where}: input must be an object`);
    return null;
  }
  const optional = [
    "criticalGapCandidates",
    "architectureForkCandidates",
    "reuseCandidates",
    "contextFragments",
  ];
  const present = new Set(Object.keys(value));
  const required = [
    "taskId",
    "taskRevision",
    "taskText",
    "policyVersion",
    "catalogHash",
    "explicitSkillIds",
    "requiredSkillIds",
    "skills",
  ];
  for (const key of required) {
    if (!present.has(key)) {
      errors.push(`${where}: input is missing ${key}`);
    }
  }
  for (const key of present) {
    if (!required.includes(key) && !optional.includes(key)) {
      errors.push(`${where}: input has unexpected key ${key}`);
    }
  }
  if (Array.isArray(value.skills)) {
    for (const [index, skill] of value.skills.entries()) {
      if (!isRecord(skill)) {
        errors.push(`${where}: skills[${index}] must be an object`);
        continue;
      }
      expectKeys(skill, ["id", "description", "excerpt"], `${where} skills[${index}]`, errors);
    }
  }
  const shape: Readonly<Record<string, readonly string[]>> = {
    criticalGapCandidates: ["id", "fact", "blocks"],
    architectureForkCandidates: ["id", "alternatives", "tradeoff"],
    reuseCandidates: ["id", "summary"],
    contextFragments: ["id", "summary"],
  };
  for (const [group, keys] of Object.entries(shape)) {
    const entries = value[group];
    if (entries === undefined) {
      continue;
    }
    if (!Array.isArray(entries)) {
      errors.push(`${where}: ${group} must be an array`);
      continue;
    }
    for (const [index, entry] of entries.entries()) {
      if (!isRecord(entry)) {
        errors.push(`${where}: ${group}[${index}] must be an object`);
        continue;
      }
      expectKeys(entry, keys, `${where} ${group}[${index}]`, errors);
    }
  }
  return value as unknown as RouterInput;
};

const checkCase = (raw: unknown, split: SplitName, errors: Errors): CaseRecord | null => {
  if (!isRecord(raw)) {
    errors.push(`[${split}] case must be an object`);
    return null;
  }
  expectKeys(
    raw,
    ["caseId", "familyId", "split", "author", "input", "forcedSkillIds", "annotations", "adjudication", "labels"],
    "[case]",
    errors,
  );
  const caseId = raw.caseId;
  const where = isString(caseId) ? `case ${caseId}` : "[unknown case]";
  if (!isString(caseId) || !SPLIT_CASE_PATTERN[split].test(caseId)) {
    errors.push(`${where}: caseId must match ${String(SPLIT_CASE_PATTERN[split])} in ${split}`);
  }
  if (isString(caseId) && EXPOSED_ID_PATTERN.test(caseId)) {
    errors.push(`${where}: exposed development ids are excluded from this corpus forever`);
  }
  if (!isString(raw.familyId) || !FAMILY_PATTERN.test(raw.familyId)) {
    errors.push(`${where}: familyId must match ${String(FAMILY_PATTERN)}`);
  }
  if (raw.split !== split) {
    errors.push(`${where}: case split must equal the containing file split ${split}`);
  }
  const author = raw.author;
  if (!isRecord(author)) {
    errors.push(`${where}: author must be an object`);
  } else {
    expectKeys(author, ["id", "method", "model"], `${where} author`, errors);
    if (!nonEmptyString(author.id)) {
      errors.push(`${where}: author id must be a non-empty string`);
    }
    if (author.method !== "human" && author.method !== "model-assisted") {
      errors.push(`${where}: author method must be human or model-assisted`);
    } else if (
      author.method === "model-assisted" ? !nonEmptyString(author.model) : author.model !== null
    ) {
      errors.push(`${where}: author model must be a non-empty string iff model-assisted`);
    }
  }

  const input = checkInputShape(raw.input, where, errors);
  let visible: VisibleState | null = null;
  let queried = new Set<string>();
  if (input) {
    if (isString(caseId) && input.taskId !== caseId) {
      errors.push(`${where}: input.taskId must equal caseId`);
    }
    try {
      const checked = precheck(input);
      visible = buildPass1Request(checked).state as VisibleState;
      queried = queriedUnitsOf(input);
      const forced = [...checked.forcedSkillIds];
      if (!sameValue(raw.forcedSkillIds, forced)) {
        errors.push(`${where}: forcedSkillIds must record the deduped explicit and required skill ids`);
      }
    } catch (error) {
      errors.push(`${where}: input must pass precheck (${(error as Error).message})`);
    }
  }

  if (!visible) {
    return null;
  }

  checkLabels(raw.labels, visible, queried, "final", `${where} labels`, errors);

  const annotations = raw.annotations;
  if (!Array.isArray(annotations)) {
    errors.push(`${where}: annotations must be an array`);
    return null;
  }
  if (annotations.length !== 2) {
    errors.push(`${where}: exactly two isolated annotations are required`);
    return null;
  }
  const seenAnnotators = new Set<string>();
  for (const [index, annotation] of annotations.entries()) {
    const annotationWhere = `${where} annotations[${index}]`;
    if (!isRecord(annotation)) {
      errors.push(`${annotationWhere}: annotation must be an object`);
      return null;
    }
    expectKeys(annotation, ["annotatorId", "method", "model", "guideVersion", "labels"], annotationWhere, errors);
    if (!nonEmptyString(annotation.annotatorId)) {
      errors.push(`${annotationWhere}: annotatorId must be a non-empty string`);
    } else if (seenAnnotators.has(annotation.annotatorId)) {
      errors.push(`${where}: the two annotations need distinct annotator ids`);
    } else {
      seenAnnotators.add(annotation.annotatorId);
    }
    if (annotation.method !== "model-assisted") {
      errors.push(`${annotationWhere}: this corpus declares model-assisted annotations only`);
    }
    if (!nonEmptyString(annotation.model)) {
      errors.push(`${annotationWhere}: the producing model must be declared`);
    }
    if (annotation.guideVersion !== GUIDE_VERSION) {
      errors.push(`${annotationWhere}: annotation must be labeled under ${GUIDE_VERSION}`);
    }
    checkLabels(annotation.labels, visible, queried, "annotator", `${annotationWhere} labels`, errors);
  }

  const record = raw as unknown as CaseRecord;
  checkAdjudication(record, raw.adjudication, `${where} adjudication`, errors);
  return record;
};

interface SplitInput {
  split: SplitName;
  file: unknown;
  expectedCount: number | null;
}

const validateCorpus = (splits: readonly SplitInput[], errors: Errors): void => {
  const collected: { split: SplitName; cases: CaseRecord[] }[] = [];
  for (const { split, file, expectedCount } of splits) {
    const fileWhere = `${split} file`;
    if (!isRecord(file)) {
      errors.push(`${fileWhere}: must be an object`);
      continue;
    }
    expectKeys(file, ["schemaVersion", "guideVersion", "split", "cases"], fileWhere, errors);
    if (file.schemaVersion !== SCHEMA_VERSION) {
      errors.push(`${fileWhere}: schemaVersion must be ${SCHEMA_VERSION}`);
    }
    if (file.guideVersion !== GUIDE_VERSION) {
      errors.push(`${fileWhere}: guideVersion must be ${GUIDE_VERSION}`);
    }
    if (file.split !== split) {
      errors.push(`${fileWhere}: split must be ${split}`);
    }
    if (!Array.isArray(file.cases)) {
      errors.push(`${fileWhere}: cases must be an array`);
      continue;
    }
    if (expectedCount !== null && file.cases.length !== expectedCount) {
      errors.push(`${fileWhere}: expected exactly ${expectedCount} cases but found ${file.cases.length}`);
    }
    const cases: CaseRecord[] = [];
    for (const raw of file.cases) {
      const record = checkCase(raw, split, errors);
      if (record) {
        cases.push(record);
      }
    }
    const ids = cases.map((record) => record.caseId);
    if (new Set(ids).size !== ids.length) {
      errors.push(`${fileWhere}: case ids must be unique within the split`);
    }
    collected.push({ split, cases });
  }

  const byFamily = new Map<string, Set<SplitName>>();
  const byCaseId = new Map<string, number>();
  const byNormalizedText = new Map<string, string>();
  for (const { split, cases } of collected) {
    for (const record of cases) {
      byCaseId.set(record.caseId, (byCaseId.get(record.caseId) ?? 0) + 1);
      const families = byFamily.get(record.familyId) ?? new Set<SplitName>();
      families.add(split);
      byFamily.set(record.familyId, families);
      const normalized = record.input.taskText.toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (normalized.length > 0) {
        byNormalizedText.set(normalized, record.caseId);
      }
    }
  }
  for (const [caseId, count] of byCaseId) {
    if (count > 1) {
      errors.push(`corpus: duplicate case id ${caseId}`);
    }
  }
  for (const [familyId, families] of byFamily) {
    if (families.size > 1) {
      errors.push(`corpus: family ${familyId} leaks across splits ${[...families].sort().join(", ")}`);
    }
  }
  if (byNormalizedText.size !== [...byCaseId.keys()].length) {
    const seen = new Set<string>();
    for (const record of collected.flatMap((entry) => entry.cases)) {
      const normalized = record.input.taskText.toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (seen.has(normalized)) {
        errors.push(`corpus: duplicated task text at ${record.caseId}`);
      }
      seen.add(normalized);
    }
  }
};

const legacyExclusions = (): { ids: Set<string>; texts: Set<string> } => {
  const parsed = JSON.parse(readFileSync(LEGACY_CORPUS_PATH, "utf8")) as {
    cases?: { id?: unknown; input?: { taskText?: unknown } }[];
  };
  const ids = new Set<string>();
  const texts = new Set<string>();
  for (const entry of parsed.cases ?? []) {
    if (typeof entry.id === "string") {
      ids.add(entry.id);
    }
    const taskText = entry.input?.taskText;
    if (typeof taskText === "string") {
      texts.add(taskText.toLowerCase().replace(/[^a-z0-9]+/g, ""));
    }
  }
  return { ids, texts };
};

const normalizeText = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "");

interface SplitCounts {
  cases: number;
  families: number;
  labels: { resolved: number; ambiguous: number; notQueried: number };
  disagreements: number;
  signals: Record<string, { resolved: number; ambiguous: number; notQueried: number }>;
  taskTypeValues: Record<string, number>;
  riskValues: Record<string, { positive: number; negative: number }>;
}

const statusBucket = (status: unknown): "resolved" | "ambiguous" | "notQueried" | null => {
  if (status === "resolved") {
    return "resolved";
  }
  if (status === "ambiguous") {
    return "ambiguous";
  }
  if (status === "not_queried") {
    return "notQueried";
  }
  return null;
};

const computeCounts = (cases: readonly CaseRecord[]): SplitCounts => {
  const counts: SplitCounts = {
    cases: cases.length,
    families: new Set(cases.map((record) => record.familyId)).size,
    labels: { resolved: 0, ambiguous: 0, notQueried: 0 },
    disagreements: 0,
    signals: Object.fromEntries(
      SIGNAL_UNITS.map((unit) => [unit, { resolved: 0, ambiguous: 0, notQueried: 0 }]),
    ),
    taskTypeValues: Object.fromEntries(TASK_TYPES.map((type) => [type, 0])),
    riskValues: Object.fromEntries(
      RISK_DIMENSIONS.map((dimension) => [dimension, { positive: 0, negative: 0 }]),
    ),
  };
  for (const record of cases) {
    counts.disagreements += record.adjudication.disagreements.length;
    for (const unit of SIGNAL_UNITS) {
      const leaf = leafParts(leafOf(record.labels, unit));
      const bucket = leaf ? statusBucket(leaf.status) : null;
      if (!leaf || !bucket) {
        continue;
      }
      counts.labels[bucket] += 1;
      const signalCounts = counts.signals[unit];
      if (signalCounts) {
        signalCounts[bucket] += 1;
      }
      if (unit === "taskType" && bucket === "resolved" && isString(leaf.value)) {
        counts.taskTypeValues[leaf.value] = (counts.taskTypeValues[leaf.value] ?? 0) + 1;
      }
      if (unit.startsWith("riskDimensions.") && bucket === "resolved") {
        const dimension = unit.slice("riskDimensions.".length);
        const riskCounts = counts.riskValues[dimension];
        if (riskCounts && (leaf.value === "positive" || leaf.value === "negative")) {
          riskCounts[leaf.value] += 1;
        }
      }
    }
  }
  return counts;
};

const sha256File = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const loadSplitFile = (split: SplitName): unknown =>
  JSON.parse(readFileSync(SPLIT_FILE[split].path, "utf8"));

// ---------------------------------------------------------------------------
// In-memory synthetic corpus used by the mutation checks below.
// ---------------------------------------------------------------------------

const SYNTHETIC_TASK_TEXT =
  "Explain the retry backoff design of the synthetic queue worker and propose the documentation update.";

const syntheticLeaf = (
  status: string,
  value: unknown,
  evidence: { path: string; span: string }[],
  rationale: string,
): Record<string, unknown> => ({ status, value, evidence, rationale });

const syntheticLabels = (): Record<string, unknown> => ({
  taskType: syntheticLeaf("resolved", "explain", [
    { path: "state.taskText", span: "Explain the retry backoff design" },
  ], "The deliverable is an explanation."),
  skillCandidates: syntheticLeaf("resolved", ["skill-docs"], [
    { path: "state.skills[skill-docs].id", span: "skill-docs" },
  ], "The documentation skill is independently justified."),
  criticalGap: syntheticLeaf("resolved", "gap-1", [
    { path: "state.criticalGaps[gap-1].id", span: "gap-1" },
  ], "The supplied gap blocks the explanation."),
  reuseCandidate: syntheticLeaf("not_queried", null, [], "No reuse candidate is supplied."),
  architectureFork: syntheticLeaf("resolved", "fork-1", [
    { path: "state.architectureForks[fork-1].id", span: "fork-1" },
  ], "The supplied fork is the required decision."),
  contextRelevance: syntheticLeaf("resolved", ["ctx-1"], [
    { path: "state.contextFragments[ctx-1].id", span: "ctx-1" },
  ], "The fragment changes the explanation."),
  riskDimensions: {
    security: syntheticLeaf("resolved", "negative", [
      { path: "state.taskText", span: "documentation update" },
    ], "No security surface is stated."),
    "data-loss": syntheticLeaf("resolved", "negative", [
      { path: "state.taskText", span: "documentation update" },
    ], "No destructive operation is stated."),
    "public-contract": syntheticLeaf("resolved", "positive", [
      { path: "state.taskText", span: "documentation update" },
    ], "The documentation is externally visible."),
    migration: syntheticLeaf("resolved", "negative", [
      { path: "state.taskText", span: "retry backoff design" },
    ], "No data or schema migration is stated."),
    "user-behavior": syntheticLeaf("resolved", "negative", [
      { path: "state.taskText", span: "queue worker" },
    ], "No user-visible change is stated."),
  },
});

const syntheticInput = (taskId: string): Record<string, unknown> => ({
  taskId,
  taskRevision: 1,
  taskText: `${SYNTHETIC_TASK_TEXT} Case marker ${taskId}.`,
  policyVersion: "pass1-lab-policy-v1",
  catalogHash: "catalog-synthetic-v1",
  explicitSkillIds: [],
  requiredSkillIds: [],
  skills: [
    {
      id: "skill-docs",
      description: "Writes technical documentation for public APIs.",
      excerpt: "Public documentation excerpt.",
    },
    {
      id: "skill-review",
      description: "Reviews code changes for defects.",
      excerpt: "Review excerpt.",
    },
  ],
  criticalGapCandidates: [
    { id: "gap-1", fact: "The retry ceiling is unknown.", blocks: "Explaining the backoff design." },
  ],
  architectureForkCandidates: [
    {
      id: "fork-1",
      alternatives: ["a single retry queue", "per-channel retry queues"],
      tradeoff: "operational simplicity versus isolation",
    },
  ],
  contextFragments: [
    { id: "ctx-1", summary: "The worker runs on a fixed schedule." },
    { id: "ctx-2", summary: "The cafeteria menu changed last week." },
  ],
});

const stripRationale = (leaf: unknown): Record<string, unknown> => {
  const rest: Record<string, unknown> = {};
  if (isRecord(leaf)) {
    for (const [key, value] of Object.entries(leaf)) {
      if (key !== "rationale") {
        rest[key] = value;
      }
    }
  }
  return rest;
};

const syntheticFinalLabels = (): Record<string, unknown> => {
  const annotated = syntheticLabels();
  const final: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(annotated)) {
    if (key === "riskDimensions" && isRecord(value)) {
      const risks: Record<string, unknown> = {};
      for (const [dimension, leaf] of Object.entries(value)) {
        risks[dimension] = stripRationale(leaf);
      }
      final.riskDimensions = risks;
    } else {
      final[key] = stripRationale(value);
    }
  }
  return final;
};

const syntheticCase = (caseId: string, familyId: string): Record<string, unknown> => {
  const labels = syntheticFinalLabels();
  return {
    caseId,
    familyId,
    input: syntheticInput(caseId),
    forcedSkillIds: [],
    author: { id: "model-author-synthetic", method: "model-assisted", model: "synthetic-model" },
    annotations: [
      {
        annotatorId: "model-annotator-a",
        method: "model-assisted",
        model: "synthetic-model",
        guideVersion: GUIDE_VERSION,
        labels: syntheticLabels(),
      },
      {
        annotatorId: "model-annotator-b",
        method: "model-assisted",
        model: "synthetic-model",
        guideVersion: GUIDE_VERSION,
        labels: syntheticLabels(),
      },
    ],
    adjudication: {
      adjudicatorId: "model-adjudicator-synthetic",
      method: "model-assisted",
      model: "synthetic-model",
      guideVersion: GUIDE_VERSION,
      disagreements: [],
    },
    labels,
  };
};

const syntheticCorpus = (): SplitInput[] => {
  const build = (split: SplitName, cases: Record<string, unknown>[]): SplitInput => ({
    split,
    expectedCount: null,
    file: {
      schemaVersion: SCHEMA_VERSION,
      guideVersion: GUIDE_VERSION,
      split,
      cases: cases.map((record) => ({ ...record, split })),
    },
  });
  return [
    build("pilot", [
      syntheticCase("P01", "fam-synthetic-alpha"),
      syntheticCase("P02", "fam-synthetic-beta"),
    ]),
    build("calibration", [syntheticCase("CAL-001", "fam-synthetic-gamma")]),
  ];
};

const syntheticCaseRecord = (
  splits: SplitInput[],
  splitIndex: number,
  caseIndex: number,
): Record<string, unknown> => {
  const entry = splits[splitIndex];
  const file = entry ? (entry.file as { cases: Record<string, unknown>[] }) : undefined;
  const record = file?.cases[caseIndex];
  if (!record) {
    throw new Error("synthetic corpus is misconfigured");
  }
  return record;
};

const baselineErrors = (splits: SplitInput[]): Errors => {
  const errors: Errors = [];
  validateCorpus(splits, errors);
  return errors;
};

// ---------------------------------------------------------------------------
// Split fixtures.
// ---------------------------------------------------------------------------

test("pilot split has exactly 14 closed cases with dual annotations and valid evidence spans", () => {
  const errors: Errors = [];
  validateCorpus([{ split: "pilot", file: loadSplitFile("pilot"), expectedCount: 14 }], errors);
  assert.deepEqual(errors, []);
});

test("calibration split has exactly 56 closed cases with dual annotations and valid evidence spans", () => {
  const errors: Errors = [];
  validateCorpus([{ split: "calibration", file: loadSplitFile("calibration"), expectedCount: 56 }], errors);
  assert.deepEqual(errors, []);
});

test("evaluation split has exactly 28 closed cases with dual annotations and valid evidence spans", () => {
  const errors: Errors = [];
  validateCorpus([{ split: "evaluation", file: loadSplitFile("evaluation"), expectedCount: 28 }], errors);
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------------------
// Cross-file guarantees.
// ---------------------------------------------------------------------------

test("corpus keeps ids unique, families split-safe, and exposed development cases excluded", () => {
  const errors: Errors = [];
  const files: SplitInput[] = (["pilot", "calibration", "evaluation"] as SplitName[]).map((split) => ({
    split,
    file: loadSplitFile(split),
    expectedCount: SPLIT_FILE[split].count,
  }));
  validateCorpus(files, errors);
  assert.deepEqual(errors, []);

  const legacy = legacyExclusions();
  for (const { file } of files) {
    for (const raw of (file as { cases: Record<string, unknown>[] }).cases) {
      const record = raw as unknown as CaseRecord;
      assert.equal(legacy.ids.has(record.caseId), false, `${record.caseId} is an exposed development id`);
      assert.equal(
        legacy.texts.has(normalizeText(record.input.taskText)),
        false,
        `${record.caseId} reuses exposed development text`,
      );
    }
  }
});

test("corpus keeps queried null, ambiguous, and not_queried labels distinct", () => {
  const files = (["pilot", "calibration", "evaluation"] as SplitName[]).map(
    (split) => loadSplitFile(split) as { cases: CaseRecord[] },
  );
  const allCases = files.flatMap((file) => file.cases);
  let queriedNull = 0;
  let ambiguous = 0;
  let notQueried = 0;
  for (const record of allCases) {
    for (const unit of SIGNAL_UNITS) {
      const leaf = leafParts(leafOf(record.labels, unit));
      if (!leaf) {
        continue;
      }
      if (leaf.status === "resolved" && leaf.value === null) {
        queriedNull += 1;
        assert.ok(
          Array.isArray(leaf.evidence) && leaf.evidence.length > 0,
          `${record.caseId} ${unit}: a queried null needs evidence for the negative`,
        );
      }
      if (leaf.status === "ambiguous") {
        ambiguous += 1;
        assert.equal(leaf.value, null, `${record.caseId} ${unit}: ambiguous keeps a null value`);
      }
      if (leaf.status === "not_queried") {
        notQueried += 1;
        assert.equal(leaf.value, null, `${record.caseId} ${unit}: not_queried keeps a null value`);
        assert.deepEqual(leaf.evidence, [], `${record.caseId} ${unit}: not_queried has no evidence`);
      }
    }
  }
  assert.ok(queriedNull > 0, "the corpus needs queried null examples");
  assert.ok(ambiguous > 0, "the corpus needs ambiguous examples");
  assert.ok(notQueried > 0, "the corpus needs not_queried examples");
});

test("corpus excludes protected context and machine or credential fragments", () => {
  const forbidden = [
    "/" + "Users/",
    "/" + "home/",
    "TYPESAFE" + "_API_KEY",
    "TYPESAFE" + "_MODEL",
    ".config" + "/jev",
    "BEGIN " + "PRIVATE KEY",
  ];
  const sessionPattern = /01[a-f\d]{6,}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}/i;
  for (const split of ["pilot", "calibration", "evaluation"] as SplitName[]) {
    const text = readFileSync(SPLIT_FILE[split].path, "utf8");
    for (const snippet of forbidden) {
      assert.equal(text.includes(snippet), false, `${split} contains protected fragment ${snippet}`);
    }
    assert.equal(sessionPattern.test(text), false, `${split} contains a machine session id`);
    const parsed = JSON.parse(text) as { cases: { input: RouterInput }[] };
    for (const record of parsed.cases) {
      for (const fragment of record.input.contextFragments ?? []) {
        assert.equal(
          Object.hasOwn(fragment, "protected"),
          false,
          "protected fragments must never enter the corpus or its provider-request fixtures",
        );
      }
    }
  }
});

test("manifest records split counts and hashes that match the corpus files", () => {
  const manifest = JSON.parse(readFileSync("fixtures/pass1-corpus-manifest.json", "utf8")) as Record<string, unknown>;
  const shapeErrors: Errors = [];
  expectKeys(manifest, ["schemaVersion", "guideVersion", "hashes", "counts", "notes"], "manifest", shapeErrors);
  assert.deepEqual(shapeErrors, []);
  assert.equal(manifest.schemaVersion, SCHEMA_VERSION);
  assert.equal(manifest.guideVersion, GUIDE_VERSION);

  const hashes = manifest.hashes as {
    guide: { path: string; sha256: string };
    splits: Record<string, { path: string; sha256: string }>;
    questionBuilder: { path: string; sha256: string };
  };
  const guideText = readFileSync(GUIDE_PATH, "utf8");
  assert.ok(guideText.includes(GUIDE_VERSION), "the frozen guide declares its version");
  assert.equal(hashes.guide.path, GUIDE_PATH);
  assert.equal(hashes.guide.sha256, sha256File(GUIDE_PATH));
  for (const split of ["pilot", "calibration", "evaluation"] as SplitName[]) {
    const recorded = hashes.splits[split];
    if (!recorded) {
      assert.fail(`manifest is missing the ${split} split hash`);
    }
    assert.equal(recorded.path, SPLIT_FILE[split].path);
    assert.match(recorded.sha256, SHA256_PATTERN);
    assert.equal(recorded.sha256, sha256File(SPLIT_FILE[split].path));
  }
  assert.equal(hashes.questionBuilder.path, QUESTION_BUILDER_PATH);
  assert.match(hashes.questionBuilder.sha256, SHA256_PATTERN);
  assert.equal(hashes.questionBuilder.sha256, sha256File(QUESTION_BUILDER_PATH));

  const counts = manifest.counts as Record<string, unknown>;
  const countErrors: Errors = [];
  expectKeys(counts, ["pilot", "calibration", "evaluation"], "manifest counts", countErrors);
  assert.deepEqual(countErrors, []);
  for (const split of ["pilot", "calibration", "evaluation"] as SplitName[]) {
    const cases = (loadSplitFile(split) as { cases: CaseRecord[] }).cases;
    assert.deepEqual(counts[split], computeCounts(cases), `${split} counts`);
  }
  const notes = manifest.notes;
  assert.ok(Array.isArray(notes) && notes.length > 0 && notes.every(nonEmptyString), "notes");
});

// ---------------------------------------------------------------------------
// In-memory mutation checks: the validator must reject each regression.
// ---------------------------------------------------------------------------

test("validator accepts a well-formed synthetic corpus", () => {
  assert.deepEqual(baselineErrors(syntheticCorpus()), []);
});

test("validator rejects duplicate case ids", () => {
  const splits = syntheticCorpus();
  const second = syntheticCaseRecord(splits, 0, 1);
  second.caseId = "P01";
  (second.input as { taskId: string }).taskId = "P01";
  const errors = baselineErrors(splits);
  assert.ok(errors.some((entry) => entry.includes("duplicate case id")), errors.join("\n"));
});

test("validator rejects family leakage across splits", () => {
  const splits = syntheticCorpus();
  syntheticCaseRecord(splits, 1, 0).familyId = "fam-synthetic-alpha";
  const errors = baselineErrors(splits);
  assert.ok(errors.some((entry) => entry.includes("leaks across splits")), errors.join("\n"));
});

test("validator rejects a missing or duplicated annotator", () => {
  const missing = syntheticCorpus();
  const missingCase = syntheticCaseRecord(missing, 0, 0);
  missingCase.annotations = (missingCase.annotations as unknown[]).slice(0, 1);
  assert.ok(
    baselineErrors(missing).some((entry) => entry.includes("exactly two isolated annotations")),
  );

  const duplicated = syntheticCorpus();
  const duplicatedCase = syntheticCaseRecord(duplicated, 0, 0);
  const annotations = duplicatedCase.annotations as { annotatorId: string }[];
  const second = annotations[1];
  const first = annotations[0];
  if (!first || !second) {
    throw new Error("synthetic corpus is misconfigured");
  }
  second.annotatorId = first.annotatorId;
  assert.ok(
    baselineErrors(duplicated).some((entry) => entry.includes("distinct annotator ids")),
  );
});

test("validator rejects an altered guide version", () => {
  const splits = syntheticCorpus();
  const record = syntheticCaseRecord(splits, 0, 0);
  const annotation = (record.annotations as { guideVersion: string }[])[0];
  if (!annotation) {
    throw new Error("synthetic corpus is misconfigured");
  }
  annotation.guideVersion = "pass1-label-guide-v9";
  const errors = baselineErrors(splits);
  assert.ok(errors.some((entry) => entry.includes("must be labeled under")), errors.join("\n"));
});

test("validator rejects an unsupported evidence span", () => {
  const splits = syntheticCorpus();
  const record = syntheticCaseRecord(splits, 0, 0);
  const labels = record.labels as { taskType: { evidence: { span: string }[] } };
  const entry = labels.taskType.evidence[0];
  if (!entry) {
    throw new Error("synthetic corpus is misconfigured");
  }
  entry.span = "a span that is not in the visible input";
  const errors = baselineErrors(splits);
  assert.ok(errors.some((entry) => entry.includes("not an exact substring")), errors.join("\n"));
});

test("validator rejects a protected context fragment", () => {
  const splits = syntheticCorpus();
  const record = syntheticCaseRecord(splits, 0, 0);
  const input = record.input as { contextFragments: Record<string, unknown>[] };
  input.contextFragments.push({ id: "ctx-3", summary: "Internal note.", protected: true });
  const errors = baselineErrors(splits);
  assert.ok(
    errors.some((entry) => entry.includes("contextFragments[2]") && entry.includes("protected")),
    errors.join("\n"),
  );
});

test("validator rejects confusion among queried null, ambiguous, and not_queried", () => {
  const splits = syntheticCorpus();
  const record = syntheticCaseRecord(splits, 0, 0);
  const labels = record.labels as { criticalGap: Record<string, unknown> };
  labels.criticalGap = { status: "not_queried", value: null, evidence: [] };
  const errors = baselineErrors(splits);
  assert.ok(
    errors.some((entry) => entry.includes("was queried but is marked not_queried")),
    errors.join("\n"),
  );
});

test("validator rejects a final label that contradicts its annotations", () => {
  const splits = syntheticCorpus();
  const record = syntheticCaseRecord(splits, 0, 0);
  const labels = record.labels as { taskType: { value: string } };
  labels.taskType.value = "change";
  const errors = baselineErrors(splits);
  assert.ok(
    errors.some((entry) => entry.includes("must equal the adopted (first) annotation")),
    errors.join("\n"),
  );
});
