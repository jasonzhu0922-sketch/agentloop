import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openStateDatabase } from "../src/shared/persistence/state-database.ts";
import { migrateRouterState } from "../src/router/persistence/state-migrations.ts";
import { migrateRuntimeState } from "../src/runtime-host/persistence/state-migrations.ts";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourcePath = resolve(appRoot, argumentValue("--source") ?? "./data/local/agentloop.db");
const routerUrl = process.env.AGENTLOOP_ROUTER_STATE_DATABASE_URL ?? "mysql://root@127.0.0.1:4000/agentloop_router";
const runtimeUrl = process.env.AGENTLOOP_RUNTIME_STATE_DATABASE_URL ?? "mysql://root@127.0.0.1:4000/agentloop_runtime";
// Keep the source-side working set modest and normal TiDB transactions below
// the local cluster memory budget.  A single opaque Evidence value may be
// larger than this and is still inserted whole in its own transaction.
const scanBatchSize = 25;
const maxInsertBytes = 1 * 1024 * 1024;

const ROUTER_TABLES = [
  "mr_identity_users", "mr_identity_tenants", "mr_identity_memberships", "mr_identity_sessions",
  "mr_runtime_nodes", "mr_tasks", "mr_assignments", "mr_turns", "mr_conversation_runtime_migrations",
  "mr_devices", "mr_device_registration_tokens", "mr_device_agent_sessions", "mr_device_local_sessions",
  "mr_attachments", "mr_artifacts",
];
const RUNTIME_TABLES = [
  "skills", "discovered_skills", "conversations", "runs", "plans", "plan_steps", "run_events",
  "runtime_actions", "human_loop_requests", "human_loop_responses", "run_recovery_states", "run_checkpoints",
  "recovery_decisions", "recovery_user_responses", "plan_revision_snapshots", "plan_step_retirements",
  "plan_revision_assessments", "skill_compliance_assessments", "run_outcomes", "sources", "source_chunks",
  "run_sources", "run_visible_directories", "batches", "batch_items", "audit_events",
  "mr_host_dispatches", "mr_run_executors",
];

if (!existsSync(sourcePath)) throw new Error(`SQLite source does not exist: ${sourcePath}`);
const source = new DatabaseSync(sourcePath, { readOnly: true });
const router = await openStateDatabase({ driver: "tidb", connectionString: routerUrl }, { schema: "router" });
const runtime = await openStateDatabase({ driver: "tidb", connectionString: runtimeUrl }, { schema: "runtime", autoMigrateKernel: false });

try {
  await migrateRouterState(router);
  await migrateRuntimeState(runtime);
  const sourceTables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)));
  const managed = new Set([...ROUTER_TABLES, ...RUNTIME_TABLES]);
  const legacy = [...sourceTables].filter((table) => !managed.has(table) && table !== "sqlite_sequence").sort();
  const legacyCounts = Object.fromEntries(legacy.map((table) => [table, sourceCount(table)]));
  for (const [table, count] of Object.entries(legacyCounts)) {
    if (count > 0) process.stderr.write(`Not copied (not owned by current schema): ${table}=${count}\n`);
  }
  await assertCompatibleColumns(source, router, ROUTER_TABLES);
  await assertCompatibleColumns(source, runtime, RUNTIME_TABLES);
  await assertTargetsEmpty(router, ROUTER_TABLES);
  await assertTargetsEmpty(runtime, RUNTIME_TABLES);

  source.exec("BEGIN");
  try {
    for (const table of ROUTER_TABLES) await copyTable(source, router, table);
    for (const table of RUNTIME_TABLES) await copyTable(source, runtime, table);
    source.exec("COMMIT");
  } catch (error) {
    source.exec("ROLLBACK");
    throw error;
  }
  await verifyCounts(source, router, ROUTER_TABLES);
  await verifyCounts(source, runtime, RUNTIME_TABLES);
  process.stdout.write(`Migrated cloud-side SQLite state from ${sourcePath} into TiDB Router and Runtime databases.\n`);
} finally {
  source.close();
  await router.close();
  await runtime.close();
}

async function copyTable(sqlite, target, table) {
  if (!sourceHasTable(table)) return;
  const columns = sqlite.prepare(`PRAGMA table_info(\`${table}\`)`).all().map((column) => String(column.name));
  if (columns.length === 0) throw new Error(`SQLite table has no columns: ${table}`);
  const quotedColumns = columns.map(quote).join(", ");
  let lastRowId = 0;
  let copied = 0;
  while (true) {
    const rows = sqlite.prepare(`SELECT rowid AS migration_cursor, ${quotedColumns} FROM ${quote(table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`)
      .all(lastRowId, scanBatchSize);
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
    lastRowId = Number(rows.at(-1).migration_cursor);
    copied += rows.length;
    if (table === "run_events" && copied % 50_000 === 0) process.stdout.write(`${table}: ${copied} copied\n`);
  }
  process.stdout.write(`${table}: ${copied}\n`);
}

async function insertRows(target, table, columns, rows) {
  const quotedColumns = columns.map(quote).join(", ");
  const marks = rows.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
  const values = rows.flatMap((row) => columns.map((column) => row[column] ?? null));
  await retryTransientTiDbWrite(target, table, rows.length, async () => {
    await target.prepare(`INSERT INTO ${quote(table)} (${quotedColumns}) VALUES ${marks}`).run(...values);
  });
}

/**
 * TiKV can briefly reject a write while it is splitting or moving a Region.
 * These errors are transport/topology failures, not a duplicate or content
 * conflict, so retry the exact atomic INSERT a bounded number of times.  Do
 * not expose bound Evidence/JSON values through an error's `sql` property.
 */
async function retryTransientTiDbWrite(target, table, rowCount, operation) {
  const maxAttempts = target.dialect === "tidb" ? 8 : 1;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientTiDbError(error) || attempt === maxAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** (attempt - 1), 8_000)));
    }
  }
  const code = typeof lastError?.errno === "number" ? ` errno=${lastError.errno}` : "";
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`TiDB insert failed for ${table} (${rowCount} row(s)) after retrying transient storage errors:${code} ${message}`);
}

function isTransientTiDbError(error) {
  const code = Number(error?.errno);
  if (code === 9005) return true; // Region is unavailable.
  const message = error instanceof Error ? error.message : String(error);
  return /region is unavailable|not leader|server is busy|raft proposal dropped|tikv server is busy/i.test(message);
}

function valueBytes(value) {
  if (typeof value === "string") return Buffer.byteLength(value);
  if (value instanceof Uint8Array) return value.byteLength;
  return 16;
}

async function assertTargetsEmpty(target, tables) {
  for (const table of tables) {
    const row = await target.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get();
    if (Number(row?.count ?? 0) !== 0) throw new Error(`TiDB target is not empty: ${table}. Refusing to merge SQLite state into an existing database.`);
  }
}

async function assertCompatibleColumns(sqlite, target, tables) {
  for (const table of tables) {
    if (!sourceHasTable(table)) continue;
    const sourceColumns = sqlite.prepare(`PRAGMA table_info(${quote(table)})`).all().map((row) => String(row.name));
    const rows = await target.prepare(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position
    `).all(table);
    const targetColumns = rows.map((row) => String(row.column_name));
    const extra = sourceColumns.filter((column) => !targetColumns.includes(column));
    const missing = targetColumns.filter((column) => !sourceColumns.includes(column));
    if (extra.length > 0 || missing.length > 0) {
      throw new Error(`Schema mismatch for ${table}: SQLite-only=[${extra.join(",")}], TiDB-only=[${missing.join(",")}]`);
    }
  }
}

async function verifyCounts(sqlite, target, tables) {
  for (const table of tables) {
    if (!sourceHasTable(table)) continue;
    const expected = sourceCount(table);
    const actual = Number((await target.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get())?.count ?? 0);
    if (actual !== expected) throw new Error(`Row-count mismatch for ${table}: SQLite=${expected}, TiDB=${actual}`);
  }
}

function sourceHasTable(table) {
  return source.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function sourceCount(table) {
  return Number(source.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get().count);
}

function quote(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new Error(`Unsafe SQL identifier: ${identifier}`);
  return `\`${identifier}\``;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
