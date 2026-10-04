import { createAdminApiServer } from "./bootstrap/server.ts";
import { DenyAllAuthorization } from "./authorization/deny-all-authorization.ts";
import { StaticTokenAuthorization } from "./authorization/static-token-authorization.ts";
import { PasswordAuthorization } from "./authorization/password-authorization.ts";
import { DatabaseAdminAuthorization } from "./authorization/database-authorization.ts";
import { ReleaseApplicationService } from "./application/release-service.ts";
import { RuntimeConfigurationSnapshotService } from "./application/runtime-configuration-snapshot-service.ts";
import { CustomSkillCatalogApplicationService } from "./application/custom-skill-catalog-service.ts";
import { RouterRunOperationsService } from "./application/run-operations-service.ts";
import { RouterRuntimeInventoryService } from "./application/runtime-inventory-service.ts";
import { RouterBusinessUserOperationsService } from "./application/business-user-operations-service.ts";
import { RouterModelCatalogService } from "./application/router-model-catalog-service.ts";
import { openReadyControlPlaneDatabase } from "./infrastructure/control-plane-database.ts";
import { SqlControlPlaneStore } from "./persistence/sql-control-plane-store.ts";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdminMemberRole } from "../../control-plane/contracts/index.ts";

// Keep the standalone local Admin API outside the Runtime Host port range
// (8791, 8792, ...). Production deployments provide their own explicit port.
const port = Number(process.env.ADMIN_API_PORT ?? "8892");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new TypeError("ADMIN_API_PORT must be a TCP port");

const connectionString = process.env.AGENTLOOP_ADMIN_DATABASE_URL;
const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const customSkills = new CustomSkillCatalogApplicationService([resolve(appRoot, process.env.ADMIN_CUSTOM_SKILLS_PATH ?? "./custom-skills")]);
const database = connectionString === undefined ? undefined : await openReadyControlPlaneDatabase(connectionString);
const store = database === undefined ? undefined : new SqlControlPlaneStore(database);
const releases = store === undefined ? undefined : new ReleaseApplicationService(store);
const routerUrl = process.env.ADMIN_ROUTER_URL;
// Admin and Router share one internal dispatch credential.
const routerToken = process.env.RUNTIME_DISPATCH_TOKEN;
const routerConfigured = routerUrl !== undefined && routerToken !== undefined;
if ((routerUrl === undefined) !== (routerToken === undefined)) throw new TypeError("ADMIN_ROUTER_URL and RUNTIME_DISPATCH_TOKEN must be configured together");
// Provider/model configuration has exactly one authority: Router. Admin is
// only its authenticated management surface; it never falls back to
// cp_releases for a second model catalog.
const models = routerConfigured ? new RouterModelCatalogService({ baseUrl: routerUrl!, token: routerToken! }) : undefined;
const snapshots = store === undefined ? undefined : new RuntimeConfigurationSnapshotService({
  repository: store, now: () => Date.now(), ttlMs: positiveInteger(process.env.CONTROL_PLANE_SNAPSHOT_TTL_MS, 60_000),
  ...(models === undefined ? {} : { modelConfiguration: models }),
});
const runOperations = routerConfigured ? new RouterRunOperationsService({ baseUrl: routerUrl!, token: routerToken! }) : undefined;
const runtimeInventory = routerConfigured ? new RouterRuntimeInventoryService({ baseUrl: routerUrl!, token: routerToken! }) : undefined;
const businessUsers = routerConfigured ? new RouterBusinessUserOperationsService({ baseUrl: routerUrl!, token: routerToken! }) : undefined;
const server = createAdminApiServer({ authorization: authorizationFromEnvironment(store), skills: customSkills, ...(releases === undefined ? {} : { releases }), ...(models === undefined ? {} : { models }), ...(snapshots === undefined ? {} : { snapshots }), ...(runOperations === undefined ? {} : { runOperations }), ...(runtimeInventory === undefined ? {} : { runtimeInventory }), ...(businessUsers === undefined ? {} : { businessUsers }), ...(store === undefined ? {} : { identity: store, users: store, audit: store, catalog: store }) });
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`AgentLoop Admin API scaffold listening on 127.0.0.1:${port}\n`);
});
async function shutdown(): Promise<void> {
  server.close();
  await database?.close();
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 86_400_000) throw new TypeError("CONTROL_PLANE_SNAPSHOT_TTL_MS must be a positive millisecond duration");
  return parsed;
}

function authorizationFromEnvironment(userStore?: SqlControlPlaneStore) {
  if (process.env.ADMIN_AUTH_MODE === "password") {
    const username = process.env.ADMIN_AUTH_USERNAME;
    const passwordHash = process.env.ADMIN_AUTH_PASSWORD_HASH;
    if (username === undefined || passwordHash === undefined) throw new TypeError("ADMIN_AUTH_USERNAME and ADMIN_AUTH_PASSWORD_HASH are required when ADMIN_AUTH_MODE=password");
    const fallback = { username, passwordHash, role: adminRole(), actorId: process.env.ADMIN_AUTH_ACTOR_ID ?? username, ...(process.env.ADMIN_AUTH_SCOPE_ID === undefined ? {} : { scopeId: process.env.ADMIN_AUTH_SCOPE_ID }) };
    return userStore === undefined
      ? new PasswordAuthorization({ ...fallback, sessionTtlMs: positiveInteger(process.env.ADMIN_AUTH_SESSION_TTL_MS, 8 * 60 * 60 * 1000) })
      : new DatabaseAdminAuthorization({ users: userStore, fallback, sessionTtlMs: positiveInteger(process.env.ADMIN_AUTH_SESSION_TTL_MS, 8 * 60 * 60 * 1000) });
  }
  if (process.env.ADMIN_AUTH_MODE !== "static") return new DenyAllAuthorization();
  const token = process.env.ADMIN_AUTH_TOKEN;
  if (token === undefined) throw new TypeError("ADMIN_AUTH_TOKEN is required when ADMIN_AUTH_MODE=static");
  const role = process.env.ADMIN_AUTH_ROLE;
  if (role !== "platform_admin" && role !== "operator" && role !== "skill_operator" && role !== "auditor" && role !== "member") throw new TypeError("ADMIN_AUTH_ROLE must be platform_admin, operator, skill_operator, auditor, or member");
  return new StaticTokenAuthorization({ token, role, actorId: process.env.ADMIN_AUTH_ACTOR_ID ?? "bootstrap-admin", ...(process.env.ADMIN_AUTH_SCOPE_ID === undefined ? {} : { scopeId: process.env.ADMIN_AUTH_SCOPE_ID }) });
}

function adminRole(): AdminMemberRole {
  const role = process.env.ADMIN_AUTH_ROLE;
  if (role !== "platform_admin" && role !== "operator" && role !== "skill_operator" && role !== "auditor" && role !== "member") throw new TypeError("ADMIN_AUTH_ROLE must be platform_admin, operator, skill_operator, auditor, or member");
  return role;
}
