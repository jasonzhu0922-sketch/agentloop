import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AppDatabase, PgConnection, ensurePostgresBigIntMigration } from "@zhujun/agentloop";
import { ControlPlaneStore } from "../src/control-plane/control-plane-store.ts";
import { SharedFilesystemAttachmentBroker } from "../src/attachments/shared-filesystem-attachment-broker.ts";
import { HostDispatchStore } from "../src/runtime/host-dispatch-store.ts";

const url = process.env.AGENTLOOP_TEST_POSTGRES_URL;

test("real PostgreSQL upgrades legacy columns once, then permits concurrent startup under a read lock", {
  skip: url === undefined ? "AGENTLOOP_TEST_POSTGRES_URL not set" : false,
}, async () => {
  const schema = `context_migration_${randomUUID().replaceAll("-", "")}`;
  const admin = await PgConnection.create(url!);
  const config = new URL(url!);
  config.searchParams.set("options", `-c search_path=${schema}`);
  const open = async () => await AppDatabase.open({ connection: await PgConnection.create(config.toString()) });
  let first: AppDatabase | undefined;
  let second: AppDatabase | undefined;
  let third: AppDatabase | undefined;
  try {
    await admin.exec(`CREATE SCHEMA ${schema}`);
    first = await open();
    const setup = async (db: AppDatabase) => {
      await new ControlPlaneStore(db).ready();
      await new SharedFilesystemAttachmentBroker(db, "/unused", "http://router.test").ready();
      await new HostDispatchStore(db).ready();
    };
    await setup(first);
    await first.exec("DELETE FROM agentloop_schema_migrations");
    await first.exec("ALTER TABLE runs ALTER COLUMN created_at TYPE INTEGER USING created_at::INTEGER");
    await first.exec("ALTER TABLE mr_tasks ALTER COLUMN created_at TYPE INTEGER USING created_at::INTEGER");
    // First upgrade is performed by the same startup path used by hosts.
    await first.close();
    first = undefined;
    second = await open();
    await setup(second);
    const types = await second.prepare(`
      SELECT table_name, data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND column_name = 'created_at'
        AND table_name IN ('runs', 'mr_tasks')
    `).all() as Array<{ table_name: string; data_type: string }>;
    assert.equal(types.length, 2);
    assert.ok(types.every((row) => row.data_type === "bigint"));

    // Holding an AccessShareLock would block even a BIGINT -> BIGINT ALTER.
    // A fully migrated restart must finish while this reader is still active.
    const locker = await PgConnection.create(config.toString());
    try {
      await locker.transaction(async () => {
        await locker.prepare("SELECT * FROM runs LIMIT 1").all();
        third = await open();
        await setup(third);
      });
    } finally {
      await locker.close();
    }

    // Two starters competing for the same new version serialize on the lock.
    const version = `probe_${randomUUID().replaceAll("-", "")}`;
    await Promise.all([second, third].map((db) => ensurePostgresBigIntMigration(
      db!, version, [["runs", "created_at"]],
    )));
    const count = await second.prepare(
      "SELECT COUNT(*) AS count FROM agentloop_schema_migrations WHERE version = ?",
    ).get(version) as { count: number };
    assert.equal(Number(count.count), 1);
  } finally {
    await third?.close();
    await second?.close();
    await first?.close();
    await admin.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.close();
  }
});
