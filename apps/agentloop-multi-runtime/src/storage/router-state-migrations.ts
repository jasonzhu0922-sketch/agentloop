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
}];

export async function migrateRouterState(database: SqlConnection): Promise<void> {
  await applyVersionedMigrations(database, "router", MIGRATIONS);
}
