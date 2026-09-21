# Design

## Context

The repository is a standalone TypeScript lab with pinned dependencies,
deterministic policy around an untrusted Jev semantic layer, synthetic
fixtures, and local verification. It currently has no remote, no license or
community files, incomplete package metadata, a lab-oriented README, and no
CI. Existing Git history exposes its configured author identity and existing
tracked artifacts include experimental evidence.

The public story must match the evidence. The corrected synthetic two-pass
smoke made two calls and ended in safe `fallback/low-confidence`; its measured
total latency was 1164.798417 ms and recorded cost was USD 0.000062664. The
bounded calibration stopped after one provider attempt with
`post-transport-validation`, recorded cost USD 0.00005124, and did not reach
holdout or the reserved smoke. A historical `status: ok` run omitted required
task evidence and is invalid as semantic-routing proof. Therefore no valid
current run demonstrates live `status: ok`, routing quality, reliability, or
economy.

## Goals / Non-Goals

**Goals:**

- Make the repository understandable and reproducible for a new contributor
  without a TypeSafe credential.
- Publish only synthetic, public, or explicitly anonymized examples and
  bounded evidence with denominator and caveats.
- Establish small, deterministic local and CI gates for the tracked tree,
  reachable Git history, dependencies, package surface, and fresh clone.
- Separate local release-candidate preparation from every external or
  destructive publication action.

**Non-Goals:**

- Changing routing prompts, thresholds, runtime contracts, or experiment
  outcomes.
- Proving Jev quality, savings, general reliability, or production readiness.
- Defining an npm API, `exports`, or executable `bin` before npm distribution
  is separately approved.
- Live provider calls in examples, CI, or release verification.

## Decisions

### 1. Product position and claims

The README presents the repository as an experimental reference
implementation. It leads with the deterministic/Jev trust boundary, the seven
typed signals, mandatory-skill preservation, and safe fallback. Evidence is
dated and links to retained reports. It states explicitly that the valid
corrected run ended in fallback and that the calibration terminated early.
The project makes no broad quality, reliability, hallucination, economy, or
production-readiness claim. Vendor claims, if mentioned, are attributed and
not restated as project findings.

### 2. Owner-approved legal and publication boundary

Apache-2.0 is selected because it is permissive and includes an explicit patent
grant. The target is `apolenkov/jev-codex-router-lab`. To avoid publishing the
local author email and internal development history, publication uses a clean
single-commit export authored with the GitHub no-reply address. The export
retains reviewed negative evidence and its limitations.

The package remains `private: true`. Version, description, keywords, engines,
license, and repository/bugs/homepage fields are added. No `exports`, `bin`, or
compatibility promise is added. The private development branch is not
rewritten; only the separately constructed public export has clean history.

### 3. Small public information architecture

`README.md` contains the five-minute credential-free quickstart, one compact
example, architecture summary, seven signals, fallback behavior, privacy
boundary, current evidence, limitations, and development commands. Focused
detail lives in:

- `docs/architecture.md` — two-pass flow, deterministic boundaries, and data
  flow;
- `docs/calibration.md` — frozen corpus, grid/holdout method, terminal negative
  result, and permitted conclusions;
- `docs/security-and-privacy.md` — data sent, data retained, secret handling,
  threat boundary, and private disclosure route;
- `docs/releasing.md` — local candidate gates and the separately authorized
  remote/release steps.

Existing reviewed fixtures remain the canonical live-smoke inputs. The
`examples/` directory adds small synthetic bug, plan, review, and
protected-context inputs plus a credential-free offline example using a fake
gateway. The fake is visibly labelled and demonstrates contract/fallback
behavior only; it never represents a Jev result. This avoids duplicating the
router or adding a demo dependency.

### 4. Standard community surface, no governance theatre

Add `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, two
issue forms (bug and feature), issue-form configuration, and one pull-request
template. Use Contributor Covenant 2.1 verbatim once its enforcement contact
is approved. Security reports use GitHub private vulnerability reporting once
the public repository enables it; secrets and vulnerabilities are never
requested in public issues. No committees, roadmap process, funding file, or
generated site are added.

### 5. One least-privilege CI workflow

Use one `.github/workflows/ci.yml` with top-level
`permissions: contents: read`, cancellation of superseded branch runs, and no
secrets or write permissions. Pin every third-party action to a verified
40-hex commit SHA and retain its release tag as a comment. Checkout uses full
history for the secret scan. Test the declared Node 20 floor only; add a matrix
later only when supported-version compatibility becomes a real requirement.

The workflow runs `npm ci`, lint, strict typecheck, all tests,
`openspec validate --changes --strict --no-interactive`,
`npm audit --audit-level=high`, dependency-license validation, a full-history
Gitleaks scan, and `npm pack --dry-run --json` surface validation. It performs
no provider request. Existing `npm run check` is made the canonical local gate
and covers every active OpenSpec change rather than one named change.

Use the current toolchain and Node standard library for public-surface and
license checks. Do not add a general release framework, test framework,
license package, or secret-scanner wrapper. Gitleaks is the one purpose-built
scanner because regex-only credential checks are not an adequate history
audit.

### 6. Public-surface sanitation is explicit

Replace machine-specific absolute paths with repository-relative or clearly
synthetic values. Remove internal task/session identifiers from prose and
examples. Keep synthetic strings used to prove redaction only when unmistakably
synthetic. Scan the tracked tree and full reachable history without printing
secret values. Review every tracked experiment artifact for public value and
privacy; retain negative evidence rather than silently deleting it, unless the
owner rejects its publication.

Dependency-license validation rejects missing or unrecognized SPDX data and
records the reviewed inventory. Package dry-run validation rejects credentials,
local environment files, raw provider payloads, generated reports not
explicitly approved, local agent workspaces, and machine-specific paths. Since
npm publication is out of scope, the pack is audit evidence rather than a
distribution contract.

### 7. Exact-candidate proof and publication separation

After implementation commits, export the exact candidate tree into a
disposable repository, commit it once with the GitHub no-reply identity, run
the documented credential-free
quickstart, full local gate, Gitleaks history scan, dependency audit, and pack
inspection, then remove only that task-created directory. Run adversarial
review and code review, followed by the mandatory Astra review on that exact
candidate. Important findings produce a new candidate and a new final review.

After acceptance, create the public GitHub repository, push the exact accepted
export as `main`, enable private vulnerability reporting when supported, and
verify the remote SHA and public files. GitHub Release and npm publication stay
separately gated.

## Work Decomposition

After the owner gates, documentation/examples/community files and
CI/package/public-surface checks have disjoint ownership and can be implemented
in parallel. The final sanitation, fresh-clone verification, and reviews are
serialized because they operate on one exact candidate.

## Risks / Trade-offs

- **Public export diverges from the reviewed tree** — compare the export tree
  to the accepted candidate before push and verify the remote SHA afterward.
- **Negative evidence makes the project look unfinished** — state it plainly;
  hiding it would make the public project less trustworthy.
- **CI becomes a bespoke release system** — keep one workflow and native npm,
  Node, OpenSpec, Git, and Gitleaks commands.
- **Pack audit implies npm support** — keep `private: true` and document that
  the pack command is only a leakage check.
- **Private history contains local identity or internal iteration** — publish
  only the reviewed clean export; do not rewrite the private branch.
