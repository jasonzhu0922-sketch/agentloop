import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openStateDatabase, stateDatabaseConfigFromEnvironment } from "../src/shared/persistence/state-database.ts";
import { migrateRouterState } from "../src/router/persistence/state-migrations.ts";
import { migrateRuntimeState } from "../src/runtime-host/persistence/state-migrations.ts";

/**
 * Explicit, standalone state migration entry point for every supported
 * backend. Startup still runs the same idempotent migrations as a readiness
 * guard, but production operators can now run and audit them before starting
 * Router/Runtime writers.
 *
 * Examples:
 *   AGENTLOOP_STATE_DRIVER=sqlite AGENTLOOP_STATE_SQLITE_PATH=./data/state.db \
 *     node scripts/migrate-shared-state.mjs --role both --apply
 *   AGENTLOOP_ROUTER_STATE_DRIVER=postgres \
 *   AGENTLOOP_ROUTER_STATE_DATABASE_URL=postgresql://... \
 *     node scripts/migrate-shared-state.mjs --role router --apply
 */

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const role = argumentValue("--role") ?? "both";
const driverOverride = argumentValue("--driver");
const apply = process.argv.includes("--apply");

if (role !== "router" && role !== "runtime" && role !== "both") {
  throw new Error("--role must be router, runtime, or both");
}
if (driverOverride !== undefined && !["sqlite", "postgres", "tidb"].includes(driverOverride)) {
  throw new Error("--driver must be sqlite, postgres, or tidb");
}

const roles = role === "both" ? ["router", "runtime"] : [role];
const plans = roles.map((currentRole) => ({
  role: currentRole,
  config: migrationConfig(currentRole, driverOverride),
}));

if (!apply) {
  const migrations = plans.map(({ role: currentRole, config }) => ({
    role: currentRole,
    driver: config.driver,
    ...(config.driver === "sqlite" ? { databasePath: config.databasePath } : {}),
  }));
  process.stdout.write(`${JSON.stringify({ mode: "dry_run", migrations })}\n`);
  process.exitCode = 2;
} else {
  for (const plan of plans) await applyPlan(plan.role, plan.config);
  process.stdout.write(`${JSON.stringify({ mode: "applied", roles: plans.map(({ role: currentRole }) => currentRole) })}\n`);
}

async function applyPlan(currentRole, config) {
  // Disable AppDatabase's implicit kernel migration. The role ledger is the
  // only owner of migration ordering and checksum recording for this command.
  const database = await openStateDatabase(config, {
    schema: currentRole,
    autoMigrateKernel: false,
  });
  try {
    if (currentRole === "router") await migrateRouterState(database);
    else await migrateRuntimeState(database);
  } finally {
    await database.close();
  }
}

function migrationConfig(currentRole, override) {
  const prefix = currentRole === "router" ? "AGENTLOOP_ROUTER_STATE" : "AGENTLOOP_RUNTIME_STATE";
  const environment = { ...process.env };
  const configuredDriver = environment[`${prefix}_DRIVER`] ?? environment.AGENTLOOP_STATE_DRIVER;
  const configuredSqlitePath = environment[`${prefix}_SQLITE_PATH`] ?? environment.AGENTLOOP_STATE_SQLITE_PATH;
  if (override !== undefined) environment[`${prefix}_DRIVER`] = override;
  const sqlitePath = argumentValue(`--${currentRole}-sqlite-path`) ?? argumentValue("--sqlite-path");
  if (sqlitePath !== undefined) environment[`${prefix}_SQLITE_PATH`] = sqlitePath;
  const databaseUrl = argumentValue(`--${currentRole}-database-url`) ?? argumentValue("--database-url");
  if (databaseUrl !== undefined) environment[`${prefix}_DATABASE_URL`] = databaseUrl;
  if (override === undefined && configuredDriver === undefined) {
    throw new Error(`Set ${prefix}_DRIVER (or AGENTLOOP_STATE_DRIVER) explicitly; standalone migrations never choose a default backend`);
  }
  if ((override ?? configuredDriver) === "sqlite" && sqlitePath === undefined && configuredSqlitePath === undefined) {
    throw new Error(`Set ${prefix}_SQLITE_PATH (or AGENTLOOP_STATE_SQLITE_PATH) explicitly for SQLite migration`);
  }
  return stateDatabaseConfigFromEnvironment({
    environment,
    appRoot,
    sqliteFallbackPath: `./data/${currentRole}.db`,
    environmentPrefix: prefix === "AGENTLOOP_ROUTER_STATE" ? "AGENTLOOP_ROUTER_STATE" : "AGENTLOOP_RUNTIME_STATE",
  });
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
