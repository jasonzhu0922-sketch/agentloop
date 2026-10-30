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
