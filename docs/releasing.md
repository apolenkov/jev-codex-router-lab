# Releasing

This document describes the public source-candidate process. The npm package
remains private, and no GitHub Release or npm publication is part of it.

## Local candidate gates

Start from a clean committed candidate with Node.js 20 or newer, npm, OpenSpec,
and Gitleaks available:

```bash
npm ci
npm run example:offline
npm run check
npm audit --audit-level=high
gitleaks git --no-banner --redact=100 --verbose .
npm pack --dry-run --json
git diff --check
```

Review the pack manifest rather than publishing it. It must not contain
credentials, `.env` files, raw provider data, local workspaces, unapproved
reports, or machine-specific paths. Confirm the dependency-license checks in
`npm run check` pass and validate every public documentation link during
candidate review.

## Exact-candidate verification

1. Record the candidate commit and verify the worktree is clean.
2. Export that exact tree into a disposable repository, not a copy of the
   working directory.
3. Create one commit using the owner's GitHub no-reply identity.
4. In a fresh clone of that export, rerun the offline quickstart, complete
   local gate, full-history Gitleaks scan, dependency audit, link checks, and
   pack inspection.
5. Compare the export tree with the accepted source candidate.
6. Obtain adversarial review, code review, and final independent review on the
   exact candidate. Important findings create a new candidate and repeat the
   affected checks and final review.

Do not rewrite the private development branch. The clean one-commit export is
the publication artifact and must retain the reviewed negative experimental
evidence and its limitations.

## Public publication

Only after the exact candidate passes:

1. Create the public `apolenkov/jev-codex-router-lab` repository.
2. Push the accepted export commit as `main`.
3. Enable GitHub private vulnerability reporting.
4. Verify the remote commit, public files, default branch, and CI result against
   the accepted candidate.

Creating an npm package, publishing a GitHub Release, changing runtime
thresholds, or integrating with Codex requires a separate decision and review.
