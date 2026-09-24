# Spec Delta

## Purpose

Defines the documentation, governance, privacy, supply-chain, and verification
requirements for a public release candidate of the isolated Jev router lab.

## ADDED Requirements

### Requirement: Legal and publication authority remains with the owner

The project MUST use Apache-2.0 in the license file and package metadata. The
package MUST remain `private: true` unless npm publication is separately
authorized. Publication MUST target `apolenkov/jev-codex-router-lab` through a
clean single-commit export using the GitHub no-reply identity, retain reviewed
experimental evidence, and enable GitHub private vulnerability reporting when
supported. This change MUST NOT publish an npm package or GitHub Release or
rewrite the private development branch.

#### Scenario: Public history is prepared

- **WHEN** the accepted candidate is exported for publication
- **THEN** its history contains one reviewed commit with a GitHub no-reply
  identity and no local author email or internal development commits

#### Scenario: Local candidate passes

- **WHEN** every local release-candidate gate passes
- **THEN** the exact accepted export may be pushed to the approved public GitHub
  repository, while npm and GitHub Release publication remain blocked

### Requirement: Public documentation states the actual trust boundary

The README MUST describe the project as an experimental reference
implementation, explain deterministic precheck/postcheck and the two-pass Jev
boundary, enumerate all seven typed signals, and explain mandatory-skill
preservation and safe fallback. Architecture, calibration, privacy/security,
and release details MUST be linked from focused documents. The documentation
MUST distinguish deterministic guarantees from semantic model judgments.

#### Scenario: Reader evaluates model authority

- **WHEN** a reader follows the README architecture and privacy links
- **THEN** the reader can determine that Jev proposes typed judgments while
  deterministic code owns allowlists, fallback, and mandatory requirements

### Requirement: Experimental claims are evidence-bound

The public documentation MUST state that no valid current live run proves
`status: ok`. It MUST report that the corrected two-pass synthetic smoke ended
in `fallback/low-confidence` and that the bounded calibration ended after one
attempt in `post-transport-validation` before holdout. Any measured latency,
usage, or cost MUST include its date, model, denominator, and caveat. The
project MUST NOT claim routing quality, general reliability, hallucination
prevention, economy, production readiness, or savings from the current
evidence.

#### Scenario: Historical status-ok artifact is described

- **WHEN** public documentation references the earlier `status: ok` run
- **THEN** it marks the run invalid as semantic evidence because required task
  evidence was omitted and does not use it to support a quality claim

#### Scenario: Corrected smoke metrics are shown

- **WHEN** latency or cost from the corrected smoke is presented
- **THEN** the same section states `n=1`, two calls,
  `fallback/low-confidence`, and that the measurement proves only the observed
  transport, accounting, fallback, and mandatory-skill paths

### Requirement: Examples are synthetic and credential-free by default

The repository SHALL include small synthetic bug, plan, review, and
protected-context inputs. Its primary quickstart and offline example MUST run
without a TypeSafe credential, provider request, private data, or working Codex
integration. Any fake gateway MUST be labelled as fake and MUST NOT be
presented as model output. Live execution MAY be documented only as an
explicit opt-in for public or synthetic data.

#### Scenario: New contributor runs the quickstart

- **WHEN** a contributor follows the documented default quickstart in a clean
  clone without `TYPESAFE_API_KEY`
- **THEN** install, local checks, and the offline example complete without a
  provider request

#### Scenario: Protected-context example is evaluated

- **WHEN** the offline example receives a synthetic protected context fragment
- **THEN** its identifier is preserved by deterministic output while its body
  is not supplied to the fake semantic response

### Requirement: Community and security paths are complete but minimal

The repository SHALL provide contribution, security, code-of-conduct,
changelog, and release guidance, two issue forms for bugs and features, and one
pull-request template. The security policy MUST direct sensitive reports to an
owner-approved private channel and MUST tell users not to disclose secrets in
public issues. The repository MUST NOT add unapproved contacts or speculative
governance bodies.

#### Scenario: Reporter finds a vulnerability

- **WHEN** a reader opens the security policy or issue-form chooser
- **THEN** the reader is directed away from public issues to the approved
  private reporting path

### Requirement: CI is reproducible, least-privilege, and offline from Jev

The repository SHALL use one CI workflow with top-level
`permissions: contents: read`. Every third-party action MUST use an immutable
40-hex commit SHA with its reviewed release tag in a comment. CI MUST use a
full-history checkout and Node 20, run `npm ci`, lint, strict typecheck, all
tests, strict validation of every active OpenSpec change, high-severity npm
dependency audit, dependency-license validation, a full-history Gitleaks scan,
and package dry-run inspection. CI MUST NOT receive a provider credential or
make a Jev request.

#### Scenario: Pull request runs CI

- **WHEN** a pull request changes code, documentation, package metadata,
  examples, or OpenSpec artifacts
- **THEN** the one read-only workflow runs every required gate without a secret
  or write permission

#### Scenario: Action reference is mutable

- **WHEN** any workflow action uses a branch, tag, or shortened commit
  reference
- **THEN** the public release candidate fails verification

### Requirement: Public and package surfaces exclude private residue

The tracked public tree and package dry-run MUST exclude credentials, `.env`
files, raw provider payloads, private or corporate data, local agent
workspaces, unapproved generated reports, machine-specific user paths, and
internal session/task identifiers. Synthetic redaction sentinels MAY remain
when clearly labelled and covered by a test. Every installed dependency MUST
have reviewed SPDX license data compatible with the owner-selected project
license; missing or unrecognized data MUST fail the release gate.

#### Scenario: Package surface contains a local file

- **WHEN** `npm pack --dry-run --json` lists a credential file, local agent
  workspace, raw response, or unapproved artifact
- **THEN** verification fails before publication

#### Scenario: History scan reports a possible secret

- **WHEN** Gitleaks reports a finding in the tracked tree or reachable history
- **THEN** verification stops and records only redacted location metadata until
  the finding is resolved or documented as a reviewed false positive

### Requirement: Exact-candidate verification precedes publication

The system SHALL verify a clean single-commit export of the committed candidate
tree from a disposable repository using the documented credential-free quickstart, complete
local gate, history secret scan, dependency checks, link checks, and package
inspection. It MUST then receive adversarial review, code review, and mandatory
Astra review on the exact resulting candidate. Any blocking or important
finding MUST create a new candidate and require repeated targeted checks and a
new final review.

#### Scenario: Fresh clone differs from the working copy

- **WHEN** a documented command or test passes only in the original working
  directory
- **THEN** release readiness fails even if the original worktree was green

#### Scenario: Exact candidate is approved

- **WHEN** all fresh-clone gates and required reviews pass on one SHA
- **THEN** the exact export may be pushed to the approved public repository and
  its remote SHA and public files MUST be verified before reporting publication
