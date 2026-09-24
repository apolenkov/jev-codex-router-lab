# Spec Delta

## Purpose

Define a reproducible synthetic annotation corpus for case-bounded evaluation
of Jev pass-1 signals, with an auditable offline correction layer for reviewed
risk labels.

## ADDED Requirements

### Requirement: Annotation labels describe only model-visible evidence

Each label MUST be justified by the task text or candidate content available to
the corresponding Jev question. The annotation record MUST distinguish
`resolved`, `ambiguous`, and `not_queried`; `null` MUST mean the question was
asked and no candidate was suitable. Protected context MUST NOT enter examples
or provider request fixtures.

#### Scenario: No supplied candidate fits

- **WHEN** an optional question is present and no candidate satisfies the label guide
- **THEN** the resolved expected answer is `null`/`none` with evidence for the negative label

#### Scenario: No candidate was supplied

- **WHEN** the input has no candidates for an optional question
- **THEN** the annotation state is `not_queried`, distinct from a resolved negative

#### Scenario: Visible evidence permits multiple answers

- **WHEN** independent annotators cannot resolve a unique label using visible evidence and the guide
- **THEN** the field is marked `ambiguous` and is not silently counted as a negative

### Requirement: Annotation provenance is auditable

Every case MUST record its author, scenario family, guide version, two isolated
annotations, evidence spans, and adjudication result. Annotators MUST NOT see
Jev outputs, each other's labels, or threshold candidates. Model-assisted
annotations MUST be identified as model-generated and MUST NOT be described as
independent human gold labels.

#### Scenario: Annotators disagree

- **WHEN** two independent labels differ
- **THEN** preserve both labels and resolve from cited input evidence or mark the field ambiguous

### Requirement: Corpus partitions are frozen and kept separate

The rubric pilot MUST contain 14 new cases and MUST NOT enter threshold
selection or evaluation. The final corpus MUST contain 56 calibration and 28
locked evaluation cases. Related scenario-family variants MUST remain in one
partition, and the previously exposed C1-C6/H1-H2 cases MUST be excluded.

#### Scenario: Selector evaluates calibration data

- **WHEN** a threshold candidate is selected
- **THEN** the selector receives calibration cases only

#### Scenario: Evaluation data is unlocked

- **WHEN** the threshold candidate and decision rule are frozen
- **THEN** the evaluation partition is scored once and is not used for retuning

### Requirement: Preparation stays offline and synthetic

Corpus preparation MUST use authored synthetic tasks or public material only.
It MUST make zero Jev/TypeSafe or other scoring/evaluation API requests, run no
threshold selection or experiment, install no thresholds, and preserve the
runtime's fail-closed behavior. Model-assisted annotation and reviewer
conversations are allowed when their model provenance is recorded; they MUST
NOT be described as independent human gold labels.

#### Scenario: Dataset is authored and validated

- **WHEN** the preparation checks run
- **THEN** they validate schema, provenance, split/family integrity, and privacy locally without calling Jev/TypeSafe or a scoring/evaluation API

### Requirement: Results are reported with limited claims

Ambiguous and unqueried fields MUST be reported separately from evaluable
denominators. Public origin MUST NOT be treated as proof that an example was
absent from model training. The corpus MUST NOT be represented as statistically
powered or as evidence of production readiness or economy.

#### Scenario: A signal lacks adequate support

- **WHEN** a partition lacks sufficient resolved positive or negative examples for a signal
- **THEN** that signal is reported as not evaluated rather than assigned an unsupported threshold

### Requirement: Risk corrections preserve source annotations and replay provenance

Reviewed risk-label changes MUST be recorded in versioned, offline correction
ledgers. Retain the v5 corpus, manifest, and ledger under
`fixtures/checkpoints/v5/` as an immutable checkpoint.
The final v6 ledger MUST retain the original source manifest SHA-256 and use the
v6 manifest SHA-256 as its base hash and exact replay input. Each ledger version
MUST apply only to its matching base corpus, and every prior label MUST match
that version's base leaf. For each correction, retain the prior and effective
label leaves, visible evidence from the matching base task text, rule, and
rationale. Store reviewer provenance once in the top-level
`review.reviewers` mapping from each risk dimension to its `reviewerId`. Each
correction's `signal` MUST resolve to a reviewer through that mapping; entries
MUST NOT add a direct `reviewerId` field or duplicate reviewer provenance.
Original dual annotations and adjudications MUST remain byte-for-byte
unchanged. Effective risk labels MUST be computed by overlaying valid ledger
entries on their matching base corpus; a ledger MUST NOT replace or rewrite
original annotations.

#### Scenario: A correction is replayed against its versioned baseline

- **WHEN** a versioned offline ledger is applied
- **THEN** its base hash matches the corresponding versioned corpus manifest, each correction is applied only when its prior leaf matches that base leaf, and the effective leaf is derived from the ledger while original annotations and adjudications remain unchanged

#### Scenario: Effective risk coverage is reported

- **WHEN** coverage is calculated after valid corrections are applied
- **THEN** per-split and per-signal denominators are computed from the effective labels, and any signal without supported evaluable labels is reported as not evaluated

#### Scenario: Risk corrections are reviewed

- **WHEN** the ledger is created or validated
- **THEN** ledger replay and coverage use local corpus data only, make no Jev/TypeSafe or other scoring/evaluation API requests, and allow model-assisted reviewer conversations when their provenance is recorded

### Requirement: Explicit-negative repairs produce a locked v6 checkpoint

The v6 corpus MUST preserve the 14/56/28 case IDs, split assignments, and
scenario-family membership from v5. Only `taskText`, revision metadata, and
truthful author provenance for CAL-043, EVAL-015, and EVAL-019 MAY change;
the incorrect author model metadata for CAL-022, CAL-041, and CAL-042 MAY be
corrected from primary execution logs without changing their inputs, labels,
annotations, or adjudications. Each revised task MUST contain
guide-compliant visible evidence for true explicit exclusions. The v5 corpus
and manifest MUST remain an immutable checkpoint. Publish a new v6 manifest
and updated correction ledger tied to the v6 base manifest.

#### Scenario: Revised cases receive fresh full-case labels

- **WHEN** any of the three task texts is revised for v6
- **THEN** obtain two fresh independent blind full-case annotations and a new adjudication based only on the revised input and those annotations; annotators and adjudicator do not see its prior v5 labels or adjudication, and no v5 label is reused as a v6 annotation

#### Scenario: Historical author model is corrected from primary evidence

- **WHEN** the author model for CAL-022, CAL-041, or CAL-042 is corrected in v6
- **THEN** a primary execution log identifies the actual model, the v5 checkpoint remains unchanged, and that case's input, labels, annotations, and adjudication remain identical to v5

#### Scenario: Final risk splits have positive and negative support

- **WHEN** effective risk coverage is reported for v6
- **THEN** each evaluated risk dimension has at least one resolved positive and one resolved negative effective example in both the 56-case calibration split and 28-case locked evaluation split; any dimension missing either class is reported as not evaluated

#### Scenario: Evaluation is re-locked as v6

- **WHEN** the v6 manifest is published
- **THEN** its evaluation split is locked, no threshold is selected, and no provider scoring request is made
