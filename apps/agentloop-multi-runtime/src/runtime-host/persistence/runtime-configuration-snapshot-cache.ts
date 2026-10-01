import { createHash } from "node:crypto";
import type { SqlConnection } from "@zhujun/agentloop";
import type { RuntimeConfigurationSnapshot, RuntimeTarget } from "../../../control-plane/contracts/index.ts";
import { parseRuntimeConfigurationSnapshot } from "../application/configuration/runtime-configuration-client.ts";
import type { LoadedRuntimeConfigurationSnapshotCache } from "../application/configuration/run-environment-resolver.ts";

/** Host-owned cache: only loaded public manifests are durable; no delivery token or secret value is stored. */
export class SqlRuntimeConfigurationSnapshotCache implements LoadedRuntimeConfigurationSnapshotCache {
  private readonly database: SqlConnection;
  public constructor(database: SqlConnection) { this.database = database; }

  public async get(target: RuntimeTarget): Promise<RuntimeConfigurationSnapshot | undefined> {
    const row = this.database.dialect === "tidb"
      ? await this.database.prepare(`SELECT snapshot_json FROM mr_runtime_configuration_snapshots WHERE target_key = ?`).get<{ snapshot_json: string }>(targetKey(target))
      : await this.database.prepare(`SELECT snapshot_json FROM mr_runtime_configuration_snapshots WHERE target_plane = ? AND scope_id = ? AND runtime_id = ? AND runtime_class = ? AND device_id = ?`).get<{ snapshot_json: string }>(target.plane, target.scopeId, target.runtimeId, target.runtimeClass ?? "", target.deviceId ?? "");
    if (row === undefined) return undefined;
    try { return parseRuntimeConfigurationSnapshot(JSON.parse(row.snapshot_json)); } catch { throw new Error("Persisted Runtime configuration snapshot is invalid"); }
  }

  public async getBySnapshotId(target: RuntimeTarget, snapshotId: string): Promise<RuntimeConfigurationSnapshot | undefined> {
    const row = await this.database.prepare(`SELECT snapshot_json FROM mr_runtime_configuration_snapshot_history WHERE snapshot_id = ? AND target_plane = ? AND scope_id = ? AND runtime_id = ? AND runtime_class = ? AND device_id = ?`).get<{ snapshot_json: string }>(snapshotId, target.plane, target.scopeId, target.runtimeId, target.runtimeClass ?? "", target.deviceId ?? "");
    if (row === undefined) return undefined;
    try { return parseRuntimeConfigurationSnapshot(JSON.parse(row.snapshot_json)); } catch { throw new Error("Persisted Runtime configuration snapshot history is invalid"); }
  }

  public async put(snapshot: RuntimeConfigurationSnapshot): Promise<void> {
    const target = snapshot.target;
    await this.putHistory(snapshot);
    const sql = this.database.dialect === "tidb"
      ? `INSERT INTO mr_runtime_configuration_snapshots(target_key, target_plane, scope_id, runtime_id, runtime_class, device_id, snapshot_id, valid_until, snapshot_json, loaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE snapshot_id = VALUES(snapshot_id), valid_until = VALUES(valid_until), snapshot_json = VALUES(snapshot_json), loaded_at = VALUES(loaded_at)`
      : `INSERT INTO mr_runtime_configuration_snapshots(target_plane, scope_id, runtime_id, runtime_class, device_id, snapshot_id, valid_until, snapshot_json, loaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(target_plane, scope_id, runtime_id, runtime_class, device_id) DO UPDATE SET snapshot_id = excluded.snapshot_id, valid_until = excluded.valid_until, snapshot_json = excluded.snapshot_json, loaded_at = excluded.loaded_at`;
    await this.database.prepare(sql).run(
      ...(this.database.dialect === "tidb" ? [targetKey(target)] : []),
      target.plane, target.scopeId, target.runtimeId, target.runtimeClass ?? "", target.deviceId ?? "", snapshot.snapshotId, snapshot.validUntil, JSON.stringify(snapshot), Date.now(),
    );
  }

  private async putHistory(snapshot: RuntimeConfigurationSnapshot): Promise<void> {
    const existing = await this.database.prepare(`SELECT snapshot_json FROM mr_runtime_configuration_snapshot_history WHERE snapshot_id = ?`).get<{ snapshot_json: string }>(snapshot.snapshotId);
    const serialized = JSON.stringify(snapshot);
    if (existing !== undefined) {
      if (existing.snapshot_json !== serialized) throw new Error("Runtime configuration snapshot history is immutable");
      return;
    }
    const target = snapshot.target;
    await this.database.prepare(`INSERT INTO mr_runtime_configuration_snapshot_history(snapshot_id, target_plane, scope_id, runtime_id, runtime_class, device_id, valid_until, snapshot_json, loaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(snapshot.snapshotId, target.plane, target.scopeId, target.runtimeId, target.runtimeClass ?? "", target.deviceId ?? "", snapshot.validUntil, serialized, Date.now());
  }
}

export async function installRuntimeConfigurationSnapshotCache(database: SqlConnection): Promise<void> {
  const text = database.dialect === "tidb" ? "VARCHAR(191)" : "TEXT";
  const json = database.dialect === "tidb" ? "LONGTEXT" : "TEXT";
  const epoch = database.dialect === "sqlite" ? "INTEGER" : "BIGINT";
  await database.exec(database.dialect === "tidb"
    ? `CREATE TABLE IF NOT EXISTS mr_runtime_configuration_snapshots (
    target_key CHAR(64) NOT NULL, target_plane ${text} NOT NULL, scope_id ${text} NOT NULL, runtime_id ${text} NOT NULL, runtime_class ${text} NOT NULL DEFAULT '', device_id ${text} NOT NULL DEFAULT '',
    snapshot_id ${text} NOT NULL, valid_until ${epoch} NOT NULL, snapshot_json ${json} NOT NULL, loaded_at ${epoch} NOT NULL,
    PRIMARY KEY(target_key)
  )`
    : `CREATE TABLE IF NOT EXISTS mr_runtime_configuration_snapshots (
    target_plane ${text} NOT NULL, scope_id ${text} NOT NULL, runtime_id ${text} NOT NULL, runtime_class ${text} NOT NULL DEFAULT '', device_id ${text} NOT NULL DEFAULT '',
    snapshot_id ${text} NOT NULL, valid_until ${epoch} NOT NULL, snapshot_json ${json} NOT NULL, loaded_at ${epoch} NOT NULL,
    PRIMARY KEY(target_plane, scope_id, runtime_id, runtime_class, device_id)
  )`);
}

function targetKey(target: RuntimeTarget): string {
  return createHash("sha256").update(JSON.stringify([
    target.plane, target.scopeId, target.runtimeId, target.runtimeClass ?? "", target.deviceId ?? "",
  ])).digest("hex");
}

/** Append-only public-manifest history used to reconstruct existing Run environments. */
export async function installRuntimeConfigurationSnapshotHistory(database: SqlConnection): Promise<void> {
  const text = database.dialect === "tidb" ? "VARCHAR(191)" : "TEXT";
  const json = database.dialect === "tidb" ? "LONGTEXT" : "TEXT";
  const epoch = database.dialect === "sqlite" ? "INTEGER" : "BIGINT";
  await database.exec(`CREATE TABLE IF NOT EXISTS mr_runtime_configuration_snapshot_history (
    snapshot_id ${text} PRIMARY KEY,
    target_plane ${text} NOT NULL, scope_id ${text} NOT NULL, runtime_id ${text} NOT NULL, runtime_class ${text} NOT NULL DEFAULT '', device_id ${text} NOT NULL DEFAULT '',
    valid_until ${epoch} NOT NULL, snapshot_json ${json} NOT NULL, loaded_at ${epoch} NOT NULL
  )`);
  const columns = "snapshot_id, target_plane, scope_id, runtime_id, runtime_class, device_id, valid_until, snapshot_json, loaded_at";
  const current = "mr_runtime_configuration_snapshots";
  const history = "mr_runtime_configuration_snapshot_history";
  const copy = database.dialect === "tidb"
    ? `INSERT IGNORE INTO ${history}(${columns}) SELECT ${columns} FROM ${current}`
    : database.dialect === "postgres"
      ? `INSERT INTO ${history}(${columns}) SELECT ${columns} FROM ${current} ON CONFLICT(snapshot_id) DO NOTHING`
      : `INSERT OR IGNORE INTO ${history}(${columns}) SELECT ${columns} FROM ${current}`;
  await database.exec(copy);
}
