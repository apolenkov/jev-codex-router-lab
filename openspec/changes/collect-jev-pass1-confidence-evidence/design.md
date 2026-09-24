# Design

## Context

`TypeSafeGateway.pass1` currently requires a calibrated threshold policy before
dispatch. The calibration runner uses the same gate and then continues through
pass 2, holdout, and smoke, so neither path is suitable for collecting the
first pass-1 confidence evidence. The prior pass-2 experiment is terminal and
remains a separate protocol.

## Goals / Non-Goals

**Goals:**

- Collect one validated pass-1 response for each fixed synthetic case, subject
  to a strict actual-request and spend ceiling.
- Retain enough closed numeric evidence and accounting for case-bounded
  inspection without storing provider response text or prompt bodies.
- Preserve the existing route's fail-closed behavior and the previous
  pass-2 experiment's caps and semantics.

**Non-Goals:**

- Selecting or adopting production thresholds in this change.
- Producing an accepted routing result, calling pass 2, or running the later
  full-router smoke.
- Statistical/general quality or cost claims, retries, prompt tuning, private
  data, public evidence, or Codex integration.

## Decisions

### Separate single-use pass-1 command

Add an explicit `calibrate:pass1` entry point that calls only
`buildPass1Request`. It must not call `TypeSafeGateway`, `routeWithTelemetry`,
`runCalibrationExperiment`, or any pass-2 builder. The production gateway
continues to parse the shared structural evidence and then apply its own
threshold gate; the collector uses structural validation only and returns
typed observations, never `Pass1Result` or `RouterDecision`.

### Reuse the bounded transport, with stricter fixed limits

Reuse the existing custom-fetch accounting path: sequential dispatch, SDK
`maxRetries: 0`, manual redirect handling, actual HTTP-attempt counting before
dispatch, exact model pinning, token usage validation, and worst-case spend
reservation. Add internal per-run limits while preserving the existing
pass-2 defaults exactly: 8 attempts, USD 0.021504 total, USD 0.002688 per
attempt. The collector cannot override these values from command-line input or
environment variables.

The current model reference lists Jev 1.13 as `jev-1.13.0`, USD 0.042/M input,
free output, and 64k total context per request (as checked 2026-09-23):
https://docs.typesafe.ai/models. At the maximum input bound, eight worst-case
requests cost USD 0.021504. Rate limits are dynamic; a 429 ends the one-shot
run and consumes that attempt.

### Closed, local-only evidence

Before any request, create a mode-0600, create-exclusive manifest recording
corpus and question fingerprints, case order/groups, SDK/model, request limits,
and claim limits. Write only parsed answer IDs and numeric values,
per-request accounting, and bounded error codes. Validate all Choice keys and
selected IDs against the frozen question candidates; validate Noul values as
finite probabilities. Validate echoes for freshness but do not retain them.
Do not persist raw responses, free text, prompts, credentials, or exception
messages. Write one closed record after each case so completed paid observations
survive a later failure; create-exclusive files and the checkpoint prevent an
accidental second run from replacing or replaying the first.

Artifacts live under `artifacts/pass1-calibration/`, covered by the existing
`artifacts/**` ignore rule. A stable local filesystem is a precondition during
the one-shot run: portable Node path checks cannot guarantee containment if
another same-user process moves the already-open parent directory. The writer
checks directory identity, creates files exclusively, and never removes or
overwrites a pathname after losing ownership. The checkpoint is updated
through its claimed file handle; an interrupted write can leave an unusable
partial checkpoint and cannot be resumed. The local output is intentionally
not committed or published.

The README must state that the command makes paid provider requests over the
synthetic fixture, has an explicit one-shot limit, writes only ignored local
evidence, and does not enable routing. It must not imply routine tests make
provider calls.

### Interpretation boundary

C1-C6 labels are provisional judgments, not verified truth. H1-H2 were exposed
to the independent label review and are not hidden holdout data. Record raw
closed observations and simple exact denominators; any derived candidate
boundary must be clearly marked exploratory, case-specific, and not applied to
runtime configuration. If the evidence does not support a distinct boundary,
report none rather than inventing one.

## Failure Behavior

The collector records a bounded typed failure and stops on the first terminal
transport, schema, or accounting failure. The attempt remains counted; there
is no retry, replacement case, resume, threshold change, or subsequent smoke.
Missing or invalid credentials fail before dispatch and do not create a paid
attempt.

## Verification

Use fake transport for tests of success, zero retries, redirects, request/spend
caps, unknown usage, malformed/unknown answers, immutable inputs, output
privacy, create-exclusive artifacts, and single-use behavior. Before live
collection, run focused and full local checks, strict OpenSpec validation, and
verify that the output path is ignored. After collection, inspect only the
closed artifact schema and accounting; do not publish it.
