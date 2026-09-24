# pass1-threshold-selection delta

## ADDED Requirements

### Requirement: Calibration collection is bounded and sequential

The calibration runner MUST issue one pass-1 `systemOne` request per
calibration case per collection attempt, in declared corpus order, strictly
sequentially, with an injected fetch implementation, `maxRetries: 0`, and a
per-call timeout. The runner MUST count every actual HTTP attempt, including
failed and retried ones, and record the counted number in the evidence
manifest.

#### Scenario: Collection respects the attempt cap

- **WHEN** the calibration collection runs
- **THEN** counted actual attempts never exceed the declared ceiling (fresh
  run: corpus size; resumed run: the cumulative ceiling) and the run aborts
  on the first transport or terminal HTTP failure

### Requirement: Evidence directory is create-once

The runner MUST create a fresh evidence directory per run, refuse to write
into a pre-existing or modified directory, and preserve partial evidence
marked incomplete on abort. An incomplete run MAY be resumed in place any
number of times under the resume rule: `collected` and `invalid-response`
records are immutable, a `failed` record may be retried once per resume, and
the manifest MUST record the carried-over accounting and the resume count.

#### Scenario: Stale evidence is not overwritten

- **WHEN** the target evidence directory already exists
- **THEN** the runner refuses to run and exits non-zero

#### Scenario: A transport-aborted run resumes in place

- **WHEN** an incomplete run is resumed with `--resume`
- **THEN** collected and invalid-response records are never re-attempted,
  a failed case may be retried and its record replaced, manifest and
  summary are atomically rewritten, cumulative accounting continues from
  the checkpoint, cumulative attempts stay within the declared
  hard ceiling (80 calibration / 40 evaluation), and sequential calls
  are spaced by the declared inter-call delay

### Requirement: Threshold selection is offline and pre-registered

The selector MUST be a pure function over collected responses, frozen corpus
labels, and the declared candidate grid; it MUST NOT make provider calls,
MUST read calibration cases only, and MUST apply the pre-registered
eligible-set, tie-break, and denominator rules without post-hoc adjustment.

#### Scenario: Selector reads only calibration evidence

- **WHEN** the selector computes the candidate table
- **THEN** evaluation-split responses and labels are not accessed

#### Scenario: Ambiguous and unqueried labels are excluded

- **WHEN** a gold label status is `ambiguous` or `not_queried`
- **THEN** that field is excluded from error and coverage denominators and
  reported separately

### Requirement: Evaluation is single-shot on a frozen tuple

The evaluator MUST refuse to run without the frozen selection artifact,
MUST verify that the artifact's selected tuple and evidence hash derive from
the retained calibration evidence, MUST apply the selected tuple to the
evaluation corpus exactly once, and MUST NOT accept tuple changes from
evaluation evidence.

#### Scenario: No retuning from holdout

- **WHEN** evaluation evidence is produced
- **THEN** the reported tuple is byte-identical to the frozen selection and
  no second evaluation pass exists

#### Scenario: Artifact must derive from evidence

- **WHEN** the selection artifact's tuple or evidence hash does not match a
  fresh recomputation over the retained calibration evidence
- **THEN** the evaluator refuses to run and exits non-zero without any
  provider call

### Requirement: Runs are isolated lab operations

The runner, selector, and evaluator MUST NOT modify gateway runtime
behavior, MUST NOT install a threshold policy, and MUST keep mandatory
skills, protected context, and deterministic policy outside calibration.

#### Scenario: Runtime stays fail-closed

- **WHEN** no `JEV_PASS1_THRESHOLDS_JSON` policy is configured
- **THEN** the gateway still fails closed and the runner does not bypass it
