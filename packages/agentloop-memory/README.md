# @zhujun/agentloop-memory

The Local Agent-only implementation slice of the AgentLoop user Memory design.

Task learning distinguishes grounded execution fragments, parameterized subtask
strategies and scoped resource/environment cognition. Independently usable
`reusableKnowledge` claims declare `standalone: true` and their own complete
conditions/exclusions. Verified claims publish as individual
`experience.knowledge` revisions for execution-time retrieval, even when the
parent classic path remains a candidate. Unmarked historical rules retain their
original group scope; they are not automatically promoted or migrated.

Standalone claims have one owner-scoped `experience.independent_knowledge`
ledger, including candidates. Task-family nomination and independent-method
nomination are separate bounded semantic comparisons: `merge=new` may still
support, revise or contradict an admitted independent method from another task
family. Shared tools or matching text never authorize an identity relation.
The model compares each fixed proposal with its original content, parameters
and definition version; support preserves that definition, while explicit
revision resets validation even if the words are unchanged. Contradictions
remain unavailable until explicit revision and fresh validation.

Task groups retain case snapshots and versioned knowledge bindings. They are
not the validation authority for independent claims. Group/canonical-ledger
updates use one CAS transaction; concurrent support merges against the latest
ledger, while a stale definition comparison must be reconsidered. Execution
cards use `experience.knowledge:<knowledgeId>` and point to the exact current
ledger revision. Both recall checks fence outdated cards before and after
semantic relevance inference. An unrelated group change cannot suspend or
renew a card, and an interrupted publication resumes from the case checkpoint
without another inference or duplicate support. Standalone claims do not also
publish through group procedures. Old group-owned cards fail the new origin
check; historical reconstruction is an explicit isolated rebuild, with no
compatibility reader or automatic online migration.

Strategies require two independent verified executions. Resource cognition may
instead cite one exact Runtime-selected Result fragment, with explicit resource
and version selectors plus recheck instructions. `record_execution_insight`
supports up to four JSON evidence selections of at most 600 characters each;
the selected values and original receipts remain distinct from model
interpretations. This establishes source provenance, not semantic entailment or
permanent validity. Raw logs and complete result bodies remain outside learning.

With Memory enabled, `recall_task_knowledge` queries the current step's concrete
information gap for up to four bounded knowledge cards (1600-token budget).
Owner authorization, exact resource context, current revisions, support
invalidation and whole-card budgets apply before projection. Missing selectors
exclude scoped cognition. Cards retain operation templates, parameters,
conditions and recheck rules; they never grant capabilities or replace current
Skill/Tool contracts. Their committed retrieval results provide a chronological
handoff to later actions in the same step, enabling the existing asynchronous
per-knowledge application review. Retrieval itself does not establish adoption,
new support or an efficiency benefit.

This package deliberately keeps the Memory boundary separate from Skills,
Tools and PlanTemplate. It provides:

- append-only `MemoryRevision` records owned by `tenantId + ownerUserId`;
- policy checks that prevent secrets and unconfirmed sensitive data from being
  persisted;
- target-specific, bounded `MemoryProjection` snapshots with content hashes;
- an idempotent settlement enqueue boundary;
- a versioned `agentloop.experienceSettlement/v1` shape separating outcome,
  key steps, reusable knowledge, failures/corrections, preference signals and
  canonical references;
- a durable SQLite store owned by the Local Agent process;
- an in-process store for contract tests only.

`createLocalMemoryPlugin({ database, ... })` is the production composition
entry point. The database must be a local SQLite connection and remains owned
by the Local Agent. The package has no cloud/control-plane backend and must
not be registered by the cloud Runtime Host.

An `experience.episode` is retained as an auditable single-Run record only;
it is not recalled as a Planner prior. The local consolidator clusters
independent verified-success episodes with similar task fingerprints before
creating an `experience.procedure`. Failed episodes remain lessons/warnings.

Batch settlement supplies canonical steps, executed actions and acceptance
evidence to bounded fusion calls; pending audit Episodes are not extracted learning.
After committing a Task Group it publishes the matching Planner procedure when
at least two distinct verified-success Runs support it. Reinforcement retains
the established method and accumulates support across batches; conflicts suspend
automatic recall. A persisted batch checkpoint lets retries finish publication
without repeating fusion. Source references and canonical capability IDs remain
bounded by the request-specific output schema. Settlement uses the selected
model adapter's completion deadline, defaulting to 60 seconds when unspecified.

Oversized inputs are normal workloads. Historical Task Groups project only the
source IDs actually cited by their claims; fresh aliases resolve directly to
original receipts instead of growing ancestry names. Evicting a historical group
also evicts its source index and candidate IDs. New revisions retain a compact
claim source index; immutable audit revisions and KnowledgeUnit evidence remain.
Grouping and fusion split large batches into complete case sets. A single large
case uses ordered evidence windows with explicit partial coverage and its original
Run/execution identity. Every observation and plan step remains in the audit;
window checkpoints resume accepted publications after a later failure. Windows
do not count as independent successful Runs. Default single-job workers use the
same adaptive path for inputs exceeding the legacy collection or request limits.
Unsplittable evidence atoms or headers still report an explicit diagnostic;
they are never silently truncated into apparently complete evidence.

Explicit preference intake is open-ended: the resolver proposes a stable dotted
semantic key, a bounded JSON value, a subject/condition-preserving description,
and a supporting `sourceQuote`. The plugin validates each proposal and commits
every accepted candidate in the message. Unknown preference keys do not require
a schema-specific branch. Existing keys are supplied to the resolver for semantic
revision matching; they do not authorize a new memory instruction.

`applicability.scope=global_interaction` explicitly identifies topic-independent
interaction preferences. It requires user authority and user-message/setting
provenance, and permits only Response/HIL targets. These preferences need no
task-topic match or relevance-model call; owner, validity, activation, selectors,
revision and projection-budget fences still apply. Facts, methods, source choices,
business definitions and task formats retain task relevance checks. An omitted
scope, including older revisions, never implies global scope. The resolver owns
this semantic classification without a subtype allowlist or automatic migration.

Every target projection preserves selected preferences in `preferences`;
Response/HIL also render their values and descriptions into `promptMarkdown`,
and Execution/Artifact augmentations retain both. The original typed `guidance`
fields are a compatibility view. Projection budgets count values as well as
descriptions. An explicit empty proposal list bypasses legacy regex intake;
that compatibility path applies only to direct callers that omit the list.

New conversation resolutions must make durability deliberate: `memoryAction=none`
requires `memoryIntents=[]`, while `memoryAction=commit` requires at least one
candidate. Missing or incoherent fields are repaired at the resolver boundary.
The Runtime separately reports the actual commit outcome to response generation
and assessment, so a model proposal cannot be presented as a successful save.

Planner 召回按目标投影的语义内容估算预算，不按完整审计记录计费。流程只投影一份 `suggestedSteps`，保留全部步骤、工具、适用条件、验收标准、警示和复核规则；来源明细留在持久修订中，由 `sourceRefs` 引用。方法本身超预算时整条跳过，不截断后续步骤或条件。

Planner priors also carry compact `knowledgeBindings` identifying each verified
method, rule and lesson in the immutable projection. Independently of semantic
fusion, the local outbox reviews their application against this Run's action and
assessment observations, in bounded batches. `local_memory_application_reviews`
retains the projection/revision/knowledge IDs, affected steps, source receipts,
adoption decision, local verification outcome, model identity and input hash.
Unchanged inputs reuse accepted checkpoints. Invalid references, incomplete
coverage and unavailable models cannot silently become successful reviews;
failures use the existing retry/dead-letter path without undoing already saved
learning or blocking the Run's terminal delivery. Batch workers checkpoint all
canonical Episodes before any model grouping/fusion. Grouping failures are
isolated to their input bucket, fusion failures to their method family, and
review failures to their Run/knowledge batch. Each job retains its own outcome;
one rejected family cannot mark other families dead or suppress their reviews.

These are retrospective model assessments with validated references, not causal
benefit measurements or additional independent support. Recall, loading a Skill
and overall Run success never establish per-knowledge adoption. An observed
failed operation may support an attempted application/counterexample; a failure
without execution evidence may not. Acceptance must cite the actual action's
tool call or result through reader-resolved observation links; matching step
numbers alone cannot borrow an earlier attempt's approval. Execution receives
only identity-bound recalled knowledge, with its scope and current-task parameter
rules. `prompt_augmentation.activated` records the exact knowledge identities and
admitted step; the reader links that handoff only to later dispatched actions in
the same step. Availability alone still does not prove adoption. Older Runs
without a matching handoff stay unknown rather than gaining inferred credit.
These action and handoff links are required
for a supported application. Missing evidence stays unknown. The first slice
reviews published experience knowledge only; legacy snapshots without knowledge
bindings remain audit-only. Preferences/facts and semantic forgetting retain
their separate contracts.

Local retrieval fuses BM25 word ranking, Han character similarity and task
fingerprint matching with reciprocal rank fusion. Scope, validity, activation,
authority and projection budgets remain independent gates. Historical answers,
caseFacts and audit prose never rank experience methods. Projections retain
the lexical, character and fingerprint signals. New semantic settlements can
also retain parameterized `retrievalQueries` in the original task language and
English; historical case answers remain outside the search document.

The local host supplies its configured Memory model as `recallModel` for bounded
topic matching across languages for every application target (at most 24
eligible revisions, a 15-second deadline and a five-minute owner/revision/goal-bound
cache). Individual judgments are reused across targets and candidate subsets;
changed goals, revisions and owners do not share cached judgments. Positive topic
judgments can nominate a method missed by lexical search; negative and uncertain
topic judgments are excluded even when superficial lexical overlap exists.
Without a usable judgment, goal-bearing recalls require positive retrieval
evidence for task-scoped conventions/facts as well as methods. Explicit global
interaction preferences follow the scope contract above. Missing, malformed, uncertain or unavailable model
judgments cannot admit a method on fingerprint similarity alone. Exact scope,
validity, activation, invalidation and maturity filters run before the model.
Natural-language conditions and recheck rules remain in the method card and
must be verified against current sources; topic relevance does not prove them.
Planner ranking places explicit constraints first, then relevance, so relevant
methods do not lose their entire budget to unrelated defaults. Complete methods
still fit or are skipped as a whole; there are no neural embeddings or claims
that a model relevance score establishes correctness or benefit.
The kernel persists `memory.recall.assessed` diagnostics even when no projection
is produced: eligible revision IDs, model status, relevance scores, projected
IDs and budget exclusions. These records omit memory bodies and model prose.
Recall rechecks active revisions and invalidated support after model inference,
so a concurrent correction or replacement cannot publish the old snapshot.

Execution resumes (including Human Loop answers, service recreation, recovery
and intent steering) rebuild method and interaction augmentations through fresh
recall. Current owner, revision, validity and goal checks therefore apply to the
resumed segment. Revoked or unavailable memory is removed rather than replayed
from a stale transcript; unrelated prompt augmentations remain intact. Method
handoffs retain their knowledge identities and never expand tool admission.

The settlement reader retains structured observation references for local audit,
including middle and late actions. This audit is not the model's learning input.
Extraction and fusion consume a method view: execution path, acquisition methods,
explicit choices, prerequisites, checks and failure-driven changes. Only successful
actions with matching local input/result identities share one method card; command
forms alone never establish equivalence. Unknown identities remain distinct. Repeated acquisition cycles retain
their order and repetition count. Decisions, failures, changed methods and step
boundaries remain distinct. Every card resolves locally to its original receipts;
repetitions within one Run never become independent verification.

Model prompts/responses, tool bodies, returned free-text summaries, unstructured error
messages, complete option catalogs and case result rows are excluded from this
view. Source events and action times place choices between the actions they
actually separated. Decision principles come from explicit constraints,
prerequisites, choices and verification criteria, never inferred private model
reasoning. Existing privacy checks remain; adaptive evidence windows handle
genuinely distinct large methods after method compaction.

With a Memory plugin, Runtime also exposes optional `record_execution_insight`.
After a meaningful discovery or change of approach, the Agent can record a bounded
purpose, finding, information-need status and next action against up to four
committed Tool Results from the current step. Runtime resolves their producer
actions; the reader preserves exact links and chronology. These records are public
model interpretations, never private reasoning, independently verified facts,
completion receipts or durable user instructions. Interpretation-only sources do
not increase a method's independent success support. Every Skill can use the same
tool without a domain-specific Memory adapter; ordinary operations need no note.

The reader also retains bounded structural observations (collection counts and
JSON selectors, without returned values), explicitly marking unavailable or partial
profiles. Counts do not prove source coverage or fulfillment. Broad step objectives
are supplied once through the plan skeleton, rather than repeated on every method.

Before historical fusion, `selection` compares compact goal/method indexes through
the configured local model. Broad fingerprint compatibility is only an exclusion
boundary; shared tools or task labels never automatically admit a history body.
Cross-language relevance is assessed before expanding selected groups. Indexes omit
case answers, source ledgers and support counts. All eligible indexes are visited in
bounded windows; at most four groups and seven unrepresented extracted episodes
are expanded. Invalid or unavailable selection uses the existing diagnostic/retry
path rather than silently creating a new family. Accepted selections are checkpointed
against the query, prompt and exact historical revisions. Already-fused publication
checkpoints remain independent of nomination. Large-history indexing cost still
needs measurement; these changes do not establish real-model learning quality or
end-to-end token savings.

Invalid semantic outputs receive at most one complete regeneration with field
diagnostics and the same evidence and admission sets. Adaptive evidence budgets
reserve room for diagnostics within the 60k-character request limit, including
correction of large evidence windows. Invented source identities
and private output are immediate failures. After regeneration, independently
invalid optional tool-use suggestions or unsupported confirmed failure lessons
may be isolated as whole units. The original unit, validation errors and accepted
projection hash remain in the settlement audit, outside published knowledge and
recall. Ordered classic paths, core rules, scope and merge decisions remain
atomic: their validation failures cannot be repaired by deleting steps.

Terminal settlement notification belongs to the shared `TerminalCommitter`,
including HIL recovery, caveated completion, failure and cancellation. Local
Runtime additionally treats committed `run_outcomes` as a durable outbox and
scans it in bounded pages across registered databases. Its independent cursor
advances only after idempotent Memory enqueue, so a notification failure or a
crash between enqueue and acknowledgement is retried without another learning
case. This also discovers older Outcomes whose completion branch missed enqueue.
Only queue registration happens at this boundary; extraction remains asynchronous.

Conversation Working Sets retain bounded historical selected options and boolean
confirmations with their original question, goal and event identity. They omit
free-text/form values and decisions from disputed/superseded outcomes. These
cards require confirmation and never enter the new Run's authority ledger or
silently establish a permanent preference. Changed subjects, dates and requested
values require current-task binding and fresh evidence.

The Local Runtime polls durable correction/dispute events in bounded pages,
resolves targets across its registered local databases within the same owner
and conversation, and persists a Run invalidation before waiting for busy
settlement. Recall fences out support from invalidated Runs even if a stale
worker subsequently publishes it; publication also removes that support.
Knowledge support is reconciled without a model or batch wait, then existing
outbox jobs are replayed with their normal retry policy. Durable cursor anchors
detect SQLite rowid reuse after deletion. Feedback does not delete history,
identify a causal culprit, or automatically turn a temporary choice into a
preference. Suspended Runtime databases are scanned when registered again.

Semantic forgetting (including paraphrase suppression and prevention of
relearning a forgotten concept) and real-model cross-domain effectiveness
evaluation are subsequent work; invalidating execution support is not a
replacement for either.

Failed tasks can also yield independently scoped `decision_rule` candidates
for stopping, retrying, or changing paths. These require a current failed
operation, exact selected observations, resource selectors, exclusions,
alternative checks and resume/recheck conditions. Execution recall labels them
`maturity=candidate` with `execution_observation` support; repeated failure
does not verify them. Current Runtime stop events can establish adoption with
an earlier same-step handoff and linked failed operation, while effect remains
unverified. A stopped candidate loop is not proof of task termination or benefit.

Validated inference summaries, including `no_learning` and corrections, are
durable checkpoints bound to the model, prompt and admitted evidence. A review
or pre-publication failure reuses the summary after validation; worker failures
have separate stage records. Neither checkpoint contains raw model responses,
full tool returns, prompts or execution logs.

When historical groups are compared with a new batch/window, the model first
summarizes current evidence without historical proposals. Fusion receives this
`independentLearning` and, when budget permits, its compact neutral observations.
Without history, a single inference is sufficient. Both stages use the same
bounded input, validation and durable checkpoint machinery; failed fusion does
not regenerate an accepted independent summary. Batch scheduling is unchanged.

`resultDiagnostics` preserves declared states, structured error codes/phases and
short redacted diagnostic messages; structural row counts remain separate from
information fulfillment. The model writes `executionReview` before claims and
assesses each path step/rule/lesson using `evidenceAssessment` (support status,
reason, exact citations and limitations). Successful Run counts and valid
citations remain necessary support checks, but never replace this semantic
judgment. Missing/tentative/contradicted assessments cannot promote new methods.
Retracted reviewed evidence requires reassessment rather than count replacement.
Published limitations travel with recall; contradicted decision advice is excluded.
Legacy verified revisions remain auditable and are not bulk rewritten.
