# Design: pass-1 threshold selection protocol (pre-registered)

Frozen before the first provider request. Any deviation aborts the run and
is recorded in the evidence manifest.

## Fixed inputs

| Artifact | Role | Pinned by |
| --- | --- | --- |
| `fixtures/pass1-calibration-cases.json` | 56 calibration cases with adjudicated labels | corpus manifest sha256 |
| `fixtures/pass1-evaluation-cases.json` | 28 holdout cases, untouched until evaluation | corpus manifest sha256 |
| `fixtures/pass1-corpus-manifest.json` | split/family/label provenance + component hashes | tracked file |
| `src/questions.ts` (`buildPass1Request`) | request builder, sha256 pinned in manifest | manifest `hashes.questionBuilder` |
| `jev-1.13.0`, `@typesafe-ai/sdk@0.6.0` | model + SDK fingerprints | recorded in manifest output |

## Request shape

One `systemOne` call per case: `buildPass1Request(case.input)` with
`model: "jev-1.13.0"`, injected fetch, `maxRetries: 0`, per-call timeout
45 s. Cases run in declared file order, strictly sequential. Every actual
HTTP attempt is counted; `attempts` in the manifest equals the real number.

## Caps

- Attempt cap: 56 (calibration) + 28 (evaluation) = 84 provider requests.
- Spend cap: USD 0.25 reserved per run before any call (worst case
  84 × USD 0.002688 = USD 0.226; observed ~USD 0.00005/call).
- Any transport failure or terminal HTTP status aborts the run immediately;
  partial evidence is preserved and marked incomplete. No retry, no case
  replacement, no label change after the first request.

## Gate under test (unchanged semantics)

For tuple `t = (floor, lo, hi)`: a case response is ACCEPTED iff every
`choice` answer has `confidence >= floor` AND every `noul` answer has
`noul < lo || noul > hi`. Otherwise REJECTED.

## Frozen candidate grid

- `floor ∈ {0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95}`
- `lo ∈ {0.40, 0.44, 0.48}`; `hi ∈ {0.52, 0.56, 0.60}`
- 10 × 3 × 3 = 90 tuples, evaluated exhaustively on collected responses.

## Label comparison (evaluable fields only)

A field is evaluable iff its gold `status` is `resolved`; `ambiguous` and
`not_queried` fields are excluded from denominators and reported separately.

- `taskType`: correct iff Jev `choice == gold.value`.
- `skillCandidates`, `contextRelevance` (sets): correct iff
  `gold.value` is empty and Jev `choice == "none"`, or Jev `choice ∈
  gold.value`. Jev is not credited for forced skills; shortlist coverage is
  reported descriptively, not scored.
- `criticalGap`, `reuseCandidate`, `architectureFork` (nullable scalars):
  correct iff `gold.value == null` and Jev `choice == "none"`, or Jev
  `choice == gold.value`.
- `riskDimensions` (5 nouls): correct iff sign(Jev noul − 0.5) matches
  gold positive/negative (`noul == 0.5` counts as error; positive iff
  `noul > 0.5`).

## Selection rule (decided now, applied later)

Per tuple: among ACCEPTED calibration cases, compute per-signal error rate
`errors / evaluable` and coverage = accepted cases / 56.

1. Eligible: tuples with **zero** accepted-case label errors across all
   signals AND coverage > 0.
2. If the eligible set is empty: select the tuple minimizing total accepted
   errors; tie → max coverage; then stricter `floor`; then wider band
   (lower `lo`, then higher `hi`); then lexicographic `(floor, lo, hi)`.
3. If eligible: select max coverage; identical tie-break chain.
4. If a tie survives the full chain: report all tied tuples and select the
   first in lexicographic order, flagged `tie-broken`.

## Evaluation (single shot)

After the tuple is frozen in `artifacts/pass1-threshold-selection.json`,
run the 28-case evaluation corpus once under identical transport rules.
Report per-signal accuracy on accepted cases, accepted/rejected counts,
denominators for excluded labels. No tuple change is permitted from
evaluation evidence; a poor evaluation is reported, not retuned.

## Failure treatment

- Terminal HTTP (400/401/402/403/404/408/429) or thrown fetch error →
  abort run, mark manifest `incomplete`, preserve collected evidence.
- A case whose response fails schema validation counts as REJECTED for
  every tuple and is reported as `invalid-response`.
- **Amendment 2026-09-24 v1 (owner-approved option B):** on a transport-level
  abort (timeout/provider/connection — no model answer received), the run
  MAY be resumed within the same evidence directory. `collected` and
  `invalid-response` case records are never re-attempted or overwritten; a
  `failed` case may be retried and its record replaced. The resumed manifest
  records `resumedFrom` accounting and `resumeCount`.
- **Amendment 2026-09-24 v2 (owner-approved after a second timeout):**
  resumes are unbounded in count; each resume continues from the first
  non-final case. Per-call timeout raised 45 s → 120 s to tolerate provider
  latency; the resumed manifest records the effective `limits.maxAttempts`
  and `timeoutMs`. If attempts exhaust before all cases collect, the run
  reports `incomplete` honestly.
- **Amendment 2026-09-24 v3 (owner-approved after a third failure):**
  provider failure rate observed ~25% (2 timeouts + 1 provider-error in
  12 attempts). Cumulative attempt ceiling raised to **70 for calibration
  and 40 for evaluation**; a fixed 1000 ms inter-call delay is inserted
  between sequential calls to reduce rate-limit pressure and is recorded
  in the manifest `limits.interCallDelayMs`. Spend cap unchanged.
- **Amendment 2026-09-24 v4 (owner-approved at ceiling exhaustion):**
  the ~25% provider failure rate persisted (17 transport failures in 70
  attempts; 53/56 collected). Calibration ceiling raised to **80**;
  evaluation ceiling stays 40. Spend cap unchanged.
- **Amendment 2026-09-24 v5 (independent review hardening):**
  - The evaluator MUST verify the frozen artifact derives from the retained
    calibration evidence: the CLI reloads calibration records, recomputes
    `selectPass1Threshold`, and requires the artifact's selected tuple and
    `inputs.evidenceSha256` to match exactly before any evaluation call.
  - A resumed evaluation MAY replace its own `incomplete` report atomically;
    fresh runs stay create-once and a `complete` summary blocks any further
    resume, so a final report can never be rewritten.
  - Spend-cap semantics clarified: USD 0.25 is enforced per bounded run
    (calibration and evaluation each). Accounting records only
    provider-reported settled usage; a failed call's provider-side billing
    is not observable and is reported as an attempt without cost. Actual
    total spend was USD 0.0042 — inside the authorized package either way.
- Protected-context fragments are stripped by the request builder; the
  corpus validator already proves no protected fragment reaches the wire.

## Privacy

All inputs are authored synthetic; evidence files record question keys,
answers, usage, latency, counted attempts — never request bodies beyond
the already-public fixture state.
