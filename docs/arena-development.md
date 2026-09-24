# Development skill-routing arena

A deterministic, fully offline development arena that replays three
skill-routing contestants over one frozen 60-case synthetic corpus and writes a
byte-identical scoreboard. It exists to validate the arena harness, tune the
router, and diagnose routing behavior during development.

**This arena is development-only.** It cannot select a winner, it is not
evidence of model superiority, and it does not justify production enablement.
Every contestant output comes from frozen fixtures or deterministic rules — no
provider, credential, network, subprocess, or Codex hook is reachable.

## Run

```bash
npm run arena:dev
```

The command loads and fingerprint-checks every frozen input before any
contestant runs, executes the three contestants in the fixed order
`jev`, `codex`, `rules`, records each run under
`artifacts/arena/dev-<12-hex-prefix>/`, then scores the recorded files — not
live contestant objects — into `scoreboard.json`.

```text
artifacts/arena/dev-<prefix>/
  manifest.json     every input fingerprint used for this run
  cases.json        the frozen case projection contestants saw
  gold.json         the frozen gold used by the scorer
  runs/jev.jsonl
  runs/codex.jsonl
  runs/rules.jsonl
  scoreboard.json   per-case records and per-contestant aggregates
```

`<prefix>` is the first 12 hex digits of the combined frozen-input fingerprint.
Re-running the command over unchanged inputs produces byte-identical files. If
a target file already exists with different bytes the command fails without
overwriting it, and a fingerprint mismatch fails before any contestant runs.

## Frozen inputs

`fixtures/arena/` is the pinned input set:

- `skill-manifest.json` — 10 routable skills with descriptions, excerpts, and
  frozen `contextTokens`.
- `dev-cases.json` — 60 public synthetic cases (30 `en` / 30 `ru`, 12 per
  stratum, unique IDs, family IDs sharing language and stratum, explicit and
  required skills forming the forced set).
- `dev-gold.json` — accepted optional routes per case (15 zero-skill, 22
  one-skill, 15 two-skill, 8 three-skill by largest accepted route), gold
  mandatory skills (a subset of each case's forced set), forbidden skills, and
  annotation provenance. Two blind annotators labeled every case under
  `rubric-v1.md`; a third adjudicated every disagreement. Only stable roles
  (`annotator-a`, `annotator-b`, `adjudicator`) and the rubric version are
  recorded — no names, timestamps, or session-derived content.
- `rules.json` — the frozen ordered trigger table for the rules contestant.
- `jev-replay.json` — synthetic recorded semantic responses served by the
  replay gateway. It exercises the harness only and says nothing about live
  Jev quality.
- `codex-replay.json` — recorded structured Codex outputs, replayed verbatim.
- `fingerprints.json` — the six pinned SHA-256 values
  (`schemaVersion` plus `skillManifest`, `cases`, `gold`, `rules`,
  `jevReplay`, `codexReplay`) over canonical JSON of the parsed fixtures.

## Metrics and denominators

Per case the scorer records the contestant status (`ok`, `abstain`, `error`),
the effective route, correctness, false positives/negatives against the chosen
closest route, mandatory misses, and forbidden hits.

- **Correct**: `ok` and the optional part of the effective route (route minus
  forced skills) exactly equals any accepted gold route. `abstain` and `error`
  are always incorrect and count as an empty optional selection.
- **Closest route** for FP/FN: minimize `|FP| + |FN|`; tie → fewest FN; tie →
  lexicographically smallest sorted-ID serialization.
- **Mandatory miss**: gold-mandatory skill absent from the effective route;
  counted again as high-risk mandatory miss on `high`-risk cases.
- **Forbidden hit**: effective route contains a forbidden skill.
- **Aggregates** per contestant: accuracy over all 60 cases; `ok`/`abstain`/
  `error` counts; mandatory and high-risk mandatory misses; forbidden hits;
  false-positive rate over zero-skill cases; micro precision/recall over
  optional selections; autonomous coverage (share answered `ok`); total
  `contextTokens` over effective routes.
- **Telemetry**: input/output tokens, latency, and cost aggregate only over
  non-`null` observations; p50/p95 use nearest rank
  (`sorted[ceil(p*n) - 1]`); every aggregate is `null` when a contestant has no
  observation, and any zero denominator yields `null`.
- **Jev-with-Codex-fallback diagnostic**: each Jev `abstain` is replaced by the
  Codex effective route when that result is `ok`, then accuracy and mandatory
  misses are recomputed.

All metrics are deterministic: identical inputs produce identical scoreboard
bytes on every run.

## Limits

- Synthetic corpus, public and sanitized — no session, corporate, credential,
  path, or user-derived content.
- The Jev replay fixture is synthetic; it cannot demonstrate live-model
  quality, calibration, or economy.
- Scores here are harness diagnostics, not a verdict, and must not be quoted
  as evidence for enabling the router anywhere.
