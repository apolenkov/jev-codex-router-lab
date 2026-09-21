# jev-codex-router-lab

An isolated TypeScript lab that evaluates whether TypeSafe Jev can serve as
an advisory semantic layer for skill and context selection. Jev proposes;
deterministic policy decides. The lab never modifies or operates the working
Codex installation and only accepts public, synthetic, or anonymized input.

## Boundary

- Input: one JSON-compatible task file with an allowlisted skill catalogue
  and optional allowlisted candidates (critical gaps, architecture forks,
  reuse candidates, context fragments).
- Output: a typed `RouterDecision` — `ok` with seven advisory signals, or
  `fallback` with a machine-readable reason. Both preserve mandatory
  (explicit + required) skills and deterministic protected-context IDs.
- Mandatory skills are uncapped and always preserved; optional Jev
  recommendations are capped at three and must reference allowlisted IDs.
- Pass 1 sends the permitted task text (at most 8,000 UTF-16 code units) plus
  skill IDs/descriptions; pass 2 sends the same task text plus only the
  shortlisted skills' descriptions and excerpts. Every other Jev-facing
  free-text field is limited to 4,000 UTF-16 code units. Protected-context
  IDs remain in the decision, while their IDs and bodies and all
  non-shortlisted excerpts are excluded from Jev. Therefore live use is
  limited to public, synthetic, or explicitly anonymized task text and
  catalogue content.
- The semantic layer never gains authority: no permissions, no commands, no
  execution, no private or corporate data.

## Layout

- `src/contracts.ts` — closed types for the routing boundary.
- `src/policy.ts` — deterministic `precheck` / `postcheck`.
- `src/router.ts` — safe two-pass orchestration and typed fallback.
- `src/telemetry.ts` — metadata-only usage, latency, and cost reporting.
- `src/cli.ts` — strict local JSON-file CLI.
- `test/` — `node:test` suites over compiled `dist/` output.
- `openspec/changes/build-jev-router-lab/` — proposal, design, spec delta,
  and task ledger for this change.

## Commands

- `npm run build` — compile to `dist/`.
- `npm run typecheck` — strict `tsc --noEmit`.
- `npm run lint` — ESLint recommended + typescript-eslint recommended.
- `npm test` — build, then run `node --test dist/test/*.test.js`.
- `npm run check` — lint + typecheck + tests + strict OpenSpec validation.
- `npm run route -- --input <json-file> [--report <json-file>]` — build and
  run one routing decision.

## Smoke workflow

Run the local gate twice before any live smoke:

```bash
npm ci
npm run check
git diff --check
```

Check only whether the credential is present; never print it. After the owner
authorizes a live run and the check reports `TYPESAFE_API_KEY=present`, run:

```bash
test -n "${TYPESAFE_API_KEY:-}" && \
  printf "TYPESAFE_API_KEY=present\n" && \
  npm run route -- --input fixtures/smoke-input.json --report artifacts/smoke-report.json
```

The smoke report is create-once. Re-running with the same report path fails
instead of replacing evidence; inspect and deliberately remove an incomplete
report, or choose a new path, before another authorized run.

## CLI contract

The CLI accepts exactly one `--input` JSON file and an optional `--report`
path. The report must be inside this repository, its parent directory must
already exist, and the target must not already exist as any file type. Reports
are create-once: the CLI never overwrites them. The input is opened once and
both identified and read through that descriptor; the input and report must
not resolve to the same path or inode. On macOS and Linux, the final report is
created before routing with `O_CREAT | O_EXCL | O_NOFOLLOW`, retained open, and
written and synced only through that descriptor. Renaming an ancestor after
open cannot redirect the write. Other platforms are rejected explicitly
rather than using a weaker path. Unknown, missing, or repeated flags are
invalid; there is no API-key flag. `TYPESAFE_API_KEY` is read only by the live
SDK factory after the JSON parses and passes deterministic precheck, including
the reserved `none` ID rule, and after any requested report is safely opened.

If a failure occurs after a new report has been created, the CLI closes its
descriptor but deliberately does not remove or rename the path. The new file
may therefore be empty or partial and require manual inspection and removal;
the fixed diagnostic says so. Existing data is never replaced by this path.

A valid run prints exactly one `RouterDecision` JSON object. Both `ok` and safe
service/model `fallback` decisions exit 0. Invalid CLI usage, unreadable or
invalid local JSON, `invalid-input`, and report-path/write failures exit 2.

Optional reports contain accounting metadata only: decision status, logical
call count, per-pass and total latency, model, token usage, observable retry
counts, and `cacheStatus: "not-used"`. They exclude task text, skill bodies,
context bodies, request/response payloads, and exception messages. Cost is
calculated only when at least one pass has observable usage and both
`TYPESAFE_INPUT_USD_PER_MILLION` and
`TYPESAFE_OUTPUT_USD_PER_MILLION` are finite non-negative numbers. Missing or
invalid prices produce `price-not-configured`; zero or incomplete observed
pass usage produces `usage-not-observable`; a non-finite calculation produces
`cost-overflow`. All three cases keep `costUsd: null`.
