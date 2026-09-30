import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "@zhujun/agentloop";
import {
  controlPlaneMigrationLedgerSql,
  controlPlaneSchemaSql,
  ControlPlaneMigrationError,
  assertControlPlaneMigrationsReady,
  migrateControlPlane,
} from "../src/persistence/control-plane-migrations.ts";

test("control-plane migrations own cp schema history and never use the Router ledger", async () => {
  const database = new AppDatabase(":memory:");
  try {
    await assert.rejects(() => assertControlPlaneMigrationsReady(database), ControlPlaneMigrationError);
    await migrateControlPlane(database);
    await migrateControlPlane(database);
    await assertControlPlaneMigrationsReady(database);
    const tables = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
    const names = new Set(tables.map((table) => table.name));
    for (const table of ["cp_schema_migrations", "cp_configuration_revision_sequence", "cp_resources", "cp_releases", "cp_target_assignments", "cp_apply_receipts", "cp_audit_events"]) {
      assert.equal(names.has(table), true, table);
    }
    assert.equal(names.has("mr_schema_migrations"), false);
    const migration = await database.prepare("SELECT checksum FROM cp_schema_migrations").get<{ checksum: string }>();
    assert.match(migration?.checksum ?? "", /^[a-f0-9]{64}$/);
    await database.prepare("UPDATE cp_schema_migrations SET checksum = 'drift'").run();
    await assert.rejects(() => migrateControlPlane(database), ControlPlaneMigrationError);
  } finally {
    await database.close();
  }
});

test("TiDB receives source-level schema with varchar keys, longtext payloads, and bigint time", () => {
  const sql = controlPlaneSchemaSql("tidb");
  assert.match(controlPlaneMigrationLedgerSql({ dialect: "tidb" }), /cp_schema_migrations \(id VARCHAR\(191\)/);
  assert.match(sql, /payload_json LONGTEXT NOT NULL/);
  assert.match(sql, /created_at BIGINT NOT NULL/);
  assert.doesNotMatch(sql, /LONGTEXT[^,\n]*DEFAULT/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS cp_target_assignments_resource_idx/);
});

test("SQLite and PostgreSQL keep explicit portable control-plane definitions", () => {
  assert.match(controlPlaneMigrationLedgerSql({ dialect: "sqlite" }), /applied_at INTEGER/);
  assert.match(controlPlaneMigrationLedgerSql({ dialect: "postgres" }), /applied_at BIGINT/);
  assert.match(controlPlaneSchemaSql("postgres"), /created_at BIGINT NOT NULL/);
});
