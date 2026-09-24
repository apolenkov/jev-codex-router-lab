# Report — fail-closed pass-1 confidence policy

## Scope

Completed the pre-existing partial implementation of the independent,
fail-closed pass-1 confidence policy (`JEV_PASS1_THRESHOLDS_JSON`). Fixed the
unbound `catch` variable in `src/cli.ts`, finished typed-reason propagation,
added the focused tests, and documented the policy and its calibration
limitation. No provider calls, no credential reads, no commits.

## Commands and results

| Command | Result |
| --- | --- |
| `npx tsc -p tsconfig.json --noEmit` | exit 0 |
| `npm run build` | exit 0 |
| `node --test dist/test/typesafe-gateway.test.js` | 26 pass / 0 fail |
| `node --test dist/test/router.test.js dist/test/cli.test.js dist/test/public-surface.test.js dist/test/calibration-cli.test.js dist/test/calibration-runner.test.js` | 75 pass / 0 fail |
| `npm run lint` | `ok`, exit 0 |
| `npm run typecheck` | `ok`, exit 0 |
| `npm run check:openspec` | `build-jev-router-lab`, `calibrate-jev-routing-thresholds`, `prepare-public-open-source` all valid (`--strict --no-interactive`) |
| `git diff --check` | clean, exit 0 |
| `npm test` | 160 pass / 1 fail — only `test/arena-fixtures.test.ts` with `ENOENT: no such file or directory, open 'fixtures/arena/dev-cases.json'`. Known unrelated failure; not fixed and not masked |

## Changed paths (vs HEAD)

Source:

- `src/contracts.ts` — `FallbackReason` gains `uncalibrated-thresholds`
- `src/pass1-thresholds.ts` — new; pure parser for `JEV_PASS1_THRESHOLDS_JSON`
  (exact three keys, `[0,1]` numbers, Noul interval strictly containing `0.5`)
- `src/typesafe-gateway.ts` — `pass1` parses the env policy before any client
  call; `createTypeSafeGateway` validates the policy before reading
  `TYPESAFE_API_KEY`; atomic `assertPass1Confidence` gate over all six queried
  Choice answers and all five Noul answers (inclusive band); optional
  questions with empty candidate lists are not evaluated
- `src/router.ts` — `uncalibrated-thresholds` added to reason mapping
- `src/cli.ts` — `serviceFallback` propagates `SemanticGatewayError.reason`;
  fixed unbound `catch` variable
- `src/calibration-cli.ts` — parses the pass-1 policy before reading
  `TYPESAFE_API_KEY`; exit 2 `uncalibrated-thresholds` on missing/invalid
- `src/calibration-runner.ts` — `runCalibrationExperiment` parses the env
  policy before corpus guard, transport, or any request

Tests:

- `test/typesafe-gateway.test.ts` — invalid-policy matrix; policy-before-key
  ordering; per-Choice floor tests (all six queried fields); per-Noul band
  tests (all five fields); inclusive boundaries; outside-band/extremes;
  confident base fixture
- `test/router.test.ts` — `uncalibrated-thresholds` mapping; forced-skill
  preservation with zero client calls; no pass 2
- `test/cli.test.ts` — typed gateway-factory reason propagation; compiled CLI
  matrix (missing policy → `uncalibrated-thresholds`; policy + missing key →
  `service-error`)
- `test/calibration-cli.test.ts` — preflight before key/transport/fetch;
  synthetic valid policy in end-to-end tests; confident fake risk values
- `test/calibration-runner.test.ts` — preflight with zero transport/report
  calls; one-request `low-confidence` stop at C1/pass1 (no tuple, no holdout,
  no smoke success)
- `test/public-surface.test.ts` — offline example expects
  `uncalibrated-thresholds` with forced/protected IDs preserved

Docs and spec:

- `README.md` — policy shape, fail-closed behavior, calibration limitation,
  offline example note
- `openspec/changes/build-jev-router-lab/design.md` — section 7 extended with
  env-only policy source and calibration-runner sharing of the fail-closed rule
- `openspec/changes/build-jev-router-lab/specs/advisory-routing/spec.md` — new
  "Pass-1 confidence is checked atomically" requirement with five scenarios
- `openspec/changes/build-jev-router-lab/tasks.md` — task 2.3 marked done;
  2.4 (actual calibration) remains open

Pre-existing worktree entries preserved untouched this run:

- `docs/superpowers/plans/2026-09-21-dev-skill-routing-arena.md` (foreign arena
  plan, modified before this run)
- `docs/superpowers/plans/2026-09-23-pass1-confidence-guard.md` (untracked)
- `fixtures/arena/` (untracked, protected)
- `test/arena-fixtures.test.ts` (untracked, protected)

## Remaining limitations

- Pass-1 threshold values are not calibrated; the repository ships no
  production values. A separate labeled pass-1 calibration (task 2.4) must
  supply `JEV_PASS1_THRESHOLDS_JSON` before live routing.
- Schema validation verifies shape and ranges only; it cannot prove the
  provenance or quality of an operator-supplied calibration.
- With a valid policy, a pass-1 answer carrying a Noul value inside the
  uncertainty band stops collection after one provider request with
  `low-confidence` — the calibration run cannot succeed on uncertain evidence
  (verified by test, expected behavior).
- Full suite retains the known unrelated failure: missing
  `fixtures/arena/dev-cases.json` (ENOENT), intentionally not created.

## Status

No readiness claim. Coordinator must independently verify this report and
request the required final read-only Astra review.
