# Spec Delta

## Purpose

Define a reproducible synthetic annotation corpus for case-bounded evaluation
of Jev pass-1 signals.

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
It MUST make zero provider requests, install no thresholds, and preserve the
runtime's fail-closed behavior.

#### Scenario: Dataset is authored and validated

- **WHEN** the preparation checks run
- **THEN** they validate schema, provenance, split/family integrity, and privacy locally without calling Jev

### Requirement: Results are reported with limited claims

Ambiguous and unqueried fields MUST be reported separately from evaluable
denominators. Public origin MUST NOT be treated as proof that an example was
absent from model training. The corpus MUST NOT be represented as statistically
powered or as evidence of production readiness or economy.

#### Scenario: A signal lacks adequate support

- **WHEN** a partition lacks sufficient resolved positive or negative examples for a signal
- **THEN** that signal is reported as not evaluated rather than assigned an unsupported threshold
