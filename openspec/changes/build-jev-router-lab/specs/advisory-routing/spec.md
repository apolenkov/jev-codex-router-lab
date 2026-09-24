# Spec Delta

## Purpose

Provides an advisory routing decision for a synthetic or public task: seven
typed semantic signals proposed by an untrusted model, gated by deterministic
precheck/postcheck policy that owns allowlists, mandatory skills, and fallback.

## ADDED Requirements

### Requirement: Deterministic precheck resolves mandatory skills

The system SHALL resolve explicitly named skills and policy-required skills
before any semantic call. The resolved mandatory set MUST preserve every
explicit and required skill identifier without a cap and MUST deduplicate the
union while preserving first-seen order. The system MUST reject input whose
task identifier, task text, policy version, or catalogue hash is empty, whose
task revision is not a positive integer, or whose skill references are not in
the supplied allowlisted catalogue. The system MUST reject task text longer
than 8,000 UTF-16 code units and any other Jev-facing free-text field longer
than 4,000 UTF-16 code units before any semantic call.

#### Scenario: Mandatory skills survive in full

- **WHEN** input names two explicit skills and four required skills with one overlap
- **THEN** the resolved mandatory set contains all five unique identifiers in first-seen order

#### Scenario: Invalid input rejected before any semantic call

- **WHEN** input has an empty policy version or a non-positive task revision
- **THEN** the input is rejected as `invalid-input` and no semantic call is made

#### Scenario: Oversized semantic text rejected before any semantic call

- **WHEN** task text or a skill excerpt exceeds its fixed character bound
- **THEN** the input is rejected as `invalid-input` and no semantic call is made

### Requirement: Jev-facing identifiers are allowlisted

The system SHALL supply the semantic layer with stable allowlisted identifiers
only: catalogue skill IDs, critical-gap candidate IDs, architecture-fork
candidate IDs, reuse candidate IDs, and context fragment IDs. A semantic
response that references any identifier outside the supplied allowlists MUST
produce a `fallback` decision with reason `unknown-id`.

#### Scenario: Unknown skill identifier falls back

- **WHEN** the semantic response lists a skill candidate absent from the supplied catalogue
- **THEN** the decision is `fallback` with reason `unknown-id` and only mandatory skills are preserved

#### Scenario: Unknown fragment identifier falls back

- **WHEN** the semantic response ranks a context fragment ID not supplied as a candidate
- **THEN** the decision is `fallback` with reason `unknown-id`

### Requirement: Optional skill recommendations are capped

The system SHALL accept at most three optional skill recommendations from the
semantic layer. Optional means not already mandatory. A response proposing
more than three optional skills MUST produce a `fallback` decision.
Mandatory skills MUST NOT count toward the cap and MUST NOT be truncated.

#### Scenario: Three optional skills accepted

- **WHEN** the semantic response proposes exactly three skills beyond the mandatory set
- **THEN** the decision accepts all three as advisory candidates

#### Scenario: Fourth optional skill rejected

- **WHEN** the semantic response proposes four skills beyond the mandatory set
- **THEN** the decision is `fallback`

### Requirement: Malformed semantic responses are rejected

The system SHALL validate the semantic response shape: duplicate candidate
identifiers, probabilities outside `[0, 1]`, missing or non-numeric risk
dimensions, and an unrecognized task type each MUST produce a `fallback`
decision with reason `malformed-response`.

#### Scenario: Out-of-range probability rejected

- **WHEN** a context relevance probability is greater than 1 or not a finite number
- **THEN** the decision is `fallback` with reason `malformed-response`

#### Scenario: Duplicate skill candidate rejected

- **WHEN** the same skill identifier appears twice in the semantic response
- **THEN** the decision is `fallback` with reason `malformed-response`

### Requirement: Stale semantic responses are rejected

The system SHALL require the semantic response to echo the request's task ID,
task revision, policy version, and catalogue hash. Any mismatch MUST produce a
`fallback` decision with reason `stale-decision`.

#### Scenario: Stale catalogue hash rejected

- **WHEN** the echoed catalogue hash differs from the request's catalogue hash
- **THEN** the decision is `fallback` with reason `stale-decision`

### Requirement: Pass-1 confidence is checked atomically

The system SHALL evaluate every queried non-echo semantic answer in pass 1
against a pass-1 threshold policy that is independent of pass 2. A Choice
answer below the configured Choice confidence floor, or a Noul probability
inside the configured inclusive uncertainty interval, MUST reject the entire
pass-1 result with reason `low-confidence`; no pass-1 signal may be accepted
independently of the others. A confident Noul probability near zero is a
confident "no" and MUST NOT be rejected merely for being low. Optional
questions omitted because their candidate lists are empty MUST NOT be treated
as missing or uncertain answers. Echo fields are validated for freshness and
shape, not semantic confidence.

Pass-1 thresholds MUST be configured separately from pass 2 through the exact
`JEV_PASS1_THRESHOLDS_JSON` object with numeric fields `choiceConfidenceMin`,
`noulUncertaintyLower`, and `noulUncertaintyUpper`, each in `[0,1]` and with
the Noul interval strictly containing `0.5`. The code validates the schema and
ranges, but does not claim to verify calibration provenance. If configuration
is missing or invalid, the gateway MUST fail closed with reason
`uncalibrated-thresholds` before reading credentials or making a provider
request. Pass-1 threshold values MUST NOT be copied from the pass-2 policy and
MUST be selected from separate calibration evidence before live routing is
enabled.

#### Scenario: One uncertain Choice answer rejects the whole pass

- **WHEN** any queried pass-1 Choice answer is below the pass-1 confidence floor
- **THEN** the route is `fallback` with reason `low-confidence`, preserves mandatory skills, and does not call pass 2

#### Scenario: One uncertain Noul answer rejects the whole pass

- **WHEN** any queried pass-1 Noul probability is on or between the configured uncertainty boundaries
- **THEN** the route is `fallback` with reason `low-confidence`, preserves mandatory skills, and accepts none of the other pass-1 signals

#### Scenario: Confident negative Noul answer is accepted

- **WHEN** a queried pass-1 Noul probability is below the uncertainty interval
- **THEN** the confidence gate accepts that answer as a confident "no"

#### Scenario: Missing threshold policy fails before network access

- **WHEN** no valid pass-1 threshold policy is configured
- **THEN** the route is `fallback` with reason `uncalibrated-thresholds`, preserves mandatory skills, and makes no semantic call

#### Scenario: Omitted optional question is not uncertain

- **WHEN** an optional candidate list is empty and its pass-1 question is omitted
- **THEN** the absent answer does not cause a confidence fallback

### Requirement: Decision output is ok or fallback

The system SHALL return a typed decision that is either `ok` or `fallback`.
An `ok` decision MUST contain all seven advisory signals — task type, skill
candidates, critical gap, reuse candidate, architecture fork, risk
dimensions, and context relevance — plus the preserved mandatory skills and
protected-context IDs. A `fallback` decision MUST contain a machine-readable
reason, the preserved mandatory skills, and the protected-context IDs, and
MUST NOT contain unverified optional recommendations.

#### Scenario: Valid response produces ok decision

- **WHEN** the semantic response passes all postcheck rules
- **THEN** the decision is `ok` and carries all seven typed signals

#### Scenario: Fallback preserves deterministic requirements

- **WHEN** any postcheck rule fails
- **THEN** the decision is `fallback`, carries a machine-readable reason, and preserves the mandatory skill set plus deterministic protected-context IDs

### Requirement: Protected context remains deterministic

The system SHALL derive protected-context IDs before the semantic call and
preserve them in every `ok` and `fallback` decision. Protected-context IDs
and bodies MUST NOT be sent to Jev or accepted from a semantic response as
context-relevance candidates.

#### Scenario: Protected context survives a semantic failure

- **WHEN** input contains a protected context fragment and the semantic call fails
- **THEN** the fallback decision contains its ID, while no protected ID or body was sent to Jev

### Requirement: Optional signals are absent without candidates

The system SHALL activate `critical_gap`, `reuse_candidate`,
`architecture_fork`, and `context_relevance` only when deterministic code
supplies candidate identifiers for them. When no candidates are supplied,
those signals MUST be explicitly empty (`null` or empty list) and MUST NOT
trigger repository search or data collection by the semantic layer.

#### Scenario: No candidates supplied

- **WHEN** the input supplies no critical-gap, fork, reuse, or context candidates
- **THEN** the `ok` decision carries `null` critical gap, reuse candidate, and architecture fork, and an empty context relevance list

### Requirement: Semantic layer is advisory only

The semantic layer MUST NOT choose harnesses or models, grant permissions,
produce commands or paths, execute recommendations, approve completion, waive
tests or review, or inspect private or corporate data. Confidence never
creates authority: every accepted signal remains a proposal under
deterministic policy.

#### Scenario: High-confidence output still passes through postcheck

- **WHEN** the semantic response reports maximum probabilities on every signal
- **THEN** the decision still applies every postcheck rule and the result remains advisory
