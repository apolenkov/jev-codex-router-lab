# Design

## Context

Greenfield isolated repository. See `proposal.md` for motivation. The binding
behaviors are the `advisory-routing` delta spec and the lab specification
(doc-005): Jev is an untrusted semantic sensor; deterministic code owns
policy, allowlists, and workflow. Inputs are JSON-compatible local files with
synthetic/public content only.

## Goals / Non-Goals

**Goals:**

- A typed `RouterInput` → `RouterDecision` pipeline: `precheck` → Jev
  (two passes) → `postcheck`.
- Seven advisory signals over allowlisted stable IDs only.
- `fallback` is always safe: it preserves mandatory skills, carries a
  machine-readable `FallbackReason`, and never leaks unverified output.
- Reproducible gates: strict `tsc`, ESLint recommended rules, `node:test`,
  `openspec validate --strict`.

**Non-Goals:**

- No integration with the working Codex/Devin harness, no dynamic catalogue
  mutation, no execution of recommendations.
- No databases, servers, or plugin systems; the only runtime dependency is
  `@typesafe-ai/sdk`.
- The smoke run proves operability only (`n=1`), not quality or economy.

## Decisions

### 1. Closed contracts in `src/contracts.ts`

`TaskType`, `RiskDimension`, and `FallbackReason` are string-literal unions —
closed sets, validated at the boundary. `AdvisorySignals` is the seven-signal
payload. `RouterInput` carries the task, policy/catalogue versions, explicit
and required skill IDs, the allowlisted skill catalogue, and optional
candidate lists (critical gaps, forks, reuse, context fragments with an
optional `protected` flag).

### 2. Echo envelope for staleness

`SemanticResponse` extends `AdvisorySignals` with a required `echo` of
`taskId`, `taskRevision`, `policyVersion`, and `catalogHash`. The semantic
layer must prove it answered the request it was given; postcheck compares the
echo and rejects mismatches as `stale-decision`. Alternative considered:
transport-level request IDs — rejected, the echo keeps the check inside the
typed contract and works with any client.

### 3. `precheck` throws, `postcheck` returns a decision

`precheck(input): PrecheckedInput` validates input shape (non-empty version
fields, positive integer `taskRevision`, unique candidate IDs, every
explicit/required skill ID present in the catalogue allowlist) and throws a
typed `PolicyError` carrying `reason: "invalid-input"` on violation. It
computes `forcedSkillIds` — the order-preserving deduplicated union of
explicit then required skills, uncapped — and `protectedContextIds` from
fragments marked `protected`. Throwing keeps the success signature clean;
the router (later task) converts the error into the `fallback` decision.
Alternative considered: returning a result union — rejected, it forces every
caller to unwrap and blurs the difference between untrusted input (a bug at
the boundary) and untrusted model output (an expected event).

`postcheck(input, semantic): RouterDecision` never throws for semantic
violations; it returns `{ status: "fallback", reason, forcedSkillIds }` or
`{ status: "ok", signals, forcedSkillIds }`.

### 4. Postcheck check order

Deterministic order, first failure wins:

1. Shape: `taskType` in the closed union; all five risk dimensions present
   and numeric; every `contextRelevance` probability a finite number in
   `[0, 1]` → `malformed-response`.
2. Echo equality → `stale-decision`.
3. Allowlist membership for every referenced ID (skills, gap, fork, reuse,
   fragments) → `unknown-id`.
4. Duplicate IDs in `skillCandidates` or `contextRelevance` →
   `malformed-response`.
5. Optional skills (candidates not in `forcedSkillIds`) > 3 →
   `malformed-response`.

Shape first because a malformed payload cannot be trusted for comparison;
staleness before content checks because a stale answer is discarded whole.

### 5. Canonical re-derivation, not echoed payloads

For selected `criticalGap`, `architectureFork`, `reuseCandidate`, and ranked
`contextRelevance` entries, postcheck re-derives the stored fields
(`fact`/`blocks`, `alternatives`/`tradeoff`, `summary`) from the input
candidate records keyed by the chosen ID. The model's free text is never
trusted; only its ID selections survive. Alternative considered: validating
that echoed fields match — rejected, re-derivation is strictly safer and
simpler.

### 6. Mandatory uncapped, optional capped at three

`forcedSkillIds` (explicit ∪ required) is never capped — mandatory
instructions are always included. Optional Jev recommendations are capped at
three; exceeding the cap is a contract violation → `fallback`, not silent
truncation, because a model that ignores its own output contract is
untrustworthy for the rest of the payload.

### 7. Two-pass gateway (later tasks)

Pass 1 batches narrow judgments producing all seven signals plus a skill
shortlist. Pass 2 verifies the shortlisted skills against full descriptions
and bounded excerpts, yielding zero to three verified optional skills.
Retries are bounded; timeout/service failure → `fallback`
(`service-error`); per-signal confidence below configured threshold →
`low-confidence`. Thresholds are experiment configuration.

### 8. Minimal dependency surface

`node:test` for tests, `tsc` for build — no test framework or build tooling
beyond the SDK and lint/type packages, all pinned to exact versions.

## Risks / Trade-offs

- Strict postcheck over-rejects borderline responses → `fallback` is the
  safe outcome; mandatory skills survive and nothing unverified leaks.
- Echo requirement couples the response contract to request metadata →
  intentional; staleness must be detectable in-process.
- Advisory value is lost on every fallback → acceptable for a lab whose
  purpose is measuring whether the advice is trustworthy at all.
- Candidate IDs must be supplied by code, so recall is bounded by what the
  caller provides → documented limitation; Jev never searches on its own.

## Open Questions

- Per-signal confidence threshold values — experiment configuration set when
  the gateway lands, not a contract decision.
- Whether the exact-match response cache is needed for smoke repeatability —
  decided when the smoke flow is measured.
