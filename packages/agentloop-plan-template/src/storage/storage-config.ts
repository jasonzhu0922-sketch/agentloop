import type { PlanTemplateStorageConfig } from "../config.ts";

export function normalizeSchemaName(value: string | undefined): string {
  const schema = value?.trim() || "agentloop_plan_template";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error("PlanTemplate postgres schemaName must be a simple SQL identifier");
  }
  return schema;
}

export function sqliteDatabasePath(config: PlanTemplateStorageConfig): string {
  if (config.type !== "sqlite") throw new Error("PlanTemplate storage config is not sqlite");
  if (config.databasePath.trim().length === 0) {
    throw new Error("PlanTemplate sqlite databasePath is required");
  }
  return config.databasePath;
}
