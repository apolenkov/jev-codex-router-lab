# Spec Delta

## Purpose

Defines a bounded, local-only, pass-1 evidence collection that does not enable
or accept routing decisions.

## ADDED Requirements

### Requirement: Pass-1 evidence collection is isolated from routing

The collector MUST use the frozen synthetic corpus and the pass-1 request only.
It MUST NOT invoke the production route, produce an accepted route decision,
call pass 2, run the prior calibration/holdout/smoke phases, or modify runtime
threshold configuration.

#### Scenario: Collection receives a pass-1 response

- **WHEN** a case is dispatched
- **THEN** exactly one pass-1 request is sent for that case and only validated typed observations are returned

#### Scenario: A route would otherwise reject low confidence

- **WHEN** the structural response is valid but would fall inside the current uncalibrated region
- **THEN** the collector records its typed confidence values without accepting a route or weakening the production gate

### Requirement: The frozen sample and interpretation are recorded before dispatch

Preflight MUST record the corpus fingerprint, question-builder fingerprint,
SDK/model versions, fixed case order, label status, and limits on claims before
the first provider attempt. C1-C6 MUST be described as provisional expert
judgments; H1-H2 MUST be described as exposed secondary cases, not hidden or
untouched holdout data.

#### Scenario: Preflight succeeds

- **WHEN** a new collection is ready to dispatch
- **THEN** its create-exclusive local manifest records `C1` through `C6`, then `H1`, `H2`, with the stated label and claim limitations

### Requirement: Provider requests are pinned and hard-capped

The collector MUST pin model `jev-1.13.0`, disable SDK retries, disable
automatic redirects, and count each actual HTTP dispatch before sending it.
The collector MUST stop before attempt 9 or before reserved plus validated
spend exceeds USD 0.021504; it MUST reserve USD 0.002688 before each request.
Each case may be attempted at most once, requests are sequential, and any
terminal provider, validation, or accounting error MUST consume the attempt
and stop the run without retry or case replacement.

#### Scenario: Attempt or spend limit would be exceeded

- **WHEN** the next request would exceed eight attempts or the spend reservation
- **THEN** the request is not dispatched

#### Scenario: Provider asks for retry or redirect

- **WHEN** the provider returns a retryable status or redirect
- **THEN** no retry/redirect is followed and the one-shot run stops with the request counted

### Requirement: Retained evidence is closed and local-only

Artifacts MUST be create-exclusive, mode 0600, and written under the
existing ignored `artifacts/` directory on a stable local filesystem. A
concurrent same-user process moving that directory is outside the containment
guarantee; on observed identity loss the collector MUST stop without deleting
or overwriting a pathname whose ownership is uncertain. A case record MAY contain only case
and answer IDs, validated Choice selected IDs/distributions/confidence, Noul
probabilities, typed result or error codes, model, token usage, latency, cost,
attempt count, and corpus/question fingerprints. Artifacts MUST NOT contain
raw provider response bodies, prompt/task text, candidate descriptions,
credentials, arbitrary exception strings, or protected/personal/corporate data.

#### Scenario: Valid response is captured

- **WHEN** a provider response passes closed schema and ID validation
- **THEN** the local case artifact contains only its typed IDs, numeric evidence, and bounded accounting

#### Scenario: Response is malformed or contains an unknown ID

- **WHEN** validation fails
- **THEN** the artifact stores only the case ID and a bounded error code; raw response data is discarded and collection stops

### Requirement: Collection cannot establish production calibration

The collector MUST NOT select or install runtime threshold values. Reports MUST
use exact case denominators and MUST NOT describe C1-C6 provisional labels as
ground truth, H1-H2 as hidden holdout, or the eight-case result as statistical
calibration, general quality, production readiness, or proven economy.

#### Scenario: No defensible candidate boundary appears

- **WHEN** the observations do not distinguish plausible accepted and rejected outcomes
- **THEN** no candidate threshold is reported and production remains fail-closed
