# Development Skill-Routing Arena Implementation Plan

> **For implementer:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task. Use TDD for every behavior change and `superpowers:verification-before-completion` before claiming completion.

**Goal:** Add one deterministic, offline development arena that replays Jev and Codex fixtures plus a rules baseline over a frozen 60-case corpus and emits a byte-identical scoreboard.

**Architecture:** Keep the arena as a narrow TypeScript feature inside this repository. Reuse the existing router, semantic gateway contract, canonical fingerprint helper, and Node test runner. Separate fixture parsing, contestant adapters, pure scoring, and the CLI so gold never reaches contestants and no default path can call a provider.

**Tech Stack:** TypeScript 6, Node.js 20 standard library, `node:test`, existing `@typesafe-ai/sdk` transitively through the current router only, OpenSpec CLI.

**Spec:** `openspec/changes/dev-skill-routing-arena/`

## Owner-approved execution decisions

- The v0 Jev replay is synthetic and exists only to exercise the arena harness; it is not evidence of live-model quality.
- Gold labels are produced by two independent fresh agents and resolved by a third fresh adjudicator; the committed provenance records stable roles, not identities.
- `artifacts/arena/` remains generated and untracked. The repository ships the frozen fixtures, tests, command, and documentation needed to reproduce it.

## Global constraints

- Implement only the approved 60-case development arena. No holdout, winner declaration, live Jev/Codex calls, hooks, UI, server, database, generic plugin framework, or new dependency.
- All fixture text is public and synthetic. Never copy session, corporate, private, credential, path, or user-derived content into fixtures.
- Contestants receive the same canonical projection and never receive gold, risk, stratum, source class, family ID, or competitor output.
- The CLI must be offline by construction. The Jev adapter requires an injected `SemanticGateway`; the default command injects replay only. Codex reads only its frozen fixture.
- Reuse `canonicalFingerprint` from `src/calibration-runner.ts`; do not introduce a second canonical JSON algorithm. Extract/export the existing serializer only if artifact bytes require it.
- Use `null` for unknown telemetry. Never infer zeros.
- Generated artifacts are repository evidence, not mutable cache: canonical order, no time/random fields, identical-or-fail, no silent overwrite.
- Keep commits scoped to the task named below. Do not mix backlog, publication, or unrelated cleanup.

## Review focus

1. Gold isolation: no contestant API or adapter can access gold or hidden case metadata.
2. Jev boundary: no provider construction, credential lookup, environment lookup, or network path exists in arena code.
3. Scoring: accepted-route selection and tie-break exactly match the OpenSpec, including abstain/error accounting and zero denominators.
4. Reproducibility: frozen fingerprints are checked before contestant invocation; a second run is byte-identical; conflicts fail closed.
5. Corpus invariants: exact 60-case balance, annotation provenance, forced/mandatory/forbidden disjointness, and public-synthetic classification are executable checks.

## Task 1: Add closed arena contracts and validators

**Files:**

- Create: `src/arena-contracts.ts`
- Create: `test/arena-contracts.test.ts`

**Step 1: Write failing contract tests**

Cover exact-key parsing and rejection for:

- manifest entries `{ id, description, excerpt, contextTokens }`;
- 60 cases with IDs, family, language, stratum, source, risk, task text, explicit and required skills;
- gold with one or more accepted routes, mandatory subset of forced skills, forbidden disjoint from accepted and forced, and two-label-plus-adjudication provenance;
- contestant result union `ok | abstain | error` with four nullable telemetry fields;
- duplicate/unknown IDs and more than three optional skills converted to `error`.

Use representative valid objects and one failing assertion per invariant before loading the full fixtures.

```ts
const result: ArenaResult = {
  caseId: "case-001",
  contestantId: "rules",
  status: "ok",
  selectedSkillIds: ["systematic-debugging"],
  reason: null,
  inputTokens: null,
  outputTokens: null,
  latencyMs: null,
  costUsd: null,
};
```

**Step 2: Run the focused test and confirm RED**

Run: `npm run build --silent && node --test dist/test/arena-contracts.test.js`

Expected: build fails because `src/arena-contracts.ts` does not exist.

**Step 3: Implement the smallest strict parser**

Export only the types and functions needed downstream:

```ts
export type ArenaContestantId = "jev" | "codex" | "rules";
export type ArenaStatus = "ok" | "abstain" | "error";
export type ArenaStratum = "bug" | "function" | "plan" | "research" | "review";

export function parseArenaManifest(value: unknown): ArenaSkillManifest;
export function parseArenaCases(value: unknown, manifest: ArenaSkillManifest): readonly ArenaCase[];
export function parseArenaGold(value: unknown, cases: readonly ArenaCase[], manifest: ArenaSkillManifest): ArenaGold;
export function normalizeArenaResult(input: ArenaContestantResultInput, arenaInput: ArenaContestantInput): ArenaResult;
```

Use local type guards and sorted unique arrays. Do not build a schema framework or add a validation library.

**Step 4: Run the focused test and confirm GREEN**

Run: `npm run build --silent && node --test dist/test/arena-contracts.test.js`

Expected: all arena contract tests pass.

**Step 5: Commit**

```bash
git add src/arena-contracts.ts test/arena-contracts.test.ts
git commit -m "feat: add arena contracts"
```

## Task 2: Freeze manifest, cases, gold, and fingerprints

**Files:**

- Create: `fixtures/arena/skill-manifest.json`
- Create: `fixtures/arena/dev-cases.json`
- Create: `fixtures/arena/dev-gold.json`
- Create: `fixtures/arena/rubric-v1.md`
- Create: `fixtures/arena/fingerprints.json`
- Create: `test/arena-fixtures.test.ts`

**Step 1: Write failing fixture invariant tests**

Assert the exact approved denominators:

```ts
assert.equal(cases.length, 60);
assert.deepEqual(countBy(cases, ({ language }) => language), { en: 30, ru: 30 });
assert.deepEqual(countBy(cases, ({ stratum }) => stratum), {
  bug: 12, function: 12, plan: 12, research: 12, review: 12,
});
assert.deepEqual(countBy(cases, largestAcceptedRouteSize), {
  "0": 15, "1": 22, "2": 15, "3": 8,
});
```

Also assert every source is `synthetic | hard-negative | minimal-pair`, all prose is intentionally public synthetic, related family members share language/stratum, zero-skill cases have exactly `[[]]`, provenance contains stable roles plus the version declared by `rubric-v1.md` only, and all three stored SHA-256 values equal `canonicalFingerprint` of the parsed manifest, cases, and gold.

**Step 2: Run the focused test and confirm RED**

Run: `npm run build --silent && node --test dist/test/arena-fixtures.test.js`

Expected: fixture reads fail because frozen files do not exist.

**Step 3: Author the frozen fixtures**

Use a small, bounded skill manifest drawn from the public skill IDs relevant to development routing. Author 60 concise synthetic prompts. Freeze a concise, versioned labeling rubric at `fixtures/arena/rubric-v1.md`; give both independent labelers the same rubric, manifest, and cases, then have the adjudicator resolve every disagreement. Do not record people or timestamps.

`fingerprints.json` starts with exact keys `schemaVersion`, `skillManifest`,
`cases`, and `gold`; each fingerprint value must match `^[0-9a-f]{64}$` and
the canonical fingerprint computed by the test.

During this task, tests may load a partial fingerprint object containing only the first three hashes; Task 5 replaces it with the final exact shape before the arena CLI exists.

**Step 4: Run the focused test and confirm GREEN**

Run: `npm run build --silent && node --test dist/test/arena-fixtures.test.js`

Expected: all fixture and balance checks pass.

**Step 5: Commit**

```bash
git add fixtures/arena/skill-manifest.json fixtures/arena/dev-cases.json fixtures/arena/dev-gold.json fixtures/arena/fingerprints.json test/arena-fixtures.test.ts
git commit -m "test: freeze arena development corpus"
```

## Task 3: Add the replay gateway and Jev contestant

**Files:**

- Create: `src/arena-contestants.ts`
- Create: `fixtures/arena/jev-replay.json`
- Create: `test/arena-contestants.test.ts`
- Modify: `fixtures/arena/fingerprints.json`

**Step 1: Write failing Jev adapter tests**

Test that:

- all non-skill signal candidate arrays are empty in the mapped `RouterInput`;
- task revision and policy version are fixed and catalogue hash is the manifest fingerprint;
- `routeWithTelemetry` is used through an injected gateway;
- no gateway means failure before routing;
- `ok` unions forced skills with returned optional skills;
- router `fallback` becomes `abstain` preserving its reason and forced skills in the record;
- replay rejects an unexpected case/pass/shortlist;
- two full replay runs are deeply equal.

```ts
const contestant = createJevContestant({ gateway: replayGateway, manifestFingerprint });
const result = await contestant.run(input);
assert.equal(result.status, "ok");
```

**Step 2: Run the focused test and confirm RED**

Run: `npm run build --silent && node --test dist/test/arena-contestants.test.js`

Expected: missing arena contestant module.

**Step 3: Implement the injected replay path**

Keep a single contestant function shape:

```ts
export interface ArenaContestant {
  readonly id: ArenaContestantId;
  run(input: ArenaContestantInput): Promise<ArenaResult>;
}

export function createJevContestant(options: {
  gateway: SemanticGateway;
  manifestFingerprint: string;
}): ArenaContestant;
```

The replay gateway implements the existing `SemanticGateway`; it validates its frozen fixture before serving responses and never imports `TypeSafeClient`.

**Step 4: Freeze replay responses and fingerprint**

Record pass 1 and, where required, pass 2 semantic responses for all 60 cases. Keep telemetry deterministic; if a value was not actually observed, store `null` at the arena-result boundary rather than fabricating it.

**Step 5: Run focused tests and confirm GREEN**

Run: `npm run build --silent && node --test dist/test/arena-contestants.test.js`

Expected: Jev contestant/replay tests pass without credentials or network.

**Step 6: Commit**

```bash
git add src/arena-contestants.ts fixtures/arena/jev-replay.json fixtures/arena/fingerprints.json test/arena-contestants.test.ts
git commit -m "feat: add offline Jev arena contestant"
```

## Task 4: Add Codex fixture contestant

**Files:**

- Modify: `src/arena-contestants.ts`
- Create: `fixtures/arena/codex-replay.json`
- Modify: `fixtures/arena/fingerprints.json`
- Modify: `test/arena-contestants.test.ts`

**Step 1: Write failing Codex replay tests**

Cover valid verbatim replay, nullable telemetry, missing case, malformed shape, duplicate skill, unknown skill, and over-three optional skills. Inject a fixture object into the adapter; do not let it read arbitrary paths.

```ts
export function createCodexFixtureContestant(
  fixture: unknown,
  manifest: ArenaSkillManifest,
): ArenaContestant;
```

**Step 2: Run the focused test and confirm RED**

Run: `npm run build --silent && node --test dist/test/arena-contestants.test.js`

Expected: Codex adapter assertions fail.

**Step 3: Implement exact fixture projection**

Validate once at construction and index by case ID. The adapter may consult only the validated in-memory map. It must not import `child_process`, hooks, Codex APIs, provider clients, or networking modules.

**Step 4: Freeze outputs and update fingerprint**

Create one structured record per case. Unknown telemetry stays `null`.

**Step 5: Run focused tests and confirm GREEN**

Run: `npm run build --silent && node --test dist/test/arena-contestants.test.js`

Expected: all Jev and Codex contestant tests pass offline.

**Step 6: Commit**

```bash
git add src/arena-contestants.ts fixtures/arena/codex-replay.json fixtures/arena/fingerprints.json test/arena-contestants.test.ts
git commit -m "feat: add Codex fixture contestant"
```

## Task 5: Add deterministic rules contestant

**Files:**

- Modify: `src/arena-contestants.ts`
- Create: `fixtures/arena/rules.json`
- Modify: `fixtures/arena/fingerprints.json`
- Modify: `test/arena-contestants.test.ts`

**Step 1: Write failing rules tests**

Assert ordered, frozen trigger evaluation from task text and public contestant input only; forced skills are always retained; repeated runs and property insertion order yield identical results; no gold or filesystem argument is accepted.

**Step 2: Run the focused test and confirm RED**

Run: `npm run build --silent && node --test dist/test/arena-contestants.test.js`

Expected: rules contestant assertions fail.

**Step 3: Implement the smallest ordered trigger table evaluator**

Use literal/regular-expression rules loaded and validated once from `rules.json`. Stop after three optional skills. Avoid a DSL, plugin registry, weights, or learned ranking.

**Step 4: Pin the final fixture fingerprint object**

Make `fingerprints.json` exact and require all six hashes: manifest, cases, gold, rules, Jev replay, Codex replay.

**Step 5: Run focused tests and confirm GREEN**

Run: `npm run build --silent && node --test dist/test/arena-contestants.test.js dist/test/arena-fixtures.test.js`

Expected: rules determinism and every frozen fingerprint pass.

**Step 6: Commit**

```bash
git add src/arena-contestants.ts fixtures/arena/rules.json fixtures/arena/fingerprints.json test/arena-contestants.test.ts test/arena-fixtures.test.ts
git commit -m "feat: add rules arena contestant"
```

## Task 6: Implement the pure deterministic scorer

**Files:**

- Create: `src/arena-scorer.ts`
- Create: `test/arena-scorer.test.ts`

**Step 1: Write failing scorer tests**

Build small table-driven cases for:

- exact match against any accepted optional route;
- closest route by `FP + FN`, then fewest FN, then sorted lexicographic serialization;
- `abstain` and `error` treated as empty optional selection for FP/FN and incorrect for accuracy;
- mandatory/high-risk mandatory misses and forbidden hits;
- zero-skill false-positive rate;
- micro precision/recall and zero-denominator `null`;
- autonomous coverage;
- selected effective-route context tokens;
- nullable sums and nearest-rank p50/p95;
- Jev-with-Codex-fallback replacing only Jev abstentions whose Codex result is `ok`;
- fixed contestant order and case-ID order.

**Step 2: Run the focused test and confirm RED**

Run: `npm run build --silent && node --test dist/test/arena-scorer.test.js`

Expected: missing scorer module.

**Step 3: Implement pure scoring functions**

```ts
export function scoreArena(input: {
  manifest: ArenaSkillManifest;
  cases: readonly ArenaCase[];
  gold: ArenaGold;
  runs: Readonly<Record<ArenaContestantId, readonly ArenaResult[]>>;
}): ArenaScoreboard;
```

Keep helper functions local unless tests require a pure export. Sort before comparing or serializing. Implement nearest rank as `sorted[Math.ceil(p * n) - 1]` for non-empty observations.

**Step 4: Run focused tests and confirm GREEN**

Run: `npm run build --silent && node --test dist/test/arena-scorer.test.js`

Expected: all scoring and aggregate tests pass.

**Step 5: Commit**

```bash
git add src/arena-scorer.ts test/arena-scorer.test.ts
git commit -m "feat: add deterministic arena scorer"
```

## Task 7: Add deterministic artifact writer and CLI

**Files:**

- Create: `src/arena-cli.ts`
- Create: `test/arena-cli.test.ts`
- Modify: `src/calibration-runner.ts`
- Modify: `package.json`

**Step 1: Write failing end-to-end CLI tests**

In a temporary repository copy, assert one command writes exactly:

```text
artifacts/arena/dev-<combined-fingerprint-prefix>/
  manifest.json
  cases.json
  gold.json
  runs/jev.jsonl
  runs/codex.jsonl
  runs/rules.jsonl
  scoreboard.json
```

Test preflight fingerprint mismatch before any contestant call, canonical file bytes, fixed ordering, no timestamps/random IDs, scoring from recorded run files, byte-identical second execution, acceptance of identical existing files, and rejection of one conflicting byte without overwrite.

**Step 2: Run the focused test and confirm RED**

Run: `npm run build --silent && node --test dist/test/arena-cli.test.js`

Expected: missing CLI module/script.

**Step 3: Expose the existing canonical serializer**

Rename the private `canonicalJson` export only as needed:

```ts
export const canonicalJson = (value: unknown): string => { /* existing body unchanged */ };
```

Do not move or duplicate its implementation. Existing calibration tests must remain green.

**Step 4: Implement preflight, execution, recording, and scoring**

The CLI sequence is fixed:

1. read six known fixture paths;
2. parse and validate all fixtures;
3. verify every pinned fingerprint;
4. derive the combined fingerprint and output directory;
5. run contestants in `jev`, `codex`, `rules` order over cases sorted by ID;
6. write canonical JSON/JSONL with identical-or-fail semantics;
7. reread run files;
8. score those recorded files and write `scoreboard.json` last.

Reuse Node `fs/promises`; copy the create-once comparison behavior from the calibration writer only where required. Do not generalize it into a storage framework.

**Step 5: Wire scripts and OpenSpec validation**

Add:

```json
"arena:dev": "npm run build --silent && node dist/src/arena-cli.js"
```

Extend `check:openspec` with:

```text
openspec validate dev-skill-routing-arena --strict --no-interactive
```

**Step 6: Run focused and regression tests**

Run: `npm run build --silent && node --test dist/test/arena-cli.test.js dist/test/calibration-runner.test.js`

Expected: CLI and unchanged calibration writer tests pass.

Run twice: `npm run arena:dev && npm run arena:dev`

Expected: both exit 0; second run makes no byte changes.

**Step 7: Commit**

```bash
git add src/arena-cli.ts src/calibration-runner.ts test/arena-cli.test.ts package.json
git commit -m "feat: add reproducible arena command"
```

## Task 8: Document use and close the OpenSpec tasks

**Files:**

- Modify: `README.md`
- Create: `docs/arena-development.md`
- Modify: `openspec/changes/dev-skill-routing-arena/tasks.md`
- Modify: `test/public-surface.test.ts`
- Modify: `package.json`

**Step 1: Write failing public-surface assertions**

Require the README to label the arena development-only, offline, fixture-replay based, and non-evidence for model superiority or production readiness. Require the documentation and frozen arena fixtures to be included in the packed surface.

**Step 2: Run the focused test and confirm RED**

Run: `npm run build --silent && node --test dist/test/public-surface.test.js`

Expected: new arena documentation assertions fail.

**Step 3: Add concise documentation**

Document:

- `npm run arena:dev`;
- artifact layout and fingerprint behavior;
- metric definitions and denominators;
- public-synthetic provenance and annotation roles;
- offline replay limitation;
- explicit statement that this arena cannot select a winner or justify production enablement.

Mark OpenSpec tasks complete only after their commands and evidence exist.

**Step 4: Run focused tests and confirm GREEN**

Run: `npm run build --silent && node --test dist/test/public-surface.test.js`

Expected: public documentation and package-surface tests pass.

**Step 5: Commit**

```bash
git add README.md docs/arena-development.md openspec/changes/dev-skill-routing-arena/tasks.md test/public-surface.test.ts package.json
git commit -m "docs: explain development routing arena"
```

## Task 9: Final verification and review

**Step 1: Verify deterministic regeneration**

Run:

```bash
npm run arena:dev
find artifacts/arena -type f -print0 | sort -z | xargs -0 shasum -a 256 > /tmp/arena-before.sha256
npm run arena:dev
find artifacts/arena -type f -print0 | sort -z | xargs -0 shasum -a 256 > /tmp/arena-after.sha256
cmp /tmp/arena-before.sha256 /tmp/arena-after.sha256
```

Expected: both arena runs and `cmp` exit 0. Remove the two `/tmp/arena-*.sha256`
files after recording the result.

**Step 2: Run the complete local gate**

Run: `npm run check`

Expected: ESLint, strict TypeScript, every offline test, and all four strict OpenSpec validations pass without provider credentials.

Run: `npm run check:licenses && npm run check:surface && npm run check:pack`

Expected: all exit 0.

**Step 3: Inspect forbidden coupling**

Run:

```bash
rg -n "TypeSafeClient|process\.env|child_process|fetch\(" src/arena-*.ts
rg -n "gold|risk|stratum|familyId|source" src/arena-contestants.ts
```

Expected: no provider/environment/process/network imports in arena code; hidden fields occur only in parser types or scorer paths, never in contestant input/adapter access.

**Step 4: Request independent final-candidate review**

Review the exact final diff and verification output, focusing on the five review-focus items above. Any blocking or important finding returns to the responsible implementation task; rerun targeted tests and the complete gate before requesting a fresh final review.

**Step 5: Update backlog and commit final evidence changes**

Record goal, decisions, implementation, exact verification results, and next step in the linked backlog task using the backlog CLI. Save any reusable arena operation guide in Documents. Do not put machine-local paths, credentials, or generated temporary files in the public repository.
