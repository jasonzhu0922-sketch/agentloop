import { TiDbConnection } from './tidb-connection.ts';
import { PersistenceRuntimeHistoryReader, RuntimeHistoryWorker, SqlRuntimeHistoryStore, type RuntimeHistoryReader, type RuntimeHistoryStore } from './runtime-history.ts';
import type { RuntimePersistence } from './runtime-records.ts';
import type { RuntimeArchiveStore } from './runtime-record-maintenance.ts';

export interface RuntimeHistoryConfig {
  url: string; connectionLimit?: number; timeoutMs?: number; batchSize?: number; intervalMs?: number; retryBaseMs?: number; retryMaxMs?: number;
}
/** A dedicated, bounded pool. Timed-out clients are destroyed before reuse; no orphan SQL commit can be acknowledged. */
export async function connectRuntimeHistory(config: RuntimeHistoryConfig) {
  const parsed = new URL(config.url), timeout = config.timeoutMs ?? 3000, limit = config.connectionLimit ?? 2;
  if (!['mysql:', 'tidb:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname.slice(1)) throw new TypeError('History requires a dedicated TiDB database URL');
  if (!Number.isSafeInteger(timeout) || timeout < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16) throw new TypeError('Invalid history connection limits');
  const mysql = await import('mysql2/promise');
  const pool = mysql.createPool({ host: parsed.hostname, port: Number(parsed.port || 4000), user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password), database: decodeURIComponent(parsed.pathname.slice(1)),
    connectTimeout: timeout, connectionLimit: limit, waitForConnections: false, supportBigNumbers: true, bigNumberStrings: false,
    ...(parsed.searchParams.get('ssl') === 'true' ? { ssl: {} } : {}) });
  const bounded = async (operation: Promise<any>, expire: () => void) => {
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([operation, new Promise((_,reject) => { timer = setTimeout(() => { expire(); reject(new Error(`History SQL timeout after ${timeout} ms`)); }, timeout); })]); }
    finally { clearTimeout(timer!); }
  };
  return TiDbConnection.fromPool({
    async getConnection() {
      let expired = false;
      const client = await bounded(pool.getConnection().then(client => { if (expired) { client.destroy(); throw new Error('History connection acquisition timed out'); } return client; }), () => { expired = true; });
      const query = (sql: string, values?: readonly unknown[]) => bounded(client.query(sql, values), () => client.destroy());
      return { query, execute: query, release: () => client.release() };
    },
    query: async (sql, values) => pool.query(sql, values as any), end: () => pool.end(),
  });
}

/** Host assembly chooses storage once. RunService never selects a backend or waits on this worker. */
export function createRuntimeHistory(options: { state: RuntimePersistence; namespace: string; config?: RuntimeHistoryConfig; store?: RuntimeHistoryStore; content?: RuntimeArchiveStore; onError?: (error: Error) => void }): {
  reader: RuntimeHistoryReader; worker?: RuntimeHistoryWorker; close(): Promise<void>;
} {
  if (!options.state.historyOutbox) return { reader: new PersistenceRuntimeHistoryReader(options.state), close: async () => {} };
  if (!options.store && !options.config) throw new Error('Redis Runtime requires history TiDB configuration');
  // Reader and writer have independent pools; an expensive history read cannot consume worker capacity.
  const writer = options.store ?? new SqlRuntimeHistoryStore({ namespace: options.namespace, connect: () => connectRuntimeHistory(options.config!), content: options.content });
  const reader = options.store ?? new SqlRuntimeHistoryStore({ namespace: options.namespace, connect: () => connectRuntimeHistory(options.config!), content: options.content });
  const worker = new RuntimeHistoryWorker({ outbox: options.state.historyOutbox, state: options.state, sink: writer, namespace: options.namespace, ...options.config, onError: options.onError });
  return { reader, worker, close: async () => { await worker.close(); if (reader !== writer) await reader.close?.(); } };
}
