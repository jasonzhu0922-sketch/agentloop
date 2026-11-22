import { randomUUID } from "node:crypto";
import { TiDbConnection, type SqlConnection } from "@zhujun/agentloop";

export class ActiveHostLeaseError extends Error {
  readonly code = "DATA_AGENT_HOST_ACTIVE";
  readonly expiresAt: number;
  constructor(expiresAt: number, now = Date.now()) {
    const seconds = Math.max(1, Math.ceil((expiresAt - now) / 1000));
    super(`该 TiDB Runtime 已有活动宿主，当前租约预计还剩 ${seconds} 秒`);
    this.name = "ActiveHostLeaseError";
    this.expiresAt = expiresAt;
  }
}

export interface HostLeaseOptions {
  onLost?: (error: Error) => void;
}

export async function connectState(url: string): Promise<SqlConnection> {
  const parsed = new URL(url);
  if (!["mysql:", "tidb:"].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname.slice(1)) throw new Error("DATA_AGENT_TIDB_URL 必须指定专用 TiDB 数据库");
  return TiDbConnection.create({ host: parsed.hostname, port: Number(parsed.port || 4000),
    user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password), database: decodeURIComponent(parsed.pathname.slice(1)),
    connectionLimit: 8, supportBigNumbers: true, bigNumberStrings: false,
    ...(parsed.searchParams.get("ssl") === "true" ? { ssl: {} } : {}),
  });
}

/** One writable host per dedicated Runtime database, including across machines. */
export async function acquireLease(database: SqlConnection, options: HostLeaseOptions = {}) {
  await database.exec(`CREATE TABLE IF NOT EXISTS data_agent_host_lease (
    id VARCHAR(64) PRIMARY KEY, owner_token VARCHAR(64) NOT NULL, expires_at BIGINT NOT NULL
  )`);
  const token = randomUUID();
  const ttl = 90_000;
  await database.prepare("INSERT IGNORE INTO data_agent_host_lease(id, owner_token, expires_at) VALUES ('host', '', 0)").run();
  let claimed = false;
  for (let attempt = 0; attempt < 2 && !claimed; attempt += 1) {
    const claim = await database.prepare(`UPDATE data_agent_host_lease
      SET owner_token = ?, expires_at = CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS UNSIGNED) + ?
      WHERE id = 'host' AND expires_at < CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS UNSIGNED)`)
      .run(token, ttl);
    claimed = Number(claim.changes) === 1;
    if (!claimed) {
      const current = await database.prepare(`SELECT expires_at,
        CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS UNSIGNED) AS db_now_ms
        FROM data_agent_host_lease WHERE id = 'host'`)
        .get<{ expires_at: number; db_now_ms: number }>();
      const expiresAt = Number(current?.expires_at ?? 0);
      const now = Number(current?.db_now_ms ?? Date.now());
      if (expiresAt > now) throw new ActiveHostLeaseError(expiresAt, now);
    }
  }
  if (!claimed) throw new Error("TiDB Runtime 宿主租约竞争失败，请稍后重试");
  let lost = false;
  const lostError = new Error("TiDB host lease lost");
  const markLost = () => {
    if (lost) return;
    lost = true;
    options.onLost?.(lostError);
  };
  const timer = setInterval(() => {
    void database.prepare(`UPDATE data_agent_host_lease
      SET expires_at = CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS UNSIGNED) + ?
      WHERE id = 'host' AND owner_token = ?
        AND expires_at > CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS UNSIGNED)`)
      .run(ttl, token).then(r => { if (Number(r.changes) !== 1) markLost(); }, markLost);
  }, 20_000);
  timer.unref();
  return {
    async assert() {
      if (lost) throw lostError;
      const row = await database.prepare(`SELECT owner_token, expires_at,
        CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS UNSIGNED) AS db_now_ms
        FROM data_agent_host_lease WHERE id = 'host' FOR UPDATE`)
        .get<{ owner_token: string; expires_at: number; db_now_ms: number }>();
      if (!row || row.owner_token !== token || Number(row.expires_at) <= Number(row.db_now_ms)) {
        markLost();
        throw lostError;
      }
    },
    async release() {
      clearInterval(timer);
      await database.prepare("UPDATE data_agent_host_lease SET expires_at = 0 WHERE id = 'host' AND owner_token = ?").run(token);
    },
  };
}
