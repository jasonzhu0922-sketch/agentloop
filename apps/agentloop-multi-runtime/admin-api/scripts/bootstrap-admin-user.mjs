import { randomUUID } from "node:crypto";
import { TiDbConnection } from "@zhujun/agentloop";
import { assertControlPlaneMigrationsReady } from "../src/persistence/control-plane-migrations.ts";
import { SqlControlPlaneStore } from "../src/persistence/sql-control-plane-store.ts";

const connectionString = process.env.AGENTLOOP_ADMIN_DATABASE_URL;
if (connectionString === undefined || !connectionString.startsWith("mysql://")) {
  throw new Error("AGENTLOOP_ADMIN_DATABASE_URL must be an explicit TiDB mysql:// URL for the dedicated admin database; no default target is used");
}
if (process.env.ADMIN_AUTH_MODE !== "password") throw new Error("ADMIN_AUTH_MODE=password is required to bootstrap the configured Admin user");
const username = required(process.env.ADMIN_AUTH_USERNAME, "ADMIN_AUTH_USERNAME");
const passwordHash = required(process.env.ADMIN_AUTH_PASSWORD_HASH, "ADMIN_AUTH_PASSWORD_HASH");
const role = required(process.env.ADMIN_AUTH_ROLE, "ADMIN_AUTH_ROLE");
if (!["platform_admin", "operator", "skill_operator", "auditor", "member"].includes(role)) throw new Error("ADMIN_AUTH_ROLE is invalid");
const userId = process.env.ADMIN_AUTH_ACTOR_ID ?? `admin-user-${username.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;

const database = await TiDbConnection.create(connectionString);
try {
  await assertControlPlaneMigrationsReady(database);
  const store = new SqlControlPlaneStore(database);
  const existing = await store.findAdminUserCredential(username);
  if (existing !== undefined) {
    process.stdout.write(`${JSON.stringify({ status: "existing", userId: existing.userId, username: existing.username })}\n`);
  } else {
    const now = Date.now();
    await store.createAdminUser({
      user: {
        contractVersion: "control-plane/v1", userId, username,
        displayName: process.env.ADMIN_AUTH_DISPLAY_NAME ?? username,
        ...(process.env.ADMIN_AUTH_SCOPE_ID === undefined ? {} : { scopeId: process.env.ADMIN_AUTH_SCOPE_ID }),
        role, status: "active", revision: 1, createdAt: now, updatedAt: now,
      },
      passwordHash, expectedRevision: 0, actorId: userId, auditEventId: `admin-user-bootstrap:${randomUUID()}`,
    });
    process.stdout.write(`${JSON.stringify({ status: "created", userId, username, role })}\n`);
  }
} finally {
  await database.close();
}

function required(value, name) {
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}
