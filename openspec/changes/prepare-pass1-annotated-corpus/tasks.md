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
- [x] 3.2 Run lint, typecheck, tests, strict OpenSpec, and confirm no provider calls
- [x] 3.3 Obtain independent final review and record the dataset limits before any later paid experiment
