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
  `fallback` with a machine-readable reason and the preserved mandatory
  (explicit + required) skills.
- Mandatory skills are uncapped and always preserved; optional Jev
  recommendations are capped at three and must reference allowlisted IDs.
- The semantic layer never gains authority: no permissions, no commands, no
  execution, no private or corporate data.

## Layout

- `src/contracts.ts` — closed types for the routing boundary.
- `src/policy.ts` — deterministic `precheck` / `postcheck`.
- `test/` — `node:test` suites over compiled `dist/` output.
- `openspec/changes/build-jev-router-lab/` — proposal, design, spec delta,
  and task ledger for this change.

## Commands

- `npm run build` — compile to `dist/`.
- `npm run typecheck` — strict `tsc --noEmit`.
- `npm run lint` — ESLint recommended + typescript-eslint recommended.
- `npm test` — build, then run `node --test dist/test/*.test.js`.
- `npm run check` — lint + typecheck + tests + strict OpenSpec validation.
- `npm run route` — build and run the CLI on a JSON input file (lands with
  the router task).
