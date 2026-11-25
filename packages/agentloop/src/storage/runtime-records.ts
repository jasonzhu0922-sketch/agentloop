import { appendRunEvents } from "./repositories/run-event-sequencer.ts";
import type { SqlConnection, SqlValue } from "./connection.ts";
import type { RuntimeRows, RuntimeTable } from "./runtime-record-schema.ts";
import { runtimeRecordSchema } from "./runtime-record-schema.ts";

export type RuntimeWhere<T extends RuntimeTable> = Partial<RuntimeRows[T]>;
/** Repository data boundary. Predicates and transitions stay in domain repositories.
 * Sequence mutations inside a transaction; independent transactions may run concurrently.
 */
export interface RuntimeRecords {
  /** Incremental enumeration for maintenance/migration. Cursor is backend opaque. */
  scan<T extends RuntimeTable>(table: T, cursor?: string, limit?: number): Promise<{ cursor?: string; rows: RuntimeRows[T][] }>;
  find<T extends RuntimeTable>(table: T, where?: RuntimeWhere<T>): Promise<RuntimeRows[T][]>;
  insert<T extends RuntimeTable>(table: T, row: Partial<RuntimeRows[T]>, mode?: "insert" | "ignore" | "replace"): Promise<void>;
  update<T extends RuntimeTable>(table: T, where: RuntimeWhere<T>, change: (row: RuntimeRows[T]) => Partial<RuntimeRows[T]> | undefined): Promise<number>;
  remove<T extends RuntimeTable>(table: T, where: RuntimeWhere<T>): Promise<number>;
}

export interface RuntimePersistence {
  readonly historyOutbox?: import("./runtime-history.ts").RuntimeHistoryOutbox;
  readonly records: RuntimeRecords;
  appendEvents?(runId: string, events: readonly import("./repositories/run-event-sequencer.ts").RunEventAppendInput[]): Promise<readonly number[]>;
  diagnostics?(): Readonly<Record<string, unknown>>;
  eventPage?(runId: string, afterSeq: number, limit: number, descending?: boolean): Promise<import("./run-event-store.ts").StoredRunEvent[]>;
  readonly eventStore?: import("./run-event-store.ts").RunEventStore;
  transaction<T>(operation: () => T | Promise<T>): Promise<T>;
  /** Opt-in pure repository transaction. May repeat after an optimistic conflict.
   * Callback must only read/write records; never execute tools, publish, or call models.
   * An enclosing transaction owns retries and is never repeated by this method.
   */
  recordTransaction?<T>(operation: () => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function recordTransaction<T>(state: RuntimePersistence, operation: () => T | Promise<T>): Promise<T> {
  return state.recordTransaction ? await state.recordTransaction(operation) : await state.transaction(operation);
}

export type RuntimePersistenceInput = RuntimePersistence | SqlConnection;
const adapters = new WeakMap<SqlConnection, RuntimePersistence>();

/** The only compatibility dispatch: existing SQLite hosts can migrate independently. */
export function runtimePersistence(input: RuntimePersistenceInput): RuntimePersistence {
  if ("records" in input) return input;
  const previous = adapters.get(input);
  if (previous) return previous;
  const adapter: RuntimePersistence = {
    records: new SqlRuntimeRecords(input),
    appendEvents: (runId, events) => appendRunEvents(input, runId, events),
    diagnostics: () => ({ storageDialect: input.dialect, ...(input.diagnosticEnvironment?.() ?? {}) }),
    eventPage: async (runId, afterSeq, limit, descending = false) => input.runEventStore ?
      (await input.runEventStore.events(runId)).filter(row => row.seq > afterSeq).sort((a, b) => descending ? b.seq - a.seq : a.seq - b.seq).slice(0, limit) :
      await input.prepare(`SELECT seq,type,payload_json,created_at FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ${descending ? "DESC" : "ASC"} LIMIT ?`)
        .all<import("./run-event-store.ts").StoredRunEvent>(runId, afterSeq, limit),
    get eventStore() { return input.runEventStore; },
    transaction: operation => input.transaction(operation),
    close: () => input.close(),
  };
  adapters.set(input, adapter);
  return adapter;
}

function identifier(table: RuntimeTable, column: string): string {
  if (!(column in runtimeRecordSchema[table].defaults)) throw new TypeError(`Unknown Runtime field ${table}.${column}`);
  return column;
}

/** SQLite's existing schema remains the disk format, including its constraints/history. */
class SqlRuntimeRecords implements RuntimeRecords {
  private readonly sql: SqlConnection;
  constructor(sql: SqlConnection) { this.sql = sql; }
  private match<T extends RuntimeTable>(table: T, where: RuntimeWhere<T>) {
    const entries = Object.entries(where);
    return { sql: entries.length ? " WHERE " + entries.map(([column, value]) => `${identifier(table, column)} ${value === null ? "IS NULL" : "= ?"}`).join(" AND ") : "",
      values: entries.filter(([, value]) => value !== null).map(([, value]) => value as SqlValue) };
  }
  async scan<T extends RuntimeTable>(table: T, cursor?: string, limit = 100): Promise<{ cursor?: string; rows: RuntimeRows[T][] }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("Invalid Runtime page size");
    const keys = runtimeRecordSchema[table].key;
    const previous = cursor ? JSON.parse(Buffer.from(cursor, "base64url").toString()) as SqlValue[] : undefined;
    if (previous && (!Array.isArray(previous) || previous.length !== keys.length)) throw new TypeError("Invalid Runtime scan cursor");
    const after = previous ? " WHERE " + keys.map((key, index) => `(${keys.slice(0, index).map(column => `${column}=? AND `).join("")}${key}>?)`).join(" OR ") : "";
    const values = previous ? keys.flatMap((_, index) => previous.slice(0, index + 1)) : [];
    const rows = await this.sql.prepare(`SELECT * FROM ${table}${after} ORDER BY ${keys.join(",")} LIMIT ?`).all<RuntimeRows[T]>(...values, limit);
    return { rows, ...(rows.length < limit ? {} : { cursor: Buffer.from(JSON.stringify(keys.map(key => rows.at(-1)![key]))).toString("base64url") }) };
  }
  async find<T extends RuntimeTable>(table: T, where: RuntimeWhere<T> = {}): Promise<RuntimeRows[T][]> {
    const match = this.match(table, where);
    return await this.sql.transaction(async () => await this.sql.prepare(`SELECT * FROM ${table}${match.sql}${this.sql.dialect === "sqlite" ? "" : " FOR UPDATE"}`).all<RuntimeRows[T]>(...match.values));
  }
  async insert<T extends RuntimeTable>(table: T, row: Partial<RuntimeRows[T]>, mode: "insert" | "ignore" | "replace" = "insert") {
    const entries = Object.entries(row);
    const key = runtimeRecordSchema[table].key;
    const columns = entries.map(([column]) => identifier(table, column));
    const update = entries.filter(([column]) => !(key as readonly string[]).includes(column));
    const conflict = mode === "insert" ? "" : this.sql.dialect === "tidb" ?
      ` ON DUPLICATE KEY UPDATE ${mode === "ignore" || !update.length ? `${key[0]}=${key[0]}` : update.map(([column]) => `${identifier(table, column)}=VALUES(${identifier(table, column)})`).join(",")}` : mode === "ignore" || !update.length ? " ON CONFLICT DO NOTHING" :
      ` ON CONFLICT(${key.map(column => identifier(table, column)).join(",")}) DO UPDATE SET ${update.map(([column]) => `${identifier(table, column)}=excluded.${identifier(table, column)}`).join(",")}`;
    await this.sql.transaction(async () => { await this.sql.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})${conflict}`)
      .run(...entries.map(([, value]) => value as SqlValue)); });
  }
  async update<T extends RuntimeTable>(table: T, where: RuntimeWhere<T>, change: (row: RuntimeRows[T]) => Partial<RuntimeRows[T]> | undefined): Promise<number> {
    return await this.sql.transaction(async () => {
      let changed = 0;
      for (const row of await this.find(table, where)) {
        const patch = change(row);
        if (!patch || !Object.keys(patch).length) continue;
        const entries = Object.entries(patch);
        const primary = Object.fromEntries(runtimeRecordSchema[table].key.map(column => [column, row[column]])) as RuntimeWhere<T>;
        const match = this.match(table, primary);
        const result = await this.sql.prepare(`UPDATE ${table} SET ${entries.map(([column]) => `${identifier(table, column)}=?`).join(",")}${match.sql}`)
          .run(...entries.map(([, value]) => value as SqlValue), ...match.values);
        changed += Number(result.changes);
      }
      return changed;
    });
  }
  async remove<T extends RuntimeTable>(table: T, where: RuntimeWhere<T>): Promise<number> {
    const match = this.match(table, where);
    return await this.sql.transaction(async () => Number((await this.sql.prepare(`DELETE FROM ${table}${match.sql}`).run(...match.values)).changes));
  }
}

export function ascending<T>(...columns: (keyof T)[]): (a: T, b: T) => number {
  return (a, b) => { for (const column of columns) { if (a[column] < b[column]) return -1; if (a[column] > b[column]) return 1; } return 0; };
}
