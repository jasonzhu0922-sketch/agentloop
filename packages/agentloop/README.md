# @zhujun/agentloop (kernel)

Plan-first single-agent runtime kernel for professional AI agents. This package
is a **headless library**: it ships the planning/runtime/storage/tool
engine and exposes it through the `@zhujun/agentloop` entry point only.

- Identity is an opaque `userId` string; bring your own authentication.
- Persistence goes through injectable connections/stores (SQLite default).
- HTTP application routing is host-owned; `streamRuntimeRun` supplies the shared durable SSE transport. See `apps/agentloop-desktop` for the Desktop host and
  `apps/agentloop-multi-runtime` for the multi-runtime application.
- Bundled Skills live in `@zhujun/agentloop-skills`.

## Delivery to baowu-super-agent

Only this directory is the integration artifact. Build and pack it with:

```sh
npm run pack:kernel
```

Bundled Skills are packaged separately with:

```sh
npm run pack:skills
```

The generated package contains the compiled kernel only; it does not contain
the Desktop App or bundled Skills. The host should install the generated
tarball (or the published `@zhujun/agentloop` package) and import only from the
package entry point:

```ts
import { AppDatabase, RunService, SkillService } from "@zhujun/agentloop";
```

The Desktop App is an independent local host. Its HTTP server, authentication,
and web UI are not part of the kernel delivery contract.

## Usage

```ts
import {
  AppDatabase,
  LlmProviderRegistry,
  RunService,
  SkillService,
} from "@zhujun/agentloop";

const database = new AppDatabase("./data/app.db");
const skills = new SkillService(database, { skillDirectories: ["./custom-skills"] });
const providers = await LlmProviderRegistry.fromConfigFile("./llm-providers.json");
const runs = new RunService({
  database,
  skills,
  modelFactory: (onRetry, modelKey) => providers.create(modelKey, onRetry),
  defaultModelKey: providers.defaultModelKey,
  modelKeys: providers.modelKeys(),
  workspaceRoot: "./workspace",
});
```

## Execution state and long-term history

`RuntimePersistence` owns execution commits. Redis hosts use native records and
atomically register object-versioned history updates in the same Redis Lua commit.
`RuntimeHistoryReader`, `RuntimeHistorySink` and `RuntimeHistoryOutbox` are the
separate long-term query, projection and durable retry contracts. Assemble them
with `createRuntimeHistory`; pass `RuntimeHistoryView` to host history routes.
The writer and reader have independent bounded TiDB pools. TiDB is lazy and
never participates in Run admission, tools, HIL or terminal acknowledgement.

`runtime_history_objects` stores versioned entities, partial/final Results,
Plans/Steps/revisions, deletion tombstones and verified content references.
There is no history `run_events` projection. Full process archives and immutable
artifact bytes live in `RuntimeArchiveStore`; SQL contains checksums and stable
keys. Downloads read verified content through the uniform view. File archival
and history ingestion run independently. The previous optional single-row
summary API remains deprecated for existing integrations and is not the new
history mechanism.

SQLite hosts continue using SQLite history through
`PersistenceRuntimeHistoryReader` without Redis, TiDB or another projection
worker. No automatic Redis cleanup or legacy-history migration is performed.
See the repository document `docs/RUNTIME-HISTORY-STORAGE.md` for the version,
retry, deletion, configuration and verification contracts.

## Conversation reconstruction

`executeConversation` and `startConversation` resolve the latest request against
durable conversation history before admitting a new Plan. Original Run inputs
remain available even when a provider or planning failure prevented a Plan from
being created. Historical Plans and published Results remain immutable.

The Resolver owns the semantic relation and input mode. Runtime validates
selected historical bindings; it does not infer a prior-Result dependency from
words in the request. A resolved `new_goal` with no historical input proceeds
to ordinary planning, even when historical Results are absent or the request
mentions results as part of its new deliverable. Automatic Result binding is
limited to the selected prior goal's own published Results.

A prior-work binding rejection starts model-driven intent reconstruction within
the existing three-call resolution budget. The model receives chronological
requests, prior constraints, Plan step states, failure boundaries, and published
Result/artifact candidates. It reconstructs the latest goal and output contract;
the ordinary Planner then creates a new Plan with validated input bindings.
Selecting a Result can supply its producer identity without a duplicate goal
selector. Changing delivery preserves that Result's historical time scope, while
an explicit source refresh uses the new Run clock. Execution reads full bound
Results through `read_result`, rather than treating history summaries as complete.

Reconstruction emits `conversation.turn.reconstruction_started`, followed by
`reconstruction_completed` or `reconstruction_unresolved` under the same event
prefix. An unresolved historical target becomes a tool-free clarification; it
does not authorize arbitrary prior results or suppress unrelated schema errors.
History and Plan projections disclose their bounded coverage. This mechanism
does not imply that every historical Run is present in the current context.
Clarification asks about the unresolved user decision using user-facing names
and choices. Internal name-to-identifier resolution stays in the authorized
execution workflow; a missing history binding cannot establish missing source
configuration or new business prerequisites.

## Tools in conversational replies

A `reply` delivers a conversational answer using the existing Run-authorized Tool
catalog. Conversation mode selects orchestration and delivery; it does not
remove Tools based on their effect declarations. Workspace files, visible
directories, uploaded sources, published Results, and connected services retain
the same Run authority. A `clarify` turn remains tool-free.

Tool visibility does not require invocation. The model uses Tools only as needed
for the user's requested outcome. Account and connection selection, resource
scope, dangerous-tool settings, selected Skill bindings, and execution policy
plugins still apply before operations execute. Reply mode neither grants nor
revokes these permissions. Tool effect metadata describes operations and remains
independent of replay safety and authorization.

The same Run authorization is preserved through recovery and restart. Explicit
prior-Result inputs must be consumed through `read_result`; their identities are
retained in the published answer's provenance. History summaries are not full
Result content. Replies with Tool access use semantic assessment against the
latest request and evidence rather than accepting any non-empty answer.

## Build & test

```sh
npm run build   # tsc -> dist/ (the published artifact)
npm test        # stable Unit + SQLite Kernel contracts
npm run test:unit
npm run test:kernel
npm run test:full # extended suite; includes environment-dependent coverage
```

## Runtime performance diagnostics

Performance diagnostics are independent from `run_events`: they use a bounded
in-memory queue and asynchronously batch JSONL records to a local file or an
injected `RuntimePerformanceSink`. Diagnostic write failures and queue overflow
are counted and never fail a Run. Formal Runtime events are not sampled or
dropped by this feature.

Enable the default JSONL sink before constructing `RunService`:

```sh
AGENTLOOP_RUNTIME_DIAGNOSTICS_FILE=./diagnostics/runtime-performance.jsonl \
AGENTLOOP_RUNTIME_DIAGNOSTICS_CAPACITY=8192 \
AGENTLOOP_RUNTIME_DIAGNOSTICS_BATCH_SIZE=128 \
AGENTLOOP_RUNTIME_DIAGNOSTICS_FLUSH_MS=250 \
node your-runtime-host.mjs
```

Or inject a sink explicitly with `new RuntimePerformanceDiagnostics({ sink })`
and pass it as `RunService.performanceDiagnostics`. Call
`runs.closePerformanceDiagnostics()` during graceful host shutdown to flush the
queue, close the sink, and record any spans still incomplete at shutdown.

The JSONL contains correlated `runId`, `stepId`, `actionId`, `requestId`,
`toolCallId`, `spanId`, `parentSpanId`, and `transactionId` when available. SQL
records contain only a normalized template and operation; parameters, prompt
content, credentials, and business values are excluded. TiDB environment facts
retain only the endpoint host/port and database name.

Summarize one file or one Run:

```sh
node packages/agentloop/scripts/summarize-runtime-performance.mjs \
  ./diagnostics/runtime-performance.jsonl [runId]
```

`durationMs` on existing model events keeps its inclusive wall-clock meaning.
New model timing fields mark request send, response headers, first raw stream
chunk, stream end, and Runtime sink callback waits. Transport, SDK, sink, event,
and transaction spans can overlap, and sink backpressure can delay subsequent
reads; category totals and child spans must not be added to reconstruct Run
wall time or subtracted to claim a pure provider/tool/server duration. Database
SQL spans are client elapsed time including driver, pool/connection state,
network, and server round trip—not server execution time.

## Selectable Runtime execution state

`openRuntimeState({ backend: "sqlite", filename })` opens disk SQLite.
`openRuntimeState({ backend: "redis", url, namespace })` opens native versioned Redis records, indexes and ordered events, with atomic optimistic transactions and commit receipts. `RunService` and execution repositories share `RuntimePersistence`; Redis execution never uses SQLite or synchronous TiDB. Legacy `RuntimeStateConnection` remains explicitly a changeset compatibility adapter.

Redis requires healthy AOF, `appendfsync always`, and `noeviction`; connection/persistence failure does not select another engine. `RuntimeRecordMaintenance` independently archives terminal snapshots/events and optionally projects long-term summaries. No automatic TTL/pruning occurs. Large files require persistent/shared workspace storage. `RuntimeArchiveStore` exposes object-storage archive integration.

Use the explicit offline `scripts/transfer-runtime-state.mjs` from the source package for checksummed migration or archive restore. Configuration switches do not copy history. See [backend contracts, host defaults, migration and limitations](../../docs/RUNTIME-NATIVE-RECORDS-STATUS.md).

Common contracts: `npm run test:runtime-records --workspace @zhujun/agentloop`. Real Redis tests create their own AOF service, namespace and files. Performance evidence is under `verification/runtime-records`; short local benchmarks are not production capacity guarantees.

## Current decision working set

Execution derives bounded exact current evidence and the committed action frontier even when the model emits no context updates. Normal Tool calls may carry changed semantic interpretations in optional `_agentloopContext`; Runtime validates provenance and strips this metadata before execution. Equivalent reads and proven obsolete consumed file versions may leave resident history; current dependencies, large native read windows, unknown effects and provider continuation keep their own lifecycles. Full exchanges remain in the original ledger with authorized Result history access. User/HIL authority and product acceptance retain their existing owners. See [the contract](../../docs/KERNEL-DECISION-WORKING-SET.md) and [current implementation, measurements and unverified boundaries](../../docs/KERNEL-CURRENT-EVIDENCE-20261125.md).
