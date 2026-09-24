# Spec Delta

## Purpose

Defines a deterministic, offline development arena that scores three
skill-routing contestants — the existing Jev router, recorded Codex fixture
output, and a deterministic rules baseline — against one frozen 60-case
corpus for harness validation, tuning, and diagnosis only.

## ADDED Requirements

### Requirement: Frozen development corpus and skill manifest

The system SHALL load a frozen development corpus of exactly 60 sanitized
cases and a frozen skill manifest before any contestant run. Each case
MUST carry a unique case ID, a family ID shared by related cases, a
language of `ru` or `en`, a task-type stratum of `bug`, `function`,
`plan`, `research`, or `review`, a source classification of `synthetic`,
`hard-negative`, or `minimal-pair`, a risk
flag of `standard` or `high`, and a typed input containing bounded task
text plus explicit and required skill IDs. Each case's gold record MUST
list one or more accepted exact optional-skill routes (each a set of zero
to three manifest skill IDs), the gold-mandatory skill IDs that MUST be a
subset of the case's forced skills, and the forbidden skill IDs disjoint from
every accepted route and from the case's forced set. Zero-skill cases MUST
hold exactly one accepted route: the empty set.

Every case MUST be authored from public synthetic material only. Two
annotators MUST independently label every case from the same frozen manifest
and rubric, and a third annotator MUST adjudicate every disagreement before
the gold fingerprint is pinned. The frozen gold MUST record only stable
annotator roles, the rubric version, and the adjudicated result; it MUST NOT
contain names, timestamps, private text, or session-derived content.

The corpus MUST contain 30 `ru` and 30 `en` cases, exactly 12 cases per
task-type stratum, and optional-skill counts of 15 zero-skill, 22
one-skill, 15 two-skill, and 8 three-skill cases, where a case's skill
count is the size of its largest accepted route. Cases sharing a family ID
MUST share language and stratum, and family IDs are reserved to the
development split so a future holdout cannot reuse them.

The skill manifest MUST list every routable skill with an ID, a bounded
description, a bounded excerpt, and a frozen non-negative integer
`contextTokens` value. The system MUST pin the SHA-256 of the canonical
JSON of the manifest, the case corpus, and the gold labels, and MUST
refuse to run when any loaded artifact does not match its pinned
fingerprint.

#### Scenario: Corpus fingerprint is recorded before execution

- **WHEN** the arena loads its frozen fixtures
- **THEN** the run manifest records the SHA-256 fingerprint of the canonical
  skill manifest, case corpus, and gold labels before any contestant runs

#### Scenario: Corpus violates a stratum or count invariant

- **WHEN** the corpus holds other than 60 cases, an unbalanced stratum, or
  an accepted route with a forbidden or unknown skill
- **THEN** the arena fails validation and no contestant is invoked

#### Scenario: Gold lacks independent annotation provenance

- **WHEN** a gold record lacks two independent labels or an adjudicated result
- **THEN** the arena fails validation and no contestant is invoked

#### Scenario: Frozen input differs from its pinned fingerprint

- **WHEN** the manifest, corpus, gold, or recorded contestant-output file
  differs from its pinned fingerprint at load time
- **THEN** the command fails without producing a run

### Requirement: Uniform typed contestant contract

Every contestant MUST receive an identical typed input per case — case ID,
task text, the frozen skill manifest view, and the case's explicit and
required skill IDs — serialized the same way for all three contestants.
Gold labels, stratum metadata, risk flags, and other contestants' outputs
MUST NOT be present in the contestant input.

Every contestant MUST return a closed result per case: `ok` carrying the
selected skill route as a set of manifest skill IDs; `abstain` carrying a
machine-readable reason; or `error` carrying a machine-readable reason.
Each result MUST carry input tokens, output tokens, latency, and cost
fields that MUST be `null` when the value is not observable. A result
whose route contains duplicate IDs, IDs outside the manifest, or more than
three skills beyond the case's forced set MUST be converted to `error`.

#### Scenario: Contestants see identical input

- **WHEN** the same case is presented to all three contestants
- **THEN** each receives byte-identical input fields with no gold, stratum,
  or competitor data

#### Scenario: Contestant emits an invalid route

- **WHEN** a contestant output lists a skill ID absent from the manifest or
  four skills beyond the forced set
- **THEN** the recorded result for that case is `error`, not `ok`

#### Scenario: Unobservable telemetry is null

- **WHEN** a contestant result lacks observable usage, cost, or latency
- **THEN** each unobserved field is recorded as `null`

### Requirement: Jev contestant uses the existing router behind an opt-in gateway

The Jev contestant MUST reuse the existing safe router pipeline —
deterministic precheck, two semantic passes, confidence policy, and
postcheck — by mapping each case input to a router input with a fixed task
revision, a frozen arena policy version, the manifest fingerprint as the
catalogue hash, the case's explicit and required skill IDs, and no
critical-gap, fork, reuse, or context candidates. An `ok` router decision
produces an `ok` result whose route is the union of the forced skills and
the returned optional candidates; any `fallback` decision produces an
`abstain` result carrying the fallback reason.

The Jev adapter MUST receive its semantic gateway by explicit injection
and MUST NOT itself construct a provider client, read credentials or
provider environment variables, or open a network connection; without an
injected gateway it cannot run. Default tests and the development
scoreboard MUST run offline against a replay gateway that returns recorded
pass responses from a frozen fixture and rejects unexpected calls.

#### Scenario: Jev cannot run without an explicit gateway

- **WHEN** the Jev contestant is invoked without an injected semantic
  gateway
- **THEN** it fails before any routing attempt and makes no provider call

#### Scenario: Router fallback becomes abstention

- **WHEN** the recorded Jev responses lead the router to a `fallback`
  decision with reason `low-confidence`
- **THEN** the case result is `abstain` with that reason and the forced
  skills remain identified in the run record

#### Scenario: Recorded replay is deterministic

- **WHEN** the Jev contestant runs twice over the frozen corpus with the
  recorded-response gateway
- **THEN** both run records are byte-identical

### Requirement: Codex contestant replays recorded fixture output only

The Codex contestant MUST produce each case result solely by validating
and projecting a pre-recorded structured fixture output keyed by case ID.
It MUST NOT spawn a subprocess, invoke a working Codex session or hook,
open a network connection, or read anything beyond the frozen fixture. A
missing, malformed, or out-of-manifest record MUST produce an `error`
result. Recorded usage, cost, or latency fields pass through when present
and are `null` otherwise.

#### Scenario: Recorded output replays verbatim

- **WHEN** the frozen Codex fixture holds a valid record for the case
- **THEN** the contestant result is `ok` with exactly the recorded route

#### Scenario: Fixture record is missing or malformed

- **WHEN** no record exists for the case ID or the record fails closed
  validation
- **THEN** the result is `error` and no other output source is consulted

### Requirement: Rules contestant is deterministic

The rules contestant MUST derive its route from the case input alone using
a frozen, ordered trigger table and MUST always include the case's forced
skills in its effective route. Identical inputs MUST produce byte-identical
results. The rules contestant MUST NOT read gold labels, other
contestants' outputs, the filesystem beyond the frozen trigger table, or
any external service.

#### Scenario: Deterministic repeat

- **WHEN** the rules contestant runs twice over the same case
- **THEN** both results are identical including field order

#### Scenario: Trigger table is frozen

- **WHEN** the trigger table differs from its pinned fingerprint
- **THEN** the command fails before scoring

### Requirement: Deterministic scorer compares against all accepted routes

The scorer MUST mark a case correct only when the contestant result is
`ok` and the optional part of its effective route — the route minus the
case's forced skills — exactly equals one accepted gold route. `abstain`
and `error` results MUST be scored incorrect and MUST be treated as an
empty optional selection for false-positive/false-negative accounting.

For each `ok` result that is not an exact match, and for FP/FN accounting
on every result, the scorer MUST derive false positives and false
negatives against the closest accepted route: the accepted route
minimizing the total of false positives plus false negatives, then — on a
tie — the fewest false negatives, then the lexicographically smallest
serialization of the sorted skill IDs. The scorer MUST count a mandatory
miss when a gold-mandatory skill is absent from the effective route, a
high-risk mandatory miss when that happens on a `high`-risk case, and a
forbidden hit when the effective route contains a forbidden skill.

#### Scenario: Multiple accepted routes

- **WHEN** a case accepts both `[a]` and `[a, b]` and the contestant
  selects `[a, b]`
- **THEN** the case is scored correct with zero false positives and zero
  false negatives

#### Scenario: Closest-route tie-break is stable

- **WHEN** two accepted routes are equally close to a predicted selection
- **THEN** the scorer derives FP/FN from the route with fewer false
  negatives, then the lexicographically smaller serialization, and repeats
  identically on every run

#### Scenario: Mandatory miss on a high-risk case

- **WHEN** the effective route omits a gold-mandatory skill on a `high`-risk
  case
- **THEN** the scoreboard records both a mandatory miss and a high-risk
  mandatory miss for that contestant

#### Scenario: Forbidden skill selected

- **WHEN** an effective route contains a forbidden skill
- **THEN** the scoreboard records a forbidden hit and the case cannot be
  scored correct

### Requirement: Scoreboard reports per-case and aggregate metrics

The scoreboard MUST contain a per-case record for every contestant-case
pair (status, effective route, correctness, FP/FN against the chosen
closest route, mandatory misses, forbidden hits) and per-contestant
aggregates: valid-route accuracy over all 60 cases; `ok`, `abstain`, and
`error` counts; mandatory-miss and high-risk mandatory-miss counts;
forbidden-hit count; false-positive rate on zero-skill cases; micro
precision and recall over optional selections; autonomous coverage as the
share of cases answered `ok`; and total selected skill-context tokens over
effective routes using the manifest's frozen `contextTokens`. Latency,
usage, and cost aggregates MUST be computed only over non-`null`
observations with p50 and p95 by the nearest-rank method, and MUST be
`null` when a contestant records no observation. The scoreboard MUST also
report a Jev-with-Codex-fallback diagnostic that replaces each Jev
`abstain` with the Codex result's effective route when that result is `ok`
and recomputes accuracy and mandatory misses.

All metrics MUST be computed identically on every run, and a denominator
of zero MUST yield `null` rather than an exception or a fabricated value.

#### Scenario: Aggregate metrics over the frozen corpus

- **WHEN** all three contestants have run records for all 60 cases
- **THEN** the scoreboard reports every aggregate for each contestant in a
  fixed contestant order with cases sorted by case ID

#### Scenario: No observable telemetry

- **WHEN** a contestant records `null` usage, cost, and latency on every
  case
- **THEN** its aggregate usage, cost, and latency fields are `null`

#### Scenario: Jev abstains and Codex has a valid route

- **WHEN** the Jev result is `abstain` and the Codex fixture result is `ok`
- **THEN** the Jev-with-Codex-fallback diagnostic scores that case with the
  Codex effective route

### Requirement: One command regenerates byte-identical artifacts

A single package-script command MUST regenerate the development run from
the frozen fixtures: it loads and fingerprint-checks every frozen input,
runs the three contestants offline in a fixed order over the corpus order,
records each contestant's results under `artifacts/arena/<run-id>/runs/`,
then scores the recorded outputs — not live objects — into
`scoreboard.json`. The run directory MUST be
`artifacts/arena/dev-<prefix>` where `<prefix>` is the first 12 hex digits
of the combined frozen-input fingerprint, and MUST contain `manifest.json`
with every input fingerprint, `cases.json`, `gold.json`,
`runs/<contestant>.jsonl` in the fixed contestant order, and
`scoreboard.json`, all serialized as canonical JSON with no wall-clock or
random fields.

Re-running the command over unchanged inputs MUST produce byte-identical
files. If a target file already exists with different bytes, the command
MUST fail without overwriting it.

#### Scenario: Byte-identical regeneration

- **WHEN** the command runs twice over unchanged frozen inputs
- **THEN** every artifact file is byte-identical between runs

#### Scenario: Conflicting existing artifact

- **WHEN** a target run file exists with content differing from the
  regenerated bytes
- **THEN** the command fails without modifying that file

#### Scenario: Scoring consumes recorded outputs

- **WHEN** the scoreboard is produced
- **THEN** every scored value derives from the recorded `runs/` output and
  frozen gold, not from contestant internals

### Requirement: Development scope and safety boundary

The arena MUST mark every scoreboard as `development` scope and MUST NOT
emit a winner, verdict, or production claim of any kind. The change MUST
NOT add an LLM judge, debate, or voting mechanism; an arbitrary command
runner; a UI, server, or database; a plugin framework or reusable skill; a
working-Codex hook or subprocess; private or unsanitized data; a sealed
holdout; or any paid provider call, and MUST NOT add runtime dependencies.
Default tests and scoring MUST run fully offline.

#### Scenario: Scoreboard carries development scope only

- **WHEN** the scoreboard is written
- **THEN** it declares `development` scope and contains no field asserting a
  production winner

#### Scenario: No provider access by default

- **WHEN** tests and the regeneration command run without credentials or
  network
- **THEN** every contestant still completes from frozen inputs
