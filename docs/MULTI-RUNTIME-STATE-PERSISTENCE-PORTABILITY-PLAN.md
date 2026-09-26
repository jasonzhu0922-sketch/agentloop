# Multi Runtime State Persistence Portability Plan

## Status

**Proposed; do not implement until the active companion work has completed and
its changes have been reviewed.** This document is an execution plan, not a
claim that PostgreSQL or TiDB production cutover is already supported.

## Decision

Multi Runtime state must have a domain-level persistence boundary. Router and
Local Runtime device workflows will depend on typed persistence ports, not on
`AppDatabase`, `SqlConnection`, SQL strings, database schema setup, or a
specific database dialect.

The supported relational backends are:

| Backend | Intended use | SQL dialect implementation |
| --- | --- | --- |
| SQLite | single-machine development and tests | SQLite |
| PostgreSQL | production default for shared state | PostgreSQL |
| TiDB | supported distributed SQL alternative | MySQL/TiDB |

TiDB is not treated as PostgreSQL. In particular, PostgreSQL `ON CONFLICT`
and TiDB `ON DUPLICATE KEY UPDATE` are distinct implementations of the same
repository operation.

## Contract to preserve

The portability boundary must preserve the actual control-plane guarantees:

1. A `(tenantId, ownerUserId, conversationId, clientMessageId)` task is
   idempotently created exactly once.
2. Reserving capacity atomically selects one eligible Runtime and records the
   reservation. Two concurrent Router replicas cannot oversubscribe it.
3. A Host's accepted or terminal state cannot be overwritten by a stale
   observation.
4. Assignment/turn/conversation projections remain tenant and user isolated.
5. Registration-token consumption, device session creation, and device revoke
   operations have their present atomic security behavior.
6. A migration is explicit, ordered, resumable, and records the installed
   version for every relational backend.

These are repository contracts, not generic CRUD requirements. No ORM or
generic `Database` wrapper may hide the transaction, uniqueness, or conditional
update semantics that enforce them.

## Current boundary and its limitation

Today `ControlPlaneStore` and `DeviceService` own all three concerns:

```text
Router / Device HTTP
        -> service and scheduling logic
        -> AppDatabase transaction + SQL queries
        -> CREATE TABLE / SQLite legacy migration
```

`SqlConnection` and `PgConnection` already isolate driver mechanics and
placeholder translation. That is useful, but it is below the required boundary:
the services still own relational schema, SQL dialect, and upgrade behavior.
The SQLite-only `PRAGMA` migration path also means that a pre-existing
PostgreSQL database has no equivalent ordered upgrade path.

## Target architecture

```text
PersistentMultiRuntimeRouter                  DeviceService
              |                                     |
              +---------- domain ports -------------+
                         |                    |
        ControlPlaneRepository          DeviceRepository
                         |                    |
              relational implementations (one transaction per operation)
                         |
      RelationalDialect + VersionedMigrationRunner + connection factory
                    |              |              |
                 SQLite       PostgreSQL        TiDB
```

### 1. Domain ports

Create ports in `apps/agentloop-multi-runtime/src/control-plane/` and
`apps/agentloop-multi-runtime/src/devices/`. They expose domain values rather
than rows, SQL, or driver results.

`ControlPlaneRepository` owns the current public store operations, grouped as:

- Runtime catalog and heartbeat: seed/register/disconnect, heartbeat, catalog
  and endpoint reads.
- Task and assignment lifecycle: reserve, accept, dispatch failure,
  continuation, observation, assignment lookup, and unsettled batches.
- Router-owned conversation projection: page and turn reads.

`DeviceRepository` owns device registration token issuance/consumption, Agent
authentication, heartbeat/last-seen updates, listing/revocation, and local
session issuance/authorization.

The Router constructor receives `ControlPlaneRepository`; `DeviceService`
receives `DeviceRepository`. Neither receives `AppDatabase`.

### 2. Relational implementations

Add `SqlControlPlaneRepository` and `SqlDeviceRepository`. They contain the
current relational mapping and transaction choreography, while converting rows
to domain records internally. They are the only locations allowed to call
`prepare`, `exec`, or `transaction` for those domains.

Do not split a currently atomic operation merely to make an interface look
generic. `reserve()` remains one repository operation and one transaction.

### 3. Dialect boundary

Create a narrow relational dialect API for only the SQL differences observed
by repository implementations and migrations, for example:

- parameter binding/query execution (the existing connection adapter layer);
- upsert fragments;
- schema/introspection operations required by migrations;
- lock/conditional-update strategy used by capacity reservation;
- timestamp/JSON/identifier types where a backend genuinely differs.

Do not make every query a runtime string template. Prefer a common SQL subset
for ordinary reads; select a dialect-specific statement only where the SQL
semantic difference is real.

The dialect names are `sqlite`, `postgres`, and `tidb`; do not model TiDB as a
PostgreSQL compatibility flag.

### 4. Versioned migrations

Move `CREATE TABLE`, indexes, and all column evolution out of service
`ready()` methods. Add an application-owned migration registry with immutable,
ordered migration IDs and a database-owned migration ledger, for example
`mr_schema_migrations(id, applied_at, checksum)`.

Each migration has a SQLite, PostgreSQL, and TiDB form when necessary. Applying
migrations must be serialized per database, validate a previously applied
checksum, and be safe to rerun after interruption. Fresh databases apply the
complete ordered sequence; existing SQLite databases receive an import/upgrade
path from the current unversioned schema before normal migrations run.

`router-main.ts` and `runtime-host-main.ts` invoke the migration runner during
process assembly, before repositories or services are constructed. Repository
interfaces intentionally have no `ready()` method that performs DDL.

## Delivery phases

### Phase 0 — Freeze the baseline and define the test oracle

- Wait for the companion task to finish; review its diff first and rebase this
  plan against its final data ownership changes.
- Inventory every current `AppDatabase` user in Multi Runtime: control plane,
  device, identity, attachment metadata, artifact catalog, Host dispatch, and
  local-directory scope. This change must not abstract only two files while
  leaving a second shared-state authority outside the migration boundary.
- Characterize the current SQLite schema and production-relevant state using a
  copy, never a live state database.
- Extract existing behavioral tests into backend-neutral repository contract
  tests before moving implementation.

**Exit criterion:** the complete shared-state owner list and a passing SQLite
contract suite are recorded; no production data is changed.

### Phase 1 — Introduce ports without behavior change

- Define `ControlPlaneRepository` and `DeviceRepository` from existing
  method-level behavior; keep return types and error contracts stable.
- Make the current code the SQLite-backed relational implementation.
- Change Router/Device construction to depend on the ports.
- Keep query results, transaction boundaries, and schema unchanged in this
  phase; no PostgreSQL/TiDB-specific code is introduced.

**Exit criterion:** existing Multi Runtime tests pass unchanged in meaning, and
a source-level dependency test proves Router and `DeviceService` no longer
import `AppDatabase` or relational adapter classes.

### Phase 2 — Establish migrations as the only schema authority

- Build the migration ledger, backend lock, checksum validation, and current
  SQLite import migration.
- Relocate every `ready()` DDL block for the state owners in scope.
- Test fresh boot, one-version upgrade, repeated boot, failed migration, and
  interrupted/resumed migration for SQLite.

**Exit criterion:** a repository can operate after migration without issuing
DDL; an existing copied SQLite state database upgrades without lost tasks,
assignments, device credentials, or foreign-key relationships.

### Phase 3 — PostgreSQL implementation and real-database contracts

- Add PostgreSQL migration forms and wire the existing connection factory to
  the migrated relational repository set.
- Run the exact same repository contract suite against a disposable real
  PostgreSQL instance, including concurrent `reserve()` calls from independent
  connections and terminal-state non-regression.
- Verify migrations against both an empty PostgreSQL database and a simulated
  older schema revision. A recording/mock connection is insufficient evidence.

**Exit criterion:** all contracts pass on SQLite and a real PostgreSQL instance,
with migration ledger versions identical for the supported application release.

### Phase 4 — TiDB implementation and compatibility qualification

- Add an explicit TiDB connection/dialect and TiDB migration forms; use
  TiDB/MySQL upsert and locking semantics deliberately rather than translating
  PostgreSQL SQL mechanically.
- Run contract tests on a real TiDB version chosen for deployment. Include
  transaction isolation and concurrent reservation tests under the production
  isolation configuration.
- Record unsupported SQL features and the minimum TiDB version in deployment
  documentation.

**Exit criterion:** TiDB passes the same semantic contracts as PostgreSQL,
including no capacity oversubscription under concurrent Router replicas.

### Phase 5 — controlled data migration and production cutover

- Choose one source and one target backend per cutover; do not introduce
  permanent dual-write authority.
- Take a verified, restorable source backup; stop or drain writers, export a
  consistent snapshot, import it into a fully migrated target, and validate
  row counts plus business invariants.
- Start a single Router/Host canary on the target, then verify a fresh
  representative Run through `Run -> Plan -> actions/events -> Assessment ->
  TerminalCommitter -> Outcome` as well as assignment/device operations.
- Scale replicas only after the canary is healthy. Retain the original backend
  as a read-only rollback source for a defined window.

**Exit criterion:** target state and a fresh end-to-end run are verified from
persisted evidence; the old backend is not removed until rollback expiration
is explicitly approved.

## Required contract tests

Every backend must run the same test cases:

1. duplicate submit returns/reuses the one durable task and does not create two
   active assignments;
2. simultaneous capacity reservations never exceed a Host limit;
3. expired reservation becomes retryable without duplicating a task;
4. late `running` observation cannot regress completed, failed, or cancelled;
5. affinity is a preference, not an availability gate;
6. tenant/user-scoped conversation and device reads cannot cross boundaries;
7. registration tokens are single-use and device revoke invalidates Agent
   authentication;
8. fresh install, current-schema restart, old-schema upgrade, and interrupted
   migration recovery are correct;
9. PostgreSQL and TiDB tests use real independent database connections for
   transactions, not in-memory/recording substitutes.

## Non-goals

- Supporting non-relational stores in this change. A future non-relational
  implementation must independently satisfy the domain ports and contracts.
- Replacing all project persistence in one unbounded refactor. Phase 0 sets
  the authoritative state-owner scope; unrelated single-process persistence is
  not silently absorbed.
- Adding a permanent fallback from an unavailable target database to SQLite.
  A selected backend must fail closed at startup rather than fork shared-state
  authority.
- Claiming a production cutover based on compile or unit-test success alone.

## Decisions needed before Phase 4/5

1. Which production target is first: PostgreSQL or TiDB?
2. Exact engine/version and managed-service topology, including TLS, backup,
   monitoring, connection limits, and selected transaction isolation.
3. Maximum acceptable maintenance/drain window for the one-time snapshot
   migration.
4. Retention window and operator for rollback source data.
