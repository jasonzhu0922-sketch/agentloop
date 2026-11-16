import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteConnection } from "@zhujun/agentloop";
import { AccountServiceClient, IdentityError, IdentityService, installIdentitySchema } from "@zhujun/agentloop-identity";
import { accountDatabaseConfiguration, openAccountDatabase } from "../src/database.ts";
import { migrateAccountSqliteToPostgres } from "../src/migrate-sqlite-postgres.ts";
import { createAccountServer } from "../src/server.ts";

test("account database selection never falls back from a configured PostgreSQL authority", () => {
  assert.equal(accountDatabaseConfiguration({}).driver, "sqlite");
  assert.throws(() => accountDatabaseConfiguration({ ACCOUNT_SERVICE_DATABASE_URL: "postgres://localhost/accounts" }), /driver_required/);
  assert.throws(() => accountDatabaseConfiguration({ ACCOUNT_SERVICE_DATABASE_DRIVER: "postgres" }), /url_required/);
  assert.throws(() => accountDatabaseConfiguration({ ACCOUNT_SERVICE_DATABASE_DRIVER: "unknown" }), /driver_invalid/);
  for (const url of ["file:///tmp/accounts", "mysql://localhost/accounts", "postgres://localhost/"]) {
    assert.throws(() => accountDatabaseConfiguration({ ACCOUNT_SERVICE_DATABASE_DRIVER: "postgres", ACCOUNT_SERVICE_DATABASE_URL: url }), /url_invalid/);
  }
  assert.deepEqual(accountDatabaseConfiguration({ ACCOUNT_SERVICE_DATABASE_DRIVER: "postgres", ACCOUNT_SERVICE_DATABASE_URL: "postgres://localhost/accounts", ACCOUNT_SERVICE_DATABASE_POOL_SIZE: "3" }),
    { driver: "postgres", url: "postgres://localhost/accounts", poolSize: 3 });
});

const url = process.env.ACCOUNT_SERVICE_TEST_DATABASE_URL;
for (const sourceVersion of ["v1", "v2"]) test(`real PostgreSQL cutover from ${sourceVersion} preserves identities, hashes and sessions, rolls back failures, and survives restart`, { skip: !url }, async t => {
  assert.match(new URL(url!).pathname, /_test$/, "use a dedicated empty test database");
  const pg = await openAccountDatabase({ driver: "postgres", url: url!, poolSize: 3 });
  let ownsTables = false;
  t.after(async () => {
    if (ownsTables) await pg.exec("DROP TABLE IF EXISTS mr_identity_sessions, mr_identity_memberships, mr_identity_profiles, mr_identity_tenants, mr_identity_users");
    await pg.close();
  });
  const existing = await pg.prepare("SELECT tablename FROM pg_tables WHERE schemaname='public'").all();
  assert.equal(existing.length, 0, "test database must be empty");
  ownsTables = true;
  const root = await mkdtemp(join(tmpdir(), "account-pg-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "accounts.db");
  const sqlite = new SqliteConnection(path);
  const oldIdentity = new IdentityService(sqlite);
  const password = "migration-fixture-password";
  const oldSession = await oldIdentity.register("cutover@example.test", password, sourceVersion === "v2" ? "账号迁移" : undefined);
  await oldIdentity.register("second@example.test", password);
  if (sourceVersion === "v1") await sqlite.exec("DROP TABLE mr_identity_profiles");
  await sqlite.close();
  const digest = () => readFile(path).then(bytes => createHash("sha256").update(bytes).digest("hex"));
  const before = await digest();
  await installIdentitySchema(pg);
  await pg.exec("ALTER TABLE mr_identity_users ADD CONSTRAINT migration_failure_fixture CHECK (email <> 'second@example.test')");
  await assert.rejects(migrateAccountSqliteToPostgres(path, pg));
  assert.equal((await pg.prepare("SELECT count(*) AS count FROM mr_identity_users").get<{count:number}>())!.count, 0, "failed import rolls back earlier inserts");
  await pg.exec("ALTER TABLE mr_identity_users DROP CONSTRAINT migration_failure_fixture");
  const result = await migrateAccountSqliteToPostgres(path, pg);
  assert.equal(result.counts.mr_identity_users, 2);
  assert.equal(await digest(), before, "source file is unchanged");
  assert.deepEqual(await migrateAccountSqliteToPostgres(path, pg, true), result);
  await assert.rejects(migrateAccountSqliteToPostgres(path, pg), /destination_not_empty/);
  const timestamps = await pg.prepare("SELECT created_at FROM mr_identity_users").all<{created_at:number}>();
  assert.ok(timestamps.every(row => typeof row.created_at === "number" && row.created_at > 2 ** 31));
  const columns = await pg.prepare("SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('created_at','expires_at')").all<{data_type:string}>();
  assert.ok(columns.every(column => column.data_type === "bigint"));
  let identity = new IdentityService(pg); await identity.ready();
  assert.deepEqual(await identity.authenticate(`Bearer ${oldSession.token}`), oldSession.principal);
  let server = createAccountServer(identity);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const client = new AccountServiceClient(`http://127.0.0.1:${address.port}`);
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const login = await client.authenticate("login", "cutover@example.test", password);
  assert.deepEqual(login.principal, oldSession.principal);
  await assert.rejects(client.authenticate("register", "cutover@example.test", password), error => error instanceof IdentityError && error.code === "email_registered");
  const created = await client.authenticate("register", "new@example.test", password, "新账号");
  assert.equal(created.principal.displayName, "新账号");
  await assert.rejects(client.authenticate("login", "cutover@example.test", "incorrect"), error => error instanceof IdentityError && error.code === "invalid_credentials");
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  const reopened = await openAccountDatabase({ driver: "postgres", url: url!, poolSize: 2 });
  t.after(() => reopened.close());
  identity = new IdentityService(reopened); await identity.ready();
  server = createAccountServer(identity); server.listen(address.port, "127.0.0.1"); await once(server, "listening");
  assert.deepEqual(await client.current(oldSession.token), oldSession.principal);
  assert.deepEqual(await client.current(login.token), oldSession.principal);
  await client.logout(login.token);
  await assert.rejects(client.current(login.token), error => error instanceof IdentityError && error.code === "session_invalid");
  assert.deepEqual(await client.current(oldSession.token), oldSession.principal);
});
