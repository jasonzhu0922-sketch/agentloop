import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { SqlConnection, SqlStatement, SqlValue } from "./connection.ts";
import type { RuntimeStateCommit, RuntimeStateStore } from "./runtime-state-store.ts";

function digest(record: Omit<RuntimeStateCommit, "checksum">): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}
/**
 * Legacy changeset compatibility adapter, NOT the native Redis repository backend.
 * Redis-backed state with an in-memory relational view. Existing domain transactions
 * retain their constraints; only SQLite's binary row changes enter the durable log.
 * No SQL is sent to Redis, and no remote SQL participates in execution.
 */
export class RuntimeStateConnection implements SqlConnection {
  readonly dialect = "sqlite" as const;
  private readonly view = new DatabaseSync(":memory:");
  private readonly context = new AsyncLocalStorage<{ active: boolean }>();
  private queue: Promise<void> = Promise.resolve();
  private version = 0;
  private failed?: Error;
  private closed = false;
  private schema: string[] = [];
  private readonly store: RuntimeStateStore;
  private constructor(store: RuntimeStateStore) {
    this.store = store;
    this.view.exec("PRAGMA foreign_keys=ON");
  }
  static async open(store: RuntimeStateStore): Promise<RuntimeStateConnection> {
    const connection = new RuntimeStateConnection(store);
    try { await store.open(); await connection.restore(); return connection; }
    catch (error) { connection.view.close(); await store.close().catch(() => {}); throw error; }
  }
  diagnosticEnvironment() { return { runtimeState: "durable-journal", queryView: "memory", stateVersion: this.version }; }
  private assertOpen() {
    if (this.failed) throw this.failed;
    if (this.closed) throw new Error("Runtime state connection is closed");
    const scope = this.context.getStore();
    if (scope && !scope.active) throw new Error("Runtime transaction callback escaped its commit boundary");
  }
  private async exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    this.assertOpen();
    const previous = this.queue; let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { this.assertOpen(); return await operation(); } finally { release(); }
  }
  async transaction<T>(operation: () => T | Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.context.getStore()?.active) return await operation();
    return await this.exclusive(async () => {
      const session = this.view.createSession();
      this.view.exec("BEGIN IMMEDIATE");
      const scope = { active: true };
      let durable = false;
      try {
        const result = await this.context.run(scope, operation);
        if ((this.view.prepare("PRAGMA defer_foreign_keys").get() as any)?.defer_foreign_keys && this.view.prepare("PRAGMA foreign_key_check").all().length)
          throw new Error("Runtime transaction contains invalid deferred references");
        const schema = this.readSchema();
        const schemaChanged = JSON.stringify(schema) !== JSON.stringify(this.schema);
        const changeset = schemaChanged ? new Uint8Array() : session.changeset();
        if (changeset.length || schemaChanged) {
          const body = { format: "agentloop.runtimeState/v1" as const, id: randomUUID(), version: this.version + 1,
            schema: schemaChanged ? schema : [], changeset: Buffer.from(changeset).toString("base64"),
            ...(schemaChanged ? { snapshot: this.snapshot() } : {}) };
          const commit = { ...body, checksum: digest(body) };
          try { await this.store.append(commit); durable = true; }
          catch (error) {
            // A response can be lost after Redis committed. Never roll back an acknowledged
            // command or retry the domain callback (which may contain external effects).
            let receipt: number | undefined;
            try { receipt = await this.store.receipt(commit.id); }
            catch { this.failed = new Error("Runtime state commit is uncertain; restart to restore the durable journal", { cause: error }); }
            if (receipt === commit.version) durable = true;
            else { this.failed ??= new Error("Runtime state persistence failed; restart before accepting more work", { cause: error }); throw this.failed; }
          }
          this.version = commit.version;
          this.schema = schema;
        }
        this.view.exec("COMMIT");
        return result;
      } catch (error) {
        try { this.view.exec("ROLLBACK"); } catch { /* A failed local commit requires replay. */ }
        if (durable) this.failed = new Error("Durable Runtime state requires view recovery; restart Runtime", { cause: error });
        throw error;
      } finally { scope.active = false; session.close(); }
    });
  }
  async exec(sql: string): Promise<void> {
    await this.transaction(() => { this.view.exec(sql); });
  }
  prepare(sql: string): SqlStatement {
    // Prepare inside the lock as DDL and transactions can change the schema.
    const read = async <T>(all: boolean, params: SqlValue[]): Promise<T> => {
      const operation = () => {
        const statement = this.view.prepare(sql);
        // get/all can execute RETURNING statements. Capture those through transaction().
        return (all ? statement.all(...params) : statement.get(...params)) as T;
      };
      return await this.transaction(operation);
    };
    return {
      run: async (...params) => await this.transaction(() => this.view.prepare(sql).run(...params)),
      get: async <T>(...params: SqlValue[]) => await read<T | undefined>(false, params),
      all: async <T>(...params: SqlValue[]) => await read<T[]>(true, params),
    };
  }
  private readSchema(): string[] {
    return (this.view.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, rowid").all() as { sql: string }[]).map(row => row.sql);
  }
  private snapshot() {
    const tables = this.view.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    return tables.map(({ name }) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Unsupported Runtime state table name");
      const columns = this.view.prepare(`PRAGMA table_info("${name}")`).all() as { pk: number }[];
      if (!columns.some(column => column.pk)) throw new Error(`Runtime state table requires a primary key: ${name}`);
      const rows = this.view.prepare(`SELECT * FROM "${name}"`).all();
      return { table: name, rows: rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
        typeof value === "bigint" ? { bigint: String(value) } : value instanceof Uint8Array ? { blob: Buffer.from(value).toString("base64") } : value]))) };
    });
  }
  private async restore() {
    for (;;) {
      const records = await this.store.read(this.version, 100);
      for (const record of records) {
        const { checksum, ...body } = record;
        if (body.format !== "agentloop.runtimeState/v1" || body.version !== this.version + 1 || digest(body) !== checksum)
          throw new Error("Runtime state journal is corrupt or has a version gap");
        this.view.exec("PRAGMA foreign_keys=OFF");
        this.view.exec("BEGIN");
        try {
          if (record.snapshot) {
            for (const { name } of this.view.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Invalid snapshot table");
              this.view.exec(`DROP TABLE "${name}"`);
            }
            for (const sql of record.schema) this.view.exec(sql);
            for (const table of record.snapshot) for (const row of table.rows) {
              const columns = Object.keys(row);
              if (![table.table, ...columns].every(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error("Invalid snapshot identifier");
              this.view.prepare(`INSERT INTO "${table.table}" (${columns.map(name => `"${name}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
                .run(...Object.values(row).map((value: any) => value && typeof value === "object"
                  ? value.blob !== undefined ? Buffer.from(value.blob, "base64") : BigInt(value.bigint) : value));
            }
          }
          if (record.changeset && !this.view.applyChangeset(Buffer.from(record.changeset, "base64"))) throw new Error("Runtime state changeset conflict");
          this.view.exec("COMMIT");
        } catch (error) { this.view.exec("ROLLBACK"); throw error; }
        finally { this.view.exec("PRAGMA foreign_keys=ON"); }
        this.version = record.version; this.schema = this.readSchema();
      }
      // Stores may bound a page by bytes as well as entries. Only an empty
      // page establishes end-of-log; a short page must not truncate history.
      if (records.length === 0) break;
    }
    if (this.view.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Runtime state recovered with invalid references");
  }
  async close() {
    if (this.closed) return;
    await this.queue;
    if (this.closed) return;
    this.closed = true; this.view.close(); await this.store.close();
  }
}
