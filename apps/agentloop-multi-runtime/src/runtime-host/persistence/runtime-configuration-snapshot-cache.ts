import type { SqlConnection } from "@zhujun/agentloop";
import type { RuntimeConfigurationSnapshot, RuntimeTarget } from "../../../control-plane/contracts/index.ts";
import { parseRuntimeConfigurationSnapshot } from "../application/configuration/runtime-configuration-client.ts";
import type { LoadedRuntimeConfigurationSnapshotCache } from "../application/configuration/run-environment-resolver.ts";

/** Host-owned cache: only loaded public manifests are durable; no delivery token or secret value is stored. */
export class SqlRuntimeConfigurationSnapshotCache implements LoadedRuntimeConfigurationSnapshotCache {
  public constructor(private readonly database: SqlConnection) {}

  public async get(target: RuntimeTarget): Promise<RuntimeConfigurationSnapshot | undefined> {
    const row = await this.database.prepare(`SELECT snapshot_json FROM mr_runtime_configuration_snapshots WHERE target_plane = ? AND tenant_id = ? AND runtime_id = ? AND runtime_class = ? AND device_id = ?`).get<{ snapshot_json: string }>(target.plane, target.tenantId, target.runtimeId, target.runtimeClass ?? "", target.deviceId ?? "");
    if (row === undefined) return undefined;
    try { return parseRuntimeConfigurationSnapshot(JSON.parse(row.snapshot_json)); } catch { throw new Error("Persisted Runtime configuration snapshot is invalid"); }
  }

  public async put(snapshot: RuntimeConfigurationSnapshot): Promise<void> {
    const target = snapshot.target;
    const sql = this.database.dialect === "tidb"
      ? `INSERT INTO mr_runtime_configuration_snapshots(target_plane, tenant_id, runtime_id, runtime_class, device_id, snapshot_id, valid_until, snapshot_json, loaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE snapshot_id = VALUES(snapshot_id), valid_until = VALUES(valid_until), snapshot_json = VALUES(snapshot_json), loaded_at = VALUES(loaded_at)`
      : `INSERT INTO mr_runtime_configuration_snapshots(target_plane, tenant_id, runtime_id, runtime_class, device_id, snapshot_id, valid_until, snapshot_json, loaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(target_plane, tenant_id, runtime_id, runtime_class, device_id) DO UPDATE SET snapshot_id = excluded.snapshot_id, valid_until = excluded.valid_until, snapshot_json = excluded.snapshot_json, loaded_at = excluded.loaded_at`;
    await this.database.prepare(sql).run(target.plane, target.tenantId, target.runtimeId, target.runtimeClass ?? "", target.deviceId ?? "", snapshot.snapshotId, snapshot.validUntil, JSON.stringify(snapshot), Date.now());
  }
}

export async function installRuntimeConfigurationSnapshotCache(database: SqlConnection): Promise<void> {
  const text = database.dialect === "tidb" ? "VARCHAR(191)" : "TEXT";
  const json = database.dialect === "tidb" ? "LONGTEXT" : "TEXT";
  const epoch = database.dialect === "sqlite" ? "INTEGER" : "BIGINT";
  await database.exec(`CREATE TABLE IF NOT EXISTS mr_runtime_configuration_snapshots (
    target_plane ${text} NOT NULL, tenant_id ${text} NOT NULL, runtime_id ${text} NOT NULL, runtime_class ${text} NOT NULL DEFAULT '', device_id ${text} NOT NULL DEFAULT '',
    snapshot_id ${text} NOT NULL, valid_until ${epoch} NOT NULL, snapshot_json ${json} NOT NULL, loaded_at ${epoch} NOT NULL,
    PRIMARY KEY(target_plane, tenant_id, runtime_id, runtime_class, device_id)
  )`);
}
