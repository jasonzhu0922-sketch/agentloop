import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";

test("legacy databases are rebuilt without users foreign keys while preserving every row", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "agentloop-user-boundary-"));
  const filename = resolve(directory, "legacy.db");
  createLegacySchemaFixture(filename);

  const database = new AppDatabase(filename);
  try {
    for (const table of ["skills", "conversations", "runs", "sources", "batches", "audit_events"]) {
      const keys = await database.prepare(`PRAGMA foreign_key_list(${table})`).all() as unknown as Array<{ table?: string }>;
      assert.equal(
        keys.some((key) => key.table === "users"),
        false,
        `${table} must not reference an application-owned users table`,
      );
    }

    assert.deepEqual(
      ((await database.prepare("SELECT id, name FROM skills ORDER BY id").all()) as Array<{ id: string; name: string }>)
        .map((row) => ({ id: row.id, name: row.name })),
      [{ id: "kept-skill", name: "legacy-demo" }],
    );
    assert.deepEqual(
      (
        (await database.prepare("SELECT id, title FROM conversations ORDER BY id").all()) as Array<{ id: string; title: string }>
      ).map((row) => ({ id: row.id, title: row.title })),
      [{ id: "kept-conversation", title: "Legacy conversation" }],
    );
    assert.deepEqual(
      ((await database.prepare("SELECT id, status FROM runs ORDER BY id").all()) as Array<{ id: string; status: string }>)
        .map((row) => ({ id: row.id, status: row.status })),
      [
        { id: "kept-run-child", status: "failed" },
        { id: "kept-run-parent", status: "completed" },
      ],
    );
    const childParent = (await database.prepare(
      "SELECT parent_run_id FROM runs WHERE id = 'kept-run-child'",
    ).get()) as { parent_run_id: string | null };
    assert.equal(childParent.parent_run_id, "kept-run-parent");
    assert.deepEqual(
      ((await database.prepare("SELECT action, outcome FROM audit_events").all()) as Array<{ action: string; outcome: string }>)
        .map((row) => ({ action: row.action, outcome: row.outcome })),
      [{ action: "legacy.action", outcome: "ok" }],
    );
    assert.deepEqual(
      ((await database.prepare("SELECT idempotency_key FROM batches").all()) as Array<{ idempotency_key: string }>)
        .map((row) => ({ idempotency_key: row.idempotency_key })),
      [{ idempotency_key: "legacy-batch" }],
    );

    // The kernel boundary: host-provided opaque user ids persist without any
    // shadow account in the host-owned users table.
    const skills = new SkillService(database);
    const created = await skills.create("external-host-user-42", {
      name: "embedded-skill",
      description: "Created by an embedded host identity",
      instructions: "EMBEDDED-BODY",
    });
    assert.equal(created.ownerUserId, "external-host-user-42");
    const userCount = ((await database.prepare("SELECT COUNT(*) AS count FROM users").get()) as { count: number }).count;
    assert.equal(userCount, 1);
  } finally {
    await database.close();
  }
});

test("fresh databases never carry users foreign keys on business tables", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "agentloop-user-boundary-fresh-"));
  const database = new AppDatabase(resolve(directory, "fresh.db"));
  try {
    assert.equal(await tableExists(database, "users"), false);
    assert.equal(await tableExists(database, "auth_sessions"), false);
    for (const table of ["skills", "conversations", "runs", "sources", "batches", "audit_events"]) {
      const keys = await database.prepare(`PRAGMA foreign_key_list(${table})`).all() as unknown as Array<{ table?: string }>;
      assert.equal(keys.some((key) => key.table === "users"), false, table);
    }
    const skills = new SkillService(database);
    const created = await skills.create("external-host-user-42", {
      name: "fresh-opaque-skill",
      description: "Created without an application users table",
      instructions: "OPAQUE-BODY",
    });
    assert.equal(created.ownerUserId, "external-host-user-42");
    assert.equal(await tableExists(database, "users"), false);
  } finally {
    await database.close();
  }
});

async function tableExists(database: AppDatabase, table: string): Promise<boolean> {
  const row = await database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table) as { name?: string } | undefined;
  return row !== undefined;
}

function createLegacySchemaFixture(filename: string): void {
  const legacy = new DatabaseSync(filename);
  try {
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE skills (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        instructions TEXT NOT NULL,
        source_kind TEXT NOT NULL DEFAULT 'inline' CHECK(source_kind IN ('inline', 'package')),
        source_url TEXT,
        source_revision TEXT,
        package_root TEXT,
        entrypoint_path TEXT,
        package_hash TEXT,
        package_file_count INTEGER,
        package_total_bytes INTEGER,
        content_hash TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(owner_user_id, name)
      );
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        visible_directories_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        parent_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        depth INTEGER NOT NULL,
        allow_dangerous_tools INTEGER NOT NULL DEFAULT 0,
        model_key TEXT,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
        input TEXT NOT NULL,
        output TEXT,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        extension TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'uploaded', 'ready', 'unsupported', 'oversized', 'unreadable', 'extract_failed', 'deleted'
        )),
        summary TEXT,
        token_estimate INTEGER NOT NULL DEFAULT 0,
        character_count INTEGER NOT NULL DEFAULT 0,
        truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0, 1)),
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE batches (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
        concurrency INTEGER NOT NULL,
        failure_policy TEXT NOT NULL CHECK(failure_policy IN ('continue', 'fail-fast')),
        allow_dangerous_tools INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        finished_at INTEGER,
        UNIQUE(owner_user_id, idempotency_key)
      );
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        outcome TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    legacy.prepare(
      "INSERT INTO users(id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
    ).run("legacy-user", "legacy@example.com", "hash", 1);
    legacy.prepare(`
      INSERT INTO skills(
        id, owner_user_id, name, description, instructions, source_kind,
        content_hash, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'inline', ?, 1, 1, 1)
    `).run("kept-skill", "legacy-user", "legacy-demo", "Kept", "BODY", "hash");
    legacy.prepare(`
      INSERT INTO conversations(id, owner_user_id, title, created_at, updated_at)
      VALUES (?, ?, ?, 1, 1)
    `).run("kept-conversation", "legacy-user", "Legacy conversation");
    legacy.prepare(`
      INSERT INTO runs(
        id, owner_user_id, conversation_id, parent_run_id, depth,
        status, input, created_at
      ) VALUES (?, ?, ?, NULL, 0, 'completed', 'parent input', 1)
    `).run("kept-run-parent", "legacy-user", "kept-conversation");
    legacy.prepare(`
      INSERT INTO runs(
        id, owner_user_id, conversation_id, parent_run_id, depth,
        status, input, error_code, created_at, finished_at
      ) VALUES (?, ?, ?, ?, 1, 'failed', 'child input', 'SOME_ERROR', 2, 3)
    `).run("kept-run-child", "legacy-user", "kept-conversation", "kept-run-parent");
    legacy.prepare(`
      INSERT INTO audit_events(id, actor_user_id, action, resource_type, outcome, created_at)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run("kept-audit", "legacy-user", "legacy.action", "run", "ok");
    legacy.prepare(`
      INSERT INTO batches(
        id, owner_user_id, idempotency_key, status, concurrency, failure_policy, created_at
      ) VALUES (?, ?, ?, 'completed', 2, 'continue', 1)
    `).run("kept-batch", "legacy-user", "legacy-batch");
  } finally {
    legacy.close();
  }
}
