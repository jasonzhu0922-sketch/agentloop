import { TiDbConnection } from "@zhujun/agentloop";
import { controlPlaneMigrationIds, migrateControlPlane } from "../src/persistence/control-plane-migrations.ts";

const connectionString = process.env.CONTROL_PLANE_DATABASE_URL;
if (connectionString === undefined || !connectionString.startsWith("mysql://")) {
  throw new Error("CONTROL_PLANE_DATABASE_URL must be an explicit TiDB mysql:// URL; no default target is used");
}
if (!process.argv.includes("--apply")) {
  process.stdout.write(`${JSON.stringify({ mode: "dry_run", migrations: controlPlaneMigrationIds() })}\n`);
  process.exitCode = 2;
} else {
  const database = await TiDbConnection.create(connectionString);
  try {
    await migrateControlPlane(database);
    process.stdout.write(`${JSON.stringify({ mode: "applied", migrations: controlPlaneMigrationIds() })}\n`);
  } finally {
    await database.close();
  }
}
