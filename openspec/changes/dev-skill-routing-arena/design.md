# Design

## Context

The lab already provides the pieces the recorded arena protocol (doc-013)
reuses: closed `RouterInput`/`RouterDecision` contracts, deterministic
`precheck`/`postcheck`, the two-pass router behind an injected
`SemanticGateway`, metadata-only telemetry with `null`-for-unknown
accounting, canonical-JSON SHA-256 fingerprints, corpus guards, and
create-once evidence writers. Doc-013 describes one decisive protocol with
a 240-case sealed holdout and pre-registered victory gates; this change
implements only its development half — the 60-case corpus, three
contestants, deterministic scorer, and reproducible scoreboard used for
harness validation and threshold tuning. See proposal.md for scope.

## Goals / Non-Goals

**Goals:**

- One typed contestant contract and one deterministic scorer usable
  offline on every machine, with byte-identical regeneration.
- Exercise the real Jev decision pipeline (precheck, two passes,
  confidence policy, postcheck, abstention) without a provider call.
- Keep gold labels and competitor outputs unreachable to contestants.
- Produce metrics sufficient for tuning and diagnosis: valid-route
  accuracy, mandatory/forbidden safety counts, zero-skill FP rate, micro
  precision/recall, autonomous coverage, selected context tokens.

**Non-Goals:**

- Sealed holdout, bootstrap confidence gates, or any production verdict —
  those belong to the later decisive-protocol change.
- Live Jev or live Codex calls, subprocesses, hooks, or working-Codex
  integration of any kind.
- A general arena framework, reusable skill, UI, server, DB, LLM judge,
  debates, voting, or arbitrary command runner; new dependencies.

## Decisions

### Split the doc-013 protocol; build the development half only

The 60-case development corpus and deterministic scorer stand alone; the
sealed holdout, paired bootstrap, and victory gates are explicitly
deferred. This keeps every part of this change offline and deterministic.
Alternative: implement the full protocol now — rejected because it forces
a Codex integration and holdout governance this change deliberately
excludes.

### Codex is a frozen fixture, not an execution

The Codex contestant validates and replays pre-recorded structured
selector output per case ID. The development arena compares against the
selector's recorded answers, which is enough to validate the harness,
scorer, and corpus before any live run exists. Alternative: drive the
real Codex selector — rejected; it requires a working-session hook or
subprocess and breaks offline determinism.

### Jev runs through the real router with an injected gateway

The Jev adapter maps each case to a `RouterInput` with fixed filler
(`taskRevision` 1, frozen arena policy version, manifest fingerprint as
`catalogHash`, and empty non-skill signal candidate lists) and calls the existing
`routeWithTelemetry`. The semantic gateway is constructor-injected; the
adapter never builds a provider client or reads credentials, so an
explicit opt-in boundary is structural, not a flag. Default scoring
injects a replay gateway that serves recorded pass responses from a frozen
fixture keyed by case ID and rejects unexpected calls. Router `fallback`
maps to `abstain` with the reason preserved; an adapter-level failure maps
to `error`. Alternative: replay final Jev decisions like the Codex fixture
— rejected because it would skip the policy and abstention logic the
arena exists to exercise.

### Closed result contract with nullable telemetry

Each case result is `ok` (selected skill route), `abstain` (reason), or
`error` (reason), plus input/output token, latency, and cost fields that
are `null` when unobserved — the same convention as `RouteReport`.
Contestants report their full intended route; the scorer derives the
optional part by subtracting the case's forced set, matching the router's
`forcedSkillIds` semantics where mandatory skills can never be dropped.
Outputs with unknown IDs, duplicates, or more than three optional skills
are coerced to `error`. Alternative: let contestants emit only optional
IDs — rejected because the Codex selector's natural output is a full route
and the uniform contract should not preprocess it.

### Gold model: multiple accepted routes plus mandatory/forbidden sets

Each case's gold lists every accepted exact optional-skill route, the
gold-mandatory skills that must be a subset of the case's forced skills, and
forbidden skills disjoint from all accepted routes and from the forced
set. Valid-route correctness is exact membership of the optional
selection in the accepted set. FP/FN use the closest accepted route:
minimum `|FP|+|FN|`, then fewest FN (misses cost more than extra noise in
this corpus), then lexicographically smallest sorted-ID serialization —
a stable, documented tie-break. `abstain`/`error` score as incorrect and
count as an empty optional selection for FP/FN. Alternative: score FP/FN
against the union or intersection of accepted routes — rejected because it
under- or over-counts when accepted routes differ in size.

### Corpus shape and fingerprints

Three frozen fixtures — skill manifest, cases, gold — are stored
separately so the contestant path never loads gold. The 60-case balance
scales doc-013's holdout proportions (60:90:60:30) to the dev size: 15
zero-skill, 22 one-skill, 15 two-skill, 8 three-skill cases, 30/30 RU/EN,
12 per doc-013 stratum (`bug`, `function`, `plan`, `research`, `review`
kept verbatim as a `stratum` label rather than coerced into the router's
seven-value task-type enum). Fingerprints reuse the canonical-JSON SHA-256
pattern and are pinned as constants, as `calibration-cli` already does.
Alternative: reuse `TaskType` for strata — rejected because `bug` and
`function` annotate the corpus, not the router's signal vocabulary.

All 60 development cases are authored from public synthetic material for
this lab; no private, corporate, or session-derived text is sanitized into
the corpus. Two annotators independently label every case from the frozen
manifest and rubric, and a third adjudicates every disagreement before the
gold fingerprint is pinned. Annotation provenance contains stable roles and
the rubric version only, never names or timestamps.

### Frozen context-token counts instead of a shipped tokenizer

Doc-013's skill-context metric needs one frozen tokenizer. The dev arena
freezes the tokenizer's *output* instead: each manifest skill carries a
`contextTokens` integer produced by a recorded counting procedure, so
scoring stays offline and byte-identical. Alternative: vendor a tokenizer
— rejected; it adds a dependency and a second source of nondeterminism.

### Deterministic run directory and identical-or-fail writes

One package-script command regenerates `artifacts/arena/dev-<prefix>/`
(`<prefix>` = first 12 hex digits of the combined frozen-input
fingerprint) containing `manifest.json` with every input fingerprint,
`cases.json`, `gold.json`, `runs/<contestant>.jsonl`, and
`scoreboard.json` — all canonical JSON, fixed ordering, no wall-clock or
random fields. Contestants run offline in fixed order; the scorer consumes
the recorded run files, enforcing the isolation boundary. Re-running with
unchanged inputs is byte-identical; a pre-existing file with different
bytes fails closed instead of being overwritten — the create-once evidence
convention adapted to a regenerable artifact. Alternative: timestamped
run IDs — rejected; they defeat byte-identical repeatability.

## Risks / Trade-offs

- [60 development cases are weak evidence for quality claims] → The
  scoreboard is marked `development` scope and cannot emit a verdict;
  tuning conclusions are provisional until the holdout protocol exists.
- [Replayed Jev responses are not live model evidence] → Scoreboard reports
  them as recorded outputs; the spec forbids production claims, and a
  later change owns live execution.
- [The rules baseline can be tuned against the dev corpus] → Acceptable:
  dev tuning is the arena's purpose; the frozen trigger table is
  fingerprinted so any tuning is a visible corpus-level diff.
- [Codex fixture may drift from the real selector] → The manifest records
  the fixture fingerprint; updating it is an explicit reviewed change, and
  doc-013's decisive run still requires the real selector.
- [Fingerprint pinning makes fixture updates toil] → Same trade-off the
  calibration change accepted: frozen inputs are the point.

## Migration Plan

1. Land the corpus/manifest/gold fixtures and validators with pinned
   fingerprints; no existing file changes behavior.
2. Add the contestant contract and the three adapters behind new modules;
   the existing router and calibration paths are untouched.
3. Add the scorer, run-directory writer, and the package script.
4. Verify locally: focused tests, lint, strict typecheck, byte-identical
   double-run, strict OpenSpec validation.
5. Rollback is `git` removal of the added files; nothing else depends on
   the arena.

## Deferred Decisions

- Whether the later decisive-protocol change reuses this scorer with a
  bootstrap layer on top — deferred to that change's design.
