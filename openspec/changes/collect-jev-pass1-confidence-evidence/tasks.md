# Tasks

## 1. Pre-register the bounded experiment

- [x] 1.1 Record the frozen corpus/question fingerprints, fixed case order, label status, measurement fields, request/spend caps, failure rule, and claim limits

## 2. Implement the collection-only path with TDD

- [x] 2.1 Add failing tests for shared structural pass-1 parsing without confidence gating, optional-question omission, stale echoes, malformed/unknown IDs, and Noul/Choice numeric evidence
- [x] 2.2 Add failing tests for the eight-attempt/USD 0.021504 limits, USD 0.002688 reservation, zero retries, redirect rejection, sequential one-case/one-request behavior, and terminal failure handling
- [x] 2.3 Add a single-use pass-1-only CLI and closed create-exclusive local artifact writer; document its paid synthetic-data boundary; prove the route remains fail-closed and no pass-2 path is invoked

## 3. Verify locally

- [x] 3.1 Run focused tests, build, lint, typecheck, full tests, strict OpenSpec, diff checks, and ignored-path validation
- [x] 3.2 Inspect exact files and request path before any live collection; confirm no production threshold or old experiment default changed

## 4. One owner-authorized live collection

- [x] 4.1 Collect C1-C6, H1, H2 sequentially once, stop on first terminal error, and retain only the approved local evidence fields
- [x] 4.2 Inspect closed artifact fields and exact accounting; summarize case-bounded results and caveats without publishing or running full-router smoke
- [x] 4.3 Obtain mandatory final Astra review of the tested candidate and evidence; address any important finding and repeat targeted checks
