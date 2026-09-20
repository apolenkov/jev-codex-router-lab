# Proposal

## Why

Codex skill and context selection is currently deterministic and manual: a
task names skills explicitly or relies on policy-required lists. We want to
evaluate whether TypeSafe Jev can act as an advisory semantic layer that
proposes relevant optional skills, missing-fact flags, reuse candidates,
architecture forks, risk dimensions, and context-fragment relevance —
without ever gaining authority over workflow, permissions, or execution.
The lab must run in isolation: it never modifies or operates the working
Codex installation and never sees private or corporate data.

## What Changes

- Initialize an isolated TypeScript package (`jev-codex-router-lab`) with
  strict typecheck, ESLint, and `node:test` gates.
- Define closed typed contracts for the routing boundary: `RouterInput`,
  `PrecheckedInput`, `AdvisorySignals`, `SemanticResponse`, `RouterDecision`,
  `FallbackReason`.
- Implement deterministic `precheck()` — input validation, allowlist
  enforcement, and mandatory-skill resolution before any model call.
- Implement deterministic `postcheck()` — stale-echo rejection, allowlist
  validation, duplicate rejection, optional-skill cap, probability range
  checks; produces a typed `ok` or `fallback` decision.
- Add a Jev semantic gateway (two passes) that produces the seven advisory
  signals from allowlisted identifiers only.
- Add a router that composes precheck, gateway, and postcheck, with bounded
  retries and safe fallback, plus a local CLI for inspection.
- Add synthetic fixtures and a single live smoke run proving operability
  only (`n=1`), with latency and usage measurement.

## Capabilities

### New Capabilities

- `advisory-routing`: Deterministic precheck/postcheck policy boundary and
  the typed advisory routing decision (seven signals, allowlisted
  identifiers only, safe fallback preserving mandatory skills).

### Modified Capabilities

(None — greenfield repository with no existing specs.)

## Impact

- New standalone repository at `/Users/wrk/work/jev-codex-router-lab`;
  no changes to the working Codex installation or harness.
- Dependencies: `@typesafe-ai/sdk` (pinned), TypeScript, ESLint,
  typescript-eslint, `@types/node` — all dev tooling is local to the lab.
- Data boundary: inputs are public, synthetic, or anonymized; logs carry
  structured metadata and identifiers only.
