import { TiDbConnection, type SqlConnection } from "@zhujun/agentloop";
import { assertControlPlaneMigrationsReady } from "../persistence/control-plane-migrations.ts";

/** Opens only a configured TiDB connection and verifies the already-applied cp migration ledger. */
export async function openReadyControlPlaneDatabase(connectionString: string): Promise<SqlConnection> {
  if (!connectionString.startsWith("mysql://")) throw new TypeError("AGENTLOOP_ADMIN_DATABASE_URL must be a TiDB mysql:// URL for the dedicated admin database");
  const database = await TiDbConnection.create(connectionString);
  try {
    await assertControlPlaneMigrationsReady(database);
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}
