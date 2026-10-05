# autopilot calibration

Dev-local calibration for an "autopilot" that would pick an option in an
`AskUserQuestion` poll on the owner's behalf. The question it answers: at which
Kev confidence does the autopilot match the owner often enough, while still
answering a useful share of polls on its own?

Target: agreement >= 90% at coverage >= 40%. If no threshold reaches it, the
autopilot stays a hint (it suggests an option, the owner still answers).

## Privacy

The corpus is built from the owner's own session journals, so it never enters
the repository:

| What | Where |
|---|---|
| corpus, per-row results, errors | `~/.local/state/autopilot-calib/` (`corpus.jsonl`, `rows-<variant>.jsonl`, `errors.jsonl`) |
| code, this README, the aggregate report | this directory (`results/calibration-<date>.md`: numbers only) |

The report carries counts and percentages, never question or answer text.

## Run

```sh
npm run autopilot:extract     # journals -> corpus.jsonl, prints counters
npm run autopilot:calibrate   # corpus -> Kev -> rows, report in results/
```

`autopilot:calibrate` needs a running Kev at `127.0.0.1:8010` and never starts
one; it stops with a clear error when Kev does not answer. A rerun skips pairs
already in `rows-<variant>.jsonl`.

## Pipeline

```
~/.claude/projects/**/*.jsonl
   | extract.ts: AskUserQuestion tool_use + paired tool_result
   v
corpus.jsonl  (question, options, owner answer, goal, tail)
   | calibrate.ts: POST /v1/systemone, type "choice", one call at a time
   v
rows-asis.jsonl, rows-stripped.jsonl  (p1, margin, top-1)
   | threshold grid T x M, baselines, cross-half hold-out
   v
results/calibration-<date>.md
```

## Extraction

Kept: single-choice questions whose answer is one of the offered labels.
Skipped (and counted): refused calls, timed-out calls (`afkTimeoutMs`, not the
owner), `multiSelect`, unanswered questions, free-text / "Other" answers, and
repeats of the same question and answer. Context (the owner's last real
message, the assistant's closing text) is taken only from lines before the
tool call, so the answer cannot leak into the state sent to Kev.

## Variants

- `asis`: labels as the assistant wrote them, including `(Recommended)`. This is
  what the autopilot would see in use.
- `stripped`: the `(Recommended)` marker (also the Russian forms) is removed, so
  Kev cannot copy the assistant's pick and its own signal is measured.

## Reading the report

- Grid cell = `coverage / agreement (auto count)`; bold cells meet the target.
- Auto means `p1 >= T` and `margin = p1 - p2 >= M`. For 2-option questions
  `margin = 2*p1 - 1`, so T and M carry the same information there.
- Selected cell: the passing one with the most coverage, then the higher
  agreement.
- Hold-out: sessions are split in two halves by a hash of the session id; the
  cell is picked on one half and evaluated on the other, both ways.
- "Fragile": the Wilson 95% lower bound of agreement is below 0.80, or the
  hold-out does not confirm 90%.
- Baselines: always `(Recommended)`, always the first option, the corpus
  majority, and Kev top-1 without any threshold.

## Tests

`test/autopilot-calibration.test.ts` runs on synthetic fixtures and a local
stub server; it needs neither the corpus nor Kev.
