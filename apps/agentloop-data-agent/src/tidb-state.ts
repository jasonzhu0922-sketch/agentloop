import { randomUUID } from "node:crypto";
import { TiDbConnection, type SqlConnection } from "@zhujun/agentloop";

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
export async function acquireLease(database: SqlConnection) {
  await database.exec(`CREATE TABLE IF NOT EXISTS data_agent_host_lease (
    id VARCHAR(64) PRIMARY KEY, owner_token VARCHAR(64) NOT NULL, expires_at BIGINT NOT NULL
  )`);
  const token = randomUUID();
  const ttl = 90_000;
  await database.prepare("INSERT IGNORE INTO data_agent_host_lease(id, owner_token, expires_at) VALUES ('host', '', 0)").run();
  const claim = await database.prepare("UPDATE data_agent_host_lease SET owner_token = ?, expires_at = ? WHERE id = 'host' AND expires_at < ?")
    .run(token, Date.now() + ttl, Date.now());
  if (Number(claim.changes) !== 1) throw new Error("该 TiDB Runtime 已有活动宿主");
  let lost = false;
  const timer = setInterval(() => {
    void database.prepare("UPDATE data_agent_host_lease SET expires_at = ? WHERE id = 'host' AND owner_token = ? AND expires_at > ?")
      .run(Date.now() + ttl, token, Date.now()).then(r => { if (Number(r.changes) !== 1) lost = true; }, () => { lost = true; });
  }, 20_000);
  timer.unref();
  return {
    async assert() {
      if (lost) throw new Error("TiDB host lease lost");
      const row = await database.prepare("SELECT owner_token, expires_at FROM data_agent_host_lease WHERE id = 'host' FOR UPDATE")
        .get<{ owner_token: string; expires_at: number }>();
      if (!row || row.owner_token !== token || Number(row.expires_at) <= Date.now()) throw new Error("TiDB host lease lost");
    },
    async release() {
      clearInterval(timer);
      await database.prepare("UPDATE data_agent_host_lease SET expires_at = 0 WHERE id = 'host' AND owner_token = ?").run(token);
    },
  };
}
