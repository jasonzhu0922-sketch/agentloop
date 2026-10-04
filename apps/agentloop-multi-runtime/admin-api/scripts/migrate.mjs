import { openControlPlaneDatabase } from "../src/infrastructure/control-plane-database.ts";
import { controlPlaneMigrationIds, migrateControlPlane } from "../src/persistence/control-plane-migrations.ts";

const connectionString = process.env.AGENTLOOP_ADMIN_DATABASE_URL ?? process.env.AGENTLOOP_ADMIN_DATABASE_PATH;
if (connectionString === undefined || connectionString.trim() === "") {
  throw new Error("Set AGENTLOOP_ADMIN_DATABASE_URL (mysql:// or postgresql://) or AGENTLOOP_ADMIN_DATABASE_PATH for SQLite; no default target is used");
}
if (!process.argv.includes("--apply")) {
  process.stdout.write(`${JSON.stringify({ mode: "dry_run", migrations: controlPlaneMigrationIds() })}\n`);
  process.exitCode = 2;
} else {
  const database = await openControlPlaneDatabase(connectionString);
  try {
    await migrateControlPlane(database);
    process.stdout.write(`${JSON.stringify({ mode: "applied", migrations: controlPlaneMigrationIds() })}\n`);
  } finally {
    await database.close();
  }
}
