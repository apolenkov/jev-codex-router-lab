# Proposal

## Why

The corrected two-pass smoke reached pass 2 but fell back on the current fixed
confidence rules, and the retained metadata cannot show which boundary fired.
A bounded calibration experiment is needed to decide whether one fixed,
predeclared pass-2 threshold tuple works on a frozen synthetic corpus without
weakening deterministic policy or tuning against the holdout result.

## What Changes

- Add a calibration-only runner for six labeled calibration cases and two
  untouched holdout cases.
- Capture validated confidence inputs needed for offline threshold replay while
  keeping normal router reports metadata-only.
- Evaluate a fixed 15-tuple pass-2 threshold grid with deterministic selection
  and failure rules.
- Disable provider retries, enforce 18-request and USD 0.01 caps, and stop on
  unknown accounting.
- Persist synthetic inputs, labels, decisions, request accounting, and a bounded
  experiment summary without secrets or protected context.
- Do not change production thresholds unless calibration and holdout pass and a
  separately reviewed change adopts the selected tuple.

## Capabilities

### New Capabilities

- `threshold-calibration`: Frozen-corpus execution, raw confidence evidence,
  offline grid evaluation, holdout gating, and request/cost enforcement for the
  isolated Jev router lab.

### Modified Capabilities

None.

## Impact

The change affects only the isolated TypeScript lab, its tests, synthetic
fixtures, OpenSpec artifacts, and experiment evidence. It adds no dependency,
does not modify the working Codex installation, and does not grant Jev authority
over skills, permissions, execution, model routing, or acceptance.
