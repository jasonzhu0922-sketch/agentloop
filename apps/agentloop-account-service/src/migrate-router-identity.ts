import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { SqliteConnection } from "@zhujun/agentloop";
import { clearLegacyIdentityRows, migrateIdentityRows, rewriteIdentityReferences } from "@zhujun/agentloop-identity";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const sourcePath = argument("--source") ?? process.env.ROUTER_IDENTITY_DATABASE_PATH;
  if (!sourcePath) throw new Error("usage: npm run migrate:router-identity -- --source /absolute/path/to/router.sqlite [--target /absolute/path/to/accounts.db]");
  const source = resolve(sourcePath);
  const target = resolve(argument("--target") ?? process.env.ACCOUNT_SERVICE_DATABASE_PATH ?? "data/accounts.db");
  if (source === target) throw new Error("migration_source_and_target_must_differ");
  await stat(source);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    await stat(target);
    const backup = `${target}.backup-${new Date().toISOString().replace(/[-:.TZ]/g, "")}`;
    await copyFile(target, backup);
    console.log(`Account Service database backup: ${backup}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const sourceBackup = `${source}.backup-${new Date().toISOString().replace(/[-:.TZ]/g, "")}`;
  await copyFile(source, sourceBackup);
  console.log(`Router source backup: ${sourceBackup}`);
  const sourceDb = new SqliteConnection(source); const targetDb = new SqliteConnection(target);
  try {
    const result = await migrateIdentityRows(sourceDb, targetDb);
    await rewriteIdentityReferences(sourceDb, result);
    await clearLegacyIdentityRows(sourceDb);
    console.log(`Migrated identity rows: users=${result.users}, tenants=${result.tenants}, memberships=${result.memberships}, sessions=${result.sessions}`);
  } finally { await sourceDb.close(); await targetDb.close(); }
}

if (import.meta.main) void main().catch(error => { console.error(`Identity migration failed: ${error instanceof Error ? error.message : "unknown_error"}`); process.exitCode = 1; });
