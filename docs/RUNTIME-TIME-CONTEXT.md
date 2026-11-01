# Runtime time context

Each Run captures one `agentloop.runtimeClock/v1` before its first model call.
The host clock supplies the instant, never an LLM, old conversation, source
timestamp, or caller-supplied "now". `RunService.timeZone` configures an IANA
zone; absent that setting, a Local Runtime uses the device zone and labels its
origin `runtime_host`. Cloud deployments must configure the appropriate user
zone instead of assuming their server's zone is the user's zone.

The clock is stored in `run.started` and canonical intent. The common model
boundary supplies it to intent resolution, planning, execution, assessment,
compaction, retries and recovery. Recovery reuses the persisted clock, not a new
date. Relative time remains anchored even if execution crosses local midnight.
Refreshing observations is distinct from changing the reference instant.

The resolver preserves the user's relative wording. A separate `temporalScope`
quotes the time expression and records its origin.
Typographic spacing around Han characters and digits may differ in the model's
quote; Runtime anchors it back to the actual user substring. Word boundaries,
paraphrases and combined non-contiguous clauses are not normalized away.
For relative calendar days,
the model chooses integer `startDayOffset` and `endDayOffset`, with the local
reference day at offset zero. Runtime computes timezone-aware absolute bounds;
the model does not invent an absolute "today". For example, a five-calendar-day
window including the current partial day has offsets -4 and +1. This convention
must be stated to the user; a rolling duration is a different interpretation.
Elapsed-time intervals use `alignment=elapsed_seconds` and second offsets.
For a calendar window through the current partial day, use
`endAtReferenceInstant=true` instead of `endDayOffset`; Runtime uses the Run
reference instant as its exclusive upper bound. `endDayOffset=0` means the
start of today and therefore excludes today. ISO civil dates not present in
the current or selected prior user's input are rejected from goal, deliverable
purposes and user constraints rather than promoted into user authority.
Explicit historical/hypothetical scopes use `basis=user_explicit`, offset-aware
timestamps, and a user expression as provenance; they do not alter the clock.
Pure continuation retains the earlier resolved scope; source refreshes and
user corrections may resolve a new scope. Derived bounds are not user quotes
and must not be copied into `userConstraints` as explicitly mandated dates.

Time scope is provider-neutral. Sources may return `temporalCoverage` with
`startInclusive`, `endExclusive`, `timeZone` and `complete`. Runtime compares
interval coverage (including unions), not a whitelist of phrases such as seven
or thirty days. A truncated or text-only query cannot attest an exhaustive
date-range result. Tools that do not declare this metadata remain subject to
semantic evidence assessment; no temporal gate invents coverage for them.
Models continue to discover source operations via the ordinary tool catalog;
there is no email-specific task routing or forced call.

Bounded intent repair retains all earlier validation feedback, so correcting
one field does not discard a different contract failure from the previous attempt.
Independent provenance failures are reported together, with field addresses.
Rejected arguments and their validation result remain an assistant/tool exchange
for the next repair attempt; the resolver never executes a service operation.
