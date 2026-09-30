import { createServer, type Server } from "node:http";
import type { AdminAuthorizationPort } from "../authorization/ports.ts";
import type { ReleaseApplicationService } from "../application/release-service.ts";
import { createAdminHttpHandler, type IntegrationDeliveryPort, type RuntimeConfigurationSnapshotPort } from "../transport/admin-http/handler.ts";

/**
 * WP-0 composition root. No migration, state-store, Router, Host, Local Agent,
 * or secret adapter is constructed here.
 */
export function createAdminApiServer(input: { readonly authorization: AdminAuthorizationPort; readonly releases?: ReleaseApplicationService; readonly snapshots?: RuntimeConfigurationSnapshotPort; readonly integrations?: IntegrationDeliveryPort }): Server {
  return createServer(createAdminHttpHandler(input));
}
