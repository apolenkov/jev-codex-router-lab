# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) if releases begin.

## [Unreleased]

### Added

- Experimental two-pass Jev routing behind deterministic precheck/postcheck.
- Seven typed advisory signals, mandatory-skill preservation, and safe typed
  fallback.
- Metadata-only accounting, bounded calibration tooling, synthetic fixtures,
  and credential-free offline examples.
- Public documentation, security policy, contribution guidance, and CI gates.

### Known limitations

- No valid current live run proves `status: ok` or routing quality.
- The corrected live smoke ended in `fallback/low-confidence`; calibration
  terminated before holdout.
- npm publication, GitHub Releases, and working Codex integration are not
  provided.
