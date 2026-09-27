import type { SqlConnection } from "@zhujun/agentloop";
import { installArtifactCatalogSchema } from "../artifacts/shared-workspace-artifact-catalog.ts";
import { installAttachmentSchema } from "../attachments/shared-filesystem-attachment-broker.ts";
import { installIdentitySchema } from "../auth/identity-service.ts";
import { installControlPlaneSchema } from "../control-plane/control-plane-store.ts";
import { installDeviceSchema } from "../devices/device-service.ts";
import { applyVersionedMigrations, type SchemaMigration } from "./schema-migration-ledger.ts";

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
    await database.exec("ALTER TABLE mr_runtime_nodes ADD COLUMN IF NOT EXISTS display_name TEXT");
  },
}];

export async function migrateRouterState(database: SqlConnection): Promise<void> {
  await applyVersionedMigrations(database, "router", MIGRATIONS);
}
