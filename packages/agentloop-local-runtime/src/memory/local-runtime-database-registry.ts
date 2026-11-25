import type { RuntimePersistenceInput } from "@zhujun/agentloop";

/** One registry per embedding host; identical Runtime IDs in other hosts stay isolated. */
export class LocalRuntimeDatabaseRegistry {
  private readonly databases = new Map<string, RuntimePersistenceInput>();
  register(runtimeId: string, database: RuntimePersistenceInput): void { this.databases.set(runtimeId, database); }
  unregister(runtimeId: string, database: RuntimePersistenceInput): void {
    if (this.databases.get(runtimeId) === database) this.databases.delete(runtimeId);
  }
  list(): readonly RuntimePersistenceInput[] { return [...this.databases.values()]; }
  entries(): readonly { readonly sourceId: string; readonly database: RuntimePersistenceInput }[] {
    return [...this.databases].map(([sourceId, database]) => ({ sourceId, database }));
  }
}
