# Pass-1 Risk Label Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 98-case corpus's risk labels consistent with its frozen evidence rule and restore explicit positive/negative examples in each final split, without erasing historical annotation provenance.

**Architecture:** Preserve the four-case v5 repair, manifest, and ledger under `fixtures/checkpoints/v5/`. In v6, revise three cases with fresh full-case annotations, correct three other author-model records from primary logs without changing their case content, and apply a versioned offline correction ledger to the other legacy risk leaves. Preserve each version's original two annotations and adjudication byte-for-byte. The original HEAD manifest hash documents provenance; the final v6 manifest hash is the exact replay input for its ledger. Do not add a generic data-layer abstraction.

**Tech Stack:** TypeScript 6, Node built-ins, JSON fixtures, node:test, OpenSpec.

**Spec:** `docs/superpowers/specs/2026-09-23-pass1-annotated-corpus-design.md` and `openspec/changes/prepare-pass1-annotated-corpus/specs/annotated-pass1-corpus/spec.md`; the explicit owner-approved extension is a provenance-preserving offline review of up to 283 suspect negative risk leaves.

## Global Constraints

- No Jev/TypeSafe or other scoring-provider request, threshold selection, smoke run, private or corporate data. Model-assisted annotation agents are allowed with recorded provenance.
- The guide is `pass1-label-guide-v1` with SHA-256 `e48caa15f9a8342ef3b8b487b09e9da30391c6d1f69ad388b259cca53fcc0d1c` and remains byte-frozen.
- Original frozen HEAD manifest SHA-256 is `9b4308805d0f33d274881df1e5e39a32727f64b3ac41e7f381d00105e387fa2e`; current v5 baseline manifest SHA-256 is `b3b85243dc70e50f1abc61c2f38427d9c576345c0b340291e96ab4ff63b5c041`.
- The v2 audit inventory has 294 original negatives: 11 explicit exclusions, 273 omission-only, 10 conflicts; it is a review queue, not corrected ground truth. Its SHA-256 is `273516939afe268b44947aa0e37963e60e909449c543ad81dd5d337180224143`.
- Eleven omission-only leaves in four v5-repaired cases are already ambiguous. The current candidate has 283 unchanged original negatives: 262 omission-only and 10 conflicting leaves require review, and an explicit-exclusion leaf may also change after case-level review.
- Source files are in the isolated `fix/pass1-annotated-corpus-review` worktree; do not disturb other worktrees or original annotation provenance.

## Review Focus

1. A ledger key is absent from the 98 cases or duplicates another key: reject it.
2. A ledger's `before` leaf differs from the v5 source leaf: reject it, rather than silently applying to a changed corpus.
3. An `ambiguous` correction has non-null value, or a `negative` correction cites only topic overlap: reject it.
4. A corrected label points to a span absent from `state.taskText`: reject it.
5. Counts and denominators change after correction: report exact effective counts by split and signal; a signal lacking support is not evaluated.
6. A replacement case changes another label: obtain two fresh, isolated full-case annotations and adjudication; do not reuse its former labels.
7. An evaluation replacement leaks scenario-family variants into calibration or removes the ambiguous architecture-fork example: reject the candidate.

---

### Task 1: Review risk evidence by dimension

**Files:** Read `fixtures/pass1-annotation-guide.md`, `fixtures/pass1-*-cases.json`, and the v2 audit inventory. No source edits.

**Interfaces:** Produce a complete decision set keyed by `caseId` plus risk dimension; each decision is `keep-negative`, `ambiguous`, or `positive`, with exact visible span and rationale. The audit buckets are a triage aid, not a verdict.

- [x] Have five non-overlapping reviewers inspect security, data-loss, public-contract, migration, and user-behavior respectively; enumerate exceptions to the provisional A=negative/B=ambiguous/C=ambiguous policy.
- [x] Reconcile the five reports against all 294 original negative keys and the four v5-changed cases; identify which original negative leaves no longer exist in the v5 candidate.
- [x] Preserve reviewer names/model provenance and uncertainties in the ledger metadata; never call these two new independent annotations.

### Task 2: Add correction-ledger validation with TDD

**Files:** Create `fixtures/pass1-risk-corrections.json`; modify `test/pass1-annotated-corpus.test.ts`.

**Interfaces:** Ledger top-level keys are `schemaVersion`, `guideVersion`, `sourceManifestSha256`, `baseManifestSha256`, `sourceInventorySha256`, `review`, and `corrections`. Each correction identifies `caseId`, `signal`, `before`, `after`, `rule`, and `rationale`; `before` and `after` use the existing `{status,value,evidence}` leaf shape. `effectiveLabel(caseId, signal)` applies at most one correction to the v5 fixture label.

- [ ] Write failing mutation tests for missing case, duplicate key, changed `before`, invalid `after`, and non-verbatim evidence. Run `npm run build && node --test dist/test/pass1-annotated-corpus.test.js`; confirm failures are from the missing validator.
- [x] Implement only test-local ledger parsing/validation using existing `checkLeaf`, `checkEvidence`, and `leafOf`; keep fixture records untouched.
- [x] Re-run the focused test and confirm the mutant cases fail while the unchanged corpus still passes.

The red-first step above was not observed in the initial v5 implementation; the current mutation checks and final corpus checks pass. Do not count that process step as completed retroactively.

### Task 3: Freeze decisions and effective coverage

**Files:** Create the ledger JSON; modify `test/pass1-annotated-corpus.test.ts` and `openspec/changes/prepare-pass1-annotated-corpus/{proposal.md,tasks.md,specs/annotated-pass1-corpus/spec.md}` only as needed.

**Interfaces:** The ledger is the sole reviewed correction layer; its effective counts and evaluated denominators are deterministic outputs, not manually asserted promises.

- [x] Populate the ledger from reconciled reviewer decisions, retaining the v5 source label and task-text evidence. All effective negative labels must have an explicit exclusion span under the frozen guide.
- [x] Add tests for replay, source hashes, exact correction count, unchanged original annotations/adjudications, and effective per-split risk coverage; encode unsupported comparisons explicitly.
- [x] Add the minimal OpenSpec amendment explaining reviewed effective labels and historical provenance. Keep future threshold calibration outside this change.
- [x] Run focused tests, `npm run check`, `npx openspec validate prepare-pass1-annotated-corpus --strict --no-interactive`, and `git diff --check` with their own exit statuses.
- [x] Preserve this v5 ledger as a verified checkpoint before the owner-authorized coverage repair; do not call the final reviewer yet.

### Task 4: Repair explicit-negative coverage in the locked splits

**Files:** Modify only the selected records in `fixtures/pass1-calibration-cases.json` and `fixtures/pass1-evaluation-cases.json`, then `fixtures/pass1-corpus-manifest.json`, `fixtures/pass1-risk-corrections.json`, `test/pass1-annotated-corpus.test.ts`, and the existing OpenSpec change. Preserve pre-repair records and v5 ledger as separate work artifacts.

**Interfaces:** CAL-043 adds explicit security and user-behavior exclusions; EVAL-015 adds data-loss and public-contract exclusions; EVAL-019 adds security and user-behavior exclusions. The 14/56/28 case counts and existing family/split IDs do not change. Each task-text revision has a new `input`, two new isolated full-case `annotations`, one new full-case `adjudication`, and derived final `labels`. CAL-022, CAL-041, and CAL-042 receive author-model metadata corrections only. The effective ledger is regenerated against the new manifest and excludes any corrected leaf whose source case was replaced.

- [x] Freeze the v5 ledger and manifest hashes in the task artifacts before changing cases; assert the three selected case families do not cross splits.
- [x] Write the three minimal task-text variants and a blinded input packet containing only model-visible state and frozen guide; no old labels or other reviewer output.
- [x] Obtain two separate model-assisted full-case annotations for each variant, with distinct reviewer/model provenance and no access to each other's labels; verify exact evidence spans.
- [x] Adjudicate all differences from the two new annotations under the frozen guide; preserve both originals and the v5 checkpoint in task artifacts.
- [x] Integrate only the three task-text revisions; regenerate the manifest and risk ledger against the resulting candidate. Update exact hash/count expectations in the test, and assert both signs per risk dimension in calibration and evaluation.
- [x] Correct the three v5-derived author-model fields using the primary author session, retain v5 as historical evidence, and prove their current inputs, labels, annotations, and adjudications are otherwise unchanged.
- [x] Rerun focused tests, `npm run check`, explicit strict validation of `prepare-pass1-annotated-corpus`, and `git diff --check`; then request a new independent read-only review of the changed final candidate because the first review found an important provenance error.

## Self-review

All spec acceptance points remain: 14/56/28 splits and original two annotations are retained; this plan adds only an auditable correction layer. The five failure modes above each map to Task 2 or 3 tests. No threshold/provider behavior is added.
