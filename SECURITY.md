# Security policy

## Supported versions

This project is experimental and has no released stable version. Security
fixes target the current default branch only; older commits and private forks
are not supported.

## Reporting a vulnerability

Do not open a public issue and do not include secrets or sensitive data in any
public discussion. Report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/apolenkov/jev-codex-router-lab/security/advisories/new).

Include the affected revision, expected impact, a minimal sanitized
reproduction, and any known mitigation. Reports are handled through the
advisory thread; timing for triage or a fix cannot be guaranteed for this
experimental project.

If a credential may have been exposed, revoke it with its provider immediately;
do not send the live value in the report. The data boundary and threat model are
documented in [docs/security-and-privacy.md](docs/security-and-privacy.md).
