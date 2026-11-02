import type { SqlConnection } from "@zhujun/agentloop";

/** One registry per embedding host; identical Runtime IDs in other hosts stay isolated. */
export class LocalRuntimeDatabaseRegistry {
  private readonly databases = new Map<string, SqlConnection>();
  register(runtimeId: string, database: SqlConnection): void { this.databases.set(runtimeId, database); }
  unregister(runtimeId: string, database: SqlConnection): void {
    if (this.databases.get(runtimeId) === database) this.databases.delete(runtimeId);
  }
  list(): readonly SqlConnection[] { return [...this.databases.values()]; }
}
