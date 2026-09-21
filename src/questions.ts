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
  choice(`Return the supplied ${field} value.`, candidateCriteria([value]));

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
    echo_task_id: echoQuestion("task ID", input.taskId),
    echo_task_revision: echoQuestion("task revision", String(input.taskRevision)),
    echo_policy_version: echoQuestion("policy version", input.policyVersion),
    echo_catalog_hash: echoQuestion("catalogue hash", input.catalogHash),
    task_type: choice("Classify the bounded task state.", criteria(TASK_TYPES)),
    risk_security: noul("Does the bounded state indicate security risk?"),
    risk_data_loss: noul("Does the bounded state indicate data-loss risk?"),
    risk_public_contract: noul("Does the bounded state indicate public-contract risk?"),
    risk_migration: noul("Does the bounded state indicate migration risk?"),
    risk_user_behavior: noul("Does the bounded state indicate user-visible behavior risk?"),
  };

  if (skills.length > 0) {
    questions.skill_candidates = choice(
      "Select the best supplied optional skill ID, or none. Probabilities rank the shortlist.",
      candidateCriteria(skills.map(({ id }) => id)),
    );
  }
  if (criticalGaps.length > 0) {
    questions.critical_gap = choice(
      "Select one supplied critical-gap ID, or none.",
      candidateCriteria(criticalGaps.map(({ id }) => id)),
    );
  }
  if (reuseCandidates.length > 0) {
    questions.reuse_candidate = choice(
      "Select one supplied reuse-candidate ID, or none.",
      candidateCriteria(reuseCandidates.map(({ id }) => id)),
    );
  }
  if (architectureForks.length > 0) {
    questions.architecture_fork = choice(
      "Select one supplied architecture-fork ID, or none.",
      candidateCriteria(architectureForks.map(({ id }) => id)),
    );
  }
  if (contextFragments.length > 0) {
    questions.context_relevance = choice(
      "Select the most relevant supplied context ID, or none. Probabilities rank the context.",
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
    return { id: skill.id, description: skill.description };
  });
  const questions: Record<string, unknown> = {
    echo_task_id: echoQuestion("task ID", input.taskId),
    echo_task_revision: echoQuestion("task revision", String(input.taskRevision)),
    echo_policy_version: echoQuestion("policy version", input.policyVersion),
    echo_catalog_hash: echoQuestion("catalogue hash", input.catalogHash),
    skill_ranking: choice(
      "Select the strongest supplied skill ID, or none. Probabilities rank all supplied skills.",
      candidateCriteria(shortlist),
    ),
  };

  shortlist.forEach((id, index) => {
    questions[`skill_fit_${index}`] = noul(
      `Is supplied skill ID ${id} independently relevant to the bounded state?`,
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
      skills,
    },
    questions,
  };
}
