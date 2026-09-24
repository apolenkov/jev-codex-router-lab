# Proposal

## Why

The prior eight-case pass-1 sample has provisional labels, exposed secondary
cases, and overlapping confidence between correct and incorrect
`architecture_fork` answers. It cannot support a defensible threshold. New
synthetic examples need explicit label semantics and provenance before they
can be used for threshold experiments.

The 98-case v5 corpus also needs an auditable way to review legacy risk labels
without changing its original annotations or adjudications.

The v5 risk review also found three cases whose task text needs explicit
exclusions to support negative risk labels. Repair them as a new v6 checkpoint
without changing the corpus IDs or scenario-family assignments.

## What Changes

- Define a versioned annotation guide for all seven pass-1 signal groups.
- Prepare a 14-case rubric pilot and then 84 new cases split into 56 calibration
  and 28 locked evaluation cases.
- Store dual annotations, evidence spans, disagreements, adjudications,
  scenario-family IDs, and split provenance.
- Add a versioned, offline correction ledger over the v5 corpus for reviewed
  risk labels, preserving original annotation provenance and deriving effective
  coverage from the overlaid labels.
- Create a v6 checkpoint by revising task text, revision metadata, and author
  provenance for CAL-043, EVAL-015, and EVAL-019; correct only the author model
  metadata for CAL-022, CAL-041, and CAL-042 from primary logs. Record fresh
  blind annotations and adjudications for the three text revisions, a new
  manifest, and a final risk correction ledger based on the v6 manifest while
  retaining the immutable v5 checkpoint.
- Keep the evaluation split locked as v6 and require positive and negative
  effective risk examples in each final split before reporting a risk dimension
  as evaluated.
- Validate the data contract and split integrity locally.

## Non-Goals

- Any Jev/TypeSafe or other scoring/evaluation API request, threshold
  selection or experiment, or full-router smoke. Model-assisted annotation and
  reviewer conversations remain allowed; their provenance must be recorded.
- Private/corporate inputs, Codex integration, model/permission routing, or
  claims of statistical calibration, production readiness, or savings.

## Impact

The change adds synthetic fixtures and their annotation guidance/tests to the
isolated TypeScript lab. The correction ledger, effective coverage, and v6
explicit-negative repair are verified separately from this proposal; runtime
behavior remains fail-closed.
