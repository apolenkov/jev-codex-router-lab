# Jev threshold calibration: terminal negative result

The frozen calibration experiment was executed exactly once on 2026-09-21 from
Git commit `92072191f7a0fa1d52c73df910918c14fb805cc2`. It used only the approved
public synthetic corpus and the create-once bounded runner. No retry, threshold
adjustment, holdout request, or smoke request followed the terminal result.

## Preflight

- Corpus SHA-256: `85fdb0f1183f8fb42332d14f6396bc4a5fd32c079ea968f40a998975f7eb9fa3`
- Frozen smoke SHA-256: `fa506bb74e22abff184bbd643f4b175cc8198abeaa7a184357d037e4ff06e4af`
- `npm ci`: 99 packages, 0 vulnerabilities
- lint and strict typecheck: PASS
- tests: 111/111 PASS
- both strict OpenSpec validations: PASS
- independent specification, security, execution-readiness, and preflight
  reviews: PASS

## One-shot live result

Command:

```text
npm run build --silent && node --env-file=.env.local dist/src/calibration-cli.js
```

Observed result:

- CLI exit: `2`, summary `calibration failed`
- terminal reason: `post-transport-validation`
- actual provider attempts: `1`
- observed input-token cost: `USD 0.000051240000000000004`
- reserved spend after termination: `USD 0`
- hard caps: 18 attempts and USD 0.05
- report: not created because failure occurred during the first calibration
  case before the first report boundary
- holdout attempts: `0`
- frozen smoke attempts: `0`

The provider envelope was sufficient for closed accounting, but the first
calibration case failed one of the local post-transport validation invariants
before pass 2. The runner intentionally records only the aggregate terminal
reason at this boundary, so retained evidence cannot distinguish
`invalid-provider-evidence`, `invalid-pass1-decision`, and
`pass1-label-mismatch`. No raw provider answer was retained. A more specific
root cause therefore cannot be established without a new experiment, and none
was attempted.

Provider latency and output-token usage were not persisted on this failure
path. This run does not satisfy calibration, holdout, or smoke PASS and does not
support any claim about routing quality or economy. The earlier corrected
two-pass smoke remains the evidence for live operability, latency, calls, and
cost; it also ended in safe `fallback/low-confidence`.
