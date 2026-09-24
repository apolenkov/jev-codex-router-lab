<!-- rubric-version: skill-routing-arena-gold-v1 -->
# Gold-labeling rubric, v1

This rubric defines the labels in `dev-gold.json` for the public, synthetic
development corpus. It supplements the corpus and gold-record constraints in
the arena spec; it does not define a production verdict.

## Independent annotation input

For each case, consider only its task text, explicit skill IDs, required skill
IDs, and the frozen skill manifest. The `familyId`, `stratum`, `source`, and
`risk` fields are audit metadata: do not use them to choose labels. Labelers
work independently and must not see another labeler's answers before they
submit all 60 records.

## Labels

- `forcedSkillIds` is the union of `explicitSkillIds` and `requiredSkillIds`.
  `acceptedRoutes` contains only optional skills; forced skills must not be
  repeated there.
- Each `acceptedRoutes` entry is a set of zero to three skills from the
  manifest that materially help fulfill the request. Include multiple routes
  only when each is independently a complete, defensible choice. Do not add
  speculative preferences or supersets of an already complete route.
- Use exactly `[[]]` when no additional skill materially improves the work
  beyond the forced skills.
- `mandatorySkillIds` contains forced skills whose omission would violate an
  explicit request, a governing requirement, or task success. A user request
  to use a named skill counts as an explicit requirement.
- `forbiddenSkillIds` contains only manifest skills that are clearly harmful,
  contradictory, or unsuitable for this case—not skills that are merely
  unnecessary. It must not overlap a forced skill or any accepted route.

## Adjudication and balance

The adjudicator reviews every disagreement against the same manifest, case,
and rubric version, and records one defensible result. Preserve genuinely
equivalent accepted routes; do not resolve ambiguity by adding arbitrary
skills. Never alter labels to hit the target route-size counts (15/22/15/8).
If adjudicated labels miss a required count, revise the affected synthetic
cases and independently relabel each changed case before pinning gold.

## Frozen provenance

Use only the stable roles `annotator-a`, `annotator-b`, and `adjudicator`.
Record the version string `skill-routing-arena-gold-v1`; do not record people,
model names, timestamps, private text, or session-derived material.
