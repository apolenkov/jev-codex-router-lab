# Tasks

## 1. Specify annotation semantics

- [x] 1.1 Review and approve this written design before creating the dataset
- [x] 1.2 Finalize versioned rules and dual-annotation record schema

## 2. Prepare synthetic examples

- [x] 2.1 Create and independently annotate the 14-case rubric pilot; resolve guide ambiguity without Jev outputs
- [x] 2.2 Freeze the guide, then create 56 calibration and 28 locked evaluation cases
- [x] 2.3 Record authorship, evidence spans, annotator disagreements, adjudication, family IDs, and exact fingerprints

## 3. Validate offline

- [x] 3.1 Add validation tests for schema, IDs, provenance, ambiguity, splits, family leakage, and protected context
- [x] 3.2 Run lint, typecheck, tests, strict OpenSpec, and confirm no Jev/TypeSafe or scoring/evaluation API calls
- [x] 3.3 Obtain independent final review and record the dataset limits before any later paid experiment

## 4. Review v5 risk labels with an offline correction ledger

- [x] 4.1 Preserve original dual annotations and adjudications; record source and v5 base manifest hashes for replay provenance
- [x] 4.2 Implement and validate a versioned ledger containing each prior/effective leaf, visible evidence, rule, and rationale; keep reviewer provenance in top-level `review.reviewers` mapping each risk dimension to its reviewerId, resolved from each correction's `signal`
- [x] 4.3 Compute effective per-split, per-signal denominators from the overlaid labels; report unsupported dimensions as not evaluated
- [x] 4.4 Verify local ledger replay and coverage without Jev/TypeSafe or scoring/evaluation API requests; retain model-assisted reviewer provenance and run the focused checks and strict OpenSpec validation

## 5. Repair explicit-negative risk coverage in v6

- [x] 5.1 Preserve all 14/56/28 case IDs and scenario-family assignments; revise task text, revision metadata, and truthful author provenance only for CAL-043, EVAL-015, and EVAL-019 to add guide-compliant explicit exclusions; correct only author model metadata for CAL-022, CAL-041, and CAL-042 from primary logs
- [x] 5.2 Obtain two fresh blind full-case annotations and a new adjudication for each revised input; do not reuse its v5 labels or adjudication
- [x] 5.3 Preserve the v5 checkpoint; create a v6 manifest and final correction ledger whose base hash is the v6 manifest SHA-256 and which retains the original source manifest hash; verify positive and negative effective risk examples in each final split, marking unsupported dimensions not evaluated
- [x] 5.4 Re-lock evaluation under v6 and verify there was no threshold selection or provider scoring call; run focused checks and strict OpenSpec validation
