# Pass 1 confidence fallback

## Goal

Restore the OpenSpec behavior: reject the whole pass-1 result if any queried
semantic signal is uncertain. Preserve the existing fallback boundary and all
mandatory skills.

## Decisions

- Pass-1 confidence policy is independent of pass 2; no pass-2 value is reused.
- Check every queried non-echo answer. For Choice, use its `confidence`; for
  Noul, reject values inside the configured inclusive uncertainty interval.
- Optional questions absent because no candidates were supplied are not checked.
- Until pass-1 thresholds have their own calibration evidence, do not send a
  provider request. Return an explicit `uncalibrated-thresholds` fallback.
- This change does not set or claim calibrated numeric thresholds and does not
  make another paid TypeSafe request.

## Global Constraints

- Pass 1 and pass 2 keep independent threshold policies; do not alter the
  existing pass-2 evaluator or tuple.
- `JEV_PASS1_THRESHOLDS_JSON` is the only runtime source for calibrated pass-1
  values. It must be an exact JSON object with `choiceConfidenceMin`,
  `noulUncertaintyLower`, and `noulUncertaintyUpper`; all values are in `[0,1]`
  and the Noul interval must strictly contain `0.5`.
- Missing or invalid configuration fails before credentials/network use with
  `uncalibrated-thresholds`. The program validates shape/ranges, not whether an
  operator's claimed calibration is truthful.
- No threshold values are invented or copied from pass 2. No paid calls or
  raw-answer artifacts are permitted in this task.
- Do not modify the existing uncommitted arena plan, fixtures, or tests.

## Task 1 — RED/GREEN pass-1 confidence gate

1. Add tests proving that missing or malformed threshold policy fails before
   credentials/client access; low confidence on each queried Choice signal and
   each of the five Noul risk answers rejects the whole pass; the Choice value
   equal to its floor passes while lower values fail; Noul band boundaries are
   inclusive; high-confidence Noul yes/no values pass; and omitted optional
   answers do not cause fallback. Preserve malformed-answer and stale-echo
   errors. Add a small independent `src/pass1-thresholds.ts` parser and
   calibration-runner preflight before key reads or transport, reusing the same
   pure parser as the gateway. Keep pass-2 `threshold-calibration.ts` separate.
   With no or invalid policy it must fail as `uncalibrated-thresholds` with zero key reads
   and requests. With a valid test policy and its retained corpus containing
   Noul `0.5`, the first collection request is expected, but validation must
   fail as `low-confidence`, skip pass 2, and produce no successful calibration
   result. Keep independent pass-2 calibration algorithm tests passing; do not
   change the runner's corpus or historical artifacts.
2. Verify the RED tests fail on current `d8247a0`.
3. Add tests for configured Choice/Noul boundaries and whole-pass fallback.
4. Add the smallest explicit pass-1 threshold policy at the TypeSafe gateway;
   read it from `JEV_PASS1_THRESHOLDS_JSON`, keep pass-2 policy and thresholds
   unchanged, and distinguish missing/invalid configuration from actual
   `low-confidence` answers. CLI chooses `options.env ?? process.env` once,
   then passes a snapshot containing only `JEV_PASS1_THRESHOLDS_JSON` through
   calibration runner → gateway. Keep API credentials in the CLI and read them
   only after policy validation; components parse the JSON field and never
   accept numeric thresholds.
   Preserve `uncalibrated-thresholds` through CLI routing instead of collapsing
   it to `service-error`, and check policy before reading credentials.
5. Update the existing OpenSpec delta, `README.md`, and `docs/architecture.md`;
   test router fallback, no
   pass-2 call, forced-skill preservation, calibration-runner preflight before
   key/network access, and low-confidence stop without claiming calibration
   success. Do not put invented threshold values in examples; a missing policy
   in the offline example should produce the documented fallback.
6. Run focused tests, build, lint, typecheck, OpenSpec validation, then the full
   test suite. Preserve and report the known unrelated arena `ENOENT` failure.
7. Request one read-only final Astra review on the exact candidate after the
   checks; do not claim full TASK-054 completion while live/calibration gates
   remain unmet.

## Scope boundaries

Owned files are the pass-1 gateway/contracts/router/CLI wiring and focused
tests; `src/pass1-thresholds.ts`; calibration CLI/runner preflight plus focused
tests; `README.md`, `docs/architecture.md`; and the existing
`build-jev-router-lab` OpenSpec documents.
Do not change the calibration corpus or historical artifacts. Do not modify
the untracked arena fixture/test or its plan. Do not retain or expose raw
provider answers, secrets, or task text in new test artifacts. Use only fake
transport; no provider calls or credential reads in this task.
