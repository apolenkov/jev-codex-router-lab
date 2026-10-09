# Agent guidance

This is an experimental TypeScript lab for advisory Jev routing. Read
[README.md](README.md), [CONTRIBUTING.md](CONTRIBUTING.md),
[SECURITY.md](SECURITY.md) and the relevant `openspec/` requirements.

- Jev proposes typed judgments; deterministic code owns allowlists, mandatory
  skills, protected context, confidence gates and safe fallback. Preserve that
  boundary when editing `src/`, calibration code or the evaluation arenas.
- Open an issue before changing public contracts, thresholds, provider payloads
  or privacy boundaries. Use the installed `openspec-*` skill for the relevant
  workflow phase, reading its canonical `SKILL.md` from the harness catalogue.
  Generated agent workflows are untracked; do not paste them into this file.
- Use synthetic, public or anonymized examples. Keep credentials, private code,
  corporate data and raw provider responses out of commits and reports.
- `npm ci`, `npm run example:offline` and `npm run check` are the local workflow.
  Default execution is credential-free and must not call a provider; live
  execution is opt-in. Use the available `typesafe-ai` skill for TypeSafe work.
- Report precisely what an experiment proves. A smoke does not establish routing
  quality, savings or production readiness; follow README's evidence limits.
