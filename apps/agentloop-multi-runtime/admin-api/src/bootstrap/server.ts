import { createServer, type Server } from "node:http";
import type { AdminAuthorizationPort } from "../authorization/ports.ts";
import type { ReleaseApplicationService } from "../application/release-service.ts";
import { createAdminHttpHandler, type IntegrationDeliveryPort, type RuntimeConfigurationSnapshotPort, type SkillArtifactDeliveryPort } from "../transport/admin-http/handler.ts";
import type { AdminAuditPort, AdminCatalogPort, AdminIdentityPort, AdminTracePort, AdminUserDirectoryPort, BusinessUserOperationsPort, RunOperationsPort, RuntimeInventoryPort, RuntimeOperationPort } from "../application/admin-ports.ts";
import type { ModelCatalogPort } from "../application/model-catalog-service.ts";
import type { CustomSkillCatalogApplicationService } from "../application/custom-skill-catalog-service.ts";

/**
 * WP-0 composition root. No migration, state-store, Router, Host, Local Agent,
 * or secret adapter is constructed here.
 */
export function createAdminApiServer(input: { readonly authorization: AdminAuthorizationPort; readonly releases?: ReleaseApplicationService; readonly models?: ModelCatalogPort; readonly skills?: CustomSkillCatalogApplicationService; readonly snapshots?: RuntimeConfigurationSnapshotPort; readonly integrations?: IntegrationDeliveryPort; readonly skillArtifacts?: SkillArtifactDeliveryPort; readonly identity?: AdminIdentityPort; readonly users?: AdminUserDirectoryPort; readonly businessUsers?: BusinessUserOperationsPort; readonly audit?: AdminAuditPort; readonly catalog?: AdminCatalogPort; readonly trace?: AdminTracePort; readonly runOperations?: RunOperationsPort; readonly runtimeInventory?: RuntimeInventoryPort; readonly runtimeOperations?: RuntimeOperationPort }): Server {
  return createServer(createAdminHttpHandler(input));
}
