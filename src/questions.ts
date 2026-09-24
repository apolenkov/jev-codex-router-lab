import { choice, noul } from "@typesafe-ai/sdk";
import type { PrecheckedInput, TaskType } from "./contracts.js";
import type { SystemOneRequest } from "./semantic-gateway.js";

export const NONE = "none";

const TASK_TYPES: readonly TaskType[] = [
  "explain",
  "research",
  "plan",
  "diagnose",
  "change",
  "review",
  "operate",
];

const criteria = (ids: readonly string[]): Record<string, null> =>
  Object.fromEntries(ids.map((id) => [id, null]));

const candidateCriteria = (ids: readonly string[]): Record<string, null> =>
  criteria([...ids, NONE]);

const echoQuestion = (field: string, value: string) =>
  choice(`Return state.echo.${field}.`, candidateCriteria([value]));

export function buildPass1Request(input: PrecheckedInput): SystemOneRequest {
  const forced = new Set(input.forcedSkillIds);
  const skills = input.skills
    .filter((skill) => !forced.has(skill.id))
    .map(({ id, description }) => ({ id, description }));
  const criticalGaps = (input.criticalGapCandidates ?? []).map(({ id, fact, blocks }) => ({
    id,
    fact,
    blocks,
  }));
  const reuseCandidates = (input.reuseCandidates ?? []).map(({ id, summary }) => ({ id, summary }));
  const architectureForks = (input.architectureForkCandidates ?? []).map(
    ({ id, alternatives, tradeoff }) => ({ id, alternatives, tradeoff }),
  );
  const contextFragments = (input.contextFragments ?? [])
    .filter((fragment) => fragment.protected !== true)
    .map(({ id, summary }) => ({ id, summary }));

  const questions: Record<string, unknown> = {
    echo_task_id: echoQuestion("taskId", input.taskId),
    echo_task_revision: echoQuestion("taskRevision", String(input.taskRevision)),
    echo_policy_version: echoQuestion("policyVersion", input.policyVersion),
    echo_catalog_hash: echoQuestion("catalogHash", input.catalogHash),
    task_type: choice("Classify state.taskText.", criteria(TASK_TYPES)),
    risk_security: noul("Does state.taskText indicate security risk?"),
    risk_data_loss: noul("Does state.taskText indicate data-loss risk?"),
    risk_public_contract: noul("Does state.taskText indicate public-contract risk?"),
    risk_migration: noul("Does state.taskText indicate migration risk?"),
    risk_user_behavior: noul("Does state.taskText indicate user-visible behavior risk?"),
  };

  if (skills.length > 0) {
    questions.skill_candidates = choice(
      "Using state.taskText and state.skills, select the best skill ID or none. Probabilities rank the shortlist.",
      candidateCriteria(skills.map(({ id }) => id)),
    );
  }
  if (criticalGaps.length > 0) {
    questions.critical_gap = choice(
      "Using state.taskText and state.criticalGaps, select one critical-gap ID or none.",
      candidateCriteria(criticalGaps.map(({ id }) => id)),
    );
  }
  if (reuseCandidates.length > 0) {
    questions.reuse_candidate = choice(
      "Using state.taskText and state.reuseCandidates, select one reuse-candidate ID or none.",
      candidateCriteria(reuseCandidates.map(({ id }) => id)),
    );
  }
  if (architectureForks.length > 0) {
    questions.architecture_fork = choice(
      "Using state.taskText and state.architectureForks, select one architecture-fork ID or none.",
      candidateCriteria(architectureForks.map(({ id }) => id)),
    );
  }
  if (contextFragments.length > 0) {
    questions.context_relevance = choice(
      "Using state.taskText and state.contextFragments, select the most relevant context ID or none. Probabilities rank the context.",
      candidateCriteria(contextFragments.map(({ id }) => id)),
    );
  }

  return {
    state: {
      echo: {
        taskId: input.taskId,
        taskRevision: input.taskRevision,
        policyVersion: input.policyVersion,
        catalogHash: input.catalogHash,
      },
      taskText: input.taskText,
      forcedSkillIds: input.forcedSkillIds,
      skills,
      criticalGaps,
      reuseCandidates,
      architectureForks,
      contextFragments,
    },
    questions,
  };
}

export function buildPass2Request(
  input: PrecheckedInput,
  shortlist: readonly string[],
): SystemOneRequest {
  const skillById = new Map(input.skills.map((skill) => [skill.id, skill]));
  const skills = shortlist.map((id) => {
    const skill = skillById.get(id)!;
    return { id: skill.id, description: skill.description, excerpt: skill.excerpt };
  });
  const questions: Record<string, unknown> = {
    echo_task_id: echoQuestion("taskId", input.taskId),
    echo_task_revision: echoQuestion("taskRevision", String(input.taskRevision)),
    echo_policy_version: echoQuestion("policyVersion", input.policyVersion),
    echo_catalog_hash: echoQuestion("catalogHash", input.catalogHash),
    skill_ranking: choice(
      "Using state.taskText and state.skills, select the strongest skill ID or none. Probabilities rank all supplied skills.",
      candidateCriteria(shortlist),
    ),
  };

  shortlist.forEach((_, index) => {
    questions[`skill_fit_${index}`] = noul(
      `Is state.skills[${index}] independently relevant to state.taskText?`,
    );
  });

  return {
    state: {
      echo: {
        taskId: input.taskId,
        taskRevision: input.taskRevision,
        policyVersion: input.policyVersion,
        catalogHash: input.catalogHash,
      },
      taskText: input.taskText,
      skills,
    },
    questions,
  };
}
