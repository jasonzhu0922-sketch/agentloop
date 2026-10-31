import { randomUUID } from "node:crypto";
import type {
  ConnectorConnection,
  CredentialProvider,
} from "@zhujun/agentloop-connector-sdk";
import type {
  ConnectorConnectionRuntime,
  ConnectionResolver,
} from "../../../src/connectors/connection-resolver.ts";
import type {
  ConnectorModuleRegistration,
} from "../../../src/connectors/connector-module-loader.ts";

export interface LocalConnectorConfiguration {
  readonly id: string;
  readonly runtimeId: string;
  readonly connectorKey: string;
  readonly displayName: string;
  readonly modulePath: string;
  readonly exportName?: string;
  readonly enabled: boolean;
  readonly config: Readonly<Record<string, unknown>>;
  readonly credentialConfigured: boolean;
  readonly updatedAt: number;
}

export interface LocalConnectorConfigurationInput {
  readonly id?: string;
  readonly connectorKey: string;
  readonly displayName: string;
  readonly modulePath: string;
  readonly exportName?: string;
  readonly enabled?: boolean;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly externalAccountId?: string;
  readonly scopes?: readonly string[];
  readonly credentials?: Readonly<Record<string, string>>;
}

interface ConnectorRow {
  connector_id: string;
  runtime_id: string;
  connector_key: string;
  display_name: string;
  module_path: string;
  export_name: string | null;
  config_json: string;
  connection_json: string;
  secret_storage_key: string | null;
  enabled: number;
  updated_at: number;
}

export interface LocalConnectorRuntimeResolution {
  readonly modules: readonly ConnectorModuleRegistration[];
  readonly connections: readonly ConnectorConnection[];
  readonly runtime: ConnectorConnectionRuntime;
}

export class LocalConnectorConfigurationStore {
  constructor(
    private readonly database: { exec(sql: string): Promise<void>; prepare(sql: string): any },
    private readonly secretStore: {
      write(values: Readonly<Record<string, string>>): Promise<string>;
      read(key: string): Promise<Readonly<Record<string, string>> | undefined>;
      remove(key: string): Promise<void>;
    },
  ) {}

  async ready(): Promise<void> {
    await this.database.exec(`
      CREATE TABLE IF NOT EXISTS local_runtime_connectors (
        connector_id TEXT PRIMARY KEY,
        runtime_id TEXT NOT NULL,
        connector_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        module_path TEXT NOT NULL,
        export_name TEXT,
        config_json TEXT NOT NULL,
        connection_json TEXT NOT NULL,
        secret_storage_key TEXT,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(runtime_id, connector_key)
      );
    `);
  }

  async list(runtimeId: string): Promise<readonly LocalConnectorConfiguration[]> {
    const rows = await this.rows(runtimeId);
    return Promise.all(rows.map((row) => this.toPublic(row)));
  }

  async get(runtimeId: string, connectorId: string): Promise<LocalConnectorConfiguration> {
    const row = await this.database.prepare(`
      SELECT connector_id, runtime_id, connector_key, display_name, module_path,
             export_name, config_json, connection_json, secret_storage_key,
             enabled, updated_at
      FROM local_runtime_connectors
      WHERE runtime_id = ? AND connector_id = ?
    `).get(runtimeId, connectorId) as ConnectorRow | undefined;
    if (row === undefined) throw new Error("local_connector_not_found");
    return this.toPublic(row);
  }

  async upsert(runtimeId: string, input: LocalConnectorConfigurationInput): Promise<LocalConnectorConfiguration> {
    const now = Date.now();
    const connectorId = input.id ?? `local_connector_${randomUUID()}`;
    const existing = await this.database.prepare(`
      SELECT connector_id, runtime_id, connector_key, display_name, module_path,
             export_name, config_json, connection_json, secret_storage_key,
             enabled, updated_at
      FROM local_runtime_connectors
      WHERE runtime_id = ? AND connector_id = ?
    `).get(runtimeId, connectorId) as ConnectorRow | undefined;
    const secretStorageKey = input.credentials === undefined
      ? existing?.secret_storage_key ?? null
      : await this.secretStore.write(input.credentials);
    const connection = {
      id: `local_connection_${connectorId}`,
      connectorKey: input.connectorKey,
      ownerType: "user" as const,
      ownerId: runtimeId,
      ...(input.externalAccountId === undefined ? {} : { externalAccountId: input.externalAccountId }),
      scopes: [...(input.scopes ?? [])],
      credentialRef: secretStorageKey ?? `local_connector_missing_${connectorId}`,
      status: "active" as const,
    };
    await this.database.prepare(`
      INSERT INTO local_runtime_connectors(
        connector_id, runtime_id, connector_key, display_name, module_path,
        export_name, config_json, connection_json, secret_storage_key,
        enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connector_id) DO UPDATE SET
        connector_key = excluded.connector_key,
        display_name = excluded.display_name,
        module_path = excluded.module_path,
        export_name = excluded.export_name,
        config_json = excluded.config_json,
        connection_json = excluded.connection_json,
        secret_storage_key = excluded.secret_storage_key,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(
      connectorId,
      runtimeId,
      input.connectorKey,
      input.displayName.trim(),
      input.modulePath,
      input.exportName ?? null,
      JSON.stringify(input.config ?? {}),
      JSON.stringify(connection),
      secretStorageKey,
      input.enabled === false ? 0 : 1,
      existing?.updated_at ?? now,
      now,
    );
    if (existing?.secret_storage_key !== null && existing?.secret_storage_key !== undefined && existing.secret_storage_key !== secretStorageKey) {
      await this.secretStore.remove(existing.secret_storage_key).catch(() => undefined);
    }
    return this.get(runtimeId, connectorId);
  }

  async remove(runtimeId: string, connectorId: string): Promise<void> {
    const row = await this.database.prepare(`
      SELECT secret_storage_key FROM local_runtime_connectors
      WHERE runtime_id = ? AND connector_id = ?
    `).get(runtimeId, connectorId) as { secret_storage_key: string | null } | undefined;
    if (row === undefined) throw new Error("local_connector_not_found");
    await this.database.prepare(`
      DELETE FROM local_runtime_connectors WHERE runtime_id = ? AND connector_id = ?
    `).run(runtimeId, connectorId);
    if (row.secret_storage_key !== null) await this.secretStore.remove(row.secret_storage_key).catch(() => undefined);
  }

  async resolve(runtimeId: string): Promise<LocalConnectorRuntimeResolution> {
    const rows = (await this.rows(runtimeId)).filter((row) => row.enabled === 1);
    const connections = rows.map((row) => JSON.parse(row.connection_json) as ConnectorConnection);
    const byId = new Map(connections.map((connection) => [connection.id, connection]));
    const modules = rows.map((row) => ({
      modulePath: row.module_path,
      ...(row.export_name === null ? {} : { exportName: row.export_name }),
      config: JSON.parse(row.config_json) as Readonly<Record<string, unknown>>,
    }));
    const resolver: ConnectionResolver = {
      async resolve(connectionId, scope) {
        const connection = byId.get(connectionId);
        if (connection === undefined) throw new Error("local_connector_connection_not_found");
        if (scope !== undefined && connection.ownerId !== scope.actorUserId && connection.ownerId !== scope.workspaceId) {
          throw new Error("local_connector_connection_not_authorized");
        }
        return connection;
      },
    };
    const credentialProvider: CredentialProvider = {
      async get(credentialRef) {
        const value = await this.secretStore.read(credentialRef);
        if (value === undefined) throw new Error("local_connector_credential_not_configured");
        return value;
      },
    };
    return { modules, connections, runtime: { resolver, credentialProvider } };
  }

  private async rows(runtimeId: string): Promise<ConnectorRow[]> {
    return await this.database.prepare(`
      SELECT connector_id, runtime_id, connector_key, display_name, module_path,
             export_name, config_json, connection_json, secret_storage_key,
             enabled, updated_at
      FROM local_runtime_connectors
      WHERE runtime_id = ?
      ORDER BY display_name, connector_id
    `).all(runtimeId) as ConnectorRow[];
  }

  private async toPublic(row: ConnectorRow): Promise<LocalConnectorConfiguration> {
    return {
      id: row.connector_id,
      runtimeId: row.runtime_id,
      connectorKey: row.connector_key,
      displayName: row.display_name,
      modulePath: row.module_path,
      ...(row.export_name === null ? {} : { exportName: row.export_name }),
      enabled: row.enabled === 1,
      config: JSON.parse(row.config_json) as Readonly<Record<string, unknown>>,
      credentialConfigured: row.secret_storage_key !== null,
      updatedAt: row.updated_at,
    };
  }
}
