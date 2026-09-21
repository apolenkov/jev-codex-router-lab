# Tasks

## 1. Pure threshold calibration

- [x] 1.1 Write failing tests for the 15-tuple grid, current-default equivalence, complete parsing before low-confidence evaluation, deterministic tie-break, no-qualifying-tuple failure, shortlist preservation, and holdout-independent selection
- [x] 1.2 Extract the pure pass-2 threshold evaluator and implement offline grid scoring; verify focused tests, lint, and strict typecheck pass

## 2. Frozen corpus and evidence boundary

- [x] 2.1 Add one canonical eight-case synthetic corpus with complete seven-signal labels/ranges and verify its deterministic SHA-256 fingerprint
- [x] 2.2 Write failing tests through the real SDK with a stub transport for corpus mutation, closed confidence evidence, protected-data exclusion, attempt counting, zero retries, redirect rejection, 429/500/timeout, unknown accounting, request 19, and USD 0.002688 reservation against the USD 0.05 hard cap
- [x] 2.3 Implement the calibration runner and report schema without changing the normal router report; verify all focused tests pass

## 3. Local preflight

- [x] 3.1 Run the complete local gate (`npm ci`, lint, strict typecheck, all tests, strict OpenSpec, diff checks) and record exact results; repeat relevant gates after any change
- [x] 3.2 Obtain independent plan/security review of the frozen corpus, labels, caps, no-retry transport, evidence schema, and executable candidate; fix important findings and repeat targeted gates

## 4. Bounded live experiment

- [ ] 4.1 Execute the six calibration cases once, stop on the first terminal condition, select one tuple offline, and record calls/usage/latency/cost plus denominator
- [ ] 4.2 If and only if calibration succeeds, execute both holdout cases once with the frozen tuple and record exact labels, invariants, accounting, and PASS/FAIL
- [ ] 4.3 If and only if both holdout cases pass and at least two requests plus reserved spend remain, execute the original frozen two-pass smoke once through the experimental runner and selected tuple; cap the smoke at two requests, do not retry or change defaults
- [ ] 4.4 Run final local verification, obtain mandatory Astra review of the exact evidence-bound candidate, update backlog truthfully, and commit the accepted result
