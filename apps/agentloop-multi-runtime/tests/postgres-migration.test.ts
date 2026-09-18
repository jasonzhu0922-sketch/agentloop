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
  const outcome = await runLockTimeoutScenario(url!, { watchdogMs: 8_000, expectDatabaseTimeout: true });
  assert.equal(outcome.kind, "database_timeout");
  assert.equal(await schemaExists(url!, outcome.schema), false);
});

test("real PostgreSQL timeout watchdog releases the holder and cleans up when database timeout is absent", {
  skip: url === undefined ? "AGENTLOOP_TEST_POSTGRES_URL not set" : false,
}, async () => {
  const startedAt = Date.now();
  const outcome = await runLockTimeoutScenario(url!, {
    watchdogMs: 500,
    expectDatabaseTimeout: false,
    ignoreDatabaseLockTimeout: true,
  });
  assert.equal(outcome.kind, "watchdog_released");
  assert.ok(Date.now() - startedAt < 2_000);
  assert.equal(await schemaExists(url!, outcome.schema), false);
});

test("real PostgreSQL cleanup failure is reported and does not hide behind the watchdog outcome", {
  skip: url === undefined ? "AGENTLOOP_TEST_POSTGRES_URL not set" : false,
}, async () => {
  let leakedSchema = "";
  try {
    await assert.rejects(
      runLockTimeoutScenario(url!, {
        watchdogMs: 500,
        expectDatabaseTimeout: false,
        ignoreDatabaseLockTimeout: true,
        injectSchemaCleanupFailure: true,
      }),
      (error: unknown) => {
        assert.equal(error instanceof ScenarioCleanupError, true);
        leakedSchema = (error as ScenarioCleanupError).schema;
        assert.match(String(error), /schema cleanup injection/u);
        return true;
      },
    );
    assert.notEqual(leakedSchema, "");
    assert.equal(await schemaExists(url!, leakedSchema), true);
  } finally {
    if (leakedSchema !== "") await dropSchema(url!, leakedSchema);
  }
  assert.equal(await schemaExists(url!, leakedSchema), false);
});

test("real PostgreSQL holder acquisition is cancelled when another process owns the schema lock", {
  skip: url === undefined ? "AGENTLOOP_TEST_POSTGRES_URL not set" : false,
}, async () => {
  const externalHolder = await PgConnection.create(url!);
  let releaseExternal!: () => void;
  const holdExternal = new Promise<void>((resolve) => { releaseExternal = resolve; });
  let resolveExternalAcquired!: () => void;
  const externalAcquired = new Promise<void>((resolve) => { resolveExternalAcquired = resolve; });
  const holding = externalHolder.transaction(async () => {
    await externalHolder.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(SCHEMA_LOCK_KEY);
    resolveExternalAcquired();
    await holdExternal;
  });
  try {
    await externalAcquired;
    const startedAt = Date.now();
    await assert.rejects(
      runLockTimeoutScenario(url!, { watchdogMs: 500, expectDatabaseTimeout: false }),
      /holder acquisition watchdog|canceling statement due to user request/u,
    );
    assert.ok(Date.now() - startedAt < 4_000, "holder acquisition must not wait for an external CI timeout");
  } finally {
    releaseExternal();
    await holding;
    await externalHolder.close();
  }
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

async function schemaExists(connectionUrl: string, schema: string): Promise<boolean> {
  const admin = await PgConnection.create(connectionUrl);
  try {
    const row = await admin.prepare(`
      SELECT COUNT(*) AS count FROM information_schema.schemata WHERE schema_name = ?
    `).get(schema) as { count: number };
    return Number(row.count) === 1;
  } finally {
    await admin.close();
  }
}

async function dropSchema(connectionUrl: string, schema: string): Promise<void> {
  const admin = await PgConnection.create(connectionUrl);
  try {
    await admin.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await admin.close();
  }
}

async function runLockTimeoutScenario(
  connectionUrl: string,
  options: {
    readonly watchdogMs: number;
    readonly expectDatabaseTimeout: boolean;
    readonly ignoreDatabaseLockTimeout?: boolean;
    readonly injectSchemaCleanupFailure?: boolean;
  },
): Promise<{ readonly kind: "database_timeout" | "watchdog_released"; readonly schema: string }> {
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
  let resolveAcquisitionStarted!: (backendPid: number) => void;
  let rejectAcquisitionStarted!: (error: unknown) => void;
  const acquisitionStarted = new Promise<number>((resolve, reject) => {
    resolveAcquisitionStarted = resolve;
    rejectAcquisitionStarted = reject;
  });
  let holding: Promise<void> | undefined;
  let opened: AppDatabase | undefined;
  let retry: AppDatabase | undefined;
  let primaryError: unknown;
  let outcome: { readonly kind: "database_timeout" | "watchdog_released"; readonly schema: string } | undefined;
  try {
    await admin.exec(`CREATE SCHEMA ${schema}`);
    holding = holder.transaction(async () => {
      const backend = await holder.prepare("SELECT pg_backend_pid() AS pid").get() as { pid: number };
      resolveAcquisitionStarted(backend.pid);
      await holder.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(SCHEMA_LOCK_KEY);
      resolveAcquired();
      await holdLock;
    });
    void holding.catch((error) => {
      rejectAcquisitionStarted(error);
      rejectAcquired(error);
    });
    const backendPid = await acquisitionStarted;
    await waitForHolderAcquisition(acquired, admin, backendPid, 2_000);

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
      outcome = { kind: "watchdog_released", schema };
    } else {
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
      outcome = { kind: "database_timeout", schema };
    }
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
    const schemaCleanup = await Promise.allSettled([options.injectSchemaCleanupFailure
      ? Promise.reject(new Error("schema cleanup injection"))
      : admin.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)]);
    const adminCleanup = await Promise.allSettled([admin.close()]);
    const cleanupErrors = rejectedReasons([...cleanup, ...schemaCleanup, ...adminCleanup]);
    if (cleanupErrors.length > 0) {
      throw new ScenarioCleanupError(schema, cleanupErrors, primaryError);
    }
  }
  if (primaryError !== undefined) throw primaryError;
  if (outcome === undefined) throw new Error("PostgreSQL lock timeout scenario produced no outcome");
  return outcome;
}

async function waitForHolderAcquisition(
  acquired: Promise<void>,
  admin: PgConnection,
  backendPid: number,
  watchdogMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void admin.prepare("SELECT pg_cancel_backend(?)").get(backendPid).then(
        () => reject(new Error(`holder acquisition watchdog cancelled backend after ${watchdogMs}ms`)),
        reject,
      );
    }, watchdogMs);
  });
  try {
    await Promise.race([acquired, watchdog]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function rejectedReasons(results: readonly PromiseSettledResult<unknown>[]): unknown[] {
  return results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
}

class ScenarioCleanupError extends AggregateError {
  readonly schema: string;
  constructor(schema: string, cleanupErrors: readonly unknown[], primaryError?: unknown) {
    super(primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors],
      `PostgreSQL timeout scenario cleanup failed for ${schema}: ${cleanupErrors.map(String).join("; ")}`);
    this.name = "ScenarioCleanupError";
    this.schema = schema;
  }
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
