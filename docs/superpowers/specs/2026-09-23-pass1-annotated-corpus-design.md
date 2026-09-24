# Pass-1 annotated corpus design

## Intent

Prepare a new public, synthetic evaluation corpus with labels that can support
case-bounded threshold experiments for the seven Jev pass-1 signals. The
existing eight cases have provisional labels and were exposed to Jev; they are
development evidence only. They will not appear in the new corpus or its
evaluation partition.

This work prepares examples and provenance only. It makes no provider calls,
does not select or install thresholds, does not enable routing, and does not
run the later full-router smoke. Any future provider experiment needs its own
approved specification and explicit spend/attempt limit.

## Corpus size and separation

1. Create a 14-case rubric pilot. Use it to find ambiguous instructions and
   annotation disagreements. Do not send it to Jev or count it in threshold
   selection or evaluation.
2. After the guide is frozen, create 84 new cases: 56 calibration cases and 28
   locked evaluation cases. This is a practical laboratory sample, not a
   statistically powered reliability claim.
3. Distribute all seven task types across both partitions. Include true,
   false, and genuinely ambiguous examples for architecture forks, plus
   plausible distractors. Cover empty, single, and multi-skill references,
   relevant and irrelevant context, and positive and negative examples for
   every risk dimension. Do not force an unrealistic full cross-product; record
   exact counts and mark unsupported comparisons as not evaluated.
4. Keep paraphrases, transformations, and counterfactual variants of one
   scenario family in the same partition. The selector may read only the 56
   calibration cases. The evaluation partition is read only after a candidate
   policy and its decision rule have been frozen. The same owner can inspect
   both; this process lock must not be described as cryptographic blindness.

## Annotation unit and record

Annotate exactly the state and candidate set that the relevant Jev question
will receive. Do not rely on omitted requirements, protected context, or an
author's hidden intent. Each field records:

- `status`: `resolved`, `ambiguous`, or `not_queried`;
- `value`: the adjudicated expected value/set for a resolved field, otherwise
  `null`;
- `evidence`: short source paths and verbatim spans from the task or candidate
  text that justify the label;
- two independent annotations, each with annotator ID, guide version, value,
  evidence, and rationale;
- an adjudication record with the final value and explanation when annotations
  disagree.

If a disagreement cannot be resolved from the visible input and this guide,
mark that field ambiguous. Do not turn unresolved disagreement into a negative
label. Model-assisted annotations must be identified as such; two model agents
are procedurally separate reviewers, not two independent human experts.

## Label rules

- **Task type:** classify the requested deliverable for the current stage.
  `diagnose` means find/explain a cause without correcting it; `change` means
  make or restore a behavior, even if diagnosis is part of the work. For
  genuinely co-primary deliverables, use `ambiguous` unless the task states
  which one is primary.
- **Optional skills:** record the set of skills that are independently
  justified by explicit work steps. Keep forced/mandatory skills in a separate
  field; Jev does not get credit for selecting them. Score the first candidate
  and shortlist coverage separately; do not compare a single pass-1 Choice
  answer as if it were the final ordered multi-skill result.
- **Critical gap:** select a missing fact only when its absence blocks the
  requested output at the current stage. Missing implementation details do not
  block research or planning unless the request makes them necessary now.
- **Reuse:** select a candidate only when the visible summary is demonstrably
  applicable to a named part of the task and does not conflict with stated
  constraints. Topic similarity alone is not reuse.
- **Architecture fork:** a positive label requires at least two currently
  viable structural alternatives, a material trade-off, and a decision that is
  still required to meet the requested outcome. A bug's possible fault
  locations, already-decided options, ordinary implementation choices, and
  downstream possibilities are negative examples. Mark ambiguous when the
  visible evidence cannot establish viability or materiality.
- **Risk dimensions:** labels indicate whether the task text itself provides
  evidence for security, data-loss, public-contract, migration, or
  user-visible-behavior risk. Do not label the probability of future harm.
  Record each as positive, negative, or ambiguous. Jev's Noul values are
  compared as scores against these categories; do not invent a separate Noul
  confidence value.
- **Context relevance:** judge each visible, unprotected fragment by whether
  it changes how to satisfy the stated task or acceptance criteria. Record all
  tied relevant fragments, irrelevant distractors, or no relevant candidate.
  Protected-fragment exclusion remains a deterministic security check, not a
  Jev accuracy label.

`null` means the question was asked and no supplied candidate is correct.
`not_queried` means the input had no candidate for that optional question.
`ambiguous` means the visible evidence supports multiple labels or does not
support a unique answer. These states are not interchangeable.

## Label provenance and freeze protocol

Case authors encode a clear intended fact pattern in public synthetic task
text and candidate descriptions. Two isolated annotators then label the
model-visible input without seeing Jev responses, each other's labels, or
threshold candidates. A separate adjudication pass compares both labels with
the cited evidence and this guide. Preserve both annotations, disagreements,
adjudication, author, versioned guide, and case-family membership.

Freeze the guide, case texts, candidate sets, labels, split, question-builder
hash, and model version before any later authorized request. Public source
material does not prove that an example is absent from model training; report
that limitation. Exclude a case from the evaluable denominator if its final
label remains ambiguous or the required signal was not queried, while still
reporting those counts explicitly.

Threshold selection is a separate future decision. Before any new provider
request, its proposal must pre-register per-signal error and minimum coverage
criteria, exact denominators, failure treatment, model/question fingerprints,
and spend/attempt caps. Select candidates using calibration cases only, freeze
them before evaluation, and do not retune against the evaluation split. No
threshold is justified merely because it rejects every case.

## Privacy and outputs

Use only authored synthetic tasks and public documentation excerpts. Do not
copy repository histories, private prompts, credentials, customer information,
or corporate content. Keep candidate and label files in the lab repository;
ensure no protected context enters a Jev request. The preparation task stores
no provider responses and makes no network request.

## Acceptance

- The 14-case pilot has complete author and annotation provenance and reports
  disagreement rates by field.
- The final 84-case corpus has 56 calibration and 28 locked evaluation cases,
  with no scenario-family leakage and no overlap with the previously exposed
  eight cases.
- Every resolved label has visible evidence and every unresolved field is
  represented explicitly as ambiguous or not queried.
- Dataset validation rejects duplicate IDs, missing rationale/provenance,
  illegal split membership, protected-context exposure, and family leakage.
- Tests, lint, typecheck, and strict OpenSpec pass; zero Jev HTTP calls are
  observed during corpus preparation.
