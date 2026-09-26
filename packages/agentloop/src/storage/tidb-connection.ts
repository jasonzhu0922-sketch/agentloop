import { AsyncLocalStorage } from "node:async_hooks";
import type { SqlConnection, SqlDialect, SqlRunResult, SqlStatement, SqlValue } from "./connection.ts";

/** Minimal `mysql2/promise` surface used by the optional TiDB driver. */
export interface TiDbClientLike {
  execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
  query(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
  release(): void;
}

export interface TiDbPoolLike {
  getConnection(): Promise<TiDbClientLike>;
  query(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}

type TiDbPoolFactory = {
  createPool(config: string | Record<string, unknown>): TiDbPoolLike;
};

/**
 * TiDB/MySQL connection adapter. It is intentionally a separate dialect from
 * PostgreSQL: both statement selection and migration ownership remain
 * explicit above this transport layer.
 */
export class TiDbConnection implements SqlConnection {
  readonly dialect: SqlDialect = "tidb";

  private readonly pool: TiDbPoolLike;
  private readonly transactionClient = new AsyncLocalStorage<TiDbClientLike>();

  private constructor(pool: TiDbPoolLike) {
    this.pool = pool;
  }

  static fromPool(pool: TiDbPoolLike): TiDbConnection {
    return new TiDbConnection(pool);
  }

  /** Loads mysql2 only for deployments which select AGENTLOOP_STATE_DRIVER=tidb. */
  static async create(config: string | Record<string, unknown>): Promise<TiDbConnection> {
    const moduleName = "mysql2/promise";
    let loaded: { default?: TiDbPoolFactory; createPool?: TiDbPoolFactory["createPool"] };
    try {
      loaded = await import(moduleName) as typeof loaded;
    } catch {
      throw new Error('TiDbConnection requires the "mysql2" package. Install it next to your application: npm install mysql2');
    }
    const createPool = loaded.default?.createPool ?? loaded.createPool;
    if (typeof createPool !== "function") throw new Error('The installed "mysql2" package did not expose createPool');
    return new TiDbConnection(createPool(config));
  }

  async exec(sql: string): Promise<void> {
    for (const statement of splitSqlStatements(sql)) {
      await this.query(translateTiDbSql(statement), []);
    }
  }

  prepare(sql: string): SqlStatement {
    const translated = translateTiDbSql(sql);
    return {
      run: async (...params: SqlValue[]): Promise<SqlRunResult> => {
        const [result] = await this.query(translated, params);
        const row = result as { affectedRows?: number; insertId?: number };
        return {
          changes: row.affectedRows ?? 0,
          ...(row.insertId === undefined ? {} : { lastInsertRowid: row.insertId }),
        };
      },
      get: async <T>(...params: SqlValue[]): Promise<T | undefined> => {
        const [result] = await this.query(translated, params);
        return Array.isArray(result) ? result[0] as T | undefined : undefined;
      },
      all: async <T>(...params: SqlValue[]): Promise<T[]> => {
        const [result] = await this.query(translated, params);
        return Array.isArray(result) ? result as T[] : [];
      },
    };
  }

  async transaction<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.transactionClient.getStore() !== undefined) return await operation();
    const client = await this.pool.getConnection();
    try {
      await client.query("START TRANSACTION");
      return await this.transactionClient.run(client, async () => {
        const result = await operation();
        await client.query("COMMIT");
        return result;
      });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* connection failure is handled by the pool */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async query(sql: string, values: readonly unknown[]): Promise<[unknown, unknown]> {
    const client = this.transactionClient.getStore();
    if (client !== undefined) return await client.execute(sql, values);
    return await this.pool.query(sql, values);
  }
}

/** Splits DDL batches without enabling MySQL's unsafe multiple-statements mode. */
export function splitSqlStatements(sql: string): readonly string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | undefined;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    if (quote !== undefined) {
      if (character === quote) {
        if (quote === "'" && sql[index + 1] === "'") { index += 1; continue; }
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") { quote = character; continue; }
    if (character === ";") {
      const statement = sql.slice(start, index).trim();
      if (statement.length > 0) statements.push(statement);
      start = index + 1;
    }
  }
  const finalStatement = sql.slice(start).trim();
  if (finalStatement.length > 0) statements.push(finalStatement);
  return statements;
}

/**
 * Converts the portable SQLite/PostgreSQL conflict subset used by AgentLoop to
 * TiDB's MySQL form. Repository code must still select an explicit statement
 * where conflict eligibility itself is part of business semantics.
 */
export function translateTiDbSql(sql: string): string {
  const portableDdl = translateTiDbDdl(sql);
  const doNothing = /ON\s+CONFLICT\s*(?:\(([^)]+)\))?\s+DO\s+NOTHING/gi;
  const withNoop = portableDdl.replace(doNothing, (_match, conflictColumns: string | undefined) => {
    const column = conflictColumns?.split(",")[0]?.trim() ?? firstInsertColumn(portableDdl);
    if (column === undefined) throw new Error("TiDB upsert requires an explicit conflict or insert column");
    return `ON DUPLICATE KEY UPDATE ${column} = ${column}`;
  });
  return withNoop
    .replace(/ON\s+CONFLICT\s*(?:\([^)]+\))?\s+DO\s+UPDATE\s+SET/gi, "ON DUPLICATE KEY UPDATE")
    .replace(/\bexcluded\.([A-Za-z_][A-Za-z0-9_]*)/g, "VALUES($1)");
}

/**
 * Physical types for values participating in a TiDB key.  This is deliberately
 * a table-and-column map instead of a blanket `TEXT -> VARCHAR` conversion:
 * evidence, model I/O, instructions, and JSON remain TEXT/LONGTEXT, while
 * identifiers and finite state fields have a bounded, indexable representation.
 *
 * Every entry is part of the TiDB schema contract. Add a new keyed text column
 * here together with its migration and an integration test; do not let TiDB
 * silently choose a prefix index for an application identity.
 */
const TIDB_KEY_TEXT_COLUMNS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  skills: { id: 191, owner_user_id: 191, name: 255, source_kind: 64, package_hash: 128, content_hash: 128 },
  discovered_skills: { name: 255, package_hash: 128 },
  conversations: { id: 191, owner_user_id: 191 },
  runs: { id: 191, owner_user_id: 191, conversation_id: 191, parent_run_id: 191, status: 64 },
  plans: { id: 191, run_id: 191, status: 64 },
  plan_steps: { plan_id: 191, step_id: 191, kind: 64, parent_step_id: 191, refinement_state: 64, status: 64 },
  run_events: { run_id: 191 },
  runtime_actions: { id: 191, run_id: 191, plan_id: 191, state: 64, result_ref: 191 },
  human_loop_requests: { id: 191, run_id: 191, plan_id: 191, action_id: 191, status: 64 },
  human_loop_responses: { id: 191, request_id: 191, run_id: 191 },
  run_recovery_states: { run_id: 191, action_id: 191 },
  run_checkpoints: { id: 191, run_id: 191, plan_id: 191, action_id: 191, child_run_id: 191 },
  recovery_decisions: { id: 191, run_id: 191, action_id: 191 },
  recovery_user_responses: { id: 191, run_id: 191, action_id: 191 },
  plan_revision_snapshots: { plan_id: 191, action_id: 191 },
  plan_step_retirements: { plan_id: 191, step_id: 191, action_id: 191 },
  plan_revision_assessments: { id: 191, recovery_decision_id: 191, plan_id: 191 },
  skill_compliance_assessments: { id: 191, plan_id: 191, step_id: 191 },
  run_outcomes: { run_id: 191, plan_id: 191, result_ref: 191 },
  sources: { id: 191, owner_user_id: 191, conversation_id: 191, sha256: 128 },
  source_chunks: { source_id: 191 },
  run_sources: { run_id: 191, source_id: 191 },
  run_visible_directories: { run_id: 191, directory_id: 191 },
  batches: { id: 191, owner_user_id: 191, idempotency_key: 191, status: 64 },
  batch_items: { id: 191, batch_id: 191, item_key: 191, run_id: 191, status: 64 },
  audit_events: { id: 191, actor_user_id: 191 },
  mr_runtime_nodes: { id: 191, device_id: 191, tenant_id: 191, owner_user_id: 191, status: 64 },
  mr_tasks: { id: 191, tenant_id: 191, owner_user_id: 191, conversation_id: 191, client_message_id: 191 },
  mr_assignments: { id: 191, task_id: 191, runtime_id: 191, dispatch_key: 191, status: 64 },
  mr_turns: { assignment_id: 191, tenant_id: 191, owner_user_id: 191, conversation_id: 191, client_message_id: 191 },
  mr_conversation_runtime_migrations: { id: 191, tenant_id: 191, owner_user_id: 191, conversation_id: 191, assignment_id: 191, previous_runtime_id: 191, selected_runtime_id: 191 },
  mr_identity_users: { id: 191, email: 254 },
  mr_identity_tenants: { id: 191 },
  mr_identity_memberships: { tenant_id: 191, user_id: 191 },
  mr_identity_sessions: { id: 191, user_id: 191, token_hash: 128 },
  mr_devices: { id: 191, tenant_id: 191, owner_user_id: 191 },
  mr_device_registration_tokens: { id: 191, tenant_id: 191, owner_user_id: 191, token_hash: 128 },
  mr_device_agent_sessions: { device_id: 191, token_hash: 128 },
  mr_device_local_sessions: { id: 191, device_id: 191, tenant_id: 191, owner_user_id: 191, token_hash: 128 },
  mr_attachments: { id: 191, tenant_id: 191, owner_user_id: 191, conversation_id: 191, storage_name: 191 },
  mr_artifacts: { id: 191, assignment_id: 191 },
  mr_host_dispatches: { dispatch_key: 191, remote_run_id: 191 },
  mr_run_executors: { remote_run_id: 191, runtime_id: 191, dispatch_key: 191 },
};

/** Applies the explicit TiDB physical-schema rules to one DDL statement. */
function translateTiDbDdl(sql: string): string {
  const table = sql.match(/^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/i)?.[1];
  if (table === undefined) return sql;
  const keyColumns = TIDB_KEY_TEXT_COLUMNS[table] ?? {};
  const withKeyTypes = sql.replace(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s+TEXT\b/gm, (match, indentation: string, column: string) => {
    const length = keyColumns[column];
    return length === undefined ? match : `${indentation}${column} VARCHAR(${length})`;
  });
  // TiDB TEXT is capped at 64 KiB, while SQLite TEXT carries unbounded model
  // I/O, evidence and JSON. Keyed fields above retain VARCHAR; every other
  // textual payload is LONGTEXT so a migration never truncates evidence.
  return withKeyTypes
    .replace(/\bTEXT(\s+NOT\s+NULL)\s+DEFAULT\s+'(?:''|[^'])*'/gi, "LONGTEXT$1")
    .replace(/\bTEXT\b/gi, "LONGTEXT")
    // SQLite INTEGER values carry epoch milliseconds, byte counts, sequence
    // numbers, and revisions. TiDB INTEGER is a 32-bit alias, so it cannot
    // represent an ordinary millisecond timestamp; BIGINT is the portable
    // physical representation for this application's integer domain.
    .replace(/\bINTEGER\b/gi, "BIGINT");
}

function firstInsertColumn(sql: string): string | undefined {
  const match = sql.match(/INSERT\s+INTO\s+[^\s(]+\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/i);
  return match?.[1];
}
