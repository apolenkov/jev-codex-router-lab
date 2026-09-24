# Calibration and evidence

This project separates deterministic correctness from semantic quality. Unit
tests can prove validation, fallback, accounting, and preservation invariants;
they cannot prove that Jev chooses the right skill for real work.

## Frozen calibration protocol

The calibration fixture contains six labelled calibration cases and two
holdout cases. All are synthetic. The planned protocol was:

1. Freeze and fingerprint the corpus before any provider request.
2. Collect a closed pass-2 confidence record for each calibration case.
3. Evaluate 15 threshold tuples offline; provider calls are not part of the
   grid search.
4. Select a tuple only if every calibration label matches exactly, with no
   false positives and all structural invariants intact.
5. Evaluate the two hidden holdouts once.
6. Run the reserved smoke only if both holdouts pass.

The experimental client pinned `jev-1.13.0`, disabled retries, rejected
redirects, counted each outbound attempt before dispatch, and enforced caps of
18 attempts and USD 0.05. A terminal validation or accounting failure stops the
experiment rather than replacing a case or tuning after the result.

## Observed result — 2026-09-21

The runner made one provider attempt and terminated with
`post-transport-validation` during the first calibration case:

| Measure | Observed value |
| --- | --- |
| Provider attempts | 1 |
| Input-token cost | USD 0.00005124 |
| Holdout attempts | 0 |
| Reserved smoke attempts | 0 |
| Retry or threshold adjustment | None |

The retained aggregate evidence cannot distinguish the narrower validation
failure without a separately designed experiment. No raw provider answer was
kept, and the run does not establish calibration, holdout performance, routing
quality, or economy. The full bounded record is in
[`artifacts/calibration-summary.md`](../artifacts/calibration-summary.md).

## Corrected live smoke — 2026-09-21

One public synthetic task (`n=1`) was run exactly once with corrected task
evidence in both passes:

| Measure | Observed value |
| --- | --- |
| Model | `jev-1.13.0` |
| Calls | 2 |
| Decision | `fallback/low-confidence` |
| Total latency | 1164.798417 ms |
| Input / output tokens | 1,492 / 580 |
| Recorded cost | USD 0.000062664 |

The required `systematic-debugging` skill was preserved. This observation
proves only the observed transport, accounting, safe-fallback, and
mandatory-skill paths. With `n=1` and no accepted seven-signal decision, it
cannot support claims about quality, reliability, savings, economy, or
production readiness. See the [metadata report](../artifacts/corrected-smoke-report.json),
[decision](../artifacts/corrected-smoke-decision.json), and
[method notes](../artifacts/smoke-summary.md).

## Live smoke — 2026-09-24 (`status: ok`)

One owner-authorized live smoke ran once on the frozen public synthetic
fixture `fixtures/smoke-input.json` (SHA-256
`e54113a38b089f4ed5096c9611fadfa8e175a60459e9082dfdc8349909f4a2fb`).

Pass-1 policy: the router requires `JEV_PASS1_THRESHOLDS_JSON`. The owner
explicitly authorized deriving an exploratory policy from the eight collected
pass-1 evidence cases under `artifacts/pass1-calibration/` — a documented
deviation from that change's not-for-runtime boundary. The rule: accept
responses at least as decisive as the weakest collected case.
`choiceConfidenceMin` is `0.5`, a small margin below the weakest observed
choice confidence (`0.52`); the Noul uncertainty band `[0.48, 0.52]` sits
inside the observed gap (`0.43` below, `0.53` above) around `0.5`. All eight
collected cases pass under this policy. These are smoke-gate values, not
calibrated production thresholds; the dedicated 56-case calibration corpus
remains the proper source for those.

| Measure | Observed value |
| --- | --- |
| Model | `jev-1.13.0` |
| Calls | 2 (pass 1 + pass 2) |
| Decision | `ok` |
| Total latency | 1256.747 ms |
| Input / output tokens | 1,476 / 574 |
| Recorded cost | USD 0.000061992 |

All seven signals were valid: `taskType=diagnose`,
`skillCandidates=[test-driven-development, writing-plans]`, `criticalGap`,
`reuseCandidate`, `architectureFork` all `null`, five `riskDimensions` values,
`contextRelevance=[]`. The required `systematic-debugging` skill was
preserved. With `n=1` this proves operability of the gated live path only —
not routing quality, reliability, savings, economy, or production readiness.
See the [metadata report](../artifacts/live-smoke-2026-09-24-report.json) and
[decision](../artifacts/live-smoke-2026-09-24-decision.json).

## Invalid historical `status: ok`

An earlier live artifact recorded `status: ok`, but that gateway version
omitted required task evidence from the provider request. It is invalid as
semantic-routing evidence and is retained only as a transparent transport and
accounting record. It must not be used to claim successful routing.

## Permitted conclusions

- Deterministic policy and the fake-gateway test suite exercise the typed
  boundary without a provider.
- The corrected live path made two calls, recorded bounded metadata, preserved
  a mandatory skill, and failed safely.
- One 2026-09-24 live smoke returned `status: ok` under an explicitly
  exploratory, owner-authorized pass-1 policy. With `n=1` it proves
  operability only — not routing quality, reliability, savings, economy, or
  production readiness.

Any future quality claim needs a new pre-registered evaluation with a useful
denominator, frozen labels, explicit thresholds, and evidence retained without
private data.
