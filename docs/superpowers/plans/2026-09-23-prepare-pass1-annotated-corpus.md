# Prepare Pass-1 Annotated Corpus Implementation Plan

> **Implementation route:** execute only after owner approval of this plan. Use `superpowers:subagent-driven-development`; run `superpowers:verification-before-completion` before completion.

**Goal:** Prepare a traceable 14-case rubric pilot and new synthetic 56-case calibration / 28-case evaluation corpus for the seven pass-1 signals, without Jev calls or threshold decisions.

**Approach:** Keep this data-only. Use one versioned annotation guide, three split-specific JSON files, a hash manifest, and one test file with a small test-only validator. Each case carries its visible input, family and author provenance, two isolated model-assisted annotations, exact evidence spans, and adjudication. Do not add production code, dependencies, or package scripts.

**Approved design:** `docs/superpowers/specs/2026-09-23-pass1-annotated-corpus-design.md` and `openspec/changes/prepare-pass1-annotated-corpus/`.

## Constraints

- Synthetic/public material only; no personal, corporate, customer, credential, or repository-history content.
- No Jev/TypeSafe requests, threshold choice/install, or full-router smoke.
- Authoring and dual annotation use the already-authorized Devin model sessions; these are not Jev evaluation requests.
- Exclude exposed C1-C6/H1-H2 IDs. Keep every scenario family in one split.
- Preserve `resolved: null`, `ambiguous`, and `not_queried` as distinct states.
- Mark annotations model-assisted; do not claim human-gold or statistical reliability.
- Keep evaluation separate and do not use its labels to tune policy.
- Preserve all existing dirty files. Own only the new files listed below and the named OpenSpec task file.

## Review focus

- Split/family leakage, duplicate or exposed IDs.
- Missing provenance, wrong guide versions, or fabricated evidence spans.
- Confusion among null, ambiguous, and not-queried labels.
- Protected context or private data in any input, annotation, export, or manifest.
- Undeclared model-assisted annotation, unsupported reliability claims, or evaluation leakage.

## File map

- Create `fixtures/pass1-annotation-guide.md`: label rules, closed record shape, evidence paths, guide version, pilot/adjudication process.
- Create `fixtures/pass1-rubric-pilot.json`: 14 synthetic pilot cases and provenance.
- Create `fixtures/pass1-calibration-cases.json`: 56 new cases and final annotations.
- Create `fixtures/pass1-evaluation-cases.json`: 28 disjoint cases and final annotations.
- Create `fixtures/pass1-corpus-manifest.json`: split counts, coverage counts, guide and fixture SHA-256 values, and the question-builder fingerprint.
- Create `test/pass1-annotated-corpus.test.ts`: test-local structural and cross-file assertions; no production validator.
- Modify only `openspec/changes/prepare-pass1-annotated-corpus/tasks.md` and TASK-054.04 through the Backlog CLI.

## Work plan

### 1. Define the guide contract and fail-closed corpus checks

1. Recheck the current `RouterInput` and pass-1 question builder; list exactly which visible input fields support each of the seven labels.
2. Write the closed JSON shape and `pass1-label-guide-v1` in the guide. Include author ID, family ID, two annotator IDs/methods/model versions, guide version, rationale, evidence spans, adjudicator, disagreements, and final labels.
3. Define evidence paths against task text or a named candidate field; require each quoted span to be an exact substring of the cited visible input.
4. Add test-local assertions for legal signal values/states, required provenance, duplicate IDs, evidence validity, and the null/ambiguous/not-queried distinctions.
5. Run the focused test once; the expected initial failure is the not-yet-created split fixtures, not a missing production export.

### 2. Run and adjudicate the 14-case rubric pilot

1. Allocate 14 unique synthetic families across all seven task types and the required label edge cases; record the allocation before drafting.
2. Create only the pilot inputs and author provenance; do not embed hidden expected labels in annotator packets.
3. Prepare two input-only annotation packets with the same draft guide. Keep each annotator’s output separate and do not expose Jev results, prior labels, or the other annotation.
4. Compare agreement by signal using exact numerator/denominator. Revise a rule only when the visible evidence shows the guide caused the disagreement; otherwise retain ambiguity.
5. Adjudicate disagreements from the guide and visible text, preserve both original annotations, and freeze the final guide version and SHA-256.
6. Run focused pilot assertions and confirm exactly 14 cases with no C1-C6/H1-H2 overlap.

### 3. Author disjoint calibration and evaluation inputs

1. Prepare and review a family-allocation matrix before case writing: 56 calibration and 28 evaluation cases, all seven task types in both, true/false/ambiguous architecture-fork examples, and the required candidate/risk/context coverage.
2. Assign calibration and evaluation to separate bounded authoring packets and separate output files; no family or paraphrase may cross partitions.
3. Ensure expected decisions are supported by task-visible wording, not hidden author intent. Include plausible distractors without forcing unsupported cross-products.
4. Run the corpus checks for exact counts, unique IDs, family isolation, task-type coverage, fork coverage, candidate presence/absence, and protected-context exclusion.

### 4. Independently annotate and adjudicate the final 84 cases

1. Prepare two isolated packets from the frozen guide and visible 84 case inputs only. Each annotator owns a distinct output artifact; neither sees the other’s output or any Jev response.
2. Record exact guide/model/annotator versions and rationales. Annotate every queried signal; use `not_queried` only when that candidate family is absent.
3. Merge annotations only after both outputs are complete. Preserve both records and adjudicate each disagreement from the visible evidence.
4. Leave unresolved cases explicitly ambiguous and report them in the evaluable denominator; never convert them to negative labels.
5. Do not inspect evaluation labels for policy selection; this task performs no policy selection.

### 5. Freeze, validate, review, and record

1. Extend the test file to load all partitions and manifest, verify every annotation/adjudication evidence span, privacy rule, exact count, coverage count, and no prior-case/family overlap.
2. Add an in-memory mutation check proving duplicate IDs, family leakage, missing annotators, altered guide versions, unsupported evidence, and protected fragments are rejected.
3. Compute SHA-256 for the guide, three split files, and current question builder; record them with exact coverage and status counts in the manifest.
4. Run `npm run check`, `openspec validate prepare-pass1-annotated-corpus --strict --no-interactive`, and `git diff --check`. Confirm there were no Jev requests and no unrelated files were staged or lost.
5. Obtain exactly one read-only AstraReviewer review on the final tested candidate. Fix important findings, then rerun affected checks and `npm run check`.
6. Update OpenSpec checkboxes and TASK-054.04 with evidence, dataset limitations, hashes, and next steps. Do not mark later threshold calibration complete.

## Delegation, isolation, and watchdog

- Before any Devin delegation, run `devin doctor` and a bounded noninteractive auth check as required by the orchestration skill. Use one task per invocation, `--prompt-file`, `--permission-mode dangerous`, and disjoint output paths. Never pass credentials or unrelated session context.
- The current user-scope `devin mcp list` includes `jev`. A prompt saying “do not call Jev” is not technical isolation. Before delegating, verify that a task-local invocation can disable Jev and cannot read a TypeSafe key. If this cannot be demonstrated, stop before any delegated generation/annotation and request the owner’s route decision; do not silently switch executors.
- SolAdvisor’s read-only review confirms that strict isolation needs a separate environment with no accessible key and blocked Jev/TypeSafe network access; neither a prompt ban nor `--config` alone proves this. The current available CLI evidence does not demonstrate that boundary.
- `devin --help` advertises no built-in runtime limit. `gtimeout` is installed. Bound every invocation with a 30-minute wall-clock cap and a 15-second kill grace; inspect process, fresh output/export, and owned-file progress at least every 10 minutes. If there is no observable progress for 10 minutes, or the cap expires, stop that exact run, preserve its export/diff, diagnose, then resume/restart only from the saved packet/report.
- No delegated packet gets Jev credentials, access to customer/corporate data, or permission to make provider-evaluation requests.

## Plan self-review

- Removed the unnecessary production validator and package changes; checks stay in one test file.
- Replaced undefined test helpers with behavior-level test requirements.
- Made file ownership, data boundaries, splits, hashes, and no-provider scope explicit.
- No implementation, Devin task, or Jev request was run in this planning step. Read-only AstraAdvisor and, under the replacement instructions, SolAdvisor were consulted on separate evidence-design and execution-isolation risks. The remaining route decision belongs to the owner.
