import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  AppDatabase,
  PgConnection,
  ensurePostgresBigIntMigration,
  initializePostgresSchema,
} from "@zhujun/agentloop";
import type { SqlConnection, SqlStatement } from "@zhujun/agentloop";
import { ControlPlaneStore } from "../src/control-plane/control-plane-store.ts";
import { SharedFilesystemAttachmentBroker } from "../src/attachments/shared-filesystem-attachment-broker.ts";
import { HostDispatchStore } from "../src/runtime/host-dispatch-store.ts";

const url = process.env.AGENTLOOP_TEST_POSTGRES_URL;
const SCHEMA_LOCK_KEY = "agentloop:postgres-schema-migrations:v1";

test("real PostgreSQL lock timeout leaves no partial schema and permits a complete retry", {
  skip: url === undefined ? "AGENTLOOP_TEST_POSTGRES_URL not set" : false,
}, async () => {
  await runLockTimeoutScenario(url!, { watchdogMs: 8_000, expectDatabaseTimeout: true });
});

test("real PostgreSQL timeout watchdog releases the holder and cleans up when database timeout is absent", {
  skip: url === undefined ? "AGENTLOOP_TEST_POSTGRES_URL not set" : false,
}, async () => {
  await assert.rejects(
    runLockTimeoutScenario(url!, {
      watchdogMs: 500,
      expectDatabaseTimeout: false,
      ignoreDatabaseLockTimeout: true,
    }),
    /test watchdog released the PostgreSQL schema lock after 500ms/u,
  );
});

test("real PostgreSQL rolls canonical DDL and ledger back when migration validation fails", {
  skip: url === undefined ? "AGENTLOOP_TEST_POSTGRES_URL not set" : false,
}, async () => {
  const schema = `context_rollback_${randomUUID().replaceAll("-", "")}`;
  const admin = await PgConnection.create(url!);
  const connection = await PgConnection.create(postgresSchemaUrl(url!, schema));
  try {
    await admin.exec(`CREATE SCHEMA ${schema}`);
    await assert.rejects(
      initializePostgresSchema(
        connection,
        "CREATE TABLE rollback_probe(id TEXT PRIMARY KEY, invalid_value TEXT NOT NULL)",
        "rollback_probe_v1",
        [["rollback_probe", "invalid_value"]],
      ),
      /Cannot migrate rollback_probe\.invalid_value from text to BIGINT/u,
    );
    assert.equal(await schemaRelationCount(admin, schema), 0);
  } finally {
    await connection.close();
    await admin.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.close();
  }
});

test("real PostgreSQL serializes complete first startup on an empty schema", {
  skip: url === undefined ? "AGENTLOOP_TEST_POSTGRES_URL not set" : false,
}, async () => {
  const admin = await PgConnection.create(url!);
  try {
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const schema = `context_first_start_${randomUUID().replaceAll("-", "")}`;
      const config = new URL(url!);
      config.searchParams.set("options", `-c search_path=${schema}`);
      let first: AppDatabase | undefined;
      let second: AppDatabase | undefined;
      try {
        await admin.exec(`CREATE SCHEMA ${schema}`);
        [first, second] = await Promise.all([
          PgConnection.create(config.toString()).then((connection) => AppDatabase.open({ connection })),
          PgConnection.create(config.toString()).then((connection) => AppDatabase.open({ connection })),
        ]);
        await Promise.all([first, second].map((database) => new ControlPlaneStore(database).ready()));
        await Promise.all([first, second].map((database) =>
          new SharedFilesystemAttachmentBroker(database, "/unused", "http://router.test").ready()
        ));
        await Promise.all([first, second].map((database) => new HostDispatchStore(database).ready()));
        const versions = await first.prepare(
          "SELECT COUNT(*) AS count FROM agentloop_schema_migrations",
        ).get() as { count: number };
        assert.equal(Number(versions.count), 4);
      } finally {
        await second?.close();
        await first?.close();
        await admin.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      }
    }
  } finally {
    await admin.close();
  }
});

function postgresSchemaUrl(connectionUrl: string, schema: string): string {
  const config = new URL(connectionUrl);
  config.searchParams.set("options", `-c search_path=${schema}`);
  return config.toString();
}

async function schemaRelationCount(connection: PgConnection, schema: string): Promise<number> {
  const row = await connection.prepare(`
    SELECT COUNT(*) AS count FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ? AND c.relkind IN ('r', 'p')
  `).get(schema) as { count: number };
  return Number(row.count);
}

async function runLockTimeoutScenario(
  connectionUrl: string,
  options: {
    readonly watchdogMs: number;
    readonly expectDatabaseTimeout: boolean;
    readonly ignoreDatabaseLockTimeout?: boolean;
  },
): Promise<void> {
  const schema = `context_timeout_${randomUUID().replaceAll("-", "")}`;
  const admin = await PgConnection.create(connectionUrl);
  const config = postgresSchemaUrl(connectionUrl, schema);
  const holder = await PgConnection.create(config);
  const rawBlockedConnection = await PgConnection.create(config);
  const blockedConnection = options.ignoreDatabaseLockTimeout
    ? new IgnoreLockTimeoutConnection(rawBlockedConnection)
    : rawBlockedConnection;
  let releaseLock!: () => void;
  const holdLock = new Promise<void>((resolve) => { releaseLock = resolve; });
  let resolveAcquired!: () => void;
  let rejectAcquired!: (error: unknown) => void;
  const acquired = new Promise<void>((resolve, reject) => {
    resolveAcquired = resolve;
    rejectAcquired = reject;
  });
  let holding: Promise<void> | undefined;
  let opened: AppDatabase | undefined;
  let retry: AppDatabase | undefined;
  let primaryError: unknown;
  try {
    await admin.exec(`CREATE SCHEMA ${schema}`);
    holding = holder.transaction(async () => {
      await holder.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(SCHEMA_LOCK_KEY);
      resolveAcquired();
      await holdLock;
    });
    void holding.catch(rejectAcquired);
    await acquired;

    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      releaseLock();
    }, options.watchdogMs);
    const startedAt = Date.now();
    let startupError: unknown;
    try {
      opened = await AppDatabase.open({ connection: blockedConnection });
    } catch (error) {
      startupError = error;
    } finally {
      clearTimeout(watchdog);
    }
    if (watchdogFired) {
      throw new Error(`test watchdog released the PostgreSQL schema lock after ${options.watchdogMs}ms`);
    }
    if (startupError === undefined) throw new Error("blocked PostgreSQL startup unexpectedly succeeded");
    assert.match(String(startupError), /lock timeout|canceling statement due to lock timeout/u);
    if (options.expectDatabaseTimeout) {
      assert.ok(Date.now() - startedAt >= 4_500, "schema lock timeout must not fail before its 5 second boundary");
    }
    assert.equal(
      await schemaRelationCount(admin, schema),
      0,
      "a timed-out first startup must not leave canonical tables or the ledger",
    );

    releaseLock();
    await holding;
    retry = await AppDatabase.open({ connection: await PgConnection.create(config) });
    const versions = await retry.prepare(
      "SELECT COUNT(*) AS count FROM agentloop_schema_migrations WHERE version = ?",
    ).get("kernel_wide_integers_v1") as { count: number };
    assert.equal(Number(versions.count), 1);
  } catch (error) {
    primaryError = error;
  } finally {
    releaseLock();
    const cleanup = await Promise.allSettled([
      holding ?? Promise.resolve(),
      opened?.close() ?? blockedConnection.close(),
      retry?.close() ?? Promise.resolve(),
      holder.close(),
    ]);
    const schemaCleanup = await Promise.allSettled([
      admin.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`),
    ]);
    const adminCleanup = await Promise.allSettled([admin.close()]);
    if (primaryError === undefined) {
      primaryError = firstRejectedReason([...cleanup, ...schemaCleanup, ...adminCleanup]);
    }
  }
  if (primaryError !== undefined) throw primaryError;
}

function firstRejectedReason(results: readonly PromiseSettledResult<unknown>[]): unknown {
  return results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
}

class IgnoreLockTimeoutConnection implements SqlConnection {
  readonly dialect = "postgres" as const;
  private readonly inner: SqlConnection;
  constructor(inner: SqlConnection) { this.inner = inner; }
  async exec(sql: string): Promise<void> {
    if (sql.trim().startsWith("SET LOCAL lock_timeout")) return;
    await this.inner.exec(sql);
  }
  prepare(sql: string): SqlStatement { return this.inner.prepare(sql); }
  transaction<T>(operation: () => T | Promise<T>): Promise<T> { return this.inner.transaction(operation); }
  close(): Promise<void> { return this.inner.close(); }
}

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
