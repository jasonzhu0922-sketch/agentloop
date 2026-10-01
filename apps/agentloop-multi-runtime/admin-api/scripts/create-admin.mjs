import { randomUUID } from "node:crypto";
import { TiDbConnection } from "@zhujun/agentloop";
import { assertControlPlaneMigrationsReady } from "../src/persistence/control-plane-migrations.ts";
import { SqlControlPlaneStore } from "../src/persistence/sql-control-plane-store.ts";

const connectionString = process.env.CONTROL_PLANE_DATABASE_URL;
if (connectionString === undefined || !connectionString.startsWith("mysql://")) {
  throw new Error("CONTROL_PLANE_DATABASE_URL must be an explicit TiDB mysql:// URL; no default target is used");
}

const args = parseArgs(process.argv.slice(2));
const tenantId = required(args["tenant-id"], "--tenant-id");
const subject = required(args.subject, "--subject");
const displayName = required(args["display-name"] ?? subject, "--display-name");
const memberId = args["member-id"] ?? `admin-${subject.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
const role = args.role ?? "platform_admin";
if (!["platform_admin", "operator", "skill_operator", "auditor", "member"].includes(role)) throw new Error("--role must be platform_admin, operator, skill_operator, auditor, or member");

const database = await TiDbConnection.create(connectionString);
try {
  await assertControlPlaneMigrationsReady(database);
  const store = new SqlControlPlaneStore(database);
  const now = Date.now();
  await store.createMember({
    contractVersion: "control-plane/v1", memberId, tenantId, subject, displayName,
    role, status: "active", revision: 1, createdAt: now, updatedAt: now,
  }, 0, `bootstrap:${subject}`, `admin-bootstrap:${randomUUID()}`);
  process.stdout.write(`${JSON.stringify({ status: "created", memberId, tenantId, subject, role })}\n`);
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
