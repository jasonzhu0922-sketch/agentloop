import { historyUpdates } from "./runtime-history.ts";
import { RedisRuntimeHistoryOutbox } from "./redis-runtime-history.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { RuntimeRedisPort } from "./redis-runtime-state-store.ts";
import type { RuntimePersistence, RuntimeRecords, RuntimeWhere } from "./runtime-records.ts";
import { runtimeRecordSchema, type RuntimeRows, type RuntimeTable } from "./runtime-record-schema.ts";
import { appendRuntimeRecordEvents, type RunEventAppendInput } from "./repositories/run-event-sequencer.ts";

type Row = Record<string, string | number | null>;
type Read = { version: number; data: Row | null };
type Context = { active: boolean; mutating?: boolean; reads: Map<string, Read>; pendingReads: Map<string, Promise<void>>; writes: Map<string, Row | null>; indexes: Map<string, Set<string>>; pendingIndexes: Map<string, Promise<void>> };
const READ = `return {redis.call('HGET',KEYS[1],'v') or '0',redis.call('HGET',KEYS[1],'data') or 'null'}`;
const INDEX = `return {redis.call('HGET',KEYS[1],'v') or '0',redis.call('SMEMBERS',KEYS[2])}`;
// All possible type/version/command failures are checked before the first write.
// Records and index revisions are independent: unrelated Runs never wait on a writer lock.
const COMMIT = `
local command=cjson.decode(ARGV[1])
local prior=redis.call('GET',KEYS[1])
if prior then
 if prior ~= ARGV[2] then return redis.error_reply('RUNTIME_COMMAND_CONFLICT') end
 return 'replayed'
end
local function safeversion(key)
 local t=redis.call('TYPE',key).ok
 if t ~= 'none' and t ~= 'hash' then return false end
 local v=redis.call('HGET',key,'v') or '0'
 return string.match(v,'^%d+$') and tonumber(v) <= 9007199254740990
end
for _,w in ipairs(command.writes) do
 if not safeversion(KEYS[w.key]) then return redis.error_reply('RUNTIME_INVALID_VERSION') end
end
for _,idx in ipairs(command.indexes) do
 if not safeversion(KEYS[idx.version]) then return redis.error_reply('RUNTIME_INVALID_VERSION') end
end
for _,r in ipairs(command.reads) do
 local t=redis.call('TYPE',KEYS[r.key]).ok
 if t ~= 'none' and t ~= 'hash' then return redis.error_reply('RUNTIME_KEY_TYPE') end
 if tonumber(redis.call('HGET',KEYS[r.key],'v') or '0') ~= r.version then return redis.error_reply('RUNTIME_VERSION_CONFLICT') end
end
for _,idx in ipairs(command.indexes) do
 local t=redis.call('TYPE',KEYS[idx.members]).ok
 if t ~= 'none' and t ~= 'set' then return redis.error_reply('RUNTIME_INDEX_TYPE') end
 local v=redis.call('TYPE',KEYS[idx.version]).ok
 if v ~= 'none' and v ~= 'hash' then return redis.error_reply('RUNTIME_KEY_TYPE') end
end
for _,idx in ipairs(command.eventIndexes) do
 local t=redis.call('TYPE',KEYS[idx.key]).ok
 if t ~= 'none' and t ~= 'zset' then return redis.error_reply('RUNTIME_INDEX_TYPE') end
end
-- History types and counters must be validated before *any* execution write.
for _,entry in ipairs(command.history or {}) do
 for _,key in ipairs({entry.objects,entry.versions,entry.tasks}) do
  local t=redis.call('TYPE',KEYS[key]).ok
  if t ~= 'none' and t ~= 'hash' then return redis.error_reply('RUNTIME_HISTORY_TYPE') end
 end
 for _,key in ipairs({entry.due,entry.age}) do
  local t=redis.call('TYPE',KEYS[key]).ok
  if t ~= 'none' and t ~= 'zset' then return redis.error_reply('RUNTIME_HISTORY_TYPE') end
 end
 local version=redis.call('HGET',KEYS[entry.versions],entry.value.objectId) or '0'
 if not string.match(version,'^%d+$') or tonumber(version)>=9007199254740990 then return redis.error_reply('RUNTIME_HISTORY_VERSION') end
end
for _,w in ipairs(command.writes) do
 redis.call('HSET',KEYS[w.key],'data',w.data)
 redis.call('HINCRBY',KEYS[w.key],'v',1)
end
for _,idx in ipairs(command.indexes) do
 for _,id in ipairs(idx.add) do redis.call('SADD',KEYS[idx.members],id) end
 for _,id in ipairs(idx.remove) do redis.call('SREM',KEYS[idx.members],id) end
 redis.call('HINCRBY',KEYS[idx.version],'v',1)
end
for _,idx in ipairs(command.eventIndexes) do
 for _,id in ipairs(idx.remove) do redis.call('ZREM',KEYS[idx.key],id) end
 for _,entry in ipairs(idx.add) do redis.call('ZADD',KEYS[idx.key],entry.seq,entry.id) end
end
for _,entry in ipairs(command.history or {}) do
 local value=entry.value
 local prior=redis.call('HGET',KEYS[entry.objects],value.objectId)
 if not prior or not cjson.decode(prior).deleted then
  value.version=redis.call('HINCRBY',KEYS[entry.versions],value.objectId,1)
  value.updatedAt=command.historyTime
  local pending=redis.call('HGET',KEYS[entry.tasks],value.objectId)
  value.pendingAt=pending and cjson.decode(pending).pendingAt or command.historyTime
  value.attempts=0; value.nextAttemptAt=command.historyTime
  local encoded=cjson.encode(value)
  redis.call('HSET',KEYS[entry.objects],value.objectId,encoded)
  redis.call('HSET',KEYS[entry.tasks],value.objectId,encoded)
  redis.call('ZADD',KEYS[entry.due],command.historyTime,value.objectId)
  redis.call('ZADD',KEYS[entry.age],value.pendingAt,value.objectId)
 end
end
redis.call('SET',KEYS[1],ARGV[2])
return 'committed'`;

export class RuntimeStateConflict extends Error {}
class RuntimeUniqueConflict extends RuntimeStateConflict {}
export class RuntimeCommitUncertain extends Error {
  readonly commandId: string;
  constructor(commandId: string, cause: unknown) { super(`Runtime commit ${commandId} requires receipt reconciliation`, { cause }); this.commandId = commandId; }
}

/** Native Redis records. This module neither imports SQLite nor accepts SQL. */
export class RedisRuntimeRecords implements RuntimePersistence, RuntimeRecords {
  readonly records: RuntimeRecords = this;
  readonly historyOutbox: RedisRuntimeHistoryOutbox;
  private readonly context = new AsyncLocalStorage<Context>();
  private readonly mutations = new AsyncLocalStorage<Context>();
  private readonly eventQueues = new Map<string, Promise<void>>();
  private closed = false;
  private readonly redis: RuntimeRedisPort;
  private readonly prefix: string;
  private readonly maxCommandBytes: number;
  private constructor(redis: RuntimeRedisPort, prefix: string, maxCommandBytes: number) { this.redis = redis; this.prefix = prefix; this.maxCommandBytes = maxCommandBytes; this.historyOutbox = new RedisRuntimeHistoryOutbox(redis, prefix); }

  static async open(redis: RuntimeRedisPort, options: { prefix: string; maxCommandBytes?: number; offlineImport?: { checksum: string; legacyVersion: number } }): Promise<RedisRuntimeRecords> {
    if (!/^[A-Za-z0-9:{}_-]{1,180}$/.test(options.prefix)) throw new TypeError("Invalid Runtime namespace");
    if (options.maxCommandBytes !== undefined && (!Number.isSafeInteger(options.maxCommandBytes) || options.maxCommandBytes < 1024)) throw new TypeError("Invalid Runtime transaction size limit");
    const store = new RedisRuntimeRecords(redis, `${options.prefix}:native-v2`, options.maxCommandBytes ?? 4 * 1024 * 1024);
    try {
      const persistence = String(await redis.sendCommand(["INFO", "persistence"]));
      const config = await redis.sendCommand(["CONFIG", "GET", "appendfsync", "maxmemory-policy"]) as string[];
      const values = Object.fromEntries(Array.from({ length: config.length / 2 }, (_, i) => [config[2 * i], config[2 * i + 1]]));
      if (!/^aof_enabled:1\r?$/m.test(persistence) || !/^aof_last_write_status:ok\r?$/m.test(persistence)
        || values.appendfsync !== "always" || values["maxmemory-policy"] !== "noeviction")
        throw new Error("Runtime Redis requires healthy AOF, appendfsync always and noeviction");
      const legacyVersion = await redis.sendCommand(["GET", `${options.prefix}:version`]);
      const format = await redis.sendCommand(["GET", `${store.prefix}:format`]);
      const migrationKey = `${store.prefix}:migration`;
      let migration = await redis.sendCommand(["GET", migrationKey]);
      if (options.offlineImport) {
        const { checksum, legacyVersion: expected } = options.offlineImport;
        if (!/^[a-f0-9]{64}$/.test(checksum) || !Number.isSafeInteger(expected) || expected < 0 || Number(legacyVersion ?? 0) !== expected) throw new Error("Offline migration source version changed");
        const marker = JSON.stringify({ status: "importing", checksum, legacyVersion: expected });
        if (migration === null) {
          // A native target is adopted only when verified by importRuntimeRecords; no data is removed.
          await redis.sendCommand(["SET", migrationKey, marker, "NX"]);
          migration = await redis.sendCommand(["GET", migrationKey]);
        }
        if (migration !== marker) throw new Error("Runtime namespace belongs to a different or completed migration");
      } else {
        const marker = migration === null ? undefined : JSON.parse(String(migration));
        if (marker && marker.status !== "complete") throw new Error("Runtime offline import is incomplete; resume and verify before startup");
        if (Number(legacyVersion ?? 0) > 0 && (!marker || marker.legacyVersion !== Number(legacyVersion)))
          throw new Error("Legacy changeset history requires an explicit offline migration; namespace was preserved");
      }
      if (format !== null && format !== "agentloop.runtimeRecords/v2") throw new Error("Unsupported Runtime state format");
      await redis.sendCommand(["SET", `${store.prefix}:format`, "agentloop.runtimeRecords/v2", "NX"]);
      return store;
    } catch (error) { await redis.close().catch(() => {}); throw error; }
  }

  /** Finalize only after a full export checksum comparison by the offline importer. */
  async completeOfflineImport(checksum: string, legacyVersion: number): Promise<void> {
    const importing = JSON.stringify({ status: "importing", checksum, legacyVersion });
    const complete = JSON.stringify({ status: "complete", checksum, legacyVersion });
    const script = `if redis.call('GET',KEYS[1]) ~= ARGV[1] or tonumber(redis.call('GET',KEYS[2]) or '0') ~= tonumber(ARGV[3]) then return redis.error_reply('RUNTIME_MIGRATION_CHANGED') end; redis.call('SET',KEYS[1],ARGV[2]); return 1`;
    await this.redis.sendCommand(["EVAL", script, "2", `${this.prefix}:migration`, `${this.prefix.slice(0, -10)}:version`, importing, complete, String(legacyVersion)]);
  }

  private scope(): Context {
    const scope = this.context.getStore();
    if (this.closed || !scope?.active) throw new Error("Runtime record operation escaped its transaction");
    return scope;
  }
  private identity(table: RuntimeTable, row: Row): string {
    const fields = runtimeRecordSchema[table].key.map(column => row[column]);
    if (fields.some(value => value === null || value === undefined)) throw new TypeError(`Missing Runtime primary key for ${table}`);
    return `${this.prefix}:r:${table}:${createHash("sha256").update(JSON.stringify(fields)).digest("hex")}`;
  }
  private index(table: RuntimeTable, column: string, value: unknown): string {
    return `${this.prefix}:i:${table}:${column}:${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
  }
  private indexes(table: RuntimeTable, row: Row): string[] {
    const fields = Object.keys(row).filter(column => ["id", "run_id", "plan_id", "owner_user_id", "conversation_id", "parent_run_id", "source_id", "request_id", "status", "state", "action_id", "name", "batch_id", "result_ref", "recovery_decision_id", "scope", "runtime_id", "remote_run_id", "dispatch_key"].includes(column));
    return [this.index(table, "all", true), ...fields.map(column => this.index(table, column, row[column]))];
  }
  private async read(key: string): Promise<Read> {
    const scope = this.scope();
    if (!scope.reads.has(key)) {
      if (!scope.pendingReads.has(key)) scope.pendingReads.set(key, (async () => {
        const result = await this.redis.sendCommand(["EVAL", READ, "1", key]) as [string, string];
        scope.reads.set(key, { version: Number(result[0]), data: JSON.parse(result[1]) });
      })());
      await scope.pendingReads.get(key);
    }
    const result = scope.reads.get(key)!;
    return { version: result.version, data: scope.writes.has(key) ? scope.writes.get(key)! : result.data };
  }
  async appendEvents(runId: string, inputs: readonly RunEventAppendInput[]): Promise<readonly number[]> {
    // An enclosing domain transaction owns its commit boundary. Never replay
    // that callback or wait for a queue that may itself need this transaction.
    if (this.context.getStore()) return await appendRuntimeRecordEvents(this, runId, inputs);
    const previous = this.eventQueues.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    this.eventQueues.set(runId, pending);
    await previous;
    try {
      for (let attempt = 0;; attempt++) {
        try { return await appendRuntimeRecordEvents(this, runId, inputs); }
        catch (error) {
          // Only this pure append is retried. A concurrent writer can commit
          // after our counter read but before our event-row read, yielding an
          // insert conflict even before commit's version validation.
          if (!(error instanceof RuntimeStateConflict) || attempt >= 31) throw error;
        }
      }
    } finally {
      release();
      if (this.eventQueues.get(runId) === pending) this.eventQueues.delete(runId);
    }
  }
  async transaction<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.closed) throw new Error("Runtime state is closed");
    if (this.context.getStore()) { this.scope(); return await operation(); }
    const scope: Context = { active: true, reads: new Map(), pendingReads: new Map(), writes: new Map(), indexes: new Map(), pendingIndexes: new Map() };
    try {
      return await this.context.run(scope, async () => {
        const result = await operation();
        if (scope.mutating) throw new Error("Runtime transaction returned before its writes completed");
        await this.commit(scope);
        return result;
      });
    } finally { scope.active = false; }
  }
  async recordTransaction<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.context.getStore()) return await this.transaction(operation);
    for (let attempt = 0;; attempt++) {
      try { return await this.transaction(operation); }
      catch (error) {
        if (!(error instanceof RuntimeStateConflict) || attempt >= 31) throw error;
      }
    }
  }
  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    return await this.transaction(async () => {
      const scope = this.scope();
      if (scope.mutating && this.mutations.getStore() !== scope) throw new Error("Sequence writes inside one Runtime transaction; concurrent transactions remain independent");
      const before = new Map(scope.writes), outer = !scope.mutating;
      if (outer) scope.mutating = true;
      try { return await this.mutations.run(scope, operation); }
      catch (error) { scope.writes = before; throw error; }
      finally { if (outer) scope.mutating = false; }
    });
  }
  async scan<T extends RuntimeTable>(table: T, cursor = "0", limit = 100): Promise<{ cursor?: string; rows: RuntimeRows[T][] }> {
    if (!(table in runtimeRecordSchema) || !/^[0-9]+$/.test(cursor) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("Invalid Runtime scan");
    if (this.context.getStore()) throw new Error("Runtime scan is maintenance-only; use indexed find inside transactions");
    if (this.closed) throw new Error("Runtime state is closed");
    const result = await this.redis.sendCommand(["SCAN", cursor, "MATCH", `${this.prefix}:r:${table}:*`, "COUNT", String(limit)]) as [string, string[]];
    const rows: RuntimeRows[T][] = [];
    for (const key of result[1]) {
      const row = await this.redis.sendCommand(["HGET", key, "data"]);
      if (row !== null && row !== "null") rows.push(JSON.parse(String(row)));
    }
    return { rows, ...(result[0] === "0" ? {} : { cursor: result[0] }) };
  }
  async find<T extends RuntimeTable>(table: T, where: RuntimeWhere<T> = {}): Promise<RuntimeRows[T][]> {
    // This retry encloses only our pure query, never a domain callback or effect.
    if (!this.context.getStore()) {
      for (let attempt = 0;; attempt++) {
        try { return await this.transaction(() => this.find(table, where)); }
        catch (error) { if (!(error instanceof RuntimeStateConflict) || attempt >= 7) throw error; }
      }
    }
    return await this.transaction(async () => {
      const schema = runtimeRecordSchema[table];
      for (const column of Object.keys(where)) if (!(column in schema.defaults)) throw new TypeError(`Unknown Runtime field ${table}.${column}`);
      const primary = schema.key.every(column => column in where);
      let keys: Set<string>;
      if (primary) keys = new Set([this.identity(table, where as Row)]);
      else {
        const entry = Object.entries(where).find(([column]) => ["run_id", "plan_id", "owner_user_id", "conversation_id", "parent_run_id", "source_id", "request_id", "status", "state", "action_id", "name", "batch_id", "result_ref", "recovery_decision_id", "scope", "runtime_id", "remote_run_id", "dispatch_key"].includes(column));
        const index = entry ? this.index(table, entry[0], entry[1]) : this.index(table, "all", true);
        const scope = this.scope();
        if (!scope.indexes.has(index)) {
          if (!scope.pendingIndexes.has(index)) scope.pendingIndexes.set(index, (async () => {
            const result = await this.redis.sendCommand(["EVAL", INDEX, "2", index, `${index}:members`]) as [string, string[]];
            scope.reads.set(index, { version: Number(result[0]), data: null });
            scope.indexes.set(index, new Set(result[1]));
          })());
          await scope.pendingIndexes.get(index);
        }
        keys = new Set(scope.indexes.get(index)!);
        for (const key of scope.writes.keys()) if (key.startsWith(`${this.prefix}:r:${table}:`)) keys.add(key);
      }
      const result: RuntimeRows[T][] = [];
      for (const key of keys) {
        const row = (await this.read(key)).data;
        if (row && Object.entries(where).every(([column, value]) => row[column] === value)) result.push(structuredClone(row) as RuntimeRows[T]);
      }
      return result;
    });
  }
  async insert<T extends RuntimeTable>(table: T, row: Partial<RuntimeRows[T]>, mode: "insert" | "ignore" | "replace" = "insert") {
    await this.mutate(async () => {
      const schema = runtimeRecordSchema[table];
      for (const column of Object.keys(row)) if (!(column in schema.defaults)) throw new TypeError(`Unknown Runtime field ${table}.${column}`);
      let value = { ...schema.defaults, ...row } as Row;
      const key = this.identity(table, value);
      const existing = (await this.read(key)).data;
      if (existing && mode === "ignore") return;
      if (existing && mode === "insert") throw new RuntimeStateConflict(`Runtime record already exists: ${table}`);
      if (existing && mode === "replace") value = { ...existing, ...row } as Row;
      try { await this.validate(table, value, key); }
      catch (error) { if (mode === "ignore" && error instanceof RuntimeUniqueConflict) return; throw error; }
      if (existing) await this.releaseClaims(table, existing, value, key);
      this.scope().writes.set(key, value);
    });
  }
  private async validate(table: RuntimeTable, row: Row, identity: string) {
    const schema = runtimeRecordSchema[table];
    for (const value of Object.values(row)) if (value !== null && (typeof value !== "string" && typeof value !== "number" || typeof value === "number" && !Number.isFinite(value))) throw new TypeError(`Invalid Runtime scalar in ${table}`);
    for (const column of Object.keys(row)) if (!(column in schema.defaults)) throw new TypeError(`Unknown Runtime field ${table}.${column}`);
    for (const column of schema.required) if (row[column] === null || row[column] === undefined) throw new TypeError(`Missing Runtime field ${table}.${column}`);
    for (const [column, allowed] of Object.entries(schema.enums)) if (row[column] !== null && !(allowed as readonly unknown[]).includes(row[column])) throw new TypeError(`Invalid Runtime field ${table}.${column}`);
    const claims: string[] = [];
    for (const unique of schema.unique) {
      if (unique.some(column => row[column] === null)) continue;
      const claim = this.claim(table, unique, row);
      const previous = (await this.read(claim)).data;
      if (previous && previous.identity !== identity) throw new RuntimeUniqueConflict(`Runtime unique constraint: ${table}`);
      claims.push(claim);
    }
    for (const fk of schema.foreignKeys) {
      if (fk.columns.some(column => row[column] === null)) continue;
      const where = Object.fromEntries(fk.columns.map((column, i) => [fk.references[i], row[column]]));
      if (!(await this.find(fk.table as RuntimeTable, where)).length) throw new RuntimeStateConflict(`Runtime reference missing: ${table} -> ${fk.table}`);
    }
    for (const claim of claims) this.scope().writes.set(claim, { identity });
  }
  private claim(table: RuntimeTable, columns: readonly string[], row: Row) {
    return `${this.prefix}:u:${table}:${Buffer.from(JSON.stringify(columns.map(column => [column, row[column]]))).toString("base64url")}`;
  }
  private async releaseClaims(table: RuntimeTable, before: Row, after: Row | null, identity: string) {
    for (const unique of runtimeRecordSchema[table].unique) {
      if (unique.some(column => before[column] === null)) continue;
      const key = this.claim(table, unique, before);
      if (after && unique.every(column => before[column] === after[column])) continue;
      const claim = await this.read(key);
      if (claim.data?.identity === identity) this.scope().writes.set(key, null);
    }
  }
  async update<T extends RuntimeTable>(table: T, where: RuntimeWhere<T>, change: (row: RuntimeRows[T]) => Partial<RuntimeRows[T]> | undefined): Promise<number> {
    return await this.mutate(async () => {
      let changed = 0;
      for (const row of await this.find(table, where)) {
        const patch = change(row);
        if (!patch || !Object.keys(patch).length) continue;
        const value = { ...row, ...patch } as Row;
        const key = this.identity(table, row as Row);
        if (this.identity(table, value) !== key) throw new TypeError("Runtime primary keys are immutable");
        await this.validate(table, value, key);
        await this.releaseClaims(table, row as Row, value, key);
        this.scope().writes.set(key, value);
        changed++;
      }
      return changed;
    });
  }
  async remove<T extends RuntimeTable>(table: T, where: RuntimeWhere<T>): Promise<number> {
    return await this.mutate(async () => {
      const rows = await this.find(table, where);
      const pending: { table: RuntimeTable; row: Row }[] = rows.map(row => ({ table, row: row as Row }));
      const visited = new Set<string>();
      const deferred: { child: RuntimeTable; filter: Record<string, unknown>; columns: readonly string[]; action: string }[] = [];
      // Compute the full CASCADE closure before applying SET NULL/RESTRICT.
      // A Run can own both an Action and its Plan; transiently nulling the
      // Action's Plan while its Run is already removed is not a valid row.
      for (const item of pending) {
        const identity = this.identity(item.table, item.row);
        if (visited.has(identity)) continue;
        visited.add(identity);
        this.scope().writes.set(identity, null);
        await this.releaseClaims(item.table, item.row, null, identity);
        for (const [child, schema] of Object.entries(runtimeRecordSchema)) for (const fk of schema.foreignKeys) {
          if (fk.table !== item.table) continue;
          const filter = Object.fromEntries(fk.columns.map((column, i) => [column, item.row[fk.references[i]]]));
          if (fk.onDelete === "CASCADE") for (const row of await this.find(child as RuntimeTable, filter)) pending.push({ table: child as RuntimeTable, row: row as Row });
          else deferred.push({ child: child as RuntimeTable, filter, columns: fk.columns, action: fk.onDelete });
        }
      }
      const patches = new Map<string, { child: RuntimeTable; key: Record<string, unknown>; patch: Row }>();
      for (const { child, filter, columns, action } of deferred) {
        const survivors = await this.find(child, filter);
        if (action !== "SET NULL" && survivors.length) throw new RuntimeStateConflict(`Runtime delete reference: ${child} -> ${table}`);
        if (action === "SET NULL") for (const row of survivors) {
          const identity = this.identity(child, row as Row);
          let change = patches.get(identity);
          if (!change) { change = { child, key: Object.fromEntries(runtimeRecordSchema[child].key.map(column => [column, row[column]])), patch: {} }; patches.set(identity, change); }
          Object.assign(change.patch, Object.fromEntries(columns.map(column => [column, null])));
        }
      }
      for (const change of patches.values()) await this.update(change.child, change.key, () => change.patch);
      return rows.length;
    });
  }
  private async commit(scope: Context) {
    const id = randomUUID();
    const keys = [`${this.prefix}:receipt:${id}`];
    const keyIndex = (key: string) => { let index = keys.indexOf(key); if (index < 0) { index = keys.length; keys.push(key); } return index + 1; };
    const reads = [...scope.reads].map(([key, value]) => ({ key: keyIndex(key), version: value.version }));
    const writes = [...scope.writes].map(([key, data]) => ({ key: keyIndex(key), data: JSON.stringify(data) }));
    const eventIndexes = new Map<string, { key: number; add: { id: string; seq: number }[]; remove: string[] }>();
    const indexes = new Map<string, { version: number; members: number; add: string[]; remove: string[] }>();
    for (const [key, row] of scope.writes) {
      const match = key.match(/:r:([a-z_]+):[a-f0-9]+$/);
      if (!match) continue;
      const table = match[1] as RuntimeTable;
      const before = scope.reads.get(key)?.data;
      if (table === "run_events") {
        for (const value of [before, row]) {
          if (!value) continue;
          const index = `${this.prefix}:events:${Buffer.from(String(value.run_id)).toString("base64url")}`;
          if (!eventIndexes.has(index)) eventIndexes.set(index, { key: keyIndex(index), add: [], remove: [] });
          if (value === row) eventIndexes.get(index)!.add.push({ id: key, seq: Number(value.seq) });
          else eventIndexes.get(index)!.remove.push(key);
        }
      }
      const old = new Set(before ? this.indexes(table, before) : []);
      const next = new Set(row ? this.indexes(table, row) : []);
      for (const index of new Set([...old, ...next])) {
        if (old.has(index) === next.has(index)) continue;
        if (!indexes.has(index)) indexes.set(index, { version: keyIndex(index), members: keyIndex(`${index}:members`), add: [], remove: [] });
        indexes.get(index)![next.has(index) ? "add" : "remove"].push(key);
      }
    }
    const history = [] as any[];
    for (const [key, row] of scope.writes) {
      const match = key.match(/:r:([a-z_]+):[a-f0-9]+$/);
      if (!match) continue;
      // Keep opaque payload JSON out of Redis cjson: empty arrays must survive as arrays.
      for (const {payload, ...metadata} of historyUpdates(match[1], key, scope.reads.get(key)?.data, row)) history.push({ value:{...metadata,payloadJson:JSON.stringify(payload)},
        objects: keyIndex(`${this.prefix}:history:objects`), versions: keyIndex(`${this.prefix}:history:versions`), tasks: keyIndex(`${this.prefix}:history:tasks`),
        due: keyIndex(`${this.prefix}:history:due`), age: keyIndex(`${this.prefix}:history:age`) });
    }
    const payload = JSON.stringify({ reads, writes, indexes: [...indexes.values()], eventIndexes: [...eventIndexes.values()], history, historyTime: Date.now() });
    if (Buffer.byteLength(payload) > this.maxCommandBytes) throw new RangeError("Runtime transaction exceeds its size limit; store large content outside Runtime state");
    const checksum = createHash("sha256").update(payload).digest("hex");
    if (!writes.length) {
      // Read-only transactions validate their complete snapshot without accumulating receipts.
      const validate = `local reads=cjson.decode(ARGV[1]); for _,r in ipairs(reads) do if tonumber(redis.call('HGET',KEYS[r.key],'v') or '0') ~= r.version then return redis.error_reply('RUNTIME_VERSION_CONFLICT') end end; return 1`;
      try { await this.redis.sendCommand(["EVAL", validate, String(keys.length), ...keys, JSON.stringify(reads)]); }
      catch (error) { if (String(error).includes("RUNTIME_VERSION_CONFLICT")) throw new RuntimeStateConflict("Runtime read snapshot changed", { cause: error }); throw error; }
      return;
    }
    try { await this.redis.sendCommand(["EVAL", COMMIT, String(keys.length), ...keys, payload, checksum]); }
    catch (error) {
      if (String(error).includes("RUNTIME_VERSION_CONFLICT")) throw new RuntimeStateConflict("Runtime transaction observed concurrent changes", { cause: error });
      let receipt: unknown;
      try { receipt = await this.redis.sendCommand(["GET", keys[0]]); }
      catch { throw new RuntimeCommitUncertain(id, error); }
      if (receipt === checksum) return;
      if (receipt === null) throw error;
      throw new RuntimeCommitUncertain(id, error);
    }
  }
  /** One Redis command reads a bounded, ordered, committed event slice. */
  async eventPage(runId: string, afterSeq: number, limit: number, descending = false): Promise<import("./run-event-store.ts").StoredRunEvent[]> {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("Invalid event cursor or page size");
    const key = `${this.prefix}:events:${Buffer.from(runId).toString("base64url")}`;
    const script = `local ids=redis.call('${descending ? "ZREVRANGEBYSCORE" : "ZRANGEBYSCORE"}',KEYS[1],${descending ? "'+inf','('..ARGV[1]" : "'('..ARGV[1],'+inf'"},'LIMIT',0,ARGV[2]); local rows={}; for _,id in ipairs(ids) do local row=redis.call('HGET',id,'data'); if row and row ~= 'null' then table.insert(rows,row) end end; return rows`;
    const rows = await this.redis.sendCommand(["EVAL", script, "1", key, String(afterSeq), String(limit)]) as string[];
    return rows.map(row => JSON.parse(row));
  }

  async close() { this.closed = true; await this.redis.close(); }

  /** Reconcile an uncertain commit on a newly connected instance; never rerun its callback. */
  async inspectCommit(commandId: string): Promise<"committed" | "absent"> {
    if (!/^[a-f0-9-]{36}$/.test(commandId)) throw new TypeError("Invalid Runtime command id");
    const receipt = await this.redis.sendCommand(["GET", `${this.prefix}:receipt:${commandId}`]);
    return receipt === null ? "absent" : "committed";
  }
}
