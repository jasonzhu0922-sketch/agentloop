import { AppDatabase, type SqlConnection } from "@zhujun/agentloop";
import { installHostDispatchSchema } from "../runtime/host-dispatch-store.ts";
import { applyVersionedMigrations, SchemaMigrationError, type SchemaMigration } from "./schema-migration-ledger.ts";

const MIGRATIONS: readonly SchemaMigration[] = [
  { id: "runtime/0001_agentloop_kernel", definition: "agentloop-kernel-canonical-schema;legacy-sqlite-upgrades:v1", apply: async (database) => {
    if (!(database instanceof AppDatabase)) throw new SchemaMigrationError("Runtime kernel migration requires an AppDatabase facade");
    await database.installKernelSchema();
  } },
  { id: "runtime/0002_host_dispatch_ledger", definition: "host-dispatch-ledger;run-executor-ownership:v1", apply: installHostDispatchSchema },
];

export async function migrateRuntimeState(database: SqlConnection): Promise<void> {
  await applyVersionedMigrations(database, "runtime", MIGRATIONS);
}
