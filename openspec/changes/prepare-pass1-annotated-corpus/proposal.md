# Proposal

## Why

The prior eight-case pass-1 sample has provisional labels, exposed secondary
cases, and overlapping confidence between correct and incorrect
`architecture_fork` answers. It cannot support a defensible threshold. New
synthetic examples need explicit label semantics and provenance before they
can be used for threshold experiments.

## What Changes

- Define a versioned annotation guide for all seven pass-1 signal groups.
- Prepare a 14-case rubric pilot and then 84 new cases split into 56 calibration
  and 28 locked evaluation cases.
- Store dual annotations, evidence spans, disagreements, adjudications,
  scenario-family IDs, and split provenance.
- Validate the data contract and split integrity locally.

## Non-Goals

- Any Jev/provider request, threshold selection or installation, or full-router
  smoke.
- Private/corporate inputs, Codex integration, model/permission routing, or
  claims of statistical calibration, production readiness, or savings.

## Impact

The change adds synthetic fixtures and their annotation guidance/tests to the
isolated TypeScript lab. Existing runtime behavior remains fail-closed.
