import { randomUUID } from "node:crypto";
import { TiDbConnection } from "@zhujun/agentloop";
import { assertControlPlaneMigrationsReady } from "../src/persistence/control-plane-migrations.ts";
import { hashAdminPassword } from "../src/authorization/password-authorization.ts";
import { SqlControlPlaneStore } from "../src/persistence/sql-control-plane-store.ts";

const connectionString = process.env.AGENTLOOP_ADMIN_DATABASE_URL;
if (connectionString === undefined || !connectionString.startsWith("mysql://")) {
  throw new Error("AGENTLOOP_ADMIN_DATABASE_URL must be an explicit TiDB mysql:// URL for the dedicated admin database; no default target is used");
}

const args = parseArgs(process.argv.slice(2));
const username = required(args.username, "--username");
const password = required(args.password, "--password");
const displayName = args["display-name"] ?? username;
const userId = args["user-id"] ?? `admin-user-${username.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
const role = args.role ?? "platform_admin";
if (!["platform_admin", "operator", "skill_operator", "auditor", "member"].includes(role)) throw new Error("--role must be platform_admin, operator, skill_operator, auditor, or member");

const database = await TiDbConnection.create(connectionString);
try {
  await assertControlPlaneMigrationsReady(database);
  const store = new SqlControlPlaneStore(database);
  const now = Date.now();
  await store.createAdminUser({
    user: { contractVersion: "control-plane/v1", userId, username, displayName, ...(args["scope-id"] === undefined ? {} : { scopeId: args["scope-id"] }), role, status: "active", revision: 1, createdAt: now, updatedAt: now },
    passwordHash: hashAdminPassword(password), expectedRevision: 0, actorId: `bootstrap:${username}`, auditEventId: `admin-user-bootstrap:${randomUUID()}`,
  });
  process.stdout.write(`${JSON.stringify({ status: "created", userId, username, role })}\n`);
} finally {
  await database.close();
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected argument ${value}`);
    const key = value.slice(2);
    const next = values[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`Missing value for --${key}`);
    result[key] = next;
    index += 1;
  }
  return result;
}

function required(value, flag) {
  if (value === undefined || value.trim() === "") throw new Error(`${flag} is required`);
  return value;
}
