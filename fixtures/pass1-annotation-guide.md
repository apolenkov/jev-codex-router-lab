# Pass-1 annotation guide

- **Guide version:** `pass1-label-guide-v1`
- **Corpus schema:** `pass1-annotated-corpus-v1`
- **Status:** draft — becomes frozen only after the 14-case pilot adjudication
  (see "Pilot to freeze protocol"). After freeze, the SHA-256 of this file is
  recorded in `fixtures/pass1-corpus-manifest.json`.

This guide is the closed annotation contract for the synthetic pass-1 corpus.
It defines what annotators may look at, the exact JSON shape every record must
have, the label rules for the seven pass-1 signals, and the provenance,
disagreement, and freeze rules. Anything not described here is not allowed in
the corpus.

## 1. Scope and non-goals

- The corpus supports case-bounded threshold experiments for the seven Jev
  pass-1 signals. It is a practical laboratory sample, not a statistically
  powered reliability claim.
- Annotation makes no provider calls, selects no thresholds, and enables no
  routing. The previously exposed cases C1–C6 and H1–H2 are development
  evidence only and MUST NOT appear in this corpus.
- Only authored synthetic tasks and public documentation excerpts may be used.
  No repository histories, private prompts, credentials, customer data, or
  corporate content.

## 2. Model-visible contract

Annotators label exactly the state and candidate set that the pass-1 question
builder (`buildPass1Request` in `src/questions.ts`) sends. The pass-1 state
contains only:

| State field | Content | Visible to which questions |
| --- | --- | --- |
| `state.echo` | `taskId`, `taskRevision`, `policyVersion`, `catalogHash` | echo checks only; never label evidence |
| `state.taskText` | the task text | all seven signals |
| `state.forcedSkillIds` | deduped `explicitSkillIds ∪ requiredSkillIds` | context for `skill_candidates`; never a label value |
| `state.skills[]` | `{id, description}` — `excerpt` is stripped before the request | `skill_candidates` |
| `state.criticalGaps[]` | `{id, fact, blocks}` | `critical_gap` |
| `state.reuseCandidates[]` | `{id, summary}` | `reuse_candidate` |
| `state.architectureForks[]` | `{id, alternatives, tradeoff}` | `architecture_fork` |
| `state.contextFragments[]` | `{id, summary}`, public fragments only; `protected: true` fragments are removed before the request | `context_relevance` |

Questions are emitted only when candidates exist:

- Always queried: `task_type`, `risk_security`, `risk_data_loss`,
  `risk_public_contract`, `risk_migration`, `risk_user_behavior`.
- Queried only when non-empty: `skill_candidates` (needs at least one
  non-forced skill), `critical_gap`, `reuse_candidate`, `architecture_fork`,
  `context_relevance` (needs at least one public fragment).

Evidence MUST come only from the visible fields above. `skills[].excerpt`,
protected context fragments, echo fields, and any author knowledge outside
`input` are NOT model-visible and MUST NOT be cited.

## 3. Evidence paths

Each evidence entry is `{ "path": <string>, "span": <string> }`. `span` is an
exact substring of the text the path resolves to. The complete allowed set:

| Path form | Span rule |
| --- | --- |
| `state.taskText` | substring of `input.taskText` |
| `state.forcedSkillIds` | exactly one forced skill id |
| `state.skills[<id>].id` | the skill id verbatim |
| `state.skills[<id>].description` | substring of that skill's description |
| `state.criticalGaps[<id>].id` | the candidate id verbatim |
| `state.criticalGaps[<id>].fact` | substring of `fact` |
| `state.criticalGaps[<id>].blocks` | substring of `blocks` |
| `state.reuseCandidates[<id>].id` | the candidate id verbatim |
| `state.reuseCandidates[<id>].summary` | substring of `summary` |
| `state.architectureForks[<id>].id` | the candidate id verbatim |
| `state.architectureForks[<id>].alternatives` | substring of one alternative element |
| `state.architectureForks[<id>].tradeoff` | substring of `tradeoff` |
| `state.contextFragments[<id>].id` | the fragment id verbatim (public only) |
| `state.contextFragments[<id>].summary` | substring of `summary` (public only) |

A `resolved` label MUST cite at least one evidence entry — including resolved
negative (`null`) labels, which need evidence for the negative. `ambiguous`
labels SHOULD cite the competing spans. `not_queried` labels MUST have empty
evidence.

## 4. File and record shape

Each split file is a closed object — no extra keys anywhere:

```json
{
  "schemaVersion": "pass1-annotated-corpus-v1",
  "guideVersion": "pass1-label-guide-v1",
  "split": "pilot | calibration | evaluation",
  "cases": [ <case record> ]
}
```

Each case record has exactly these keys:

| Key | Shape |
| --- | --- |
| `caseId` | unique id; equals `input.taskId`; `P##` in pilot, `CAL-###` in calibration, `EVAL-###` in evaluation; never C1–C6 or H1–H2 |
| `familyId` | `fam-<slug>`; paraphrases, transformations, and counterfactual variants of one scenario share a family |
| `split` | equals the containing file's `split` |
| `author` | `{id, method, model}`; `method` is `human` or `model-assisted`; `model` is a non-empty string iff `model-assisted`, else `null` |
| `input` | a `RouterInput` that passes `precheck`; optional candidate arrays may be absent or empty |
| `forcedSkillIds` | deduped `explicitSkillIds ∪ requiredSkillIds`; recorded separately — see §6 |
| `annotations` | exactly two records `{annotatorId, method: "model-assisted", model, guideVersion, labels}`; distinct `annotatorId`s; each label also carries a non-empty `rationale` |
| `adjudication` | `{adjudicatorId, method, model, guideVersion, disagreements}`; `disagreements` may be empty |
| `labels` | the final adjudicated label set |

Disagreement entries have exactly
`{signal, annotatorA: {status, value}, annotatorB: {status, value}, outcome, explanation}`
where `outcome` is `adopt-a`, `adopt-b`, or `ambiguous`, and `explanation` is
a non-empty string grounded in the cited evidence and this guide.

### Label set

`labels` has exactly seven signal keys: `taskType`, `skillCandidates`,
`criticalGap`, `reuseCandidate`, `architectureFork`, `contextRelevance`, and
`riskDimensions` (itself a record over `security`, `data-loss`,
`public-contract`, `migration`, `user-behavior`).

Every signal label has `{status, value, evidence}` — annotator labels add
`rationale`. `status` is one of:

- `resolved` — a unique label follows from the visible input and this guide.
  `value` holds the adjudicated expected answer and `evidence` is non-empty.
- `ambiguous` — the visible evidence supports multiple labels or no unique
  answer. `value` is `null`. Ambiguous fields are reported separately and are
  excluded from evaluable denominators; they are never converted to negative
  labels.
- `not_queried` — the input had no candidate for that optional question, so
  the question was never asked. `value` is `null`, `evidence` is empty.

A queried `null` is NOT `not_queried`: when candidates were supplied and none
is correct, the label is `resolved` with `value: null` and evidence for the
negative.

Legal `value` per signal:

| Signal | `resolved` value |
| --- | --- |
| `taskType` | one of `explain`, `research`, `plan`, `diagnose`, `change`, `review`, `operate` |
| `skillCandidates` | non-empty unique subset of non-forced `state.skills` ids, or `null` when none fit |
| `criticalGap` | a `criticalGapCandidates` id, or `null` |
| `reuseCandidate` | a `reuseCandidates` id, or `null` |
| `architectureFork` | an `architectureForkCandidates` id, or `null` |
| `contextRelevance` | non-empty unique subset of public fragment ids (all tied relevant fragments), or `null` |
| `riskDimensions.<dim>` | `positive` or `negative` (`ambiguous` status covers unclear evidence) |

## 5. Label rules

- **Task type:** classify the requested deliverable for the current stage.
  `diagnose` means find/explain a cause without correcting it; `change` means
  make or restore a behavior even if diagnosis is part of the work. For
  genuinely co-primary deliverables use `ambiguous` unless the task states
  which one is primary.
- **Optional skills:** record the set of skills independently justified by
  explicit work steps in `state.taskText`. Topic overlap is not
  justification. The pass-1 answer is a first choice plus ranked shortlist;
  label the full justified set, not just the single best pick.
- **Critical gap:** select a candidate only when its absence blocks the
  requested output at the current stage. Missing implementation details do not
  block research or planning unless the request makes them necessary now.
- **Reuse:** select a candidate only when the visible `summary` is demonstrably
  applicable to a named part of the task and does not conflict with stated
  constraints. Topic similarity alone is not reuse.
- **Architecture fork:** a positive label requires (a) at least two currently
  viable structural alternatives, (b) a material trade-off, and (c) a decision
  that is still required to meet the requested outcome — all three visible in
  the task text and candidate content.
  - *Positive example:* "Design the event-log storage; choose between one
    append-only file and segmented files and justify the recovery trade-off,"
    with a candidate whose `alternatives` names both layouts and whose
    `tradeoff` names the recovery cost. All three conditions hold → resolved
    with that fork id.
  - *Negative examples:* (1) "Find why the parser drops tokens" with a
    candidate whose alternatives are possible fault locations — diagnosis
    hypotheses, not structural alternatives. (2) "We chose Postgres; write the
    migration" — the decision is already made. (3) "Rename `cacheSize` to
    `cacheLimit`" — an ordinary implementation choice. (4) "Fix the README
    typo; someday we may split the docs" — a downstream possibility, not a
    decision required now. All → resolved `null`.
  - *Ambiguous example:* "Consider whether the worker should eventually become
    a separate service," with no trade-off or viability evidence visible →
    `ambiguous`.
- **Risk dimensions:** labels state whether `state.taskText` itself provides
  evidence for security, data-loss, public-contract, migration, or
  user-visible-behavior risk. They do not estimate the probability of future
  harm. `positive`/`negative` require visible evidence; otherwise `ambiguous`.
  Jev's noul outputs are compared as scores against these categories; do not
  record a separate noul confidence value.
- **Context relevance:** judge each visible, unprotected fragment by whether
  it changes how to satisfy the stated task or acceptance criteria. Record all
  tied relevant fragments. Irrelevant distractors and a `resolved: null` (no
  relevant candidate) are both expected cases. Protected fragments are never
  candidates and never evidence — their exclusion is a deterministic security
  check, not a Jev accuracy label.

## 6. Forced vs optional skills

`explicitSkillIds` and `requiredSkillIds` are mandatory; they are recorded in
`forcedSkillIds` and removed from `state.skills` before the `skill_candidates`
question is built. They MUST NOT appear in the `skillCandidates` label — Jev
gets no credit for selecting them. When every catalog skill is forced (or the
catalog is empty), `skill_candidates` is not emitted and the label is
`not_queried`.

## 7. Provenance

- Every case records its `author` (human or model-assisted, with model id when
  applicable), `familyId`, and the `guideVersion` it was labeled under.
- Exactly two isolated annotators label each case. Both are model-assisted in
  this corpus; each annotation declares `annotatorId`, `method:
  "model-assisted"`, the producing `model`, and `guideVersion`. Two model
  agents are procedurally separate reviewers, not two independent human
  experts, and must never be described as human-gold labels.
- Annotators see only the case `input` and this guide: never Jev responses,
  never each other's labels, never threshold candidates.
- The adjudication pass records `adjudicatorId`, `method`, `model` (or `null`
  for a human), and `guideVersion`, and preserves every disagreement.

## 8. Disagreement and adjudication

1. After both annotations are complete, compare them per signal.
2. Every signal where the two annotations differ in `status` or `value` MUST
   have a `disagreements` entry quoting both sides verbatim.
3. `adopt-a` / `adopt-b` outcomes are allowed only when the cited evidence and
   this guide resolve the disagreement; the final label then equals the
   adopted side.
4. If the disagreement cannot be resolved from the visible input and this
   guide, the outcome is `ambiguous` and the final label is `ambiguous` —
   never a silent negative.
5. When the annotators agree, there is no disagreement entry and the final
   label equals the agreed annotation.

## 9. Families, splits, and ids

- `caseId`: `P##` (pilot), `CAL-###` (calibration), `EVAL-###` (evaluation);
  unique across all files; C1–C6 and H1–H2 are excluded forever.
- `familyId`: `fam-<slug>`; every paraphrase, transformation, or
  counterfactual variant of one scenario shares it, and all members of a
  family MUST sit in the same partition.
- Counts: pilot exactly 14, calibration exactly 56, evaluation exactly 28.
- The evaluation partition is locked: its labels are never read for policy or
  threshold selection.

## 10. Pilot to freeze protocol

1. Tag this draft as `pass1-label-guide-v1` and record the 14-family pilot
   allocation across all seven task types and the required edge cases before
   drafting.
2. Author pilot inputs with author provenance only; annotator packets contain
   no expected labels.
3. Two isolated model-assisted annotators label the pilot inputs with this
   draft guide.
4. Report per-signal agreement as exact numerator/denominator. Revise a rule
   only when the visible evidence shows the guide caused the disagreement;
   otherwise retain the ambiguity.
5. Adjudicate the pilot, preserve both annotations, then freeze this guide and
   record its SHA-256.
6. Freeze a family-allocation matrix for 56 calibration + 28 evaluation cases
   before writing; assign the partitions to separate bounded authoring
   packets.
7. Annotate the frozen 84 inputs with the frozen guide; adjudicate; leave
   unresolved fields `ambiguous` and report them outside evaluable
   denominators.
8. Compute SHA-256 for this guide, the three split files, and
   `src/questions.ts`; record them with split and status counts in
   `fixtures/pass1-corpus-manifest.json`.
9. Report disagreement rates, ambiguous/not-queried counts, and the
   public-origin limitation (public material does not prove absence from
   model training). No threshold is selected in this task.
