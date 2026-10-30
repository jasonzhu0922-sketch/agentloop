import type { SqlConnection } from "@zhujun/agentloop";

const databases = new Map<string, SqlConnection>();

export function registerLocalRuntimeDatabase(runtimeId: string, database: SqlConnection): void {
  databases.set(runtimeId, database);
}

export function unregisterLocalRuntimeDatabase(runtimeId: string, database: SqlConnection): void {
  if (databases.get(runtimeId) === database) databases.delete(runtimeId);
}

export function localRuntimeDatabases(): readonly SqlConnection[] {
  return [...databases.values()];
}
