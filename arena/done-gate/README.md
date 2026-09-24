# done-gate calibration corpus and scorer

Dev-local calibration for `jev_verify` as a done-gate: do an agent's final
claims ("tests passed", "file created", "hook installed") hold against the
evidence it cites?

This is **calibration, not the doc-013 arena**: no WIN/LOSE protocol, no
bootstrap CI, no LLM judge, no provider calls. The corpus exists to estimate
where an `auto_accept` threshold lands before any live run is approved.

## Layout

```
arena/done-gate/
  corpus/*.jsonl            frozen labelled cases (117 cases / 129 claims)
  manifest.sha256           sha256 of every corpus file — corpus is frozen
  fixtures/results.sample.jsonl  hand-labelled "as-if" jev_verify output (12 cases)
  score.ts                  deterministic offline scorer
```

## Corpus format

One JSON object per line:

```json
{
  "id": "ar-02",
  "source": "session | synthetic",
  "domain": "agent-report | command-output | config | design-lint | drift-check",
  "tags": ["near-miss", "stale-evidence"],
  "claims": ["Все тесты прошли"],
  "evidence": [{ "id": "npm-test", "text": "pass 47, fail 1" }],
  "gold": ["contradicted"]
}
```

- `gold[i]` is the gold verdict for `claims[i]` — same length, same order.
- Verdicts: `verified` (evidence supports the claim), `contradicted`
  (evidence conflicts with the claim), `unsupported` (evidence does not
  settle the claim either way — wrong evidence, missing field, unmeasured).
- Class balance is roughly thirds: 46 verified / 43 contradicted / 40
  unsupported across 129 claims. Domains: agent reports, configs, command
  outputs, plus design-lint and drift-check cases derived from a real session
  (doc-016 episodes E1–E4, anonymized).
- `tags` mark hard cases: `near-miss` (boundary numbers, skipped-but-not-failed
  tests), `stale-evidence` (evidence shows an earlier state), `mixed`
  (multi-claim cases with heterogeneous gold), `missing-field`/`missing-key`
  (classic unsupported), `cause` (attribution claims), `units`/`boundary`.
- All data is synthetic or anonymized session material — no secrets, no PII,
  no machine-local paths (decision-002).

Editing the corpus invalidates `manifest.sha256`; regenerate with
`shasum -a 256 corpus/*.jsonl > manifest.sha256` and treat the new corpus as a
new freeze (scores against old result files are no longer comparable).

## Results format (scorer input)

One JSON object per line, one line per case:

```json
{
  "case_id": "ar-02",
  "model": "jev-1.13.0",
  "results": [
    {
      "claim_index": 0,
      "verdict": "verified",
      "probabilities": {"verified": 0.55, "contradicted": 0.42, "unsupported": 0.03},
      "confidence": 0.5,
      "action": "review"
    }
  ]
}
```

- `claim_index` indexes into the corpus case's `claims` array (0-based).
- Required per claim: `claim_index`, `verdict`, `probabilities` with all three
  verdict keys in `[0, 1]`. `confidence` and `action` are optional and recorded
  but not used by the primary grid.
- A results file must cover **all claims of every case it touches**; extra
  `case_id`s not in the corpus fail closed. Cases without any result row are
  reported as uncovered, not silently dropped (`--require-all` turns partial
  coverage into an error).

## Scoring semantics

A claim is **auto-accepted** iff `verdict == "verified"` and
`probabilities.verified >= threshold`. Gold `verified` is the positive class:

- TP: gold verified, auto-accepted. FN: gold verified, not accepted
  (over-review). FP: gold contradicted/unsupported, auto-accepted — the
  dangerous error: a false claim passes the gate.
- `fn-rate = FN/(TP+FN)`, `fp-rate = FP/(FP+TN)`. Undefined ratios print `-`.
- `caught(C)`: share of gold-`contradicted` claims predicted `contradicted`
  with `probabilities.contradicted >= threshold` — the done-gate "return the
  work" trigger quality.

## Run

```bash
npm run calib                      # scores fixtures/results.sample.jsonl
node dist/arena/done-gate/score.js --results <results.jsonl>   # after build
node dist/arena/done-gate/score.js --json                      # machine output
node dist/arena/done-gate/score.js --domain config             # slice corpus
node dist/arena/done-gate/score.js --require-all               # demand full coverage
node dist/arena/done-gate/score.js --no-manifest-check         # skip hash check
```

Exit codes: `0` scored, `2` input/validation/coverage/manifest error.
The scorer is deterministic and offline — the test suite spawns it with all
network APIs stubbed to throw.

A live `jev_verify` run against the corpus is a **separately approved step**;
this directory only provides the frozen labels and the scoring machinery.
