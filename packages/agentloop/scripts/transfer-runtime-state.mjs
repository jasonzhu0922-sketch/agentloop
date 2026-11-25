#!/usr/bin/env node
// Explicit offline tool; never invoked by application startup. Config files are mode 0600.
import { readFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync, backup } from 'node:sqlite';
import { AppDatabase, openRuntimeState, exportRuntimeRecords, importRuntimeRecords, writeRuntimeTransfer,
  readRuntimeTransfer, RedisRuntimeRecords, RuntimeRedisClient, RedisRuntimeStateStore, RuntimeStateConnection, TiDbConnection, FileRuntimeArchiveStore, restoreRuntimeArchives } from '../dist/index.js';

const [operation, configPath, transferPath, acknowledgement] = process.argv.slice(2);
if (!['export', 'import', 'initialize-empty', 'restore-archive'].includes(operation) || !configPath || !transferPath || acknowledgement !== '--writers-stopped')
  throw new Error('Usage: node transfer-runtime-state.mjs export|import|initialize-empty|restore-archive config.json backup.json --writers-stopped');
const config = JSON.parse(await readFile(configPath, 'utf8'));
let state, sourceConnection, directory;
try {
  if (operation === 'restore-archive') {
    state = await openRuntimeState(config);
    const references = JSON.parse(await readFile(transferPath, 'utf8'));
    console.log(JSON.stringify(await restoreRuntimeArchives(state, new FileRuntimeArchiveStore(config.archiveRoot), references)));
  } else if (operation === 'export') {
    if (config.backend === 'legacy-redis' || config.backend === 'tidb') {
      if (!Object.hasOwn(config, 'legacyEventOutbox')) throw new Error('Legacy export requires legacyEventOutbox: null (confirmed absent) or {url,prefix}; pending events must be drained before migration');
      if (config.legacyEventOutbox !== null) {
        const outbox = config.legacyEventOutbox;
        if (!outbox?.url || !outbox?.prefix) throw new Error('Invalid legacyEventOutbox configuration');
        const client = new RuntimeRedisClient(outbox.url);
        try {
          const pending = Number(await client.sendCommand(['XLEN', `${outbox.prefix}:pending`]));
          const batches = Number(await client.sendCommand(['HLEN', `${outbox.prefix}:batches`]));
          if (pending || batches) throw new Error(`Legacy outbox is not drained: ${pending} events, ${batches} batches; restart the old projector and verify sequence continuity before export`);
        } finally { await client.close(); }
      }
      if (config.backend === 'tidb') {
        const sql = await TiDbConnection.create(config.url);
        sourceConnection = { dialect: sql.dialect, exec: async () => { throw new Error('Migration source is read only'); },
          prepare: statement => {
            if (!/^SELECT\s/i.test(statement)) throw new Error('Migration source accepts SELECT only');
            const query = sql.prepare(statement); return { ...query, run: async () => { throw new Error('Migration source is read only'); } };
          }, transaction: operation => operation(), close: () => sql.close() };
      } else {
      // Historical commits can contain a complete snapshot. Fetch one at a time:
      // the live journal's 100-entry page can exceed hundreds of MiB during export.
      const store = new RedisRuntimeStateStore(new RuntimeRedisClient(config.url, 60000), { prefix: config.namespace });
      // Replay exists only in this explicit migration path. Any attempted source write fails.
      sourceConnection = await RuntimeStateConnection.open({ open: () => store.open(), read: (v, n) => store.read(v, Math.min(n, 1)),
        receipt: id => store.receipt(id), append: async () => { throw new Error('Migration source is read only'); }, close: () => store.close() });
      }
      // Export legacy tables to a disposable disk staging file; never change the Redis log.
      directory = await mkdtemp(join(tmpdir(), 'agentloop-state-export-'));
      const target = new AppDatabase(join(directory, 'stage.sqlite')); await target.ready();
      const tables = await sourceConnection.prepare(config.backend === 'tidb' ?
        "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()" :
        "SELECT name FROM sqlite_master WHERE type='table'").all();
      const names = new Set(tables.map(row => row.name));
      const { runtimeRecordSchema } = await import('../dist/storage/runtime-record-schema.js');
      await target.exec('PRAGMA foreign_keys=OFF');
      for (const table of Object.keys(runtimeRecordSchema)) {
        if (!names.has(table)) continue;
        const columns = Object.keys(runtimeRecordSchema[table].defaults);
        for (const row of await sourceConnection.prepare(`SELECT * FROM ${table}`).all()) {
          const present = columns.filter(column => column in row);
          await target.prepare(`INSERT INTO ${table}(${present.join(',')}) VALUES(${present.map(() => '?').join(',')})`).run(...present.map(column => row[column]));
        }
      }
      if (config.legacyEventOutbox !== null) {
        const outbox = config.legacyEventOutbox, client = new RuntimeRedisClient(outbox.url);
        try {
          const counters = await client.sendCommand(['HGETALL', `${outbox.prefix}:sequences`]);
          for (let index = 0; index < counters.length; index += 2) {
            const projected = await target.prepare('SELECT MAX(seq) AS seq FROM run_events WHERE run_id=?').get(counters[index]);
            if (Number(counters[index + 1]) !== Number(projected?.seq ?? 0)) throw new Error('Legacy outbox sequence does not match projected events; export stopped without changing the source');
          }
        } finally { await client.close(); }
      }
      // Application admission and dispatch ledgers are execution records too.
      for (const [oldTable, scope] of [['data_agent_requests', 'data-agent'], ['report_agent_requests', 'report-agent']]) {
        if (!names.has(oldTable)) continue;
        for (const row of await sourceConnection.prepare(`SELECT request_id,fingerprint,run_id FROM ${oldTable}`).all())
          await target.prepare('INSERT INTO runtime_requests(scope,request_id,fingerprint,run_id) VALUES(?,?,?,?)').run(scope, row.request_id, row.fingerprint, row.run_id);
      }
      if (names.has('data_agent_mcp_calls')) for (const row of await sourceConnection.prepare('SELECT id,scenario_id,started_at,payload_json FROM data_agent_mcp_calls').all())
        await target.prepare('INSERT INTO runtime_observations(scope,id,category,created_at,payload_json) VALUES(?,?,?,?,?)').run('data-agent', row.id, row.scenario_id, row.started_at, row.payload_json);
      for (const [oldTable, newTable] of [['mr_host_dispatches', 'runtime_dispatches'], ['mr_run_executors', 'runtime_executors']]) {
        if (!names.has(oldTable)) continue;
        const columns = Object.keys(runtimeRecordSchema[newTable].defaults);
        for (const row of await sourceConnection.prepare(`SELECT * FROM ${oldTable}`).all())
          await target.prepare(`INSERT INTO ${newTable}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(column => row[column]));
      }
      // Confirmed dangling rows can be omitted only by an explicit primary-key list with a reason.
      const skipped = [];
      for (const item of config.confirmedOrphans ?? []) {
        if (!runtimeRecordSchema[item.table] || typeof item.reason !== 'string' || !item.reason.trim()) throw new Error('Confirmed orphan needs a known table, primary key and reason');
        const keys = runtimeRecordSchema[item.table].key;
        if (Object.keys(item.key ?? {}).length !== keys.length || keys.some(key => !(key in item.key))) throw new Error('Confirmed orphan must identify its exact primary key');
        const result = await target.prepare(`DELETE FROM ${item.table} WHERE ${keys.map(key => key+'=?').join(' AND ')}`).run(...keys.map(key => item.key[key]));
        skipped.push({ table: item.table, reason: item.reason, count: Number(result.changes) });
      }
      if (skipped.length) console.log(JSON.stringify({ confirmedOrphans: skipped }));
      const violations = await target.prepare('PRAGMA foreign_key_check').all();
      if (violations.length) throw new Error(`Legacy source has ${violations.length} dangling references; staging retained for explicit review: ${directory}`);
      await target.exec('PRAGMA foreign_keys=ON'); state = target;
    } else if (config.backend === 'sqlite') {
      // Snapshot with SQLite backup API includes WAL data; original DB is read-only.
      directory = await mkdtemp(join(tmpdir(), 'agentloop-state-export-'));
      const original = new DatabaseSync(config.filename, { readOnly: true });
      try { await backup(original, join(directory, 'stage.sqlite')); } finally { original.close(); }
      state = new AppDatabase(join(directory, 'stage.sqlite')); await state.ready();
    } else state = await openRuntimeState(config);
    const manifest = await exportRuntimeRecords(state, config.sourceLabel ?? config.backend);
    await writeRuntimeTransfer(transferPath, manifest);
    console.log(JSON.stringify({ operation, sha256: manifest.sha256, counts: manifest.counts, staging: directory }));
  } else {
    let manifest;
    if (operation === 'initialize-empty') {
      // Explicit operator choice to start without old execution history. Source
      // logs remain untouched and the empty target is verified before activation.
      directory = await mkdtemp(join(tmpdir(), 'agentloop-state-empty-'));
      const empty = new AppDatabase(join(directory, 'empty.sqlite'));
      try { await empty.ready(); manifest = await exportRuntimeRecords(empty, 'explicit-empty-start/legacy-history-discarded'); }
      finally { await empty.close(); }
      await writeRuntimeTransfer(transferPath, manifest);
    } else manifest = await readRuntimeTransfer(transferPath);
    const legacyVersion = config.legacyVersion ?? 0;
    state = config.backend === 'redis' ? await RedisRuntimeRecords.open(new RuntimeRedisClient(config.url), {
      prefix: config.namespace, offlineImport: { checksum: manifest.sha256, legacyVersion }, maxCommandBytes: config.maxCommandBytes,
    }) : await openRuntimeState(config);
    const result = await importRuntimeRecords(state, manifest);
    if (state instanceof RedisRuntimeRecords) await state.completeOfflineImport(manifest.sha256, legacyVersion);
    console.log(JSON.stringify({ operation, ...result }));
  }
} finally { await state?.close(); await sourceConnection?.close(); }
