# Select pass-1 routing thresholds on the annotated corpus

## Why

`typesafe-gateway` fails closed without a threshold policy
(`uncalibrated-thresholds`). The annotated pass-1 corpus (56 calibration + 28
locked evaluation cases, frozen by `fixtures/pass1-corpus-manifest.json`)
exists to pick that policy once, from evidence, instead of exploratory
smoke-gate values. This change adds the bounded runner that collects pass-1
responses on the calibration split, an offline selector that scores a frozen
candidate grid against gold labels, and a single-shot evaluator for the
holdout split.

## What changes

- New bounded runner: sequential pass-1 `systemOne` calls over the frozen
  calibration corpus, injected fetch, zero retries, counted attempts, spend
  cap reserved per call, create-once evidence directory, terminal HTTP
  failures abort the run.
- New offline selector: scores the frozen candidate tuple grid on collected
  calibration responses vs adjudicated gold labels; per-signal error and
  coverage criteria and tie-breaks are pre-registered in `design.md`.
- New single-shot evaluator: applies the frozen selected tuple to the
  evaluation split exactly once; no retuning.
- New fixture-hash pins and public-surface allowances for the evidence and
  report artifacts.

## What does NOT change

- Runtime gateway behavior: nothing is installed or enabled; the selected
  tuple is reported as evidence only.
- Mandatory skills, protected context, allowlists, permissions, and
  deterministic policy remain outside calibration.
- No case text, label, split, or manifest may change after the first
  provider request of the collection run.
