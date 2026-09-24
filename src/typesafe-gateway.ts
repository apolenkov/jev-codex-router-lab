import {
  TypeSafeClient,
  type EntryType,
  type Questions,
} from "@typesafe-ai/sdk";
import type {
  PrecheckedInput,
  RiskDimension,
  SemanticEcho,
  TaskType,
} from "./contracts.js";
import { MAX_OPTIONAL_SKILL_CANDIDATES } from "./contracts.js";
import {
  PASS1_THRESHOLDS_ENV,
  parsePass1Thresholds,
  type Pass1Thresholds,
} from "./pass1-thresholds.js";
import { buildPass1Request, buildPass2Request, NONE } from "./questions.js";
import {
  SemanticGatewayError,
  type Pass1Result,
  type Pass2Result,
  type PassMetadata,
  type SemanticGateway,
  type SystemOneClientPort,
  type SystemOneRequest,
} from "./semantic-gateway.js";
import {
  DEFAULT_PASS2_THRESHOLDS,
  evaluatePass2,
  type ParsedPass2,
} from "./threshold-calibration.js";

const TASK_TYPES: readonly TaskType[] = [
  "explain",
  "research",
  "plan",
  "diagnose",
  "change",
  "review",
  "operate",
];

const RISK_QUESTIONS: Readonly<Record<RiskDimension, string>> = {
  security: "risk_security",
  "data-loss": "risk_data_loss",
  "public-contract": "risk_public_contract",
  migration: "risk_migration",
  "user-behavior": "risk_user_behavior",
};

export interface ParsedTypeSafeEnvelope {
  answers: Record<string, unknown>;
  metadata: PassMetadata;
}

export interface Pass1ChoiceObservation {
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

export interface Pass1Observations {
  readonly echo: SemanticEcho;
  readonly taskType: Pass1ChoiceObservation;
  readonly skillCandidates: Pass1ChoiceObservation | null;
  readonly criticalGap: Pass1ChoiceObservation | null;
  readonly reuseCandidate: Pass1ChoiceObservation | null;
  readonly architectureFork: Pass1ChoiceObservation | null;
  readonly contextRelevance: Pass1ChoiceObservation | null;
  readonly riskDimensions: Readonly<Record<RiskDimension, number>>;
}

interface ParsedChoice {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isProbability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const malformed = (): never => {
  throw new SemanticGatewayError("malformed-response");
};

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
};

export const parseTypeSafeEnvelope = (
  value: unknown,
  expectedAnswers: readonly string[],
  latencyMs: number,
): ParsedTypeSafeEnvelope => {
  if (
    !isRecord(value) ||
    typeof value.model !== "string" ||
    value.model.trim().length === 0 ||
    !isRecord(value.answers) ||
    !exactKeys(value.answers, expectedAnswers) ||
    !isRecord(value.usage) ||
    !Number.isInteger(value.usage.input_tokens) ||
    (value.usage.input_tokens as number) < 0 ||
    !Number.isInteger(value.usage.output_tokens) ||
    (value.usage.output_tokens as number) < 0 ||
    !Number.isFinite(latencyMs) ||
    latencyMs < 0
  ) {
    return malformed();
  }

  return {
    answers: value.answers,
    metadata: {
      model: value.model,
      inputTokens: value.usage.input_tokens as number,
      outputTokens: value.usage.output_tokens as number,
      latencyMs,
    },
  };
};

const parseChoiceShape = (value: unknown): ParsedChoice => {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["type", "choice", "confidence", "probabilities"]) ||
    value.type !== "choice" ||
    typeof value.choice !== "string" ||
    value.choice.length === 0 ||
    !isProbability(value.confidence) ||
    !isRecord(value.probabilities)
  ) {
    return malformed();
  }

  const probabilities: Record<string, number> = {};
  for (const [id, probability] of Object.entries(value.probabilities)) {
    if (!isProbability(probability)) {
      return malformed();
    }
    probabilities[id] = probability;
  }
  if (!Object.hasOwn(probabilities, value.choice)) {
    return malformed();
  }

  return {
    choice: value.choice,
    confidence: value.confidence,
    probabilities,
  };
};

const parseChoice = (
  value: unknown,
  allowed: readonly string[],
  invalidIdReason: "malformed-response" | "unknown-id" = "unknown-id",
): ParsedChoice => {
  const answer = parseChoiceShape(value);
  const allowedSet = new Set(allowed);
  if (
    !allowedSet.has(answer.choice) ||
    Object.keys(answer.probabilities).some((id) => !allowedSet.has(id))
  ) {
    throw new SemanticGatewayError(invalidIdReason);
  }
  if (!exactKeys(answer.probabilities, allowed)) {
    return malformed();
  }
  return answer;
};

const parseEcho = (value: unknown, expected: string): string => {
  const answer = parseChoiceShape(value);
  if (answer.choice !== expected) {
    throw new SemanticGatewayError("stale-decision");
  }
  if (!exactKeys(answer.probabilities, [expected, NONE])) {
    return malformed();
  }
  return answer.choice;
};

const parseEchoes = (
  answers: Readonly<Record<string, unknown>>,
  input: PrecheckedInput,
): SemanticEcho => ({
  taskId: parseEcho(answers.echo_task_id, input.taskId),
  taskRevision: Number(parseEcho(answers.echo_task_revision, String(input.taskRevision))),
  policyVersion: parseEcho(answers.echo_policy_version, input.policyVersion),
  catalogHash: parseEcho(answers.echo_catalog_hash, input.catalogHash),
});

const parseNoul = (value: unknown): number => {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["type", "noul"]) ||
    value.type !== "noul" ||
    !isProbability(value.noul)
  ) {
    return malformed();
  }
  return value.noul;
};

const rankedIds = (
  answer: ParsedChoice,
  ids: readonly string[],
  limit = ids.length,
): string[] =>
  ids
    .map((id, index) => ({ id, index, probability: answer.probabilities[id]! }))
    .sort((left, right) => right.probability - left.probability || left.index - right.index)
    .slice(0, limit)
    .map(({ id }) => id);

const queriedChoice = (
  answerValue: unknown,
  ids: readonly string[],
): ParsedChoice | null =>
  ids.length === 0 ? null : parseChoice(answerValue, [...ids, NONE]);

const selectedId = (answer: ParsedChoice | null): string | null =>
  answer === null || answer.choice === NONE ? null : answer.choice;

const selectedObject = <T extends { id: string }>(
  answer: ParsedChoice | null,
  candidates: readonly T[],
): T | null => {
  const selected = selectedId(answer);
  return selected === null
    ? null
    : candidates.find(({ id }) => id === selected)!;
};

const assertPass1Confidence = (
  choices: readonly (ParsedChoice | null)[],
  nouls: readonly number[],
  thresholds: Pass1Thresholds,
): void => {
  if (
    choices.some((answer) =>
      answer !== null && answer.confidence < thresholds.choiceConfidenceMin
    ) ||
    nouls.some((value) =>
      value >= thresholds.noulUncertaintyLower &&
      value <= thresholds.noulUncertaintyUpper
    )
  ) {
    throw new SemanticGatewayError("low-confidence");
  }
};

const assertNoReservedChoiceValues = (input: PrecheckedInput): void => {
  const values = [
    input.taskId,
    input.policyVersion,
    input.catalogHash,
    ...input.skills.map(({ id }) => id),
    ...(input.criticalGapCandidates ?? []).map(({ id }) => id),
    ...(input.architectureForkCandidates ?? []).map(({ id }) => id),
    ...(input.reuseCandidates ?? []).map(({ id }) => id),
    ...(input.contextFragments ?? []).map(({ id }) => id),
  ];
  if (values.includes(NONE)) {
    throw new SemanticGatewayError("invalid-input");
  }
};

const mapWithMetadata = <T>(metadata: PassMetadata, operation: () => T): T => {
  try {
    return operation();
  } catch (error) {
    if (error instanceof SemanticGatewayError) {
      throw new SemanticGatewayError(error.reason, metadata);
    }
    throw error;
  }
};

export const parsePass1Observations = (
  answers: Readonly<Record<string, unknown>>,
  input: PrecheckedInput,
): Pass1Observations => {
  const echo = parseEchoes(answers, input);
  const taskType = parseChoice(
    answers.task_type,
    TASK_TYPES,
    "malformed-response",
  );
  const forced = new Set(input.forcedSkillIds);
  const optionalSkillIds = input.skills
    .map(({ id }) => id)
    .filter((id) => !forced.has(id));
  const skillCandidates = optionalSkillIds.length === 0
    ? null
    : parseChoice(answers.skill_candidates, [...optionalSkillIds, NONE]);
  const criticalGap = queriedChoice(
    answers.critical_gap,
    (input.criticalGapCandidates ?? []).map(({ id }) => id),
  );
  const reuseCandidate = queriedChoice(
    answers.reuse_candidate,
    (input.reuseCandidates ?? []).map(({ id }) => id),
  );
  const architectureFork = queriedChoice(
    answers.architecture_fork,
    (input.architectureForkCandidates ?? []).map(({ id }) => id),
  );
  const riskDimensions = {
    security: parseNoul(answers[RISK_QUESTIONS.security]),
    "data-loss": parseNoul(answers[RISK_QUESTIONS["data-loss"]]),
    "public-contract": parseNoul(answers[RISK_QUESTIONS["public-contract"]]),
    migration: parseNoul(answers[RISK_QUESTIONS.migration]),
    "user-behavior": parseNoul(answers[RISK_QUESTIONS["user-behavior"]]),
  };
  const publicContextIds = (input.contextFragments ?? [])
    .filter((fragment) => fragment.protected !== true)
    .map(({ id }) => id);
  const contextRelevance = queriedChoice(
    answers.context_relevance,
    publicContextIds,
  );
  return {
    echo,
    taskType,
    skillCandidates,
    criticalGap,
    reuseCandidate,
    architectureFork,
    contextRelevance,
    riskDimensions,
  };
};

export const parsePass2Record = (
  answers: Readonly<Record<string, unknown>>,
  input: PrecheckedInput,
  shortlist: readonly string[],
): ParsedPass2 => {
  const expectedAnswers = [
    "echo_task_id",
    "echo_task_revision",
    "echo_policy_version",
    "echo_catalog_hash",
    "skill_ranking",
    ...shortlist.map((_, index) => `skill_fit_${index}`),
  ];
  if (!exactKeys(answers, expectedAnswers)) {
    return malformed();
  }
  parseEchoes(answers, input);
  const ranking = parseChoice(answers.skill_ranking, [...shortlist, NONE]);
  const fits = shortlist.map((_, index) => parseNoul(answers[`skill_fit_${index}`]));
  return {
    shortlist: [...shortlist],
    ranking,
    ranked: rankedIds(ranking, shortlist),
    fits,
  };
};

export class TypeSafeGateway implements SemanticGateway {
  constructor(
    private readonly client: SystemOneClientPort,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async pass1(input: PrecheckedInput): Promise<Pass1Result> {
    const thresholds = parsePass1Thresholds(this.env[PASS1_THRESHOLDS_ENV]);
    if (thresholds === null) {
      throw new SemanticGatewayError("uncalibrated-thresholds");
    }
    assertNoReservedChoiceValues(input);
    const request = buildPass1Request(input);
    const { answers, metadata } = await this.call(request);
    return mapWithMetadata(metadata, () => {
      const observations = parsePass1Observations(answers, input);
      assertPass1Confidence(
        [
          observations.taskType,
          observations.skillCandidates,
          observations.criticalGap,
          observations.reuseCandidate,
          observations.architectureFork,
          observations.contextRelevance,
        ],
        Object.values(observations.riskDimensions),
        thresholds,
      );

      const forced = new Set(input.forcedSkillIds);
      const optionalSkillIds = input.skills
        .map(({ id }) => id)
        .filter((id) => !forced.has(id));
      const publicContextIds = (input.contextFragments ?? [])
        .filter((fragment) => fragment.protected !== true)
        .map(({ id }) => id);
      const skillCandidates = observations.skillCandidates;
      const contextRelevance = observations.contextRelevance;

      return {
        echo: observations.echo,
        taskType: observations.taskType.choice as TaskType,
        skillCandidates: skillCandidates === null ||
            skillCandidates.choice === NONE
          ? []
          : rankedIds(
            skillCandidates,
            optionalSkillIds,
            MAX_OPTIONAL_SKILL_CANDIDATES,
          ),
        criticalGap: selectedObject(
          observations.criticalGap,
          input.criticalGapCandidates ?? [],
        ),
        reuseCandidate: selectedId(observations.reuseCandidate),
        architectureFork: selectedObject(
          observations.architectureFork,
          input.architectureForkCandidates ?? [],
        ),
        riskDimensions: observations.riskDimensions,
        contextRelevance: contextRelevance === null ||
            contextRelevance.choice === NONE
          ? []
          : rankedIds(contextRelevance, publicContextIds).map((id) => ({
            id,
            probability: contextRelevance.probabilities[id]!,
          })),
        metadata,
      };
    });
  }

  async pass2(input: PrecheckedInput, shortlist: readonly string[]): Promise<Pass2Result> {
    assertNoReservedChoiceValues(input);
    if (!Array.isArray(shortlist)) {
      throw new SemanticGatewayError("malformed-response");
    }
    if (shortlist.includes(NONE)) {
      throw new SemanticGatewayError("invalid-input");
    }
    if (
      shortlist.length === 0 ||
      shortlist.length > MAX_OPTIONAL_SKILL_CANDIDATES ||
      shortlist.some((id) => typeof id !== "string" || id.length === 0) ||
      new Set(shortlist).size !== shortlist.length
    ) {
      throw new SemanticGatewayError("malformed-response");
    }
    const catalogIds = new Set(input.skills.map(({ id }) => id));
    if (shortlist.some((id) => !catalogIds.has(id))) {
      throw new SemanticGatewayError("unknown-id");
    }

    const request = buildPass2Request(input, shortlist);
    const { answers, metadata } = await this.call(request);
    return mapWithMetadata(metadata, () => {
      const record = parsePass2Record(answers, input, shortlist);
      const evaluation = evaluatePass2(record, DEFAULT_PASS2_THRESHOLDS);
      if (evaluation.status === "low-confidence") {
        throw new SemanticGatewayError("low-confidence");
      }
      return {
        skillCandidates: evaluation.skillCandidates,
        metadata,
      };
    });
  }

  private async call(request: SystemOneRequest): Promise<ParsedTypeSafeEnvelope> {
    const started = performance.now();
    let response: unknown;
    try {
      response = await this.client.systemOne(request);
    } catch {
      throw new SemanticGatewayError("service-error");
    }
    return parseTypeSafeEnvelope(
      response,
      Object.keys(request.questions),
      performance.now() - started,
    );
  }
}

export function createTypeSafeGateway(): TypeSafeGateway {
  if (parsePass1Thresholds(process.env[PASS1_THRESHOLDS_ENV]) === null) {
    throw new SemanticGatewayError("uncalibrated-thresholds");
  }
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) {
    throw new SemanticGatewayError("service-error");
  }
  const client = new TypeSafeClient({
    apiKey,
    logLevel: "off",
    timeout: 10_000,
    retry: { maxRetries: 2 },
  });
  const port: SystemOneClientPort = {
    systemOne: (request) => client.systemOne({
      state: request.state as EntryType,
      questions: request.questions as Questions,
    }),
  };
  return new TypeSafeGateway(port);
}
