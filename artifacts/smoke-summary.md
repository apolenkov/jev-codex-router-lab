# Jev router local smoke evidence

This file records local-only Task 4A evidence at Git SHA
`55fcf1ee9be76b0620e35fa6ca9656e96c654e0d`.

Initial credential presence check: `TYPESAFE_API_KEY=absent`. The owner later
installed a non-empty key in mode-0600 `.env.local`; only presence and file mode
were checked, and the value was not printed. Three separately authorized live
commands were run. The first two are invalid semantic-routing evidence because
of the implementation defect documented below; the corrected third run is
reported separately and was not retried.

## Fixture regression

- RED: the focused test exited 1 with `ENOENT` for
  `fixtures/smoke-input.json` before the fixture existed.
- The first post-fixture run exposed an incorrect test expectation: failed
  `pass1` is one observed call, not zero. The expectation was corrected to the
  existing telemetry contract.
- GREEN: the focused test exited 0 with 1 test passed and 0 failed.
- The regression uses a throwing fake gateway. It preserves
  `systematic-debugging` in safe fallback and checks that the report excludes
  the exact task text and every supplied skill/context body.

## Complete local gate — run 1

Commands, in order:

```text
npm ci
npm run check
git diff --check
```

Exact outcomes:

```text
npm ci: exit 0; added 99 packages, audited 100 packages in 2s; 0 vulnerabilities
npm run check: exit 0; lint exit 0; typecheck exit 0; tests 46, pass 46, fail 0; Change 'build-jev-router-lab' is valid
git diff --check: exit 0; no output
```

The command outcomes above describe this historical gate run. The final
candidate content fingerprint and current worktree state are recorded
separately below.

## Complete local gate — run 2

Commands, in order:

```text
npm ci
npm run check
git diff --check
```

Exact outcomes:

```text
npm ci: exit 0; added 99 packages, audited 100 packages in 1s; 0 vulnerabilities
npm run check: exit 0; lint exit 0; typecheck exit 0; tests 46, pass 46, fail 0; Change 'build-jev-router-lab' is valid
git diff --check: exit 0; no output
```

The second run created no additional tracked change at that point. The final
candidate content fingerprint and current worktree state are recorded
separately below.

## Artifact tracking boundary

`.gitignore` leaves only `artifacts/.gitkeep`,
`artifacts/smoke-summary.md`, `artifacts/smoke-report.json`,
`artifacts/two-pass-smoke-report.json`, `artifacts/corrected-smoke-report.json`,
and `artifacts/corrected-smoke-decision.json` eligible for tracking.
`git check-ignore -q --no-index` returned 1 for each exact allowlist path.
`git check-ignore -v --no-index` returned 0 and matched
`.gitignore:4:artifacts/**` for `artifacts/unrelated.bin`,
`artifacts/nested/private.bin`, `artifacts/smoke-report.json/private.bin`, and
`artifacts/smoke-summary.md/private.bin`. No other artifact is exposed.

Post-boundary verification: `npm run lint`, `npm run typecheck`, `npm test`
(46/46), strict OpenSpec validation, and `git diff --check` each exited 0.

## Live smoke 1: INVALID EXPERIMENT — task evidence omitted

Denominator: `n=1` public synthetic task. The authorized command was run exactly
once on 2026-09-21 with input price `USD 0.042/M` and output price `USD 0/M`:

```text
npm run route -- --input fixtures/smoke-input.json --report artifacts/smoke-report.json
```

The persisted metadata report proves: `status: ok`, model `jev-1.13.0`, one Jev
call, `923.8225 ms` total latency, 757 input tokens, 342 output tokens,
`cacheStatus: not-used`, and calculated cost `USD 0.000031794`. The session
transcript showed all seven typed signal groups and retained forced skill
`systematic-debugging`, but no independent decision JSON was saved; those two
claims are transcript-derived rather than reproducible from the tracked
artifacts. The metadata report contains no task text, skill ID, skill body, or
context body.

The smoke does **not** pass the approved gate because the denominator required
exactly two Jev calls. Pass 1 returned no optional skill candidate, so the router
correctly skipped pass 2. This is not an infrastructure failure and no automatic
retry was made.

Final review later proved that this gateway version omitted `taskText` from the
provider request. The run therefore proves only that the one-pass transport and
accounting path operated; it is not evidence about Jev routing quality or the
configured thresholds.

## Live smoke 2: INVALID EXPERIMENT — task evidence omitted

After the owner explicitly authorized a separate experiment, a second fixture
was frozen before execution. Its synthetic task required a test-first bug fix;
`systematic-debugging` remained mandatory and `test-driven-development` was the
expected optional candidate. PASS required `status: ok`, exactly two Jev calls,
the optional candidate, seven signals, and privacy PASS. The command was run once:

```text
npm run route -- --input fixtures/two-pass-smoke-input.json --report artifacts/two-pass-smoke-report.json
```

The persisted metadata report proves two calls, `1189.809667 ms` total latency,
and `cacheStatus: not-used`. Pass 1 used model `jev-1.13.0`, 761 input tokens,
348 output tokens, and `807.226833 ms`; pass 2 took `381.874958 ms`. The session
transcript showed `status: fallback`, reason `low-confidence`, but no independent
decision JSON was saved. Aggregate usage and cost are `null` with
`costReason: usage-not-observable`; final review proved this was an accounting
defect because validated pass-2 metadata was discarded on low-confidence.
Neither metadata report contains the task, skill IDs, skill bodies, or context
bodies.

Final review also proved that this gateway version omitted `taskText` from both
requests and shortlisted excerpts from pass 2. The run proves only that the
two-call orchestration path executes; it cannot validate Jev, the thresholds,
or semantic skill selection. No retry or threshold change was made after the
answer. A corrected implementation requires a new, separately authorized live
smoke before any integration conclusion.

## Live smoke 3: corrected semantic request — gate FAIL

After the owner authorized one corrected run, the same frozen public synthetic
two-pass fixture was executed exactly once on 2026-09-21. The corrected adapter
sent bounded task evidence in both passes and shortlisted descriptions/excerpts
only in pass 2. No protected context was supplied.

```text
npm run route -- --input fixtures/two-pass-smoke-input.json --report artifacts/corrected-smoke-report.json
```

The persisted decision is `status: fallback`, reason `low-confidence`, with
forced `systematic-debugging` preserved. The persisted metadata proves exactly
two calls, `1164.798417 ms` total latency, 1,492 input tokens, 580 output tokens,
`cacheStatus: not-used`, and calculated cost `USD 0.000062664` at the recorded
price snapshot. Pass 1 used `jev-1.13.0`, 817 input tokens, 348 output tokens,
and `850.821125 ms`; pass 2 used the same model, 675 input tokens, 232 output
tokens, and `312.980459 ms`.

A repository scan excluding `.env.local` found no credential-shaped value in
the fixtures, reports, decision, README, or summary. The report contains only
provider metadata; the decision contains only status, reason, and forced skill
IDs. This is privacy PASS for the approved synthetic boundary.

The smoke fails the approved gate because `status` is not `ok`; consequently it
does not provide seven accepted signals or validate the expected optional TDD
selection. No retry, threshold adjustment, or result cherry-picking was made.
The run proves the corrected two-call transport, accounting, fallback, and
mandatory-skill preservation paths only. Denominator `n=1` cannot establish
economy or routing quality.

## Post-smoke deterministic review fixes

Mandatory final review found two contract gaps after the corrected run:
Jev-facing text lacked fixed size limits, and protected-context IDs were not
preserved in final decisions. The final code now rejects task text above 8,000
UTF-16 code units and other Jev-facing text fields above 4,000 before any SDK
call. It also preserves deterministic `protectedContextIds` in every decision
while excluding their IDs and bodies from Jev and from semantic context output.

These fixes made no further live call. They do not change the frozen fixture's
provider payload or the recorded provider metadata, because its text is within
the new limits and it contains no protected context. The persisted decision is
the verbatim output of the pre-fix corrected run and therefore lacks the new
empty `protectedContextIds` field; it remains historical evidence, not output
claimed to have been regenerated by the final code.

Final review then found that an absent or `undefined` nullable signal property
could be mistaken for explicit `null`. The deterministic postcheck now requires
all seven signal properties to be present and rejects `undefined`, while
continuing to accept explicit `null` for nullable signals.

After these fixes, `npm run check` passed lint, strict typecheck, 59/59 tests,
and strict OpenSpec validation; staged and unstaged diff checks also passed.

## Final candidate fingerprint

The initial Task 4A fingerprint was stale after live evidence and code fixes and
is intentionally removed. The exact final evidence-bound fingerprint is added
after all corrected code, fixtures, decision JSON, reports, and this summary are
staged together; it excludes only its own digest line.

Candidate fingerprint: `sha256:793afa543d632ceb6e538fce0f81e711163b7af01e4e5399b15a69cd251f89bd` (sorted staged mode/blob manifest; this line omitted from the normalized summary blob).
