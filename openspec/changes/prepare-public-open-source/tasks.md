# Tasks

## 1. Record owner gates and freeze the public claim boundary

- [ ] 1.1 Record Apache-2.0, target `apolenkov/jev-codex-router-lab`, GitHub
  no-reply export identity, GitHub private vulnerability reporting, and the
  decision that npm remains private
- [ ] 1.2 Inventory the tracked tree and reachable history for credentials,
  machine paths, personal email, internal task/session identifiers, raw
  payloads, generated files, dependency licenses, and third-party notices;
  record findings without printing secret values
- [ ] 1.3 Freeze the factual evidence statement: the corrected two-call run is
  `fallback/low-confidence`, the one-request calibration ended in
  `post-transport-validation`, a valid current live `status: ok` is unproven,
  and no quality, reliability, economy, or production-readiness claim is made

## 2. Public documentation and synthetic examples

- [ ] 2.1 Rewrite `README.md` around a credential-free five-minute quickstart,
  the seven signals, deterministic/Jev boundary, safe fallback, privacy,
  current evidence, limitations, and development commands
- [ ] 2.2 Add `docs/architecture.md`, `docs/calibration.md`,
  `docs/security-and-privacy.md`, and `docs/releasing.md`; verify links and
  commands against the current repository rather than duplicating README prose
- [ ] 2.3 Add minimal synthetic bug, plan, review, and protected-context inputs
  plus a clearly labelled offline fake-gateway example; add a regression that
  proves the example needs no credential or provider request and preserves
  mandatory skills in typed fallback
- [ ] 2.4 Add `CONTRIBUTING.md`, owner-approved `SECURITY.md`, Contributor
  Covenant 2.1 `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, two issue forms, issue-form
  configuration, and a pull-request template; do not add speculative
  governance, funding, or a documentation site

## 3. Package, CI, and public-surface gates

- [ ] 3.1 Write failing public-surface tests for required package metadata,
  `private: true`, dependency-license completeness, forbidden package entries,
  machine-specific paths, and credential-free offline example execution
- [ ] 3.2 Add the approved `LICENSE` and minimal `package.json` metadata; keep
  npm private and omit `exports`/`bin`; update `npm run check` to validate all
  active OpenSpec changes, then make the public-surface tests pass
- [ ] 3.3 Add one least-privilege CI workflow with every third-party action
  pinned to a verified 40-hex SHA and a release-tag comment; run Node 20,
  `npm ci`, lint, strict typecheck, all tests, strict validation of all active
  OpenSpec changes, high-severity dependency audit, dependency-license check,
  full-history Gitleaks, and package dry-run inspection without provider calls
- [ ] 3.4 Replace machine-specific paths and internal task/session identifiers
  in tracked public content with repository-relative or clearly synthetic
  values; review retained experiment artifacts explicitly instead of deleting
  negative evidence by default

## 4. Exact-candidate acceptance

- [ ] 4.1 Run local install, lint, strict typecheck, all tests, all active
  strict OpenSpec validations, high-severity dependency audit, dependency
  license inventory, Gitleaks over the tracked tree and full reachable history,
  link checks, `git diff --check`, and `npm pack --dry-run --json`; preserve
  bounded redacted evidence
- [ ] 4.2 Commit the local release candidate, clone that exact SHA into a
  disposable non-local clone, and repeat the documented credential-free
  quickstart, complete gate, history scan, and pack inspection from clean state
- [ ] 4.3 Obtain adversarial review and requesting-code-review on the candidate,
  fix every blocking or important finding, repeat targeted and complete gates,
  and obtain mandatory Astra review on the resulting exact SHA
- [ ] 4.4 Update OpenSpec and backlog with verified evidence; build and verify a
  clean single-commit public export, create `apolenkov/jev-codex-router-lab`,
  push accepted `main`, enable supported security settings, and verify remote
  SHA/files; keep GitHub Release and npm publication unperformed
