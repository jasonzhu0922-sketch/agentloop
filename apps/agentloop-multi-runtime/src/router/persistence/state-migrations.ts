import type { SqlConnection } from "@zhujun/agentloop";
import { installArtifactCatalogSchema } from "../artifacts/shared-workspace-artifact-catalog.ts";
import { installAttachmentSchema } from "../attachments/shared-filesystem-attachment-broker.ts";
import { installIdentitySchema } from "../identity/service.ts";
import { installControlPlaneSchema } from "./control-plane-store.ts";
import { installDeviceSchema } from "../devices/device-service.ts";
import { applyVersionedMigrations, type SchemaMigration } from "../../shared/persistence/schema-migration-ledger.ts";

const MIGRATIONS: readonly SchemaMigration[] = [{
  id: "router/0001_identity_control_plane_devices_attachments_artifacts",
  definition: "identity;control-plane;devices;attachments;artifact-catalog;legacy-sqlite-upgrades:v1",
  apply: async (database) => {
    await installIdentitySchema(database); await installControlPlaneSchema(database); await installDeviceSchema(database);
    await installAttachmentSchema(database); await installArtifactCatalogSchema(database);
  },
}, {
  id: "router/0002_runtime_display_names",
  definition: "mr_runtime_nodes.display_name:v1",
  apply: async (database) => {
    if (database.dialect === "sqlite") {
      const columns = await database.prepare("PRAGMA table_info(mr_runtime_nodes)").all<{ name: string }>();
      if (!columns.some((column) => column.name === "display_name")) await database.exec("ALTER TABLE mr_runtime_nodes ADD COLUMN display_name TEXT");
      return;
    }
    await database.exec(database.dialect === "tidb"
      ? "ALTER TABLE mr_runtime_nodes ADD COLUMN IF NOT EXISTS display_name LONGTEXT"
      : "ALTER TABLE mr_runtime_nodes ADD COLUMN IF NOT EXISTS display_name TEXT");
  },
}, {
  id: "router/0003_message_attachment_snapshots",
  definition: "mr_tasks.message_attachments_json:v1",
  apply: async (database) => {
    if (database.dialect === "sqlite") {
      const columns = await database.prepare("PRAGMA table_info(mr_tasks)").all<{ name: string }>();
      if (!columns.some((column) => column.name === "message_attachments_json")) {
        await database.exec("ALTER TABLE mr_tasks ADD COLUMN message_attachments_json TEXT NOT NULL DEFAULT '[]'");
      }
      return;
    }
    if (database.dialect === "tidb") {
      // TiDB rejects defaults on LONGTEXT. Add nullable first so existing
      // tasks can be backfilled, then restore the non-null contract.
      await database.exec("ALTER TABLE mr_tasks ADD COLUMN IF NOT EXISTS message_attachments_json LONGTEXT");
      await database.prepare("UPDATE mr_tasks SET message_attachments_json = ? WHERE message_attachments_json IS NULL OR message_attachments_json = ''").run("[]");
      await database.exec("ALTER TABLE mr_tasks MODIFY COLUMN message_attachments_json LONGTEXT NOT NULL");
      return;
    }
    await database.exec("ALTER TABLE mr_tasks ADD COLUMN IF NOT EXISTS message_attachments_json TEXT NOT NULL DEFAULT '[]'");
  },
}, {
  id: "router/0004_conversation_dispatch_locks",
  definition: "mr_conversation_dispatch_locks:v1",
  apply: async (database) => {
    await database.exec(database.dialect === "tidb" ? `CREATE TABLE IF NOT EXISTS mr_conversation_dispatch_locks (
      tenant_id VARCHAR(191) NOT NULL,
      owner_user_id VARCHAR(191) NOT NULL,
      conversation_id VARCHAR(191) NOT NULL,
      assignment_id VARCHAR(191) NOT NULL UNIQUE REFERENCES mr_assignments(id) ON DELETE CASCADE,
      expires_at BIGINT NOT NULL,
      PRIMARY KEY(tenant_id, owner_user_id, conversation_id)
    )` : `CREATE TABLE IF NOT EXISTS mr_conversation_dispatch_locks (
      tenant_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      assignment_id TEXT NOT NULL UNIQUE REFERENCES mr_assignments(id) ON DELETE CASCADE,
      expires_at ${database.dialect === "postgres" ? "BIGINT" : "INTEGER"} NOT NULL,
      PRIMARY KEY(tenant_id, owner_user_id, conversation_id)
    )`);
  },
}, {
  id: "router/0005_artifact_verification_projection",
  definition: "mr_artifacts.verification_json:canonical-read-projection:v1",
  apply: async (database) => {
    if (database.dialect === "sqlite") {
      const columns = await database.prepare("PRAGMA table_info(mr_artifacts)").all<{ name: string }>();
      if (!columns.some((column) => column.name === "verification_json")) {
        await database.exec("ALTER TABLE mr_artifacts ADD COLUMN verification_json TEXT");
      }
      return;
    }
    await database.exec(database.dialect === "tidb"
      ? "ALTER TABLE mr_artifacts ADD COLUMN IF NOT EXISTS verification_json LONGTEXT"
      : "ALTER TABLE mr_artifacts ADD COLUMN IF NOT EXISTS verification_json TEXT");
  },
}, {
  id: "router/0006_external_identity_authority",
  definition: "remove-local-identity-tables-after-explicit-account-service-migration:v1",
  apply: async (database) => {
    // 0001 is historical and created these tables. They are now removed only
    // after the migration tool has copied all rows to Account Service. A
    // non-empty source fails closed so a Router restart cannot silently strand
    // accounts or sessions.
    const users = await database.prepare("SELECT COUNT(*) AS count FROM mr_identity_users").get<{ count: number | bigint }>();
    const count = typeof users?.count === "bigint" ? Number(users.count) : users?.count ?? 0;
    if (count > 0) throw new Error("router_local_identity_migration_required");
    if (database.dialect === "sqlite") await detachSqliteDeviceIdentityForeignKeys(database);
    // TiDB/PostgreSQL deployments keep empty legacy tables until their
    // operator-specific FK migration is applied; no account rows remain in
    // Router and all new schemas omit these references.
    if (database.dialect === "sqlite") {
      await database.exec("DROP TABLE IF EXISTS mr_identity_sessions");
      await database.exec("DROP TABLE IF EXISTS mr_identity_memberships");
      await database.exec("DROP TABLE IF EXISTS mr_identity_users");
      await database.exec("DROP TABLE IF EXISTS mr_identity_tenants");
    }
  },
}];

async function detachSqliteDeviceIdentityForeignKeys(database: SqlConnection): Promise<void> {
  const referencesIdentity = async (table: string): Promise<boolean> => {
    const rows = await database.prepare(`PRAGMA foreign_key_list(${table})`).all<{ table: string }>();
    return rows.some(row => row.table.startsWith("mr_identity_"));
  };
  if (!await referencesIdentity("mr_devices") && !await referencesIdentity("mr_device_registration_tokens") && !await referencesIdentity("mr_device_local_sessions")) return;
  await database.exec(`
    CREATE TABLE mr_devices_external (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
      display_name TEXT NOT NULL, public_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'revoked')), last_seen_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE mr_device_registration_tokens_external (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE mr_device_agent_sessions_external (
      device_id TEXT PRIMARY KEY REFERENCES mr_devices_external(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
    );
    CREATE TABLE mr_device_local_sessions_external (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES mr_devices_external(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    INSERT INTO mr_devices_external SELECT * FROM mr_devices;
    INSERT INTO mr_device_registration_tokens_external SELECT * FROM mr_device_registration_tokens;
    INSERT INTO mr_device_agent_sessions_external SELECT * FROM mr_device_agent_sessions;
    INSERT INTO mr_device_local_sessions_external SELECT * FROM mr_device_local_sessions;
    DROP TABLE mr_device_local_sessions;
    DROP TABLE mr_device_agent_sessions;
    DROP TABLE mr_device_registration_tokens;
    DROP TABLE mr_devices;
    ALTER TABLE mr_devices_external RENAME TO mr_devices;
    ALTER TABLE mr_device_registration_tokens_external RENAME TO mr_device_registration_tokens;
    ALTER TABLE mr_device_agent_sessions_external RENAME TO mr_device_agent_sessions;
    ALTER TABLE mr_device_local_sessions_external RENAME TO mr_device_local_sessions;
    CREATE INDEX mr_devices_owner_idx ON mr_devices(tenant_id, owner_user_id, created_at DESC);
    CREATE INDEX mr_device_registration_tokens_owner_idx ON mr_device_registration_tokens(tenant_id, owner_user_id, created_at DESC);
    CREATE INDEX mr_device_local_sessions_expiry_idx ON mr_device_local_sessions(expires_at);
  `);
}

export async function migrateRouterState(database: SqlConnection): Promise<void> {
  await applyVersionedMigrations(database, "router", MIGRATIONS);
}
