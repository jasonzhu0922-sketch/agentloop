import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { AppDatabase } from "@zhujun/agentloop";
import type { ConnectorConnection } from "@zhujun/agentloop-connector-sdk";
import { loadConnectorModules, type ConnectorModuleRegistration } from "../connectors/connector-module-loader.ts";
import type { LocalConnectorConfigurationPort, LocalConnectorRuntimeResolution } from "../contracts/host.ts";
import type { LocalRuntimeSecretStore } from "./local-runtime-configuration-store.ts";
import { LocalManagementError } from "./skill-import.ts";

export interface ConnectorSettingInput {
  readonly id?: string; readonly connectorKey: string; readonly displayName: string;
  readonly enabled: boolean; readonly scopes: readonly string[]; readonly credentials?: Readonly<Record<string, string>>;
}
interface Row { id: string; owner_id: string; connector_key: string; display_name: string;
  enabled: number; scopes: string; secret_ref: string | null; updated_at: number }

/** Modules are installed/approved by the host, never imported from browser-supplied paths. */
export class ConnectorSettings implements LocalConnectorConfigurationPort {
  private modules = new Map<string, { registration: ConnectorModuleRegistration; definition: import("@zhujun/agentloop-connector-sdk").ConnectorDefinition }>();
  constructor(private database: AppDatabase, private secrets: LocalRuntimeSecretStore,
    private registrations: readonly ConnectorModuleRegistration[]) {}
  async ready() {
    await this.database.exec(`CREATE TABLE IF NOT EXISTS desktop_connector_settings (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, connector_key TEXT NOT NULL, display_name TEXT NOT NULL,
      enabled INTEGER NOT NULL, scopes TEXT NOT NULL, secret_ref TEXT, updated_at INTEGER NOT NULL
    )`);
    // Connector accounts are device/user capabilities, not Runtime settings.
    // Preserve all existing connections while removing the legacy Runtime FK.
    const columns = await this.database.prepare("PRAGMA table_info(desktop_connector_settings)").all() as Array<{ name: string }>;
    if (columns.some(column => column.name === "runtime_id")) await this.database.exec(`
      ALTER TABLE desktop_connector_settings RENAME TO desktop_connector_settings_runtime_scoped;
      CREATE TABLE desktop_connector_settings (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, connector_key TEXT NOT NULL, display_name TEXT NOT NULL,
        enabled INTEGER NOT NULL, scopes TEXT NOT NULL, secret_ref TEXT, updated_at INTEGER NOT NULL
      );
      INSERT INTO desktop_connector_settings(id, owner_id, connector_key, display_name, enabled, scopes, secret_ref, updated_at)
      SELECT id, owner_id, connector_key, display_name, enabled, scopes, secret_ref, updated_at
      FROM desktop_connector_settings_runtime_scoped;
      DROP TABLE desktop_connector_settings_runtime_scoped;
    `);
    for (const registration of this.registrations) {
      if (!isAbsolute(registration.modulePath)) throw new LocalManagementError(400, "connector_module_path_must_be_absolute");
      const [module] = await loadConnectorModules({ registrations: [registration] });
      const key = module!.definition.manifest.key;
      if (this.modules.has(key)) throw new LocalManagementError(409, "connector_module_duplicate");
      this.modules.set(key, { registration, definition: module!.definition });
    }
  }
  catalog() { return [...this.modules.values()].map(({ definition }) => ({
    key: definition.manifest.key, displayName: definition.manifest.displayName,
    description: definition.manifest.description, capabilities: definition.capabilities,
  })); }
  async list(owner: string) {
    return (await this.rows()).filter(row => row.owner_id === owner).map(row => ({
      id: row.id, connectionId: row.id, connectorKey: row.connector_key, displayName: row.display_name,
      enabled: row.enabled === 1, scopes: JSON.parse(row.scopes) as string[], credentialConfigured: row.secret_ref !== null,
      moduleAvailable: this.modules.has(row.connector_key), updatedAt: row.updated_at,
    }));
  }
  async save(owner: string, input: ConnectorSettingInput) {
    if (!input || Object.keys(input).some(k => !["id", "connectorKey", "displayName", "enabled", "scopes", "credentials"].includes(k))
      || !this.modules.has(input.connectorKey) || typeof input.displayName !== "string" || !input.displayName.trim() || input.displayName.length > 100
      || typeof input.enabled !== "boolean" || !Array.isArray(input.scopes) || input.scopes.length > 100 || input.scopes.some(s => typeof s !== "string" || s.length > 200)) throw new LocalManagementError(400, "connector_configuration_invalid");
    const existing = input.id === undefined ? undefined : (await this.rows()).find(row => row.id === input.id && row.owner_id === owner);
    if (input.id !== undefined && !existing) throw new LocalManagementError(404, "connector_not_found");
    if (existing && existing.connector_key !== input.connectorKey) throw new LocalManagementError(409, "connector_identity_immutable");
    const credentials = input.credentials;
    if (credentials !== undefined && (!credentials || typeof credentials !== "object" || Array.isArray(credentials)
      || Object.entries(credentials).some(([k, v]) => !/^[A-Za-z][A-Za-z0-9_-]{0,100}$/.test(k) || typeof v !== "string" || !v.length || v.length > 16000))) throw new LocalManagementError(400, "connector_configuration_invalid");
    const id = existing?.id ?? `connection_${randomUUID()}`;
    const reference = credentials === undefined ? existing?.secret_ref ?? null : await this.secrets.write(credentials);
    try {
      await this.database.prepare(`INSERT INTO desktop_connector_settings VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, enabled=excluded.enabled,
        scopes=excluded.scopes, secret_ref=excluded.secret_ref, updated_at=excluded.updated_at`).run(
        id, owner, input.connectorKey, input.displayName.trim(), Number(input.enabled), JSON.stringify(input.scopes), reference, Date.now());
    } catch (error) { if (credentials !== undefined && reference) await this.secrets.remove(reference).catch(() => undefined); throw error; }
    let credentialCleanupPending = false;
    if (existing?.secret_ref && existing.secret_ref !== reference) await this.secrets.remove(existing.secret_ref).catch(() => { credentialCleanupPending = true; });
    return { connector: (await this.list(owner)).find(row => row.id === id)!, credentialCleanupPending };
  }
  async remove(owner: string, id: string) {
    const row = (await this.rows()).find(row => row.id === id && row.owner_id === owner);
    if (!row) throw new LocalManagementError(404, "connector_not_found");
    await this.database.prepare("DELETE FROM desktop_connector_settings WHERE id = ? AND owner_id = ?").run(id, owner);
    let credentialCleanupPending = false;
    if (row.secret_ref) await this.secrets.remove(row.secret_ref).catch(() => { credentialCleanupPending = true; });
    return { removed: true, credentialCleanupPending };
  }
  async references() { return (await this.rows()).flatMap(r => r.secret_ref ? [r.secret_ref] : []); }
  async cleanup(references: readonly string[]) { for (const reference of references) await this.secrets.remove(reference); }
  private rows() { return this.database.prepare("SELECT * FROM desktop_connector_settings ORDER BY display_name, id").all<Row>(); }
  async resolve(_runtimeId: string): Promise<LocalConnectorRuntimeResolution> {
    const rows = (await this.rows()).filter(r => r.enabled === 1);
    const byId = new Map<string, { connection: ConnectorConnection; secret?: string }>();
    const modules = new Map<string, ConnectorModuleRegistration>();
    for (const row of rows) {
      const module = this.modules.get(row.connector_key);
      if (!module) throw new LocalManagementError(409, "connector_module_unavailable");
      modules.set(row.connector_key, module.registration);
      byId.set(row.id, { connection: { id: row.id, connectorKey: row.connector_key, displayName: row.display_name, ownerType: "user", ownerId: row.owner_id,
        scopes: JSON.parse(row.scopes) as string[], credentialRef: row.secret_ref ?? `no_secret_${row.id}`, status: "active" }, ...(row.secret_ref ? { secret: row.secret_ref } : {}) });
    }
    const secrets = this.secrets;
    return { modules: [...modules.values()], connections: [...byId.values()].map(r => r.connection), runtime: {
      resolver: { async resolve(id, scope) {
        const row = byId.get(id);
        if (!row || !scope || row.connection.ownerId !== scope.actorUserId) throw new LocalManagementError(403, "connector_connection_not_authorized");
        return row.connection;
      } },
      credentialProvider: { async get(reference) {
        const row = [...byId.values()].find(r => r.connection.credentialRef === reference);
        if (!row) throw new LocalManagementError(403, "connector_connection_not_authorized");
        if (!row.secret) return {};
        const values = await secrets.read(row.secret); if (!values) throw new LocalManagementError(409, "connector_credentials_missing"); return values;
      } },
    } };
  }
}
