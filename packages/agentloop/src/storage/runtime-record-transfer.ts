import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { runtimeRecordSchema, type RuntimeRows, type RuntimeTable } from "./runtime-record-schema.ts";
import { runtimePersistence, type RuntimePersistenceInput } from "./runtime-records.ts";

export interface RuntimeTransferManifest {
  schema: "agentloop.runtimeTransfer/v1";
  source: string;
  tables: Partial<{ [T in RuntimeTable]: RuntimeRows[T][] }>;
  counts: Partial<Record<RuntimeTable, number>>;
  sha256: string;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const canonical = (table: RuntimeTable, row: Record<string, unknown>) => Object.fromEntries(Object.keys(runtimeRecordSchema[table].defaults).map(key => [key, row[key] ?? runtimeRecordSchema[table].defaults[key]]));
const identity = (table: RuntimeTable, row: Record<string, unknown>) => JSON.stringify(runtimeRecordSchema[table].key.map(key => row[key]));

/** Explicit offline operation: caller must stop all writers. Never called on Runtime startup. */
export async function exportRuntimeRecords(input: RuntimePersistenceInput, source: string): Promise<RuntimeTransferManifest> {
  const state = runtimePersistence(input), tables: Record<string, unknown[]> = {}, counts: Record<string, number> = {};
  for (const table of Object.keys(runtimeRecordSchema) as RuntimeTable[]) {
    const rows = new Map<string, Record<string, unknown>>();
    let cursor: string | undefined;
    do {
      const page = await state.records.scan(table, cursor, 250); cursor = page.cursor;
      for (const row of page.rows) rows.set(identity(table, row), canonical(table, row));
    } while (cursor);
    tables[table] = [...rows].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
    counts[table] = rows.size;
  }
  const body = { schema: "agentloop.runtimeTransfer/v1" as const, source, tables, counts };
  return { ...body, sha256: hash(body) } as RuntimeTransferManifest;
}

export function validateRuntimeTransfer(value: unknown): RuntimeTransferManifest {
  const manifest = value as RuntimeTransferManifest;
  if (!manifest || manifest.schema !== "agentloop.runtimeTransfer/v1") throw new Error("Unsupported Runtime transfer format");
  const { sha256, ...body } = manifest;
  if (hash(body) !== sha256) throw new Error("Runtime transfer checksum mismatch");
  for (const [table, rows] of Object.entries(manifest.tables)) {
    if (!(table in runtimeRecordSchema) || !Array.isArray(rows) || manifest.counts[table] !== rows.length) throw new Error("Runtime transfer count/table mismatch");
    const identities = new Set<string>();
    for (const row of rows) {
      const id = identity(table as RuntimeTable, row);
      if (identities.has(id)) throw new Error("Duplicate Runtime transfer identity");
      identities.add(id);
    }
  }
  return manifest;
}

/** Resumable exact import. Existing identical rows are accepted; differences or extra rows fail. */
export async function importRuntimeRecords(input: RuntimePersistenceInput, value: unknown): Promise<{ inserted: number; unchanged: number; sha256: string }> {
  const manifest = validateRuntimeTransfer(value), state = runtimePersistence(input);
  const pending: { table: RuntimeTable; row: Record<string, unknown> }[] = [];
  let inserted = 0, unchanged = 0;
  for (const table of Object.keys(runtimeRecordSchema) as RuntimeTable[]) {
    const wanted = new Map<string, Record<string, unknown>>((manifest.tables[table] ?? []).map(row => [identity(table, row), row] as const));
    let cursor: string | undefined;
    do {
      const page = await state.records.scan(table, cursor, 250); cursor = page.cursor;
      for (const row of page.rows) {
        const expected = wanted.get(identity(table, row));
        if (!expected || hash(canonical(table, row)) !== hash(canonical(table, expected))) throw new Error(`Runtime target differs: ${table}; use an empty target or the same interrupted import`);
      }
    } while (cursor);
    for (const row of wanted.values()) pending.push({ table, row });
  }
  // Resolve both table and row dependencies (including parent Runs) before inserting.
  // Cycles or dangling references fail explicitly; nothing is silently skipped.
  while (pending.length) {
    let progress = false;
    for (let index = 0; index < pending.length;) {
      const { table, row } = pending[index], definition = runtimeRecordSchema[table];
      const key = Object.fromEntries(definition.key.map(column => [column, row[column]]));
      const outcome = await state.transaction(async () => {
        const existing = (await state.records.find(table, key))[0];
        if (existing) {
          if (hash(canonical(table, existing)) !== hash(canonical(table, row))) throw new Error(`Runtime import collision: ${table}`);
          return "unchanged";
        }
        for (const fk of definition.foreignKeys) {
          if (fk.columns.some(column => row[column] === null)) continue;
          const where = Object.fromEntries(fk.columns.map((column, i) => [fk.references[i], row[column]]));
          if (!(await state.records.find(fk.table as RuntimeTable, where)).length) return "deferred";
        }
        await state.records.insert(table, row); return "inserted";
      });
      if (outcome === "deferred") { index++; continue; }
      outcome === "inserted" ? inserted++ : unchanged++;
      pending.splice(index, 1); progress = true;
    }
    if (!progress) throw new Error(`Runtime import has unresolved references: ${pending.slice(0, 10).map(item => item.table).join(",")}; preserve source and incomplete target for diagnosis`);
  }
  const actual = await exportRuntimeRecords(state, manifest.source);
  if (actual.sha256 !== manifest.sha256) throw new Error("Runtime import final count/checksum verification failed");
  return { inserted, unchanged, sha256: actual.sha256 };
}

/** Exclusive file creation avoids replacing the only backup. */
export async function writeRuntimeTransfer(path: string, manifest: RuntimeTransferManifest): Promise<void> {
  validateRuntimeTransfer(manifest);
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(manifest)); await file.sync(); } finally { await file.close(); }
}
export async function readRuntimeTransfer(path: string): Promise<RuntimeTransferManifest> {
  return validateRuntimeTransfer(JSON.parse(await readFile(path, "utf8")));
}
