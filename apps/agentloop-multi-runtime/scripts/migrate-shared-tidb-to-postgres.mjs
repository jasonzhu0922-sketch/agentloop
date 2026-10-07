import { openStateDatabase } from "../src/shared/persistence/state-database.ts";
import { migrateRouterState } from "../src/router/persistence/state-migrations.ts";
import { migrateRuntimeState } from "../src/runtime-host/persistence/state-migrations.ts";

const sourceWritersDrained = process.argv.includes("--source-writers-drained");
const pruneTerminalOrphanAssignments = process.argv.includes("--prune-terminal-orphan-assignments");
if (!sourceWritersDrained) {
  throw new Error("Refusing TiDB-to-PostgreSQL migration while source writers may be active. Stop Router and Runtime Hosts, then pass --source-writers-drained.");
}

const routerUrl = requiredEnvironment("AGENTLOOP_ROUTER_STATE_DATABASE_URL");
const runtimeUrl = requiredEnvironment("AGENTLOOP_RUNTIME_STATE_DATABASE_URL");
const targetUrl = requiredEnvironment("AGENTLOOP_POSTGRES_DATABASE_URL");
const sourceRouter = await openStateDatabase({ driver: "tidb", connectionString: routerUrl }, { schema: "router" });
const sourceRuntime = await openStateDatabase({ driver: "tidb", connectionString: runtimeUrl }, { schema: "runtime", autoMigrateKernel: false });
const target = await openStateDatabase({ driver: "postgres", connectionString: targetUrl }, { schema: "router" });

const scanBatchSize = 25;
const maxInsertBytes = 1 * 1024 * 1024;

const ROUTER_TABLES = [
  "mr_identity_users", "mr_identity_tenants", "mr_identity_memberships", "mr_identity_sessions",
  "mr_runtime_nodes", "mr_tasks", "mr_assignments", "mr_turns", "mr_conversation_runtime_migrations",
  "mr_devices", "mr_device_registration_tokens", "mr_device_agent_sessions", "mr_device_local_sessions",
  "mr_attachments", "mr_artifacts",
];
const RUNTIME_TABLES = [
  "skills", "discovered_skills", "conversations", "runs", "plans", "plan_steps", "run_events", "run_event_sequences",
  "runtime_actions", "human_loop_requests", "human_loop_responses", "run_recovery_states", "run_checkpoints",
  "recovery_decisions", "recovery_user_responses", "plan_revision_snapshots", "plan_step_retirements",
  "plan_revision_assessments", "skill_compliance_assessments", "run_outcomes", "sources", "source_chunks",
  "run_sources", "run_visible_directories", "batches", "batch_items", "audit_events",
  "mr_host_dispatches", "mr_run_executors",
];

try {
  await migrateRouterState(target);
  await migrateRuntimeState(target);
  const excludedAssignmentIds = await terminalOrphanAssignmentIds(sourceRouter, pruneTerminalOrphanAssignments);
  const excludedDispatchAssignmentIds = await orphanDispatchAssignmentIds(sourceRouter, sourceRuntime, pruneTerminalOrphanAssignments);
  await assertTargetEmpty(target, [...ROUTER_TABLES, ...RUNTIME_TABLES]);
  await assertCompatibleColumns(sourceRouter, target, ROUTER_TABLES);
  await assertCompatibleColumns(sourceRuntime, target, RUNTIME_TABLES);

  await target.transaction(async () => {
    for (const table of ROUTER_TABLES) await copyTable(sourceRouter, target, table, excludedAssignmentIds, excludedDispatchAssignmentIds);
    for (const table of RUNTIME_TABLES) await copyTable(sourceRuntime, target, table, excludedAssignmentIds, excludedDispatchAssignmentIds);
    await verifyCounts(sourceRouter, target, ROUTER_TABLES, excludedAssignmentIds, excludedDispatchAssignmentIds);
    await verifyCounts(sourceRuntime, target, RUNTIME_TABLES, excludedAssignmentIds, excludedDispatchAssignmentIds);
  });
  process.stdout.write("Migrated cloud-side TiDB state into PostgreSQL after an explicit source-writer drain.\n");
} finally {
  await Promise.all([sourceRouter.close(), sourceRuntime.close(), target.close()]);
}

async function copyTable(source, target, table, excludedAssignmentIds, excludedDispatchAssignmentIds) {
  const columns = await sourceColumns(source, table);
  const quotedColumns = columns.map(quotePostgres).join(", ");
  let offset = 0;
  let copied = 0;
  const filter = assignmentFilter(table, excludedAssignmentIds, excludedDispatchAssignmentIds);
  while (true) {
    const rows = await source.prepare(`SELECT ${columns.map(quoteTiDb).join(", ")} FROM ${quoteTiDb(table)}${filter.sql} LIMIT ? OFFSET ?`)
      .all(...filter.params, scanBatchSize, offset);
    if (rows.length === 0) break;
    let pending = [];
    let pendingBytes = 0;
    for (const row of rows) {
      const rowBytes = columns.reduce((total, column) => total + valueBytes(row[column]), 0);
      if (pending.length > 0 && pendingBytes + rowBytes > maxInsertBytes) {
        await insertRows(target, table, columns, pending);
        pending = [];
        pendingBytes = 0;
      }
      pending.push(row);
      pendingBytes += rowBytes;
    }
    if (pending.length > 0) await insertRows(target, table, columns, pending);
    offset += rows.length;
    copied += rows.length;
    if (table === "run_events" && copied % 50_000 === 0) process.stdout.write(`${table}: ${copied} copied\n`);
  }
  process.stdout.write(`${table}: ${copied}\n`);
}

async function insertRows(target, table, columns, rows) {
  const quotedColumns = columns.map(quotePostgres).join(", ");
  const values = rows.flatMap((row) => columns.map((column) => row[column] ?? null));
  const marks = rows.map((_, rowIndex) => `(${columns.map((_, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`).join(", ")})`).join(", ");
  await target.prepare(`INSERT INTO ${quotePostgres(table)} (${quotedColumns}) VALUES ${marks}`).run(...values);
}

async function assertTargetEmpty(target, tables) {
  for (const table of tables) {
    const row = await target.prepare(`SELECT COUNT(*) AS count FROM ${quotePostgres(table)}`).get();
    if (Number(row?.count ?? 0) !== 0) throw new Error(`PostgreSQL target is not empty: ${table}. Refusing to merge TiDB state into an existing database.`);
  }
}

async function assertCompatibleColumns(source, target, tables) {
  for (const table of tables) {
    const sourceColumnNames = await sourceColumns(source, table);
    const targetRows = await target.prepare(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position
    `).all(table);
    const targetColumnNames = targetRows.map((row) => String(row.column_name));
    const sourceOnly = sourceColumnNames.filter((column) => !targetColumnNames.includes(column));
    const targetOnly = targetColumnNames.filter((column) => !sourceColumnNames.includes(column));
    if (sourceOnly.length > 0 || targetOnly.length > 0) {
      throw new Error(`Schema mismatch for ${table}: TiDB-only=[${sourceOnly.join(",")}], PostgreSQL-only=[${targetOnly.join(",")}]`);
    }
  }
}

async function sourceColumns(source, table) {
  const rows = await source.prepare(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position
  `).all(table);
  const columns = rows.map((row) => String(row.column_name));
  if (columns.length === 0) throw new Error(`TiDB source table is absent: ${table}`);
  return columns;
}

async function verifyCounts(source, target, tables, excludedAssignmentIds, excludedDispatchAssignmentIds) {
  for (const table of tables) {
    const filter = assignmentFilter(table, excludedAssignmentIds, excludedDispatchAssignmentIds);
    const sourceCount = Number((await source.prepare(`SELECT COUNT(*) AS count FROM ${quoteTiDb(table)}${filter.sql}`).get(...filter.params))?.count ?? 0);
    const targetCount = Number((await target.prepare(`SELECT COUNT(*) AS count FROM ${quotePostgres(table)}`).get())?.count ?? 0);
    if (sourceCount !== targetCount) throw new Error(`Row-count mismatch for ${table}: TiDB=${sourceCount}, PostgreSQL=${targetCount}`);
  }
}

async function terminalOrphanAssignmentIds(source, allowPrune) {
  const rows = await source.prepare(`
    SELECT a.id, a.status
    FROM mr_assignments a
    LEFT JOIN mr_tasks t ON t.id = a.task_id
    WHERE t.id IS NULL
  `).all();
  if (rows.length === 0) return [];
  const nonTerminal = rows.filter((row) => !["completed", "failed", "cancelled"].includes(String(row.status)));
  if (nonTerminal.length > 0) throw new Error(`Refusing to migrate ${nonTerminal.length} orphan assignment(s) that are not terminal.`);
  if (!allowPrune) {
    throw new Error(`Found ${rows.length} terminal assignments whose Task was deleted. Preserve TiDB as rollback source and rerun with --prune-terminal-orphan-assignments only after explicitly approving this history repair.`);
  }
  const counts = Object.groupBy(rows, (row) => String(row.status));
  process.stdout.write(`Pruning ${rows.length} terminal orphan assignment(s) from PostgreSQL import: ${Object.entries(counts).map(([status, entries]) => `${status}=${entries.length}`).join(", ")}. Router child projections and Host dispatch receipts with the same assignment ID are excluded; TiDB is unchanged.\n`);
  return rows.map((row) => String(row.id));
}

async function orphanDispatchAssignmentIds(router, runtime, allowPrune) {
  const rows = await runtime.prepare("SELECT DISTINCT assignment_id FROM mr_host_dispatches").all();
  const ids = rows.map((row) => String(row.assignment_id));
  if (ids.length === 0) return [];
  const known = new Set();
  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100);
    const found = await router.prepare(`SELECT id FROM mr_assignments WHERE id IN (${batch.map(() => "?").join(", ")})`).all(...batch);
    for (const row of found) known.add(String(row.id));
  }
  const orphanIds = ids.filter((id) => !known.has(id));
  if (orphanIds.length === 0) return [];
  if (!allowPrune) throw new Error(`Found ${orphanIds.length} Host dispatch receipt(s) without a Router assignment. Rerun with --prune-terminal-orphan-assignments only after explicitly approving this history repair.`);
  process.stdout.write(`Pruning ${orphanIds.length} Host dispatch receipt(s) whose Router assignment is absent; their Runtime Runs remain imported. TiDB is unchanged.\n`);
  return orphanIds;
}

function assignmentFilter(table, excludedAssignmentIds, excludedDispatchAssignmentIds) {
  const excludedIds = table === "mr_host_dispatches"
    ? [...new Set([...excludedAssignmentIds, ...excludedDispatchAssignmentIds])]
    : excludedAssignmentIds;
  if (excludedIds.length === 0) return { sql: "", params: [] };
  const column = table === "mr_assignments"
    ? "id"
    : ["mr_turns", "mr_conversation_runtime_migrations", "mr_host_dispatches"].includes(table)
      ? "assignment_id"
      : undefined;
  if (column === undefined) return { sql: "", params: [] };
  return { sql: ` WHERE ${quoteTiDb(column)} NOT IN (${excludedIds.map(() => "?").join(", ")})`, params: excludedIds };
}

function valueBytes(value) {
  if (typeof value === "string") return Buffer.byteLength(value);
  if (value instanceof Uint8Array) return value.byteLength;
  return 16;
}

function quoteTiDb(identifier) {
  assertIdentifier(identifier);
  return `\`${identifier}\``;
}

function quotePostgres(identifier) {
  assertIdentifier(identifier);
  return `"${identifier}"`;
}

function assertIdentifier(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new Error(`Unsafe SQL identifier: ${identifier}`);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} must be set`);
  return value;
}
