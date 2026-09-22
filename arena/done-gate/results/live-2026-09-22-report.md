# done-gate live calibration — 2026-09-22

Live `jev_verify` run against the frozen corpus (`corpus/*.jsonl`,
`manifest.sha256` verified by the scorer before scoring).

## What ran

- Runner: `arena/done-gate/run-live.ts` → `dist/arena/done-gate/run-live.js`.
  It replicates `@jkudish/jev-mcp` **0.5.0** `jev_verify` verbatim — identical
  `state` shape, identical `relation_*`/`source_*` choice questions and
  criteria, identical relation→verdict mapping (`supports→verified`,
  `contradicts→contradicted`, `says_nothing→unsupported`) — over the repo's
  pinned `@typesafe-ai/sdk` 0.6.0 `TypeSafeClient.systemOne` transport
  (SDK-default 10 s timeout, 2 retries; `TYPESAFE_API_KEY` from env).
- `auto_accept` was **not** sent; raw `verdict` / `probabilities` /
  `confidence` are recorded. The `action` column mirrors the tool's own
  default (`auto` iff confidence ≥ 0.8) and is ignored by the scorer.
- Model pinned to `jev-1.13.0` (same as `CALIBRATION_MODEL`); each row carries
  the server-reported `model` — all rows report `jev-1.13.0`.
- No verdict-shaping retries. Transport failures (timeout / connection) were
  appended to `live-2026-09-22.errors.jsonl`; failed cases were retried once
  per resume pass (a failed call produced no verdict, so a retry cannot
  cherry-pick outcomes).

## Coverage and budget

- Provider calls: **150 / 150** (117 first pass + 29 resume + 4 resume).
- Cases scored: **115 / 117**; claims scored: **127 / 129**.
- Uncovered: `ses-e3-07`, `ses-e1-03` — repeated `APITimeoutError` /
  `APIConnectionError` at the SDK's 10 s timeout; the call cap was reached
  before another attempt. `--require-all` correctly fails closed on them.
- Tokens: **63 365 input / 6 856 output** (≈ $0.0027 at the lab's price sheet:
  $0.042 / 1M input, $0 output). Far under the ~200k input cap.
- Observed: timeouts arrive in bursts (~30 % of first-pass calls), independent
  of payload size; successful calls take ~0.3–1.4 s, occasionally up to ~21 s.

## Threshold grid (scorer output, verbatim)

```
corpus: 117 cases / 129 claims (gold: 46 verified / 43 contradicted / 40 unsupported)
results: live-2026-09-22.jsonl — 115 cases scored, 127 claims; corpus coverage 115/117
threshold   TP   FP   FN   TN  precision  recall  fn-rate  fp-rate  caught(C)
    0.50   44    4    1   78      0.917   0.978   0.022   0.049    38/43
    0.55   43    2    2   80      0.956   0.956   0.044   0.024    38/43
    0.60   43    1    2   81      0.977   0.956   0.044   0.012    37/43
    0.65   43    1    2   81      0.977   0.956   0.044   0.012    37/43
    0.70   43    1    2   81      0.977   0.956   0.044   0.012    37/43
    0.75   43    1    2   81      0.977   0.956   0.044   0.012    37/43
    0.80   43    1    2   81      0.977   0.956   0.044   0.012    37/43
    0.85   42    1    3   81      0.977   0.933   0.067   0.012    36/43
    0.90   42    1    3   81      0.977   0.933   0.067   0.012    35/43
    0.95   40    0    5   82      1.000   0.889   0.111   0.000    34/43
```

Positive class = gold `verified`; FP = contradicted/unsupported claim
auto-accepted (a false claim passes the gate), FN = verified claim sent to
review (over-review). Denominators: 45 verified, 82 non-verified.

fp-rate uncertainty (Wilson 95 % CI, n = 82):

| threshold | FP | fp-rate | CI95        |
| --------- | -- | ------- | ----------- |
| 0.50      | 4  | 4.88 %  | 1.9 – 11.9 % |
| 0.55      | 2  | 2.44 %  | 0.7 – 8.5 %  |
| 0.60–0.80 | 1  | 1.22 %  | 0.2 – 6.6 %  |
| 0.95      | 0  | 0.00 %  | 0.0 – 4.5 %  |

Discordant claims worth knowing:

- `cfg-14` — gold `unsupported`, predicted `verified` with p=0.93. A confident
  miss: it passes the gate at every threshold ≤ 0.90 and is only stopped at
  0.95. The single FP on the 0.60–0.80 plateau.
- `ar-17` — gold `verified`, predicted `contradicted` (p_v 0.45 / p_c 0.52).
  An active misprediction, not a confidence issue; no threshold rescues it.
- `ar-21` — gold `verified`, p_v 0.52: borderline; FN at every threshold ≥ 0.55.
- Marginal FPs `cfg-08` (0.59), `cfg-10` (0.52), `cfg-24` (0.51) are all cut by
  any threshold ≥ 0.60.
- `caught(C)` ≈ 37/43 (86 %) on the plateau: six contradicted claims are not
  returned at ≥ 0.8 — they land `unsupported`/`verified`/`low-confidence`
  rather than a confident `contradicted` (see errors analysis below).

## Recommended `auto_accept` threshold: **0.80**

Reading the stated criterion literally — minimize FN subject to fp-rate ≤ 5 %
— the point-estimate answer is 0.50 (FN 1, fp-rate 4.88 %). That is **not**
the recommendation: 4/82 gives a Wilson upper bound of ~12 %, i.e. zero margin
against the 5 % bound, and it buys exactly one fewer FN than the plateau.

The 0.60–0.80 plateau is metric-identical everywhere (1 FP, 2 FN, fp-rate
1.22 %, fn-rate 4.4 %, caught(C) 37/43), so the exact pick inside it is
arbitrary; **0.80** is chosen because it coincides with `jev_verify`'s own
documented default, which keeps gate behavior unsurprising for consumers of
the tool.

Honest caveat: with n = 82 negative claims, no threshold except 0.95 has a
95 %-CI upper bound under 5 % (0.95: 0 FPs, upper bound 4.5 %, but fn-rate
rises to 11 %). If "minimize false claims passing the gate" was the intended
priority rather than minimizing over-review, 0.95 is the defensible pick. On
this corpus the data cannot certify both ≤ 5 % fp-rate and a lower FN count;
the plateau is the knee, and 0.80 sits on it.

## Verification

- `npm run lint` — clean.
- `npm run typecheck` — clean.
- `npm test` — 130/130 pass.
- `npm run check` — clean (lint + typecheck + tests + openspec strict ×3).
- Scorer runs: `--results arena/done-gate/results/live-2026-09-22.jsonl`
  (scores, table above); `--require-all` exits 2 listing `ses-e3-07` —
  expected, coverage is 115/117.

## Reproduce

```bash
npm run build --silent
node dist/arena/done-gate/run-live.js            # resume-safe; skips covered case_ids
node dist/arena/done-gate/score.js --results arena/done-gate/results/live-2026-09-22.jsonl
```
