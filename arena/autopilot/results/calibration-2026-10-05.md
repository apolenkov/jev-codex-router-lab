# Autopilot calibration 2026-10-05

Goal: agreement >= 90% at coverage >= 40%, otherwise the autopilot stays a hint.

## Verdict

**только hint** (variant `asis`, the deployment condition: labels as the assistant wrote them).
Variant `stripped` (Kev cannot see the (Recommended) hint): **только hint**.

A cell passes when agreement >= 90% and coverage >= 40%; the pick is the passing cell with the most coverage, then the higher agreement. "Fragile" means the Wilson 95% lower bound is below 0.80 or the cross-half hold-out does not confirm >= 90%.

## Data

- corpus pairs: 70; scored: asis 70 (errors 0), stripped 70 (errors 0)
- by number of options (asis): 2 options: 21; 3 options: 45; 4 options: 4
- Kev: jaredpalmer/kev-4b@6cfce5c2fa4b4bd64026336ab649c5ca78857d52; Kev pointer head on Qwen/Qwen3.5-4B-Base, serving jaredpalmer/kev-4b@6cfce5c2fa4b4bd64026336ab649c5ca78857d52 at temperature 2.41
- Kev latency, asis: mean 554 ms, median 680 ms, p95 856 ms
- Kev latency, stripped: mean 550 ms, median 681 ms, p95 872 ms
- For 2-option questions margin = 2*p1 - 1, so T and M are redundant there; the grid mixes them with 3+ option questions.

## Variant asis

Cell: coverage / agreement (auto count). Bold: passes the target. N = 70.

| T \ M | 0.0 | 0.1 | 0.2 | 0.3 | 0.4 | 0.5 |
|---|---|---|---|---|---|---|
| 0.50 | 59% / 44% (41) | 53% / 46% (37) | 46% / 50% (32) | 39% / 52% (27) | 17% / 33% (12) | 9% / 50% (6) |
| 0.55 | 50% / 46% (35) | 50% / 46% (35) | 44% / 48% (31) | 37% / 50% (26) | 17% / 33% (12) | 9% / 50% (6) |
| 0.60 | 33% / 43% (23) | 33% / 43% (23) | 33% / 43% (23) | 27% / 42% (19) | 17% / 33% (12) | 9% / 50% (6) |
| 0.65 | 21% / 47% (15) | 21% / 47% (15) | 21% / 47% (15) | 21% / 47% (15) | 14% / 40% (10) | 9% / 50% (6) |
| 0.70 | 10% / 43% (7) | 10% / 43% (7) | 10% / 43% (7) | 10% / 43% (7) | 10% / 43% (7) | 7% / 60% (5) |
| 0.75 | 6% / 50% (4) | 6% / 50% (4) | 6% / 50% (4) | 6% / 50% (4) | 6% / 50% (4) | 6% / 50% (4) |
| 0.80 | 4% / 33% (3) | 4% / 33% (3) | 4% / 33% (3) | 4% / 33% (3) | 4% / 33% (3) | 4% / 33% (3) |
| 0.85 | 0% / - (0) | 0% / - (0) | 0% / - (0) | 0% / - (0) | 0% / - (0) | 0% / - (0) |
| 0.90 | 0% / - (0) | 0% / - (0) | 0% / - (0) | 0% / - (0) | 0% / - (0) | 0% / - (0) |
| 0.95 | 0% / - (0) | 0% / - (0) | 0% / - (0) | 0% / - (0) | 0% / - (0) | 0% / - (0) |

Selected: none

Baselines (agreement with the owner):

- always (Recommended): 80.0% on the 50 of 70 pairs that carry the label (coverage 71.4%)
- always the first option: 82.9%
- corpus majority (option index 1): 82.9%
- Kev top-1, no threshold: 45.7%

Hold-out (sessions split into two halves by hash; pick on one half, evaluate on the other):

- train half 0 (40 pairs) -> test (30 pairs): picked none; on test no cell to evaluate; confirmed >= 90%: no
- train half 1 (30 pairs) -> test (40 pairs): picked none; on test no cell to evaluate; confirmed >= 90%: no

## Variant stripped

Cell: coverage / agreement (auto count). Bold: passes the target. N = 70.

| T \ M | 0.0 | 0.1 | 0.2 | 0.3 | 0.4 | 0.5 |
|---|---|---|---|---|---|---|
| 0.50 | 54% / 42% (38) | 50% / 43% (35) | 41% / 41% (29) | 30% / 43% (21) | 13% / 44% (9) | 7% / 40% (5) |
| 0.55 | 50% / 43% (35) | 50% / 43% (35) | 41% / 41% (29) | 30% / 43% (21) | 13% / 44% (9) | 7% / 40% (5) |
| 0.60 | 29% / 35% (20) | 29% / 35% (20) | 29% / 35% (20) | 20% / 36% (14) | 13% / 44% (9) | 7% / 40% (5) |
| 0.65 | 14% / 40% (10) | 14% / 40% (10) | 14% / 40% (10) | 14% / 40% (10) | 10% / 43% (7) | 7% / 40% (5) |
| 0.70 | 7% / 40% (5) | 7% / 40% (5) | 7% / 40% (5) | 7% / 40% (5) | 7% / 40% (5) | 6% / 50% (4) |
| 0.75 | 6% / 50% (4) | 6% / 50% (4) | 6% / 50% (4) | 6% / 50% (4) | 6% / 50% (4) | 6% / 50% (4) |
| 0.80 | 4% / 33% (3) | 4% / 33% (3) | 4% / 33% (3) | 4% / 33% (3) | 4% / 33% (3) | 4% / 33% (3) |
| 0.85 | 1% / 100% (1) | 1% / 100% (1) | 1% / 100% (1) | 1% / 100% (1) | 1% / 100% (1) | 1% / 100% (1) |
| 0.90 | 0% / - (0) | 0% / - (0) | 0% / - (0) | 0% / - (0) | 0% / - (0) | 0% / - (0) |
| 0.95 | 0% / - (0) | 0% / - (0) | 0% / - (0) | 0% / - (0) | 0% / - (0) | 0% / - (0) |

Selected: none

Baselines (agreement with the owner):

- always (Recommended): 80.0% on the 50 of 70 pairs that carry the label (coverage 71.4%)
- always the first option: 82.9%
- corpus majority (option index 1): 82.9%
- Kev top-1, no threshold: 42.9%

Hold-out (sessions split into two halves by hash; pick on one half, evaluate on the other):

- train half 0 (40 pairs) -> test (30 pairs): picked none; on test no cell to evaluate; confirmed >= 90%: no
- train half 1 (30 pairs) -> test (40 pairs): picked none; on test no cell to evaluate; confirmed >= 90%: no

## Limits

- One owner, one corpus of a few dozen pairs: confidence intervals are wide, so a passing cell is an estimate, not a guarantee.
- Pairs are extracted from past sessions; the answer to an earlier question can shape later ones, so pairs are not independent.
- Multi-select, free-text, timed-out and refused questions are excluded, so the autopilot is calibrated only for single-choice questions.
- Kev sees the goal and the assistant's closing text, trimmed to a fixed size, not the whole session; owner messages that start with `<` (slash commands, pasted blocks) are dropped, so the goal is short or empty for about half of the pairs. The verdict is "Kev with this state is not calibrated", not "Kev cannot".
- The model and its serving temperature are those reported above; a different Kev revision needs a new run.
