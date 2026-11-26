import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { SqliteConnection, type RuntimeStateConfig } from "@zhujun/agentloop";
import type { AgentOptions } from "./agent.ts";

export type RuntimeStorageConfig = RuntimeStateConfig;

/** Select execution state only. Business Skill database settings are independent. */
export function resolveRuntimeStorageConfig(appRoot: string, fileDirectory: string, env: NodeJS.ProcessEnv = process.env): RuntimeStorageConfig {
  const backend = env.DATA_AGENT_STATE_BACKEND ?? "redis";
  if (backend === "sqlite") {
    const filename = env.DATA_AGENT_SQLITE_FILE ?? join(fileDirectory, "runtime.sqlite");
    if (!filename.trim() || filename.includes("\0") || filename === ":memory:") throw new Error("DATA_AGENT_SQLITE_FILE 必须指定持久 SQLite 文件");
    return { backend, filename: resolve(appRoot, filename) };
  }
  if (backend !== "redis") throw new Error("DATA_AGENT_STATE_BACKEND 必须为 sqlite 或 redis");
  if (env.DATA_AGENT_REDIS_IMPORT_LEGACY && env.DATA_AGENT_REDIS_IMPORT_LEGACY !== "false") throw new Error("Legacy import requires explicit offline migration / 离线迁移");
  if (env.DATA_AGENT_REDIS_MAX_STATE_BYTES) throw new Error("DATA_AGENT_REDIS_MAX_STATE_BYTES belongs to the legacy changeset store; configure Redis capacity and DATA_AGENT_REDIS_MAX_COMMAND_BYTES");
  const url = env.DATA_AGENT_REDIS_URL ?? "redis://127.0.0.1:6379";
  try { const parsed = new URL(url); if (!["redis:", "rediss:"].includes(parsed.protocol) || !parsed.hostname) throw new Error(); }
  catch { throw new Error("DATA_AGENT_REDIS_URL 必须为有效的 Redis URL"); }
  // Preserve the existing changeset namespace. Native records occupy a separate versioned key space beneath it.
  const namespace = env.DATA_AGENT_REDIS_STATE_PREFIX ?? `data-agent:{state-${createHash("sha256").update(fileDirectory).digest("hex").slice(0, 16)}}`;
  if (!/^[A-Za-z0-9:{}_-]{1,180}$/.test(namespace)) throw new Error("DATA_AGENT_REDIS_STATE_PREFIX 无效");
  const maxCommandBytes = Number(env.DATA_AGENT_REDIS_MAX_COMMAND_BYTES ?? 4 * 1024 * 1024);
  if (!Number.isSafeInteger(maxCommandBytes) || maxCommandBytes < 1024) throw new Error("DATA_AGENT_REDIS_MAX_COMMAND_BYTES 无效");
  return { backend, url, namespace, maxCommandBytes };
}

/** Startup never imports legacy data or connects a Runtime TiDB pool. */
export async function openConfiguredRuntimeStorage(config: RuntimeStorageConfig, fileDirectory: string): Promise<
  Pick<AgentOptions, "connection" | "stateConfig" | "runtimeHistoryConfig"> & { stateUrl?: string }
> {
  const filename = join(fileDirectory, "catalogue.sqlite");
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  if (config.backend === "sqlite") await mkdir(dirname(config.filename), { recursive: true, mode: 0o700 });
  const historyUrl = process.env.DATA_AGENT_HISTORY_TIDB_URL ?? process.env.DATA_AGENT_RUNTIME_SUMMARY_TIDB_URL ?? process.env.DATA_AGENT_TIDB_URL;
  if (config.backend === "redis" && !historyUrl) throw new Error("Redis Runtime 必须配置 DATA_AGENT_HISTORY_TIDB_URL（兼容 DATA_AGENT_TIDB_URL）");
  const number = (key: string, fallback: number) => { const value = Number(process.env[key] ?? fallback); if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} 无效`); return value; };
  return { connection: new SqliteConnection(filename), stateConfig: config,
    ...(config.backend === "redis" && historyUrl ? { runtimeHistoryConfig: { url: historyUrl,
      connectionLimit: number("DATA_AGENT_HISTORY_CONNECTION_LIMIT", 2), timeoutMs: number("DATA_AGENT_HISTORY_TIMEOUT_MS", 3000),
      batchSize: number("DATA_AGENT_HISTORY_BATCH_SIZE", 100), intervalMs: number("DATA_AGENT_HISTORY_INTERVAL_MS", 1000),
      retryBaseMs: number("DATA_AGENT_HISTORY_RETRY_BASE_MS", 1000), retryMaxMs: number("DATA_AGENT_HISTORY_RETRY_MAX_MS", 60000) } } : {}) };
}
