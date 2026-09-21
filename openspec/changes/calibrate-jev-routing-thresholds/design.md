# Design

## Context

The current adapter embeds pass-2 thresholds and exposes only final decisions
plus accounting. The corrected live run made two calls and returned
`low-confidence`, but retained evidence cannot identify the failing boundary.
The existing router and metadata-only report remain the security boundary.

## Goals / Non-Goals

**Goals:**

- Capture a closed, replayable confidence record for frozen synthetic cases.
- Select one tuple offline with no provider calls during grid evaluation.
- Enforce actual-request and spend caps before dispatch.
- Keep normal CLI reports and deterministic policy unchanged.

**Non-Goals:**

- Production threshold adoption, general quality claims, prompt optimization,
  pass-1 tuning, retries, Codex integration, or private data.

## Decisions

### Calibration-only runner and evidence schema

Add a separate CLI entry point rather than widening the normal router report.
The runner uses the same request builders and closed answer validation but emits
only the confidence values required for replay. Alternative: add raw answers to
all reports; rejected because it expands the routine data surface.

### Parameterize pass-2 evaluation without changing defaults

Extract one closed pass-2 parser that validates ranking and every fit before
threshold evaluation, then a pure evaluator accepting a tuple. The existing
adapter applies current defaults after parsing; the experiment persists the
validated record and replays the grid. Alternative: capture after the current
early low-confidence throw; rejected because it loses fits needed for replay.

### Count attempts outside the SDK and disable retries

Construct the experimental SDK client with `maxRetries: 0` and a custom `fetch`
hook that rejects redirects and increments the counter immediately before each
HTTP dispatch. Requests are sequential. Tests exercise the real SDK against a
stub transport for success, 429, 500, and timeout. Alternative: count logical
pass calls; rejected because retries or redirects could escape the cap.

The runner pins `jev-1.13.0`, USD 0.042/M input tokens, and USD 0/M output
tokens; aliases and runtime price/model overrides are rejected. The official
Jev 1.13 limit is 64k input tokens, so the runner reserves USD 0.002688 before
each request against the owner-approved USD 0.05
hard cap. After a response, validated actual usage replaces the reservation.
Unknown accounting terminates execution without another request.

### Freeze corpus and labels as one canonical JSON artifact

Store all eight synthetic inputs and labels in one canonical fixture with a
SHA-256 fingerprint recorded before dispatch. Calibration and holdout are
selected by fixed IDs, never by runtime filtering. The chosen tuple and
calibration report are atomically persisted before holdout; the selector API
cannot receive holdout records. Alternative: separate loose
fixtures; rejected because their combined identity is easier to drift.

### Stop on the first non-evaluable case

Service, schema, accounting, or shortlist failure ends the experiment. No
automatic retry or replacement exists. This sacrifices completion rate to make
the small denominator auditable.

## Risks / Trade-offs

- [Two holdout cases are weak evidence] → Limit claims to this frozen corpus.
- [A lower threshold can admit a wrong answer] → Require exact frozen labels and
  false-positive count zero on calibration and holdout.
- [Pass 1 can omit the correct skill] → Record shortlist recall and fail rather
  than inject a candidate.
- [Evidence can expose prompt content] → Persist closed confidence/accounting
  values and fixture IDs; keep task and catalogue bodies only in the reviewed
  synthetic corpus.

## Migration Plan

1. Add pure threshold evaluation, corpus validation, and runner behind a new
   package script; existing defaults remain byte-for-byte equivalent.
2. Verify locally with fake responses and cap/privacy tests.
3. Freeze and fingerprint the corpus, then obtain final preflight review.
4. Execute once within the owner-approved caps.
5. Run the original smoke through the experimental runner and frozen tuple only
   after both holdouts pass; adopt defaults only in a later reviewed change.
