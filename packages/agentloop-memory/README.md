# @zhujun/agentloop-memory

The Local Agent-only implementation slice of the AgentLoop user Memory design.

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
evidence to one fusion call; pending audit Episodes are not extracted learning.
After committing a Task Group it publishes the matching Planner procedure when
at least two distinct verified-success Runs support it. Reinforcement retains
the established method and accumulates support across batches; conflicts suspend
automatic recall. A persisted batch checkpoint lets retries finish publication
without repeating fusion. Source references and canonical capability IDs remain
bounded by the request-specific output schema. Settlement uses the selected
model adapter's completion deadline, defaulting to 60 seconds when unspecified.

Explicit preference intake is open-ended: the resolver proposes a stable dotted
semantic key, a bounded JSON value, a subject/condition-preserving description,
and a supporting `sourceQuote`. The plugin validates each proposal and commits
every accepted candidate in the message. Unknown preference keys do not require
a schema-specific branch. Existing keys are supplied to the resolver for semantic
revision matching; they do not authorize a new memory instruction.

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
