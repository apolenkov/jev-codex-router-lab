# Tasks

## 1. Repository, contracts, and deterministic policy

- [x] 1.1 Initialize OpenSpec change `build-jev-router-lab` and verify `openspec validate build-jev-router-lab --strict --no-interactive` passes
- [x] 1.2 Create `package.json` (pinned versions), `tsconfig.json` (strict, `rootDir: "."`, `outDir: "dist"`), `eslint.config.js`, `.gitignore`, `README.md`; run `npm install` and commit the lockfile
- [x] 1.3 Write failing `test/policy.test.ts` (dedup/mandatory-preservation/unknown-ID cases, synthetic fixtures only) and observe `npm test` fail before `src/` exists
- [x] 1.4 Implement `src/contracts.ts` and `src/policy.ts` (`precheck`, `postcheck`); verify `npm run lint`, `npm run typecheck`, `npm test` all exit 0

## 2. Jev semantic gateway

- [ ] 2.1 Implement the two-pass gateway (`SemanticGateway` port + TypeSafe Jev adapter): pass 1 batches the seven signals, pass 2 verifies the top three skills; verify with fake-client tests covering all signals and absent optional candidates
- [ ] 2.2 Add bounded retries and per-signal confidence thresholds; verify timeout, service failure, and low confidence each produce `fallback` with the right reason in tests

## 3. Router and CLI

- [ ] 3.1 Implement `route(input, gateway)` composing precheck → gateway → postcheck, converting `invalid-input` and gateway failures to `fallback`; verify tests prove mandatory skills survive every outcome
- [ ] 3.2 Implement `src/cli.ts` reading a JSON input file and printing the typed decision plus structured metadata (no task text, secrets, or bodies); verify CLI tests and `npm run route` on a synthetic fixture

## 4. Smoke evidence

- [ ] 4.1 Run local gates (`npm run check`) and one live smoke; verify the smoke reports `status: ok`, exactly two Jev calls, all seven valid signals, latency/usage records, and states `n=1` proves operability only
