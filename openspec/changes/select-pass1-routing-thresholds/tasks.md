# Tasks

## 1. Bounded calibration runner

- [x] 1.1 `src/pass1-threshold-runner.ts`: sequential pass-1 collection over the frozen calibration corpus; injected fetch, `maxRetries: 0`, 45 s timeout, counted attempts, spend cap, create-once evidence dir, abort-on-failure; unit tests with fake fetch (zero real calls).
- [x] 1.2 `src/pass1-threshold-cli.ts`: `npm run calibrate:pass1-thresholds -- --split calibration` entry point; usage errors exit 2; pinned file-hash verification before any call; tests.

## 2. Offline selector

- [x] 2.1 `src/pass1-threshold-selector.ts`: pure function — collected responses + corpus labels + frozen 90-tuple grid → per-tuple errors/coverage + selected tuple per the pre-registered rule; tests covering zero-error path, Pareto path, ties, invalid-response exclusion, ambiguous/not-queried denominators.
- [x] 2.2 Selector CLI/report writer: `artifacts/pass1-threshold-selection.json` (tuple, grid, per-tuple table, selection rationale, input hashes); tests.

## 3. Single-shot evaluator

- [x] 3.1 `src/pass1-threshold-evaluator.ts`: applies the frozen tuple file to the evaluation corpus once (same runner machinery); refuses to run without the frozen selection file; writes `artifacts/pass1-threshold-evaluation.json`; tests.
- [x] 3.2 CLI: `npm run calibrate:pass1-thresholds -- --split evaluation` gated on the selection artifact.

## 4. Evidence and closeout

- [x] 4.1 Live collection run — 56/56 collected over 73 attempts, USD 0.0028 (provider instability absorbed via authorized resume, ceiling 80).
- [x] 4.2 Offline selection → frozen tuple artifact `{floor: 0.95, lo: 0.4, hi: 0.52}`, `eligible: false` (no zero-error tuple on the grid).
- [x] 4.3 Live evaluation run — 28/28 collected over 37 attempts, USD 0.0014; single frozen tuple, no retune.
- [ ] 4.4 Report: `docs/calibration.md` update (selection rule, results, n-limits), artifact hashes recorded in backlog task.
- [ ] 4.5 Independent review; `npm run check` green; no `uncalibrated-thresholds` string in public docs.
