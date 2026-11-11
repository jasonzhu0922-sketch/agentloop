import type { SqlConnection } from "@zhujun/agentloop";
import { installIdentitySchema } from "./service.ts";

interface User { id: string; email: string; password_hash: string; created_at: number }
interface Tenant { id: string; name: string; created_at: number }
interface Membership { tenant_id: string; user_id: string; role: string; created_at: number }
interface Session { id: string; user_id: string; token_hash: string; expires_at: number; created_at: number }
interface Profile { user_id: string; display_name: string }

export interface IdentityMigrationResult {
  readonly users: number;
  readonly tenants: number;
  readonly memberships: number;
  readonly sessions: number;
  readonly userIdMap: Readonly<Record<string, string>>;
  readonly tenantIdMap: Readonly<Record<string, string>>;
}

/**
 * Copy the legacy Router identity rows into the standalone Account Service.
 * The source is never modified. Destination conflicts abort its transaction;
 * callers should stop both services and make a backup before invoking this.
 */
export async function migrateIdentityRows(source: SqlConnection, destination: SqlConnection): Promise<IdentityMigrationResult> {
  const users = await readRows<User>(source, "SELECT id, email, password_hash, created_at FROM mr_identity_users");
  const tenants = await readRows<Tenant>(source, "SELECT id, name, created_at FROM mr_identity_tenants");
  const memberships = await readRows<Membership>(source, "SELECT tenant_id, user_id, role, created_at FROM mr_identity_memberships");
  const sessions = await readRows<Session>(source, "SELECT id, user_id, token_hash, expires_at, created_at FROM mr_identity_sessions");
  const profiles = await readRows<Profile>(source, "SELECT user_id, display_name FROM mr_identity_profiles");
  await installIdentitySchema(destination);
  const destinationUsers = await readRows<User>(destination, "SELECT id, email, password_hash, created_at FROM mr_identity_users");
  const destinationTenants = await readRows<Tenant>(destination, "SELECT id, name, created_at FROM mr_identity_tenants");
  const destinationMemberships = await readRows<Membership>(destination, "SELECT tenant_id, user_id, role, created_at FROM mr_identity_memberships");
  const userIdMap: Record<string, string> = {};
  const tenantIdMap: Record<string, string> = {};
  const byEmail = new Map(destinationUsers.map(row => [row.email, row]));
  const byId = new Map(destinationUsers.map(row => [row.id, row]));
  const destinationUserIds = new Set(destinationUsers.map(row => row.id));
  for (const row of users) {
    const sameId = byId.get(row.id); const sameEmail = byEmail.get(row.email);
    if (sameId && sameId.email !== row.email) throw new Error("identity_id_conflict");
    if (sameEmail) userIdMap[row.id] = sameEmail.id;
    else userIdMap[row.id] = row.id;
  }
  const ownerTenantByUser = new Map(destinationMemberships.filter(row => row.role === "owner").map(row => [row.user_id, row.tenant_id]));
  const tenantById = new Map(destinationTenants.map(row => [row.id, row]));
  const destinationTenantIds = new Set(destinationTenants.map(row => row.id));
  const sourceMembershipsByTenant = new Map<string, Membership[]>();
  for (const row of memberships) sourceMembershipsByTenant.set(row.tenant_id, [...(sourceMembershipsByTenant.get(row.tenant_id) ?? []), row]);
  for (const row of tenants) {
    if (tenantById.has(row.id)) { tenantIdMap[row.id] = row.id; continue; }
    const mappedOwner = sourceMembershipsByTenant.get(row.id)?.find(member => member.role === "owner");
    const existingOwnerTenant = mappedOwner === undefined ? undefined : ownerTenantByUser.get(userIdMap[mappedOwner.user_id]!);
    tenantIdMap[row.id] = existingOwnerTenant ?? row.id;
  }
  await destination.transaction(async () => {
    for (const row of users) {
      if (userIdMap[row.id] === row.id && !destinationUserIds.has(row.id)) {
        await destination.prepare("INSERT INTO mr_identity_users(id, email, password_hash, created_at) VALUES (?, ?, ?, ?)").run(row.id, row.email, row.password_hash, row.created_at);
        destinationUserIds.add(row.id);
      }
    }
    for (const row of tenants) {
      if (tenantIdMap[row.id] === row.id && !destinationTenantIds.has(row.id)) {
        await destination.prepare("INSERT INTO mr_identity_tenants(id, name, created_at) VALUES (?, ?, ?)").run(row.id, row.name, row.created_at);
        destinationTenantIds.add(row.id);
      }
    }
    for (const row of memberships) {
      const tenantId = tenantIdMap[row.tenant_id]!, userId = userIdMap[row.user_id]!;
      const existing = await destination.prepare("SELECT 1 FROM mr_identity_memberships WHERE tenant_id = ? AND user_id = ?").get(tenantId, userId);
      if (!existing) await destination.prepare("INSERT INTO mr_identity_memberships(tenant_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").run(tenantId, userId, row.role, row.created_at);
    }
    for (const row of sessions) {
      const existing = await destination.prepare("SELECT user_id, token_hash FROM mr_identity_sessions WHERE id = ?").get<{ user_id: string; token_hash: string }>(row.id);
      if (existing) { if (existing.token_hash !== row.token_hash) throw new Error("identity_session_id_conflict"); continue; }
      await destination.prepare("INSERT INTO mr_identity_sessions(id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(row.id, userIdMap[row.user_id]!, row.token_hash, row.expires_at, row.created_at);
    }
    for (const row of profiles) {
      const userId = userIdMap[row.user_id]!;
      const existing = await destination.prepare("SELECT 1 FROM mr_identity_profiles WHERE user_id = ?").get(userId);
      if (!existing) await destination.prepare("INSERT INTO mr_identity_profiles(user_id, display_name) VALUES (?, ?)").run(userId, row.display_name);
    }
  });
  return { users: users.length, tenants: tenants.length, memberships: memberships.length, sessions: sessions.length, userIdMap, tenantIdMap };
}

/** Rewrite Router business ownership references before its legacy identity tables are retired. */
export async function rewriteIdentityReferences(source: SqlConnection, mapping: Pick<IdentityMigrationResult, "userIdMap" | "tenantIdMap">): Promise<void> {
  const tables = await readRows<{ name: string }>(source, "SELECT name FROM sqlite_master WHERE type = 'table'");
  await source.exec("PRAGMA foreign_keys = OFF");
  await source.transaction(async () => {
    for (const table of tables.map(row => row.name).filter(name => !name.startsWith("mr_identity_") && name !== "mr_schema_migrations" && name !== "sqlite_sequence")) {
      const columns = await readRows<{ name: string }>(source, `PRAGMA table_info("${table.replaceAll('"', '""')}")`);
      const names = new Set(columns.map(column => column.name));
      if (names.has("owner_user_id")) for (const [from, to] of Object.entries(mapping.userIdMap)) if (from !== to) await source.prepare(`UPDATE "${table.replaceAll('"', '""')}" SET owner_user_id = ? WHERE owner_user_id = ?`).run(to, from);
      if (names.has("user_id")) for (const [from, to] of Object.entries(mapping.userIdMap)) if (from !== to) await source.prepare(`UPDATE "${table.replaceAll('"', '""')}" SET user_id = ? WHERE user_id = ?`).run(to, from);
      if (names.has("tenant_id")) for (const [from, to] of Object.entries(mapping.tenantIdMap)) if (from !== to) await source.prepare(`UPDATE "${table.replaceAll('"', '""')}" SET tenant_id = ? WHERE tenant_id = ?`).run(to, from);
    }
  });
}

export async function clearLegacyIdentityRows(source: SqlConnection): Promise<void> {
  const profiles = await readRows<Profile>(source, "SELECT user_id, display_name FROM mr_identity_profiles");
  await source.exec("PRAGMA foreign_keys = OFF");
  await source.transaction(async () => {
    await source.prepare("DELETE FROM mr_identity_sessions").run();
    await source.prepare("DELETE FROM mr_identity_memberships").run();
    if (profiles.length) await source.prepare("DELETE FROM mr_identity_profiles").run();
    await source.prepare("DELETE FROM mr_identity_users").run();
    await source.prepare("DELETE FROM mr_identity_tenants").run();
  });
}

async function readRows<T>(database: SqlConnection, sql: string): Promise<T[]> {
  try { return await database.prepare(sql).all<T>(); }
  catch (error) {
    const message = String(error);
    if (/no such table|doesn't exist|does not exist/i.test(message)) return [];
    throw error;
  }
}
