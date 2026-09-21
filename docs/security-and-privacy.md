# Security and privacy

The router is designed for public, synthetic, or explicitly anonymized input.
It is not approved for secrets, personal data, private source code, corporate
material, or raw session transcripts.

## What may leave the machine

A live route can send the provider:

- bounded task text;
- allowlisted optional skill IDs and descriptions;
- pass-2 excerpts for shortlisted skills;
- allowlisted candidate facts, summaries, alternatives, and trade-offs;
- non-protected context IDs and summaries;
- task/policy/catalogue echoes used for freshness checks.

Protected context IDs and bodies are not sent. Their IDs are preserved only in
the deterministic local decision. The router does not infer that text is safe:
the caller must classify and anonymize it before use.

## What the repository retains

Optional reports contain metadata only: status, call count, latency, model,
observable usage/retry counts, cache status, and cost when calculable. They do
not contain task text, skill or context bodies, provider requests/responses, or
exception messages. Report files are create-once to avoid replacing evidence.

Tracked evidence is synthetic and bounded. `.env.local`, arbitrary reports,
generated build output, and local agent workspaces are excluded from the public
surface.

## Credentials

- Pass `TYPESAFE_API_KEY` through the environment only.
- Never put a key in a task file, CLI argument, issue, test fixture, report, or
  commit.
- The offline quickstart and CI do not use a provider credential.
- If a key may have been exposed, revoke it with the provider before doing
  anything else.

## Threat boundary

Jev output is untrusted input. Deterministic code checks exact response shapes,
probability ranges, state echoes, allowlisted IDs, candidate counts, and
confidence. A checked `ok` result is still advice, not authorization or proof
of semantic correctness. The project does not execute recommendations, alter
permissions, or integrate with a working Codex installation.

The lab does not defend against a caller deliberately putting sensitive text
into an allowed field, a compromised local machine, or provider-side data
handling outside this repository. Review the provider's current terms before
any live request.

## Report a vulnerability privately

Do not disclose vulnerabilities, credentials, or sensitive reproduction data
in a public issue. Use
[GitHub private vulnerability reporting](https://github.com/apolenkov/jev-codex-router-lab/security/advisories/new).
Include the affected revision, impact, minimal sanitized reproduction, and any
suggested mitigation. See [SECURITY.md](../SECURITY.md) for the support policy.
