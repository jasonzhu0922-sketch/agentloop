import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isAbsolute } from "node:path";
import type { SqlConnection, SqlValue } from "@zhujun/agentloop";
import { installIdentitySchema } from "@zhujun/agentloop-identity";
import { accountDatabaseConfiguration, openAccountDatabase } from "./database.ts";

const tables = [
  ["mr_identity_users", ["id", "email", "password_hash", "created_at"]],
  ["mr_identity_tenants", ["id", "name", "created_at"]],
  ["mr_identity_profiles", ["user_id", "display_name"]],
  ["mr_identity_memberships", ["tenant_id", "user_id", "role", "created_at"]],
  ["mr_identity_sessions", ["id", "user_id", "token_hash", "expires_at", "created_at"]],
] as const;
type Row = Record<string, SqlValue>;
type Snapshot = { table: string; columns: readonly string[]; rows: Row[] }[];

function fingerprint(snapshot: Snapshot): string {
  // Compare every value, including password/token hashes, without exposing them.
  const canonical = snapshot.map(({ table, columns, rows }) => ({ table,
    rows: rows.map(row => JSON.stringify(columns.map(column => row[column]))).sort() }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function readDestination(destination: SqlConnection): Promise<Snapshot> {
  const snapshot: Snapshot = [];
  for (const [table, columns] of tables) snapshot.push({ table, columns,
    rows: await destination.prepare(`SELECT ${columns.join(",")} FROM ${table}`).all<Row>() });
  return snapshot;
}

/** Exact storage cutover: no account merging, remapping, dropped rows, or source writes. */
export async function migrateAccountSqliteToPostgres(sourcePath: string, destination: SqlConnection, verifyOnly = false) {
  if (!isAbsolute(sourcePath)) throw new Error("account_migration_source_must_be_absolute");
  if (destination.dialect !== "postgres") throw new Error("account_migration_requires_postgres");
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let snapshot: Snapshot;
  try {
    source.exec("BEGIN");
    const integrity = source.prepare("PRAGMA quick_check").all();
    if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok" || source.prepare("PRAGMA foreign_key_check").all().length) throw new Error("account_migration_source_integrity_failed");
    // Account schema v1 has four tables; v2 adds optional display-name profiles.
    // This is a one-time schema upgrade, not a second runtime account reader.
    const names = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
    const expectedNames = new Set(tables.map(([table]) => table));
    if ([...names].some(name => !expectedNames.has(name as typeof tables[number][0]))
      || tables.some(([table]) => table !== "mr_identity_profiles" && !names.has(table))) throw new Error("account_migration_source_schema_invalid");
    snapshot = tables.map(([table, columns]) => ({ table, columns,
      rows: table === "mr_identity_profiles" && !names.has(table) ? []
        : source.prepare(`SELECT ${columns.join(",")} FROM ${table}`).all() as Row[] }));
    source.exec("COMMIT");
  } finally { source.close(); }
  const expected = fingerprint(snapshot);
  await destination.transaction(async () => {
    await destination.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get("agentloop.account-service.identity-migration");
    if (!verifyOnly) {
      await installIdentitySchema(destination);
      const existing = await readDestination(destination);
      if (existing.some(table => table.rows.length > 0)) throw new Error("account_migration_destination_not_empty");
      for (const { table, columns, rows } of snapshot) {
        const statement = destination.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
        for (const row of rows) await statement.run(...columns.map(column => row[column]!));
      }
    }
    if (fingerprint(await readDestination(destination)) !== expected) throw new Error("account_migration_verification_failed");
  });
  return { verified: true, fingerprint: expected, counts: Object.fromEntries(snapshot.map(({ table, rows }) => [table, rows.length])) };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] !== "--source" || !args[1] || args.length > 3 || (args[2] !== undefined && args[2] !== "--verify-only")) throw new Error("account_migration_arguments_invalid");
  const configuration = accountDatabaseConfiguration();
  if (configuration.driver !== "postgres") throw new Error("account_migration_requires_postgres");
  const destination = await openAccountDatabase(configuration);
  try { console.log(JSON.stringify(await migrateAccountSqliteToPostgres(args[1], destination, args[2] === "--verify-only"))); }
  finally { await destination.close(); }
}
if (import.meta.main) void main().catch(() => {
  console.error("Account migration failed; source is unchanged. Check source integrity, PostgreSQL configuration and an empty destination.");
  process.exitCode = 1;
});
