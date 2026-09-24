# Proposal

## Why

Before any live routing evaluation, the lab needs a deterministic way to
compare skill-selection strategies on identical inputs. The recorded
protocol (doc-013) calls for one frozen, deterministic multi-label
skill-selection evaluation with three contestants — the existing Jev
router, the current Codex selector, and a deterministic rules baseline —
judged by a deterministic scorer, never by an LLM. This change builds only
the development half of that protocol: a 60-case frozen corpus and an
offline scoreboard used to validate the harness and tune or diagnose
thresholds, with no authority to declare a production winner.

## What Changes

- Add a frozen, sanitized 60-case development corpus with case and family
  IDs, RU/EN and task-type strata, source classification, risk flags, and
  per-case accepted optional-skill routes plus mandatory and forbidden
  skills, together with a frozen skill manifest carrying per-skill context
  token counts. Corpus, gold, and manifest are pinned by SHA-256
  fingerprints of their canonical JSON.
- Define one typed arena contract: every contestant receives an identical
  typed case input and returns a closed result — `ok` with a selected
  skill route, `abstain`, or `error` — where unobserved usage, cost, and
  latency are represented as `null`.
- Add three contestant adapters behind that contract: the existing Jev
  router driven through an explicitly injected semantic gateway, a Codex
  adapter that replays pre-recorded structured fixture output only, and a
  deterministic rules baseline built on a frozen trigger table.
- Add a deterministic scorer that accepts multiple exact gold routes per
  case, derives false positives/negatives against the closest accepted
  route with a stable tie-break, preserves mandatory-skill safety, and
  emits per-case and aggregate metrics as a byte-reproducible development
  scoreboard.
- Add one package-script command that regenerates the run artifacts
  (manifest, cases, gold, per-contestant runs, scoreboard) from frozen
  inputs and recorded contestant outputs, byte-identical across repeats.
- The development scoreboard tunes and diagnoses only; it cannot declare
  production victory, and it creates no general arena framework or
  reusable skill.

## Capabilities

### New Capabilities

- `dev-skill-routing-arena`: Frozen 60-case development corpus, uniform
  typed contestant contract, three offline contestant adapters (Jev router
  behind an injected gateway, recorded Codex fixture, deterministic
  rules), deterministic multi-gold scoring, and a byte-reproducible
  development scoreboard command.

### Modified Capabilities

None.

## Impact

The change is additive to the isolated TypeScript lab: new arena module,
new contestant adapters, new deterministic scorer, new `fixtures/arena/`
inputs, generated evidence under `artifacts/arena/`, new tests, and one
new package script. It adds no dependency, makes no provider call by
default, does not modify the working Codex installation, and grants no
contestant authority over skills, permissions, execution, model routing,
or acceptance. The existing router, policy, telemetry, and calibration
code paths remain unchanged.
