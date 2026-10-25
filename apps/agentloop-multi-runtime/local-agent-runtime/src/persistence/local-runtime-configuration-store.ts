import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import type { LocalModelConfigurationStore, ResolvedLocalModelConfiguration } from "./local-model-configuration-store.ts";
import {
  discoverSkillDirectory,
  inspectSkillPackage,
  makeSkillPackageReadOnly,
  parseSkillDeclaration,
  removeSkillPackage,
  serializeSkillDeclaration,
  type SkillDeclaration,
  parseMcpServersConfig,
  type AppDatabase,
  type McpServersConfig,
  type McpServerRegistration,
  type ToolSourceCapability,
} from "@zhujun/agentloop";

export type LocalSkillPackageSourceKind = "custom_directory" | "uploaded";

export interface LocalSkillPackageSummary {
  readonly packageId: string;
  readonly skillName: string;
  readonly displayName: string;
  readonly description: string;
  readonly sourceKind: LocalSkillPackageSourceKind;
  readonly validationStatus: "valid" | "invalid";
  readonly validationDetail?: string;
  readonly metadataSource?: "package" | "legacy-frontmatter" | "detected";
  readonly metadataNeedsReview: boolean;
  readonly updatedAt: number;
}

export interface LocalSkillMetadata {
  readonly packageId: string;
  readonly packageHash: string;
  readonly name: string;
  readonly description: string;
  readonly declaration: SkillDeclaration;
  readonly source: "package" | "legacy-frontmatter" | "detected";
  readonly editable: boolean;
}

export type LocalRuntimeMcpAuthentication =
  | { readonly kind: "none" }
  | { readonly kind: "bearer"; readonly credentialConfigured: boolean }
  | { readonly kind: "api_key_header"; readonly headerName: string; readonly credentialConfigured: boolean }
  | { readonly kind: "basic"; readonly username: string; readonly credentialConfigured: boolean }
  | { readonly kind: "query_parameter"; readonly parameterName: string; readonly credentialConfigured: boolean }
  | { readonly kind: "custom_headers"; readonly headerNames: readonly string[]; readonly credentialConfigured: boolean };

export interface LocalRuntimeMcpServerConfiguration {
  readonly id: string;
  readonly displayName: string;
  readonly key: string;
  readonly transport: "http";
  readonly url: string;
  readonly protocolVersion?: string;
  readonly timeoutMs?: number;
  readonly auth: LocalRuntimeMcpAuthentication;
  readonly toolAllowlist?: readonly string[];
  readonly toolBlocklist?: readonly string[];
  readonly trust?: "trusted" | "untrusted";
  readonly aliases?: readonly string[];
  readonly capabilities?: readonly ToolSourceCapability[];
}

export interface LocalRuntimeMcpServerWrite {
  readonly id?: string;
  readonly displayName: string;
  readonly key: string;
  readonly transport: "http";
  readonly url: string;
  readonly protocolVersion?: string;
  readonly timeoutMs?: number;
  readonly auth:
    | { readonly kind: "none" }
    | { readonly kind: "bearer"; readonly secretStorageKey?: string }
    | { readonly kind: "api_key_header"; readonly headerName: string; readonly secretStorageKey?: string }
    | { readonly kind: "basic"; readonly username: string; readonly secretStorageKey?: string }
    | { readonly kind: "query_parameter"; readonly parameterName: string; readonly secretStorageKey?: string }
    | { readonly kind: "custom_headers"; readonly headerNames: readonly string[]; readonly secretStorageKey?: string };
  readonly toolAllowlist?: readonly string[];
  readonly toolBlocklist?: readonly string[];
  readonly trust?: "trusted" | "untrusted";
  readonly aliases?: readonly string[];
  readonly capabilities?: readonly ToolSourceCapability[];
}

export interface LocalRuntimeMcpServerInput {
  readonly id?: string;
  readonly displayName: string;
  readonly key: string;
  readonly transport: "http";
  readonly url: string;
  readonly protocolVersion?: string;
  readonly timeoutMs?: number;
  readonly auth:
    | { readonly kind: "none" }
    | { readonly kind: "bearer"; readonly token?: string }
    | { readonly kind: "api_key_header"; readonly headerName: string; readonly value?: string }
    | { readonly kind: "basic"; readonly username: string; readonly password?: string }
    | { readonly kind: "query_parameter"; readonly parameterName: string; readonly value?: string }
    | { readonly kind: "custom_headers"; readonly headers?: Readonly<Record<string, string>>; readonly headerNames?: readonly string[] };
  readonly toolAllowlist?: readonly string[];
  readonly toolBlocklist?: readonly string[];
  readonly trust?: "trusted" | "untrusted";
  readonly aliases?: readonly string[];
  readonly capabilities?: readonly ToolSourceCapability[];
}

export interface LocalRuntimeConfigurationInput {
  readonly skillPackageIds?: readonly string[];
  readonly mcpServers?: readonly LocalRuntimeMcpServerInput[];
}

interface LocalRuntimeConfigurationStorageInput {
  readonly skillPackageIds?: readonly string[];
  readonly mcpServers?: readonly LocalRuntimeMcpServerWrite[];
}

export interface LocalRuntimeConfiguration {
  readonly runtimeId: string;
  readonly skills: readonly LocalSkillPackageSummary[];
  readonly mcpServers: readonly LocalRuntimeMcpServerConfiguration[];
  readonly updatedAt: number;
}

export interface LocalRuntimeSecretStore {
  write(values: Readonly<Record<string, string>>): Promise<string>;
  read(secretStorageKey: string): Promise<Readonly<Record<string, string>> | undefined>;
  remove(secretStorageKey: string): Promise<void>;
  listKeys(): Promise<readonly string[]>;
}

export interface ResolvedLocalRuntimeConfiguration {
  readonly modelConfiguration?: ResolvedLocalModelConfiguration;
  readonly customSkillDirectories: readonly string[];
  readonly mcpServers: readonly McpServerRegistration[];
  readonly integrationEnvironment: Readonly<Record<string, string | undefined>>;
}

export interface LegacyLocalRuntimeConfigurationMigration {
  readonly mcpConfiguration?: McpServersConfig;
  readonly integrationEnvironment?: Readonly<Record<string, string | undefined>>;
}

export interface LegacyLocalRuntimeConfigurationMigrationResult {
  readonly missingCredentialServerKeys: readonly string[];
}

interface SkillPackageRow {
  package_id: string;
  skill_name: string;
  display_name: string;
  source_kind: LocalSkillPackageSourceKind;
  storage_key: string;
  manifest_json: string;
  validation_status: "valid" | "invalid";
  validation_detail: string | null;
  updated_at: number;
}

interface McpServerRow {
  mcp_server_id: string;
  display_name: string;
  source_key: string;
  transport: "http";
  url: string;
  protocol_version: string | null;
  timeout_ms: number | null;
  auth_kind: LocalRuntimeMcpServerWrite["auth"]["kind"];
  auth_config_json: string;
  secret_storage_key: string | null;
  tool_policy_json: string;
}

const EMPTY_SECRET_STORE: LocalRuntimeSecretStore = {
  async write() { throw new LocalRuntimeConfigurationStoreError(501, "local_runtime_secret_store_unavailable"); },
  async read() { return undefined; },
  async remove() {},
  async listKeys() { return []; },
};

/** Supervisor-owned authority for per-Runtime optional Skills and MCP servers. */
export class LocalRuntimeConfigurationStore {
  private readonly packageRoots = new Map<string, string>();
  private readonly database: AppDatabase;
  private readonly secretStore: LocalRuntimeSecretStore;
  private readonly customSkillDirectories: readonly string[];
  private readonly uploadedPackageRoot?: string;
  private readonly modelConfigurations?: LocalModelConfigurationStore;

  constructor(
    database: AppDatabase,
    secretStore: LocalRuntimeSecretStore = EMPTY_SECRET_STORE,
    customSkillDirectories: readonly string[] = [],
    uploadedPackageRoot?: string,
    modelConfigurations?: LocalModelConfigurationStore,
  ) {
    this.database = database;
    this.secretStore = secretStore;
    this.customSkillDirectories = customSkillDirectories;
    this.uploadedPackageRoot = uploadedPackageRoot;
    this.modelConfigurations = modelConfigurations;
  }

  async ready(): Promise<void> {
    await this.database.exec(`
      CREATE TABLE IF NOT EXISTS local_skill_packages (
        package_id TEXT PRIMARY KEY,
        skill_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('custom_directory', 'uploaded')),
        storage_key TEXT NOT NULL UNIQUE,
        manifest_json TEXT NOT NULL,
        validation_status TEXT NOT NULL CHECK(validation_status IN ('valid', 'invalid')),
        validation_detail TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_runtime_configurations (
        runtime_id TEXT PRIMARY KEY REFERENCES local_runtime_instances(runtime_id) ON DELETE CASCADE,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_runtime_skill_bindings (
        runtime_id TEXT NOT NULL REFERENCES local_runtime_instances(runtime_id) ON DELETE CASCADE,
        package_id TEXT NOT NULL REFERENCES local_skill_packages(package_id),
        created_at INTEGER NOT NULL,
        PRIMARY KEY(runtime_id, package_id)
      );
      CREATE TABLE IF NOT EXISTS local_runtime_mcp_servers (
        mcp_server_id TEXT PRIMARY KEY,
        runtime_id TEXT NOT NULL REFERENCES local_runtime_instances(runtime_id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        source_key TEXT NOT NULL,
        transport TEXT NOT NULL CHECK(transport = 'http'),
        url TEXT NOT NULL,
        protocol_version TEXT,
        timeout_ms INTEGER,
        auth_kind TEXT NOT NULL CHECK(auth_kind IN ('none', 'bearer', 'api_key_header', 'basic', 'query_parameter', 'custom_headers')),
        auth_config_json TEXT NOT NULL,
        secret_storage_key TEXT,
        tool_policy_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(runtime_id, source_key)
      );
    `);
    await this.migrateMcpServerTableForQueryAuthentication();
    await this.removeOrphanedSecrets();
    await this.synchronizeCustomDirectories(this.customSkillDirectories);
    await this.restoreUploadedPackages();
  }

  private async removeOrphanedSecrets(): Promise<void> {
    const referencedRows = await this.database.prepare(`
      SELECT DISTINCT secret_storage_key FROM local_runtime_mcp_servers WHERE secret_storage_key IS NOT NULL
    `).all() as Array<{ secret_storage_key: string }>;
    const referenced = new Set(referencedRows.map((row) => row.secret_storage_key));
    const orphaned = (await this.secretStore.listKeys()).filter((key) => !referenced.has(key));
    await Promise.all(orphaned.map((key) => this.secretStore.remove(key)));
  }

  private async migrateMcpServerTableForQueryAuthentication(): Promise<void> {
    const table = await this.database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'local_runtime_mcp_servers'
    `).get() as { sql: string } | undefined;
    if (table === undefined || table.sql.includes("'query_parameter'")) return;
    await this.database.exec(`
      ALTER TABLE local_runtime_mcp_servers RENAME TO local_runtime_mcp_servers_before_query_auth;
      CREATE TABLE local_runtime_mcp_servers (
        mcp_server_id TEXT PRIMARY KEY,
        runtime_id TEXT NOT NULL REFERENCES local_runtime_instances(runtime_id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        source_key TEXT NOT NULL,
        transport TEXT NOT NULL CHECK(transport = 'http'),
        url TEXT NOT NULL,
        protocol_version TEXT,
        timeout_ms INTEGER,
        auth_kind TEXT NOT NULL CHECK(auth_kind IN ('none', 'bearer', 'api_key_header', 'basic', 'query_parameter', 'custom_headers')),
        auth_config_json TEXT NOT NULL,
        secret_storage_key TEXT,
        tool_policy_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(runtime_id, source_key)
      );
      INSERT INTO local_runtime_mcp_servers(
        mcp_server_id, runtime_id, display_name, source_key, transport, url, protocol_version,
        timeout_ms, auth_kind, auth_config_json, secret_storage_key, tool_policy_json, created_at, updated_at
      )
      SELECT
        mcp_server_id, runtime_id, display_name, source_key, transport, url, protocol_version,
        timeout_ms, auth_kind, auth_config_json, secret_storage_key, tool_policy_json, created_at, updated_at
      FROM local_runtime_mcp_servers_before_query_auth;
      DROP TABLE local_runtime_mcp_servers_before_query_auth;
    `);
  }

  async synchronizeCustomDirectories(directories: readonly string[]): Promise<readonly LocalSkillPackageSummary[]> {
    const now = Date.now();
    await this.database.prepare(`
      UPDATE local_skill_packages
      SET validation_status = 'invalid', validation_detail = 'skill_package_not_available', updated_at = ?
      WHERE source_kind = 'custom_directory'
    `).run(now);
    for (const directory of directories) {
      for (const entry of await discoverSkillDirectory(directory)) {
        const storageKey = `custom:${createHash("sha256").update(resolve(directory)).digest("hex")}:${entry.inspection.name}`;
        const packageId = `local_skill_${createHash("sha256").update(storageKey).digest("hex").slice(0, 32)}`;
        this.packageRoots.set(packageId, entry.inspection.root);
        await this.database.prepare(`
          INSERT INTO local_skill_packages(
            package_id, skill_name, display_name, source_kind, storage_key, manifest_json,
            validation_status, validation_detail, created_at, updated_at
          ) VALUES (?, ?, ?, 'custom_directory', ?, ?, 'valid', NULL, ?, ?)
          ON CONFLICT(package_id) DO UPDATE SET
            skill_name = excluded.skill_name,
            display_name = excluded.display_name,
            manifest_json = excluded.manifest_json,
            validation_status = 'valid',
            validation_detail = NULL,
            updated_at = excluded.updated_at
        `).run(
          packageId,
          entry.inspection.name,
          entry.inspection.name,
          storageKey,
          JSON.stringify({
            description: entry.inspection.description,
            packageHash: entry.inspection.packageHash,
            fileCount: entry.inspection.fileCount,
            totalBytes: entry.inspection.totalBytes,
            ...(entry.inspection.declarationSource === undefined ? {} : { metadataSource: entry.inspection.declarationSource }),
            ...(entry.inspection.agentLoop === undefined ? {} : { agentLoop: entry.inspection.agentLoop }),
          }),
          now,
          now,
        );
      }
    }
    return this.listSkillPackages();
  }

  async listSkillPackages(): Promise<readonly LocalSkillPackageSummary[]> {
    const rows = await this.database.prepare(`
      SELECT package_id, skill_name, display_name, source_kind, storage_key, manifest_json,
             validation_status, validation_detail, updated_at
      FROM local_skill_packages ORDER BY display_name, package_id
    `).all() as SkillPackageRow[];
    return rows.map(toSkillSummary);
  }

  async registerUploadedPackage(input: {
    readonly storageKey: string;
    readonly root: string;
    readonly inspection: {
      readonly name: string;
      readonly description: string;
      readonly packageHash: string;
      readonly fileCount: number;
      readonly totalBytes: number;
      readonly agentLoop?: unknown;
      readonly metadataSource?: "package" | "legacy-frontmatter" | "detected";
    };
  }): Promise<LocalSkillPackageSummary> {
    if (!/^uploaded-[0-9a-f]{64}$/.test(input.storageKey)) throw new LocalRuntimeConfigurationStoreError(400, "skill_package_storage_key_invalid");
    const packageId = `local_skill_${input.inspection.packageHash.slice(0, 32)}`;
    const now = Date.now();
    await this.database.prepare(`
      INSERT INTO local_skill_packages(
        package_id, skill_name, display_name, source_kind, storage_key, manifest_json,
        validation_status, validation_detail, created_at, updated_at
      ) VALUES (?, ?, ?, 'uploaded', ?, ?, 'valid', NULL, ?, ?)
      ON CONFLICT(package_id) DO UPDATE SET
        skill_name = excluded.skill_name,
        display_name = excluded.display_name,
        storage_key = excluded.storage_key,
        manifest_json = excluded.manifest_json,
        validation_status = 'valid',
        validation_detail = NULL,
        updated_at = excluded.updated_at
    `).run(
      packageId,
      input.inspection.name,
      input.inspection.name,
      input.storageKey,
      JSON.stringify({
        description: input.inspection.description,
        packageHash: input.inspection.packageHash,
        fileCount: input.inspection.fileCount,
        totalBytes: input.inspection.totalBytes,
        metadataSource: input.inspection.metadataSource ?? "package",
        ...(input.inspection.agentLoop === undefined ? {} : { agentLoop: input.inspection.agentLoop }),
      }),
      now,
      now,
    );
    this.packageRoots.set(packageId, input.root);
    return (await this.listSkillPackages()).find((skill) => skill.packageId === packageId)!;
  }

  async skillMetadata(packageId: string): Promise<LocalSkillMetadata> {
    const row = await this.skillPackageRow(packageId);
    const root = this.packageRoots.get(packageId);
    if (root === undefined || row.validation_status !== "valid") throw new LocalRuntimeConfigurationStoreError(409, "skill_package_not_available");
    const inspection = await inspectSkillPackage(root);
    if (inspection.declaration === undefined || inspection.declarationSource === undefined) {
      throw new LocalRuntimeConfigurationStoreError(409, "skill_metadata_missing");
    }
    const manifest = parseRecord(row.manifest_json, "stored Skill manifest");
    const source = manifest.metadataSource === "legacy-frontmatter" || manifest.metadataSource === "detected" || manifest.metadataSource === "package"
      ? manifest.metadataSource
      : inspection.declarationSource;
    if (source === undefined) throw new LocalRuntimeConfigurationStoreError(409, "skill_metadata_missing");
    return {
      packageId,
      packageHash: inspection.packageHash,
      name: inspection.name,
      description: inspection.description,
      declaration: inspection.declaration,
      source,
      editable: row.source_kind === "uploaded",
    };
  }

  /** Create a new immutable uploaded-package revision with an edited sidecar. */
  async updateSkillMetadata(packageId: string, value: unknown): Promise<LocalSkillPackageSummary> {
    const row = await this.skillPackageRow(packageId);
    if (row.source_kind !== "uploaded") throw new LocalRuntimeConfigurationStoreError(403, "skill_metadata_not_editable");
    let activeBinding: { status: string } | undefined;
    try {
      activeBinding = await this.database.prepare(`
        SELECT i.status FROM local_runtime_skill_bindings b
        JOIN local_runtime_instances i ON i.runtime_id = b.runtime_id
        WHERE b.package_id = ? AND i.status <> 'stopped' LIMIT 1
      `).get(packageId) as { status: string } | undefined;
    } catch (error) {
      if (!(error instanceof Error) || !/no such table/i.test(error.message)) throw error;
    }
    if (activeBinding !== undefined) throw new LocalRuntimeConfigurationStoreError(409, "skill_metadata_runtime_active");
    const root = this.packageRoots.get(packageId);
    if (root === undefined || this.uploadedPackageRoot === undefined) throw new LocalRuntimeConfigurationStoreError(409, "skill_package_not_available");
    const before = await inspectSkillPackage(root);
    const declaration = parseSkillDeclaration(value);
    if (declaration.identity.name !== before.name || declaration.identity.description !== before.description) {
      throw new LocalRuntimeConfigurationStoreError(409, "skill_identity_immutable");
    }
    const staging = join(this.uploadedPackageRoot, `.metadata-${randomUUID()}`);
    await fs.cp(root, staging, { recursive: true, force: true });
    try {
      await makeWritableTree(staging);
      await fs.writeFile(join(staging, "agentloop.skill.json"), serializeSkillDeclaration(declaration), { mode: 0o600 });
      const edited = await inspectSkillPackage(staging);
      const storageKey = `uploaded-${edited.packageHash}`;
      const target = join(this.uploadedPackageRoot, storageKey);
      if (edited.packageHash !== before.packageHash) {
        const existing = await inspectSkillPackage(target).catch(() => undefined);
        if (existing !== undefined && existing.packageHash !== edited.packageHash) throw new LocalRuntimeConfigurationStoreError(409, "skill_package_storage_conflict");
        if (existing === undefined) await fs.rename(staging, target);
      }
      const finalRoot = edited.packageHash === before.packageHash ? root : target;
      await makeSkillPackageReadOnly({ ...edited, root: finalRoot });
      const newPackageId = `local_skill_${edited.packageHash.slice(0, 32)}`;
      const now = Date.now();
      const manifest = JSON.stringify(manifestForInspection(edited));
      await this.database.transaction(async () => {
        await this.database.prepare(`
          INSERT INTO local_skill_packages(
            package_id, skill_name, display_name, source_kind, storage_key, manifest_json,
            validation_status, validation_detail, created_at, updated_at
          ) VALUES (?, ?, ?, 'uploaded', ?, ?, 'valid', NULL, ?, ?)
          ON CONFLICT(package_id) DO UPDATE SET
            manifest_json = excluded.manifest_json,
            validation_status = 'valid', validation_detail = NULL, updated_at = excluded.updated_at
        `).run(newPackageId, edited.name, edited.name, storageKey, manifest, now, now);
        if (newPackageId !== packageId) {
          await this.database.prepare("UPDATE local_runtime_skill_bindings SET package_id = ? WHERE package_id = ?").run(newPackageId, packageId);
          await this.database.prepare("UPDATE local_skill_packages SET validation_status = 'invalid', validation_detail = ?, updated_at = ? WHERE package_id = ?").run(`superseded_by:${newPackageId}`, now, packageId);
        }
      });
      this.packageRoots.set(newPackageId, finalRoot);
      return (await this.listSkillPackages()).find((skill) => skill.packageId === newPackageId)!;
    } finally {
      if (await pathExists(staging)) await removeSkillPackage(staging);
    }
  }

  async allValidSkillPackageIds(): Promise<readonly string[]> {
    const rows = await this.database.prepare(`
      SELECT package_id FROM local_skill_packages WHERE validation_status = 'valid' ORDER BY package_id
    `).all() as Array<{ package_id: string }>;
    return rows.map((row) => row.package_id);
  }

  async hasConfiguration(runtimeId: string): Promise<boolean> {
    return await this.database.prepare(`
      SELECT runtime_id FROM local_runtime_configurations WHERE runtime_id = ?
    `).get(runtimeId) !== undefined;
  }

  async initialize(runtimeId: string, input: LocalRuntimeConfigurationStorageInput = {}): Promise<void> {
    await this.replaceStored(runtimeId, input);
  }

  async initializeFromLegacy(
    runtimeId: string,
    skillPackageIds: readonly string[],
    migration: LegacyLocalRuntimeConfigurationMigration = {},
  ): Promise<LegacyLocalRuntimeConfigurationMigrationResult> {
    const createdSecretKeys: string[] = [];
    const missingCredentialServerKeys: string[] = [];
    const storedServers: LocalRuntimeMcpServerWrite[] = [];
    try {
      for (const server of migration.mcpConfiguration?.servers ?? []) {
        const converted = await this.storeLegacyMcpServer(
          runtimeId,
          server,
          migration.mcpConfiguration?.defaultTrust,
          migration.integrationEnvironment ?? {},
          createdSecretKeys,
        );
        storedServers.push(converted.server);
        if (!converted.credentialConfigured) missingCredentialServerKeys.push(server.key);
      }
      await this.replaceStored(runtimeId, { skillPackageIds, mcpServers: storedServers }, true);
      return { missingCredentialServerKeys };
    } catch (error) {
      await Promise.all(createdSecretKeys.map((key) => this.secretStore.remove(key).catch(() => undefined)));
      throw error;
    }
  }

  async apply(runtimeId: string, input: LocalRuntimeConfigurationInput): Promise<void> {
    const existingRows = await this.mcpRows(runtimeId);
    const existingById = new Map(existingRows.map((row) => [row.mcp_server_id, row]));
    const createdSecretKeys: string[] = [];
    const storedServers: LocalRuntimeMcpServerWrite[] = [];
    try {
      for (const server of input.mcpServers ?? []) {
        const existing = server.id === undefined ? undefined : existingById.get(server.id);
        if (server.id !== undefined && existing === undefined) throw new LocalRuntimeConfigurationStoreError(404, "mcp_server_not_found");
        const auth = await this.storeAuthentication(server.auth, existing, createdSecretKeys);
        storedServers.push({ ...server, auth });
      }
      await this.replaceStored(runtimeId, { skillPackageIds: input.skillPackageIds, mcpServers: storedServers });
    } catch (error) {
      await Promise.all(createdSecretKeys.map((key) => this.secretStore.remove(key).catch(() => undefined)));
      throw error;
    }
    const retained = new Set(storedServers.flatMap((server) => server.auth.kind === "none" || server.auth.secretStorageKey === undefined ? [] : [server.auth.secretStorageKey]));
    const obsolete = existingRows
      .map((row) => row.secret_storage_key)
      .filter((key): key is string => key !== null && !retained.has(key));
    await Promise.all(obsolete.map((key) => this.secretStore.remove(key).catch(() => undefined)));
  }

  private async replaceStored(runtimeId: string, input: LocalRuntimeConfigurationStorageInput, allowMissingCredentials = false): Promise<void> {
    const skillPackageIds = unique(input.skillPackageIds ?? []);
    const mcpServers = validateMcpServers(input.mcpServers ?? [], allowMissingCredentials);
    await this.assertValidPackages(skillPackageIds);
    const now = Date.now();
    await this.database.transaction(async () => {
      await this.database.prepare(`
        INSERT INTO local_runtime_configurations(runtime_id, updated_at) VALUES (?, ?)
        ON CONFLICT(runtime_id) DO UPDATE SET updated_at = excluded.updated_at
      `).run(runtimeId, now);
      await this.database.prepare("DELETE FROM local_runtime_skill_bindings WHERE runtime_id = ?").run(runtimeId);
      for (const packageId of skillPackageIds) {
        await this.database.prepare(`
          INSERT INTO local_runtime_skill_bindings(runtime_id, package_id, created_at) VALUES (?, ?, ?)
        `).run(runtimeId, packageId, now);
      }
      await this.database.prepare("DELETE FROM local_runtime_mcp_servers WHERE runtime_id = ?").run(runtimeId);
      for (const server of mcpServers) await this.insertMcpServer(runtimeId, server, now);
    });
  }

  private async storeLegacyMcpServer(
    runtimeId: string,
    server: McpServerRegistration,
    defaultTrust: "trusted" | "untrusted" | undefined,
    environment: Readonly<Record<string, string | undefined>>,
    createdSecretKeys: string[],
  ): Promise<{ readonly server: LocalRuntimeMcpServerWrite; readonly credentialConfigured: boolean }> {
    if (server.headers !== undefined && server.auth !== undefined && server.auth.kind !== "none") {
      throw new LocalRuntimeConfigurationStoreError(409, `legacy_mcp_headers_with_auth_unsupported:${server.key}`);
    }
    const auth = server.headers !== undefined
      ? await this.storeLegacyHeaders(server.headers, createdSecretKeys)
      : await this.storeLegacyAuthentication(server.auth, environment, createdSecretKeys);
    return {
      server: {
        id: `local_mcp_legacy_${createHash("sha256").update(`${runtimeId}\0${server.key}`).digest("hex").slice(0, 32)}`,
        displayName: server.key,
        key: server.key,
        transport: server.transport,
        url: server.url,
        ...(server.protocolVersion === undefined ? {} : { protocolVersion: server.protocolVersion }),
        ...(server.timeoutMs === undefined ? {} : { timeoutMs: server.timeoutMs }),
        auth: auth.auth,
        ...(server.toolAllowlist === undefined ? {} : { toolAllowlist: server.toolAllowlist }),
        ...(server.toolBlocklist === undefined ? {} : { toolBlocklist: server.toolBlocklist }),
        ...((server.trust ?? defaultTrust) === undefined ? {} : { trust: server.trust ?? defaultTrust }),
        ...(server.aliases === undefined ? {} : { aliases: server.aliases }),
        ...(server.capabilities === undefined ? {} : { capabilities: server.capabilities }),
      },
      credentialConfigured: auth.credentialConfigured,
    };
  }

  private async storeLegacyAuthentication(
    auth: McpServerRegistration["auth"],
    environment: Readonly<Record<string, string | undefined>>,
    createdSecretKeys: string[],
  ): Promise<{ readonly auth: LocalRuntimeMcpServerWrite["auth"]; readonly credentialConfigured: boolean }> {
    if (auth === undefined || auth.kind === "none") return { auth: { kind: "none" }, credentialConfigured: true };
    if (auth.kind === "bearer") {
      const token = legacyEnvironmentValue(environment, auth.tokenEnv);
      const key = token === undefined ? undefined : await this.writeMigratedSecret({ token }, createdSecretKeys);
      return { auth: { kind: "bearer", ...(key === undefined ? {} : { secretStorageKey: key }) }, credentialConfigured: key !== undefined };
    }
    if (auth.kind === "query") {
      const value = legacyEnvironmentValue(environment, auth.secretEnv);
      const key = value === undefined ? undefined : await this.writeMigratedSecret({ value }, createdSecretKeys);
      return { auth: { kind: "query_parameter", parameterName: auth.name, ...(key === undefined ? {} : { secretStorageKey: key }) }, credentialConfigured: key !== undefined };
    }
    if (auth.kind === "headers") return this.storeLegacyHeaders(auth.headers, createdSecretKeys);
    const headers: Record<string, string> = {};
    let complete = true;
    for (const [headerName, environmentName] of Object.entries(auth.headerEnvs)) {
      const value = legacyEnvironmentValue(environment, environmentName);
      if (value === undefined) complete = false;
      else headers[headerName] = value;
    }
    if (!complete) return { auth: { kind: "custom_headers", headerNames: Object.keys(auth.headerEnvs) }, credentialConfigured: false };
    return this.storeLegacyHeaders(headers, createdSecretKeys);
  }

  private async storeLegacyHeaders(
    headers: Readonly<Record<string, string>>,
    createdSecretKeys: string[],
  ): Promise<{ readonly auth: LocalRuntimeMcpServerWrite["auth"]; readonly credentialConfigured: boolean }> {
    const headerNames = Object.keys(headers);
    if (headerNames.length === 0) return { auth: { kind: "none" }, credentialConfigured: true };
    const secretStorageKey = await this.writeMigratedSecret(headers, createdSecretKeys);
    return { auth: { kind: "custom_headers", headerNames, secretStorageKey }, credentialConfigured: true };
  }

  private async writeMigratedSecret(values: Readonly<Record<string, string>>, createdSecretKeys: string[]): Promise<string> {
    const key = await this.secretStore.write(values);
    createdSecretKeys.push(key);
    return key;
  }

  private async storeAuthentication(
    auth: LocalRuntimeMcpServerInput["auth"],
    existing: McpServerRow | undefined,
    createdSecretKeys: string[],
  ): Promise<LocalRuntimeMcpServerWrite["auth"]> {
    if (auth.kind === "none") return auth;
    const retain = (): string | undefined => existing?.auth_kind === auth.kind ? existing.secret_storage_key ?? undefined : undefined;
    if (auth.kind === "bearer") {
      const key = auth.token === undefined ? retain() : await this.secretStore.write({ token: auth.token });
      if (auth.token !== undefined) createdSecretKeys.push(key!);
      if (key === undefined) throw new LocalRuntimeConfigurationStoreError(400, "mcp_credential_required");
      return { kind: auth.kind, secretStorageKey: key };
    }
    if (auth.kind === "api_key_header") {
      const key = auth.value === undefined ? retain() : await this.secretStore.write({ value: auth.value });
      if (auth.value !== undefined) createdSecretKeys.push(key!);
      if (key === undefined) throw new LocalRuntimeConfigurationStoreError(400, "mcp_credential_required");
      return { kind: auth.kind, headerName: auth.headerName, secretStorageKey: key };
    }
    if (auth.kind === "basic") {
      const key = auth.password === undefined ? retain() : await this.secretStore.write({ password: auth.password });
      if (auth.password !== undefined) createdSecretKeys.push(key!);
      if (key === undefined) throw new LocalRuntimeConfigurationStoreError(400, "mcp_credential_required");
      return { kind: auth.kind, username: auth.username, secretStorageKey: key };
    }
    if (auth.kind === "query_parameter") {
      const key = auth.value === undefined ? retain() : await this.secretStore.write({ value: auth.value });
      if (auth.value !== undefined) createdSecretKeys.push(key!);
      if (key === undefined) throw new LocalRuntimeConfigurationStoreError(400, "mcp_credential_required");
      return { kind: auth.kind, parameterName: auth.parameterName, secretStorageKey: key };
    }
    if (auth.headers !== undefined) {
      const headerNames = Object.keys(auth.headers);
      const key = await this.secretStore.write(auth.headers);
      createdSecretKeys.push(key);
      return { kind: auth.kind, headerNames, secretStorageKey: key };
    }
    const key = retain();
    if (key === undefined) throw new LocalRuntimeConfigurationStoreError(400, "mcp_credential_required");
    const headerNames = auth.headerNames ?? requiredStringArray(parseRecord(existing!.auth_config_json, "stored MCP auth config").headerNames, "stored MCP custom header names");
    return { kind: auth.kind, headerNames, secretStorageKey: key };
  }

  async configuration(runtimeId: string): Promise<LocalRuntimeConfiguration> {
    const configuration = await this.database.prepare(`
      SELECT updated_at FROM local_runtime_configurations WHERE runtime_id = ?
    `).get(runtimeId) as { updated_at: number } | undefined;
    if (configuration === undefined) throw new LocalRuntimeConfigurationStoreError(404, "runtime_configuration_not_found");
    const skillRows = await this.database.prepare(`
      SELECT p.package_id, p.skill_name, p.display_name, p.source_kind, p.storage_key,
             p.manifest_json, p.validation_status, p.validation_detail, p.updated_at
      FROM local_runtime_skill_bindings b
      JOIN local_skill_packages p ON p.package_id = b.package_id
      WHERE b.runtime_id = ? ORDER BY p.display_name, p.package_id
    `).all(runtimeId) as SkillPackageRow[];
    const mcpRows = await this.mcpRows(runtimeId);
    return {
      runtimeId,
      skills: skillRows.map(toSkillSummary),
      mcpServers: mcpRows.map(toPublicMcpServer),
      updatedAt: configuration.updated_at,
    };
  }

  async secretStorageKeysForRuntime(runtimeId: string): Promise<readonly string[]> {
    const rows = await this.database.prepare(`
      SELECT secret_storage_key FROM local_runtime_mcp_servers
      WHERE runtime_id = ? AND secret_storage_key IS NOT NULL
    `).all(runtimeId) as Array<{ secret_storage_key: string }>;
    return unique(rows.map((row) => row.secret_storage_key));
  }

  async missingCredentialServerKeys(runtimeId: string): Promise<readonly string[]> {
    const missing: string[] = [];
    for (const row of await this.mcpRows(runtimeId)) {
      if (row.auth_kind === "none") continue;
      const secret = row.secret_storage_key === null ? undefined : await this.secretStore.read(row.secret_storage_key);
      if (secret !== undefined) continue;
      missing.push(row.source_key);
      if (row.secret_storage_key !== null) {
        await this.database.prepare(`
          UPDATE local_runtime_mcp_servers SET secret_storage_key = NULL, updated_at = ? WHERE mcp_server_id = ?
        `).run(Date.now(), row.mcp_server_id);
      }
    }
    return missing;
  }

  async removeSecrets(secretStorageKeys: readonly string[]): Promise<void> {
    await Promise.all(unique(secretStorageKeys).map((key) => this.secretStore.remove(key)));
  }

  async resolve(runtimeId: string): Promise<ResolvedLocalRuntimeConfiguration> {
    const packageRows = await this.database.prepare(`
      SELECT p.package_id, p.validation_status
      FROM local_runtime_skill_bindings b
      JOIN local_skill_packages p ON p.package_id = b.package_id
      WHERE b.runtime_id = ? ORDER BY p.package_id
    `).all(runtimeId) as Array<{ package_id: string; validation_status: string }>;
    const customSkillDirectories = packageRows.map((row) => {
      if (row.validation_status !== "valid") throw new LocalRuntimeConfigurationStoreError(409, "skill_package_invalid");
      const root = this.packageRoots.get(row.package_id);
      if (root === undefined) throw new LocalRuntimeConfigurationStoreError(409, "skill_package_not_available");
      return root;
    });
    const environment: Record<string, string | undefined> = {};
    const mcpServers: McpServerRegistration[] = [];
    for (const row of await this.mcpRows(runtimeId)) {
      mcpServers.push(await this.resolveMcpServer(row, environment));
    }
    return { customSkillDirectories, mcpServers, integrationEnvironment: environment,
      ...(this.modelConfigurations === undefined ? {} : { modelConfiguration: await this.modelConfigurations.resolve() }) };
  }

  private async assertValidPackages(packageIds: readonly string[]): Promise<void> {
    for (const packageId of packageIds) {
      const row = await this.database.prepare(`
        SELECT validation_status FROM local_skill_packages WHERE package_id = ?
      `).get(packageId) as { validation_status: string } | undefined;
      if (row === undefined) throw new LocalRuntimeConfigurationStoreError(404, "skill_package_not_found");
      if (row.validation_status !== "valid") throw new LocalRuntimeConfigurationStoreError(409, "skill_package_invalid");
      if (!this.packageRoots.has(packageId)) throw new LocalRuntimeConfigurationStoreError(409, "skill_package_not_available");
    }
  }

  private async skillPackageRow(packageId: string): Promise<SkillPackageRow> {
    const row = await this.database.prepare(`
      SELECT package_id, skill_name, display_name, source_kind, storage_key, manifest_json,
             validation_status, validation_detail, updated_at
      FROM local_skill_packages WHERE package_id = ?
    `).get(packageId) as SkillPackageRow | undefined;
    if (row === undefined) throw new LocalRuntimeConfigurationStoreError(404, "skill_package_not_found");
    return row;
  }

  private async restoreUploadedPackages(): Promise<void> {
    if (this.uploadedPackageRoot === undefined) return;
    const rows = await this.database.prepare(`
      SELECT package_id, storage_key FROM local_skill_packages WHERE source_kind = 'uploaded'
    `).all() as Array<{ package_id: string; storage_key: string }>;
    for (const row of rows) {
      if (!/^uploaded-[0-9a-f]{64}$/.test(row.storage_key)) {
        await this.markPackageUnavailable(row.package_id);
        continue;
      }
      const root = resolve(this.uploadedPackageRoot, row.storage_key);
      const inspection = await inspectSkillPackage(root).catch(() => undefined);
      if (inspection === undefined || row.storage_key !== `uploaded-${inspection.packageHash}`) {
        await this.markPackageUnavailable(row.package_id);
        continue;
      }
      this.packageRoots.set(row.package_id, inspection.root);
    }
  }

  private async markPackageUnavailable(packageId: string): Promise<void> {
    await this.database.prepare(`
      UPDATE local_skill_packages
      SET validation_status = 'invalid', validation_detail = 'skill_package_not_available', updated_at = ?
      WHERE package_id = ?
    `).run(Date.now(), packageId);
  }

  private async insertMcpServer(runtimeId: string, server: LocalRuntimeMcpServerWrite, now: number): Promise<void> {
    const authConfig = nonSecretAuthConfig(server.auth);
    const secretStorageKey = server.auth.kind === "none" ? null : server.auth.secretStorageKey ?? null;
    await this.database.prepare(`
      INSERT INTO local_runtime_mcp_servers(
        mcp_server_id, runtime_id, display_name, source_key, transport, url, protocol_version,
        timeout_ms, auth_kind, auth_config_json, secret_storage_key, tool_policy_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'http', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      server.id ?? `local_mcp_${randomUUID()}`,
      runtimeId,
      server.displayName.trim(),
      server.key.trim(),
      server.url,
      server.protocolVersion ?? null,
      server.timeoutMs ?? null,
      server.auth.kind,
      JSON.stringify(authConfig),
      secretStorageKey,
      JSON.stringify({
        ...(server.toolAllowlist === undefined ? {} : { toolAllowlist: server.toolAllowlist }),
        ...(server.toolBlocklist === undefined ? {} : { toolBlocklist: server.toolBlocklist }),
        ...(server.trust === undefined ? {} : { trust: server.trust }),
        ...(server.aliases === undefined ? {} : { aliases: server.aliases }),
        ...(server.capabilities === undefined ? {} : { capabilities: server.capabilities }),
      }),
      now,
      now,
    );
  }

  private async mcpRows(runtimeId: string): Promise<McpServerRow[]> {
    return await this.database.prepare(`
      SELECT mcp_server_id, display_name, source_key, transport, url, protocol_version,
             timeout_ms, auth_kind, auth_config_json, secret_storage_key, tool_policy_json
      FROM local_runtime_mcp_servers WHERE runtime_id = ? ORDER BY display_name, mcp_server_id
    `).all(runtimeId) as McpServerRow[];
  }

  private async resolveMcpServer(row: McpServerRow, environment: Record<string, string | undefined>): Promise<McpServerRegistration> {
    const authConfig = parseRecord(row.auth_config_json, "stored MCP auth config");
    const policy = parseRecord(row.tool_policy_json, "stored MCP tool policy");
    const toolAllowlist = optionalNonEmptyStringArray(policy.toolAllowlist, "stored MCP tool allowlist");
    const toolBlocklist = optionalNonEmptyStringArray(policy.toolBlocklist, "stored MCP tool blocklist");
    const registration: Record<string, unknown> = {
      key: row.source_key,
      transport: row.transport,
      url: row.url,
      ...(row.protocol_version === null ? {} : { protocolVersion: row.protocol_version }),
      ...(row.timeout_ms === null ? {} : { timeoutMs: row.timeout_ms }),
      ...(toolAllowlist === undefined ? {} : { toolAllowlist }),
      ...(toolBlocklist === undefined ? {} : { toolBlocklist }),
      ...(policy.trust === undefined ? {} : { trust: policy.trust }),
      ...(policy.aliases === undefined ? {} : { aliases: policy.aliases }),
      ...(policy.capabilities === undefined ? {} : { capabilities: policy.capabilities }),
    };
    if (row.auth_kind === "none") registration.auth = { kind: "none" };
    else {
      if (row.secret_storage_key === null) throw new LocalRuntimeConfigurationStoreError(409, "mcp_credential_not_configured");
      const secret = await this.secretStore.read(row.secret_storage_key);
      if (secret === undefined) throw new LocalRuntimeConfigurationStoreError(409, "mcp_credential_not_configured");
      const prefix = `LOCAL_RUNTIME_MCP_${createHash("sha256").update(row.mcp_server_id).digest("hex").slice(0, 16).toUpperCase()}`;
      if (row.auth_kind === "bearer") {
        environment[`${prefix}_TOKEN`] = requiredSecret(secret, "token");
        registration.auth = { kind: "bearer", tokenEnv: `${prefix}_TOKEN` };
      } else if (row.auth_kind === "api_key_header") {
        const headerName = requiredString(authConfig.headerName, "stored MCP API key header name");
        environment[`${prefix}_API_KEY`] = requiredSecret(secret, "value");
        registration.auth = { kind: "headers_env", headerEnvs: { [headerName]: `${prefix}_API_KEY` } };
      } else if (row.auth_kind === "basic") {
        const username = requiredString(authConfig.username, "stored MCP basic username");
        environment[`${prefix}_AUTHORIZATION`] = `Basic ${Buffer.from(`${username}:${requiredSecret(secret, "password")}`).toString("base64")}`;
        registration.auth = { kind: "headers_env", headerEnvs: { Authorization: `${prefix}_AUTHORIZATION` } };
      } else if (row.auth_kind === "query_parameter") {
        const parameterName = requiredString(authConfig.parameterName, "stored MCP query parameter name");
        environment[`${prefix}_QUERY`] = requiredSecret(secret, "value");
        registration.auth = { kind: "query", name: parameterName, secretEnv: `${prefix}_QUERY` };
      } else {
        const headerNames = requiredStringArray(authConfig.headerNames, "stored MCP custom header names");
        const headerEnvs: Record<string, string> = {};
        for (const [index, headerName] of headerNames.entries()) {
          const environmentKey = `${prefix}_HEADER_${index}`;
          environment[environmentKey] = requiredSecret(secret, headerName);
          headerEnvs[headerName] = environmentKey;
        }
        registration.auth = { kind: "headers_env", headerEnvs };
      }
    }
    return parseMcpServersConfig({ servers: [registration] }, "stored Runtime MCP configuration").servers[0]!;
  }
}

export class LocalRuntimeConfigurationStoreError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function validateMcpServers(servers: readonly LocalRuntimeMcpServerWrite[], allowMissingCredentials = false): readonly LocalRuntimeMcpServerWrite[] {
  const keys = new Set<string>();
  const namespaces = new Set<string>();
  const normalized: LocalRuntimeMcpServerWrite[] = [];
  for (const server of servers) {
    if (server.displayName.trim().length < 1 || server.displayName.trim().length > 100) throw new LocalRuntimeConfigurationStoreError(400, "mcp_configuration_invalid");
    let endpoint: URL;
    try { endpoint = new URL(server.url); } catch { throw new LocalRuntimeConfigurationStoreError(400, "mcp_configuration_invalid"); }
    if ((endpoint.protocol !== "http:" && endpoint.protocol !== "https:") || endpoint.username !== "" || endpoint.password !== "") {
      throw new LocalRuntimeConfigurationStoreError(400, "mcp_configuration_invalid");
    }
    for (const name of endpoint.searchParams.keys()) {
      if (/(?:token|secret|password|api[-_]?key|auth)/i.test(name)) throw new LocalRuntimeConfigurationStoreError(400, "mcp_secret_must_use_auth_fields");
    }
    const parsed = parseMcpServersConfig({ servers: [{
      key: server.key,
      transport: server.transport,
      url: server.url,
      ...(server.protocolVersion === undefined ? {} : { protocolVersion: server.protocolVersion }),
      ...(server.timeoutMs === undefined ? {} : { timeoutMs: server.timeoutMs }),
      ...(server.toolAllowlist === undefined ? {} : { toolAllowlist: server.toolAllowlist }),
      ...(server.toolBlocklist === undefined ? {} : { toolBlocklist: server.toolBlocklist }),
      ...(server.trust === undefined ? {} : { trust: server.trust }),
      ...(server.aliases === undefined ? {} : { aliases: server.aliases }),
      ...(server.capabilities === undefined ? {} : { capabilities: server.capabilities }),
      auth: { kind: "none" },
    }] }, "Runtime MCP configuration").servers[0]!;
    if (keys.has(parsed.key)) throw new LocalRuntimeConfigurationStoreError(409, "mcp_source_key_conflict");
    const namespace = parsed.key.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (namespaces.has(namespace)) throw new LocalRuntimeConfigurationStoreError(409, "mcp_source_key_conflict");
    keys.add(parsed.key);
    namespaces.add(namespace);
    if (server.auth.kind !== "none") {
      if (server.auth.secretStorageKey === undefined) {
        if (!allowMissingCredentials) throw new LocalRuntimeConfigurationStoreError(400, "mcp_credential_required");
      } else if (server.auth.secretStorageKey.trim().length === 0) throw new LocalRuntimeConfigurationStoreError(400, "mcp_configuration_invalid");
    }
    const { toolAllowlist: _toolAllowlist, toolBlocklist: _toolBlocklist, ...rest } = server;
    normalized.push({
      ...rest,
      ...(parsed.toolAllowlist === undefined || parsed.toolAllowlist.length === 0 ? {} : { toolAllowlist: parsed.toolAllowlist }),
      ...(parsed.toolBlocklist === undefined || parsed.toolBlocklist.length === 0 ? {} : { toolBlocklist: parsed.toolBlocklist }),
    });
  }
  return normalized;
}

function nonSecretAuthConfig(auth: LocalRuntimeMcpServerWrite["auth"]): Record<string, unknown> {
  if (auth.kind === "api_key_header") return { headerName: auth.headerName };
  if (auth.kind === "basic") return { username: auth.username };
  if (auth.kind === "query_parameter") return { parameterName: auth.parameterName };
  if (auth.kind === "custom_headers") return { headerNames: unique(auth.headerNames) };
  return {};
}

function toSkillSummary(row: SkillPackageRow): LocalSkillPackageSummary {
  const manifest = parseRecord(row.manifest_json, "stored Skill manifest");
  return {
    packageId: row.package_id,
    skillName: row.skill_name,
    displayName: row.display_name,
    description: typeof manifest.description === "string" ? manifest.description : "",
    sourceKind: row.source_kind,
    validationStatus: row.validation_status,
    ...(row.validation_detail === null ? {} : { validationDetail: row.validation_detail }),
    ...(manifest.metadataSource === "package" || manifest.metadataSource === "legacy-frontmatter" || manifest.metadataSource === "detected"
      ? { metadataSource: manifest.metadataSource }
      : {}),
    metadataNeedsReview: manifest.metadataSource !== "package",
    updatedAt: row.updated_at,
  };
}

function manifestForInspection(inspection: {
  readonly description: string;
  readonly packageHash: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly declarationSource?: string;
  readonly agentLoop?: unknown;
}): Record<string, unknown> {
  return {
    description: inspection.description,
    packageHash: inspection.packageHash,
    fileCount: inspection.fileCount,
    totalBytes: inspection.totalBytes,
    metadataSource: inspection.declarationSource ?? "package",
    ...(inspection.agentLoop === undefined ? {} : { agentLoop: inspection.agentLoop }),
  };
}

async function pathExists(path: string): Promise<boolean> {
  return await fs.stat(path).then(() => true).catch(() => false);
}

async function makeWritableTree(path: string): Promise<void> {
  await fs.chmod(path, 0o700).catch(() => undefined);
  for (const entry of await fs.readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await makeWritableTree(child);
    else await fs.chmod(child, 0o600).catch(() => undefined);
  }
}

function toPublicMcpServer(row: McpServerRow): LocalRuntimeMcpServerConfiguration {
  const authConfig = parseRecord(row.auth_config_json, "stored MCP auth config");
  const policy = parseRecord(row.tool_policy_json, "stored MCP tool policy");
  const toolAllowlist = optionalNonEmptyStringArray(policy.toolAllowlist, "stored MCP tool allowlist");
  const toolBlocklist = optionalNonEmptyStringArray(policy.toolBlocklist, "stored MCP tool blocklist");
  const credentialConfigured = row.secret_storage_key !== null;
  const auth: LocalRuntimeMcpAuthentication = row.auth_kind === "none"
    ? { kind: "none" }
    : row.auth_kind === "bearer"
      ? { kind: "bearer", credentialConfigured }
      : row.auth_kind === "api_key_header"
        ? { kind: "api_key_header", headerName: requiredString(authConfig.headerName, "stored MCP API key header name"), credentialConfigured }
        : row.auth_kind === "basic"
          ? { kind: "basic", username: requiredString(authConfig.username, "stored MCP basic username"), credentialConfigured }
          : row.auth_kind === "query_parameter"
            ? { kind: "query_parameter", parameterName: requiredString(authConfig.parameterName, "stored MCP query parameter name"), credentialConfigured }
            : { kind: "custom_headers", headerNames: requiredStringArray(authConfig.headerNames, "stored MCP custom header names"), credentialConfigured };
  return {
    id: row.mcp_server_id,
    displayName: row.display_name,
    key: row.source_key,
    transport: row.transport,
    url: row.url,
    ...(row.protocol_version === null ? {} : { protocolVersion: row.protocol_version }),
    ...(row.timeout_ms === null ? {} : { timeoutMs: row.timeout_ms }),
    auth,
    ...(toolAllowlist === undefined ? {} : { toolAllowlist }),
    ...(toolBlocklist === undefined ? {} : { toolBlocklist }),
    ...(policy.trust === undefined ? {} : { trust: policy.trust === "trusted" ? "trusted" as const : "untrusted" as const }),
    ...(policy.aliases === undefined ? {} : { aliases: requiredStringArray(policy.aliases, "stored MCP aliases") }),
    ...(policy.capabilities === undefined ? {} : { capabilities: policy.capabilities as readonly ToolSourceCapability[] }),
  };
}

function parseRecord(raw: string, label: string): Record<string, unknown> {
  const value = JSON.parse(raw) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function optionalNonEmptyStringArray(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const values = requiredStringArray(value, label);
  return values.length === 0 ? undefined : values;
}

function requiredStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) throw new TypeError(`${label} must be a string array`);
  return value as readonly string[];
}

function requiredSecret(secret: Readonly<Record<string, string>>, name: string): string {
  const value = secret[name];
  if (value === undefined || value.length === 0) throw new LocalRuntimeConfigurationStoreError(409, "mcp_credential_not_configured");
  return value;
}

function unique(values: readonly string[]): readonly string[] {
  const result = [...new Set(values)];
  if (result.some((value) => typeof value !== "string" || value.trim().length === 0)) throw new LocalRuntimeConfigurationStoreError(400, "runtime_configuration_invalid");
  if (result.length !== values.length) throw new LocalRuntimeConfigurationStoreError(409, "runtime_configuration_duplicate_value");
  return result;
}

function legacyEnvironmentValue(environment: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = environment[name];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}
