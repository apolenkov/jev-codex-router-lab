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
the supplied allowlisted catalogue.

#### Scenario: Mandatory skills survive in full

- **WHEN** input names two explicit skills and four required skills with one overlap
- **THEN** the resolved mandatory set contains all five unique identifiers in first-seen order

#### Scenario: Invalid input rejected before any semantic call

- **WHEN** input has an empty policy version or a non-positive task revision
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

### Requirement: Decision output is ok or fallback

The system SHALL return a typed decision that is either `ok` or `fallback`.
An `ok` decision MUST contain all seven advisory signals — task type, skill
candidates, critical gap, reuse candidate, architecture fork, risk
dimensions, and context relevance — plus the preserved mandatory skills. A
`fallback` decision MUST contain a machine-readable reason and the preserved
mandatory skills, and MUST NOT contain unverified optional recommendations.

#### Scenario: Valid response produces ok decision

- **WHEN** the semantic response passes all postcheck rules
- **THEN** the decision is `ok` and carries all seven typed signals

#### Scenario: Fallback preserves mandatory skills only

- **WHEN** any postcheck rule fails
- **THEN** the decision is `fallback`, carries a machine-readable reason, and preserves exactly the mandatory skill set

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
