# Contributing

Thanks for helping improve this experimental reference implementation.

## Before opening a change

- Use a public, synthetic, or anonymized example. Never submit credentials,
  private code, corporate data, or raw provider responses.
- Keep Jev advisory. Deterministic code must continue to own allowlists,
  mandatory skills, protected context, and fallback.
- Open a feature issue before changing the public contract, thresholds,
  provider payload, or privacy boundary.
- Report security problems through a
  [private advisory](https://github.com/apolenkov/jev-codex-router-lab/security/advisories/new),
  not an issue.

## Local workflow

Use Node.js 20.19.0 or newer:

```bash
npm ci
npm run example:offline
npm run check
git diff --check
```

The default workflow is credential-free and must not make a provider request.
Add the smallest focused test that proves a behavior change. Keep documentation
and synthetic examples consistent with the actual contract and evidence.

## Pull requests

Explain the problem, the smallest solution, and how you verified it. Keep
unrelated cleanup separate. A contribution must preserve safe fallback, pass
the complete local gate, and avoid quality or savings claims not supported by
a pre-registered evaluation.

By contributing, you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE). Participation is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).
