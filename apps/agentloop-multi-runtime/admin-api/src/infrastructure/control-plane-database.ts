import { PgConnection, SqliteConnection, TiDbConnection, type SqlConnection } from "@zhujun/agentloop";
import { assertControlPlaneMigrationsReady } from "../persistence/control-plane-migrations.ts";

/** Opens a configured Admin database without selecting a second schema authority. */
export async function openControlPlaneDatabase(connectionString: string): Promise<SqlConnection> {
  if (connectionString.startsWith("mysql://")) return await TiDbConnection.create(connectionString);
  if (connectionString.startsWith("postgres://") || connectionString.startsWith("postgresql://")) {
    return await PgConnection.create(connectionString);
  }
  if (connectionString.startsWith("file:")) {
    return new SqliteConnection(fileUrlPath(connectionString));
  }
  if (connectionString.startsWith("sqlite:")) {
    return new SqliteConnection(connectionString.slice("sqlite:".length));
  }
  // A plain path is accepted for local SQLite operations. Cloud deployments
  // must use an explicit mysql:// or postgresql:// URL instead.
  if (connectionString.includes("://")) throw new TypeError("Admin database URL must use mysql://, postgresql://, or file:");
  return new SqliteConnection(connectionString);
}

/** Opens an Admin database and verifies the already-applied cp migration ledger. */
export async function openReadyControlPlaneDatabase(connectionString: string): Promise<SqlConnection> {
  const database = await openControlPlaneDatabase(connectionString);
  try {
    await assertControlPlaneMigrationsReady(database);
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

function fileUrlPath(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "file:") throw new TypeError("Admin SQLite URL must use file:");
  return decodeURIComponent(url.pathname);
}
