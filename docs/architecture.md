# Architecture

The router treats Jev as an untrusted advisory component behind deterministic
policy. The model can rank allowlisted options; it cannot invent an executable
action, remove a mandatory skill, reveal protected context, or bypass a failed
check.

## Flow

```text
RouterInput
   |
   v
precheck (deterministic)
   |  validate shape, sizes, IDs, mandatory skills
   |  derive forcedSkillIds + protectedContextIds
   v
pass 1 (Jev)
   |  classify task; rank optional skills and other allowlisted candidates;
   |  score five risk dimensions
   v
postcheck (deterministic)
   |  validate closed schema, echoes, probabilities, allowlisted IDs
   |  cap optional skills at three
   +---------------------- no optional skills --------------------+
   |                                                            |
   v                                                            v
pass 2 (Jev)                                              RouterDecision
   |  rank shortlist; independently score each skill fit
   v
confidence policy + postcheck (deterministic)
   |
   v
RouterDecision: ok with seven signals, or typed fallback
```

## Responsibility split

| Deterministic code guarantees | Jev judgments |
| --- | --- |
| Input shape and text-size bounds | Task classification |
| Catalogue and candidate allowlists | Optional skill ranking |
| Mandatory-skill preservation | Critical-gap selection |
| Protected-context preservation and exclusion | Reuse-candidate selection |
| Request-state echoes and stale-response rejection | Architecture-fork selection |
| Closed response shape and probability bounds | Risk probabilities |
| Optional-skill cap and known-ID checks | Context relevance |
| Safe fallback and metadata-only reports | Pass-2 shortlist ranking and fit |

An `ok` result means the semantic output passed these mechanical checks. It
does not mean the semantic judgment is correct.

## Provider payload

Before any SDK call, `precheck` requires a valid `RouterInput`. Task text is
limited to 8,000 UTF-16 code units; every other Jev-facing free-text field is
limited to 4,000.

Pass 1 receives:

- the permitted task text;
- non-mandatory skill IDs and descriptions;
- allowlisted critical-gap, reuse, and architecture-fork candidates;
- allowlisted non-protected context IDs and summaries;
- state echoes used to reject stale decisions.

Pass 2 receives the permitted task text and only the shortlisted skills' IDs,
descriptions, and excerpts. Mandatory skills are already fixed by policy and
are not delegated to Jev. Protected context IDs and bodies are excluded from
both passes; only deterministic output retains their IDs.

## Decision and fallback

The `RouterDecision` union has two forms:

- `ok`: the seven checked advisory signals plus `forcedSkillIds` and
  `protectedContextIds`;
- `fallback`: one of `invalid-input`, `service-error`, `malformed-response`,
  `stale-decision`, `unknown-id`, or `low-confidence`, plus the deterministic
  mandatory/protected IDs recoverable from the input.

Pass 2 is skipped when pass 1 selects no optional skill. A service or model
failure never triggers a command or permission change; it produces fallback.

## Telemetry

Optional reports contain decision status, call count, per-pass and total
latency, model, observable token usage, retry counts when observable, cache
status, and cost when configured prices and usage are complete. They exclude
task text, skill and context bodies, provider payloads, raw responses, and
exception messages.

Reports are create-once and written only inside the repository. See
[Security and privacy](security-and-privacy.md) for operational constraints.
