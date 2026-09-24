# Proposal

## Why

The isolated router now fails closed when pass-1 thresholds are absent, as it
should. The existing pass-2 experiment is terminal and cannot be retried or
reused to obtain pass-1 confidence evidence. The owner separately authorized
one bounded, synthetic, pass-1-only collection so the current confidence
signals can be inspected without enabling a route or spending the prior
experiment's budget.

## What Changes

- Add a single-use collector for the frozen eight-case synthetic fixture. It
  sends one pass-1 request per case, sequentially, and stops on a terminal
  request, response, or accounting failure.
- Pin `jev-1.13.0`; disable retries and redirects; cap at eight actual HTTP
  attempts and USD 0.021504 reserved at the documented 64k-token maximum.
- Validate and retain only closed typed answer IDs and numeric Choice/Noul
  evidence plus model, usage, latency, cost, and bounded error codes in local
  ignored artifacts.
- Treat C1-C6 labels as provisional expert judgments and H1-H2 as exposed
  secondary cases, not hidden holdout data.
- Document that the explicit CLI sends synthetic prompts to the paid provider
  and writes private local evidence; running it is not part of ordinary checks.
- Keep production threshold configuration unset; do not run pass 2 or the
  separate two-call full-router smoke; do not publish the local artifact.

## Capabilities

### New Capabilities

- `pass1-confidence-evidence`: safe, one-shot collection of typed pass-1
  confidence observations from the frozen synthetic corpus.

### Modified Capabilities

None.

## Impact

Only the isolated TypeScript lab, its README, tests, this OpenSpec change, and
ignored local artifacts are in scope. The production route continues to require its
independently supplied threshold policy and remains fail-closed. No private or
corporate input, permissions, model routing, Codex integration, or live router
smoke is authorized by this proposal.

## Frozen Inputs and Measurement Boundary

- Corpus file SHA-256: `848ffc0f04e1dd6c93a5006e9a000871982c3a3754543dbde7d95a3dbba9d73e`
- Pass-1 question-builder SHA-256: `5101440bf90c2a6d174b6f87c112bbdffa8eac2080a2e1eb8d2bc938ccc25e78`
- SDK: `@typesafe-ai/sdk` 0.6.0; model: `jev-1.13.0`
- Fixed case order: `C1`, `C2`, `C3`, `C4`, `C5`, `C6`, `H1`, `H2`
- C1-C6 are the provisional-label analysis set. H1-H2 were exposed to review
  and are secondary observations, not an untouched or hidden holdout.
- Report only case-bounded counts and exact denominators. Do not claim
  statistical calibration, general quality, production readiness, or economy.

The official model reference as checked 2026-09-23 lists USD 0.042 per million
input tokens, free output tokens, and a maximum 64k-token context per request.
At the full input bound, one reservation is USD 0.002688 and eight are USD
0.021504. The SDK retries by default; this collector explicitly sets
`maxRetries: 0`.
