# Tasks

## 1. Frozen corpus, manifest, and gold fixtures

- [x] 1.1 Write failing tests for corpus validation: exactly 60 public synthetic cases; 30/30 RU/EN; 12 per stratum; 15/22/15/8 optional-skill distribution by largest accepted route; unique case IDs; shared family IDs keep one language and stratum; accepted routes are unique sets of zero to three non-forced, non-forbidden manifest skills; gold-mandatory skills are a subset of forced skills; zero-skill cases hold exactly the empty route; every gold record has two independent labels and adjudication provenance
- [x] 1.2 Write failing tests for manifest validation and canonical SHA-256 fingerprint pinning of manifest, cases, and gold, including mismatch rejection
- [x] 1.3 Author the sanitized corpus, manifest with frozen `contextTokens`, gold labels, frozen rules trigger table, recorded Codex outputs, and recorded Jev pass responses under `fixtures/arena/`; pin every fingerprint constant; verify corpus tests pass

## 2. Contestant contract

- [x] 2.1 Write failing tests for the closed `ok | abstain | error` result: invalid route (unknown, duplicate, or >3 optional skills) coerces to `error`; unobserved usage/cost/latency serialize as `null`; identical case input serializes byte-identically for all three contestants and carries no gold or stratum fields
- [x] 2.2 Implement the typed arena input/result contract and result validation; verify focused tests, lint, and strict typecheck pass

## 3. Codex fixture adapter

- [x] 3.1 Write failing tests: verbatim replay of a recorded route; `error` on missing, malformed, or out-of-manifest records; recorded telemetry passes through or is `null`; no subprocess, hook, network, or non-fixture read is reachable
- [x] 3.2 Implement the Codex fixture adapter; verify focused tests pass

## 4. Rules contestant

- [x] 4.1 Write failing tests: deterministic byte-identical output on repeat runs; forced skills always present in the effective route; frozen trigger-table fingerprint enforced; no gold or competitor access
- [x] 4.2 Implement the deterministic rules contestant; verify focused tests pass

## 5. Jev adapter behind the existing router

- [x] 5.1 Write failing tests: case input maps to router input with fixed revision, frozen policy version, manifest fingerprint as catalogue hash, and empty candidate lists; `ok` decision yields the forced ∪ candidates route; each `fallback` reason yields `abstain`; invocation without an injected gateway fails before any call; the replay gateway serves only recorded pass responses and rejects unexpected calls; the adapter constructs no provider client and reads no credential environment
- [x] 5.2 Implement the Jev adapter and recorded-response replay gateway reusing `routeWithTelemetry`; verify focused tests pass and default tests need no provider credential

## 6. Deterministic scorer and scoreboard

- [x] 6.1 Write failing tests: exact membership in any accepted route scores correct; `abstain`/`error` score incorrect as empty selections; closest-route FP/FN with the documented tie-break (minimum |FP|+|FN|, fewest FN, lexicographically smallest serialization); mandatory, high-risk mandatory, and forbidden counting; zero-skill false-positive rate; micro precision/recall; autonomous coverage; `contextTokens` totals; nearest-rank p50/p95 and `null` aggregates over missing observations; Jev-with-Codex-fallback diagnostic; zero denominators yield `null`; fixed contestant and case ordering
- [x] 6.2 Implement the pure deterministic scorer over recorded run outputs plus gold; verify focused tests pass

## 7. Regeneration command and run artifacts

- [x] 7.1 Write failing tests: one command writes `artifacts/arena/dev-<12-hex-prefix>/` with `manifest.json` (all input fingerprints), `cases.json`, `gold.json`, `runs/<contestant>.jsonl` in fixed contestant order, and `scoreboard.json`; a second run over unchanged inputs is byte-identical; a conflicting pre-existing file fails without overwrite; frozen-input mismatch fails before any run; scoring reads recorded `runs/` files rather than contestant internals
- [x] 7.2 Implement the arena CLI and run writer with canonical-JSON identical-or-fail semantics, wire the package script, and add `dev-skill-routing-arena` to the `check:openspec` chain; verify the command regenerates the scoreboard end to end

## 8. Final verification

- [ ] 8.1 Run the complete local gate (lint, strict typecheck, all tests offline without credentials, strict OpenSpec validation including the new change) and the byte-identical double-run check; record exact results
- [ ] 8.2 Obtain independent review of the corpus safety fields, scorer tie-breaks, isolation boundary, and opt-in gateway boundary; fix important findings and repeat targeted gates
