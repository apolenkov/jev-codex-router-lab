# Proposal

## Why

The isolated Jev router lab is technically reviewable but is not ready to be
made public. It lacks an approved license, public-facing documentation,
community and security policies, reproducible CI, package-surface checks, and
an explicit decision about the personal identity already present in Git
history. Its retained live evidence is useful but negative: no valid current
run proves `status: ok`, routing quality, reliability, or economy.

## What Changes

- Position the project as an experimental reference implementation and CLI,
  not a production Codex integration or autonomous policy engine.
- Add a public quickstart, architecture/privacy/calibration documentation,
  synthetic examples, limitations, and evidence-backed non-claims.
- Add Apache-2.0, package metadata, contribution and
  security policies, changelog/release guidance, and minimal GitHub templates.
- Add least-privilege GitHub Actions with immutable action SHAs for install,
  lint, strict typecheck, tests, every active strict OpenSpec validation,
  secret/history scanning, dependency audit, and package-surface checks.
- Remove machine-specific paths and internal task/session identifiers from the
  public tree, then verify the exact candidate from a disposable fresh clone.
- Publish a clean, single-commit export to the public GitHub repository
  `apolenkov/jev-codex-router-lab` only after exact-candidate acceptance.
- Keep npm publication, GitHub Release publication, and working Codex
  integration outside this change.

## Capabilities

### New Capabilities

- `public-release-readiness`: Public documentation, governance, supply-chain
  gates, privacy checks, and exact-candidate release evidence for the lab.

### Modified Capabilities

None. Routing and calibration behavior remain unchanged.

## Impact

The change affects repository metadata, documentation, synthetic examples,
tests for the public surface, and GitHub configuration. The package remains
`private: true`; no provider call is part of implementation or CI. Apache-2.0
is selected. The public export uses the GitHub no-reply identity so local email
and internal development history are not published.

## Non-Goals

- npm publication, hosted service, telemetry, documentation site, Docker
  image, sponsorship, broad governance, production SLA, or compatibility
  matrix.
- Publishing an npm package or GitHub Release.
- Rewriting the private development branch or concealing negative experiment
  evidence from the clean public export.
