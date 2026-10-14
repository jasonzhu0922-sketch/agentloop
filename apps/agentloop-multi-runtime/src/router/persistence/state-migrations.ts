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
}];

export async function migrateRouterState(database: SqlConnection): Promise<void> {
  await applyVersionedMigrations(database, "router", MIGRATIONS);
}
