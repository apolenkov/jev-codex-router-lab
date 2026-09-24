# Spec Delta

## Purpose

Defines a bounded, reproducible experiment for selecting Jev pass-2 confidence
thresholds from frozen synthetic cases and evaluating them once on holdout data.

## ADDED Requirements

### Requirement: Corpus and labels are immutable before execution
The system SHALL load exactly six calibration cases and two holdout cases whose complete inputs, candidate ordering, expected optional skills, expected categorical and identifier signals, and inclusive numerical risk ranges are frozen before the first provider request.

#### Scenario: Corpus fingerprint is recorded
- **WHEN** experiment preflight succeeds
- **THEN** the report contains a deterministic fingerprint covering every frozen input and label

#### Scenario: Corpus changes after execution starts
- **WHEN** any frozen case or label differs from the preflight fingerprint
- **THEN** execution stops without dispatching another provider request

### Requirement: Provider attempts and spend are hard-capped
The system MUST pin model `jev-1.13.0`, input price USD 0.042/M tokens, and
output price USD 0/M tokens for the experiment and MUST reject aliases or
runtime overrides. It MUST disable SDK retries and automatic redirects, count every actual
provider request attempt at the SDK transport hook before dispatch, refuse
request 19, and reserve USD 0.002688 before each dispatch so aggregate reserved
plus validated spend cannot exceed the owner-approved USD 0.05 hard cap.
Unknown usage or cost MUST stop the experiment.

#### Scenario: Request cap would be exceeded
- **WHEN** the next dispatch would be the nineteenth provider request
- **THEN** the experiment stops before the request

#### Scenario: Accounting becomes unknown
- **WHEN** a completed request lacks valid usage or calculable configured cost
- **THEN** the experiment stops and does not retry

#### Scenario: Worst-case reservation would exceed spend cap
- **WHEN** validated spend plus the next USD 0.002688 reservation would exceed USD 0.05
- **THEN** the experiment stops before dispatch

### Requirement: Calibration preserves raw decision evidence
The system SHALL persist only validated closed-schema choice probabilities, relative confidence, Noul values, model, usage, latency, cost, typed decisions, forced skills, and protected-context IDs needed to replay the declared threshold grid. It MUST NOT persist credentials, raw exceptions, protected bodies, or unbounded prompt bodies.

The normal adapter and experiment SHALL share one closed pass-2 parser that
fully validates ranking and every fit before threshold evaluation. The
experiment SHALL persist the validated record before applying any tuple.

#### Scenario: Evidence is replayed offline
- **WHEN** calibration responses are complete
- **THEN** all 15 declared threshold tuples can be evaluated without another provider request

#### Scenario: Ranking is below the current threshold
- **WHEN** ranking confidence is low but ranking and every fit value are valid
- **THEN** the complete validated record remains available for offline replay

### Requirement: Threshold selection is deterministic
The system SHALL evaluate ranking minimums 0.40, 0.45, 0.50, 0.55, and 0.60 crossed with Noul bands 0.35–0.65, 0.40–0.60, and 0.45–0.55. A qualifying tuple MUST exactly match every calibration optional-skill label, have no false positive, retain the provider shortlist, and preserve deterministic invariants. Ties MUST resolve by highest ranking minimum, then highest upper boundary, then lowest lower boundary.

#### Scenario: No tuple qualifies
- **WHEN** every tuple misses any calibration label or invariant
- **THEN** calibration fails without changing router thresholds or running holdout cases

#### Scenario: Multiple tuples qualify
- **WHEN** more than one tuple satisfies every calibration case
- **THEN** the predefined strictness order selects exactly one tuple

### Requirement: Holdout is evaluated once without adaptation
The system SHALL select and persist the tuple and calibration result before the
first holdout request. The selector MUST receive only calibration cases. It
SHALL apply the selected tuple once to both untouched holdout cases without
retry, relabeling, forced shortlist, threshold adjustment, or case substitution.

#### Scenario: Holdout passes
- **WHEN** both holdout cases return ok after exactly two calls each, match every frozen label and risk range, preserve deterministic IDs, pass privacy checks, and remain within caps
- **THEN** the experiment reports holdout PASS with calibration denominator six and holdout denominator two

#### Scenario: Holdout fails
- **WHEN** either holdout case violates any holdout criterion
- **THEN** the experiment reports holdout FAIL and makes no further holdout request

#### Scenario: Holdout evidence changes
- **WHEN** holdout labels or recorded results are varied in a local test
- **THEN** the persisted calibration tuple remains unchanged

### Requirement: Original smoke is reserved for successful holdout
The system MUST reserve the final two requests for one execution of the original
frozen two-pass smoke through the experimental runner with the selected tuple,
without changing default router constants, and SHALL run it only after both
holdout cases PASS.

#### Scenario: Holdout passes within budget
- **WHEN** holdout passes and two requests plus sufficient spend remain
- **THEN** the original frozen smoke runs once with the selected tuple

#### Scenario: Holdout does not pass
- **WHEN** holdout fails or ends without a selected tuple
- **THEN** the original smoke is not rerun
