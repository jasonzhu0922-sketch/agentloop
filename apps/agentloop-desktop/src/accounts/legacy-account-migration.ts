import { backup, DatabaseSync } from "node:sqlite";
import { cp, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EncryptedLocalRuntimeSecretStore } from "@zhujun/agentloop-local-runtime";

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function table(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}
function columns(db: DatabaseSync, name: string): string[] {
  return (db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).map(row => row.name);
}
function inside(root: string, path: string): boolean {
  const offset = relative(resolve(root), resolve(path));
  return offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
}

/** Do not import symlinks or special files as another account's owned files. */
async function copyOwnedTree(source: string, destination: string): Promise<void> {
  if (!await exists(source)) return;
  async function inspect(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error("legacy_account_file_type_invalid");
    if (info.isDirectory()) for (const entry of await readdir(path)) await inspect(join(path, entry));
  }
  await inspect(source);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await cp(source, destination, { recursive: true, preserveTimestamps: true, force: false, errorOnExist: true });
}

/** Copy a consistent SQLite snapshot, retain only the authenticated owner and
 * vacuum deleted pages. The legacy database is always opened read-only. */
async function ownerDatabase(source: string, destination: string, owner: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const original = new DatabaseSync(source, { readOnly: true });
  try { await backup(original, destination); } finally { original.close(); }
  const db = new DatabaseSync(destination);
  try {
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(row => row.name);
    // Root deletion cascades to events, plans, results, sources and actions.
    for (const name of names.filter(name => columns(db, name).includes("owner_user_id"))) {
      db.prepare(`DELETE FROM "${name.replaceAll('"', '""')}" WHERE owner_user_id IS NULL OR owner_user_id <> ?`).run(owner);
    }
    if (table(db, "audit_events")) db.prepare("DELETE FROM audit_events WHERE actor_user_id IS NULL OR actor_user_id <> ?").run(owner);
    for (const name of ["discovered_skills", "local_directory_scopes"]) if (table(db, name)) db.exec(`DELETE FROM "${name}"`);
    if (table(db, "local_memory_revisions")) db.exec("DELETE FROM local_memory_revisions WHERE memory_id NOT IN (SELECT id FROM local_memory_items)");
    // Unknown unscoped tables must never be copied into a personal namespace.
    for (const name of names) {
      if (["discovered_skills", "local_directory_scopes", "audit_events", "local_memory_revisions"].includes(name)) continue;
      if (columns(db, name).includes("owner_user_id")) continue;
      const foreignKeys = db.prepare(`PRAGMA foreign_key_list("${name}")`).all();
      if (foreignKeys.length === 0 && Number(db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get()!.count) > 0) throw new Error("legacy_account_unscoped_table");
    }
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("legacy_account_integrity_failed");
    db.exec("COMMIT; PRAGMA journal_mode=DELETE; VACUUM");
  } finally { db.close(); }
}

interface LegacyRuntime { runtime_id: string; storage_key: string; display_name: string; is_default: number; status: string; created_at: number; updated_at: number }
export interface AccountMigration { readonly legacySharedConfiguration: boolean; readonly migratedRuntimes: number; readonly legacyModelsRestored?: boolean }

export async function migrateLegacyAccount(root: string, staged: string, final: string, owner: string): Promise<AccountMigration> {
  const supervisorPath = join(root, "supervisor.db");
  const hasSupervisor = await exists(supervisorPath);
  const supervisor = hasSupervisor ? new DatabaseSync(supervisorPath, { readOnly: true }) : undefined;
  const definitions = supervisor && table(supervisor, "local_runtime_instances")
    ? supervisor.prepare("SELECT runtime_id,storage_key,display_name,is_default,status,created_at,updated_at FROM local_runtime_instances").all() as unknown as LegacyRuntime[] : [];
  if (!definitions.length && await exists(join(root, "runtime.db"))) definitions.push({ runtime_id: "desktop-default", storage_key: "default", display_name: "本机 Runtime", is_default: 1, status: "ready", created_at: Date.now(), updated_at: Date.now() });
  const storage = supervisor && table(supervisor, "local_device_storage_configuration")
    ? supervisor.prepare("SELECT workspace_root,upload_storage_root FROM local_device_storage_configuration WHERE singleton=1").get() as { workspace_root: string; upload_storage_root: string } | undefined : undefined;
  const workspace = storage?.workspace_root ?? join(root, "workspace");
  const uploads = storage?.upload_storage_root ?? join(root, "uploads");
  let count = 0;
  try {
    for (const definition of definitions) {
      if (!/^[a-zA-Z0-9_-]{1,200}$/.test(definition.storage_key) || !/^[a-zA-Z0-9_-]{1,200}$/.test(definition.runtime_id)) throw new Error("legacy_runtime_path_invalid");
      const suffix = definition.is_default ? "runtime.db" : join("runtimes", definition.storage_key, "agentloop.db");
      const source = join(root, suffix);
      if (!await exists(source)) continue;
      const old = new DatabaseSync(source, { readOnly: true });
      let owned = false;
      try {
        const names = old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
        // Retry tombstones and dispatch reservations are owned history too,
        // even after the last conversation has been deleted.
        owned = names.some(({ name }) => columns(old, name).includes("owner_user_id")
          && old.prepare(`SELECT 1 FROM "${name.replaceAll('"', '""')}" WHERE owner_user_id=? LIMIT 1`).get(owner) !== undefined);
      } finally { old.close(); }
      if (!owned) continue;
      await ownerDatabase(source, join(staged, suffix), owner);
      const db = new DatabaseSync(join(staged, suffix));
      try {
        if (table(db, "sources")) for (const row of db.prepare("SELECT id,storage_path,conversation_id FROM sources").all() as Array<{ id: string; storage_path: string; conversation_id: string | null }>) {
          const expected = join(uploads, definition.storage_key, "users", `user-${owner}`);
          if (!inside(expected, row.storage_path) || !inside(await realpath(expected), await realpath(row.storage_path))) throw new Error("legacy_source_path_invalid");
          const rel = relative(expected, row.storage_path);
          const target = join("storage", "uploads", definition.storage_key, "users", `user-${owner}`, rel);
          await copyOwnedTree(row.storage_path, join(staged, target));
          db.prepare("UPDATE sources SET storage_path=? WHERE id=?").run(join(final, target), row.id);
        }
        // Kernel-private packaged Skills have an owner; shared custom libraries do not.
        if (table(db, "skills")) for (const row of db.prepare("SELECT id,package_root FROM skills WHERE package_root IS NOT NULL").all() as Array<{ id: string; package_root: string }>) {
          const target = join("skill-packages", row.id);
          if (!/^[a-zA-Z0-9_-]{1,200}$/.test(row.id)) throw new Error("legacy_skill_path_invalid");
          await copyOwnedTree(row.package_root, join(staged, target));
          db.prepare("UPDATE skills SET package_root=? WHERE id=?").run(join(final, target), row.id);
        }
      } finally { db.close(); }
      // Only runtime identity/status is retained. Unowned models/MCP/Skill
      // configurations and their credentials remain in the legacy archive.
      const target = new DatabaseSync(join(staged, "supervisor.db"));
      try {
        const sql = supervisor?.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='local_runtime_instances'").get()?.sql;
        if (!sql) throw new Error("legacy_runtime_schema_missing");
        target.exec(String(sql).replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "));
        target.prepare(`INSERT INTO local_runtime_instances(runtime_id,display_name,storage_key,is_default,status,pending_action,created_at,updated_at) VALUES(?,?,?,?,?,NULL,?,?)`)
          .run(definition.runtime_id, definition.display_name, definition.storage_key, definition.is_default, "ready", definition.created_at, definition.updated_at);
      } finally { target.close(); }
      count++;
    }
    if (count) {
      const db = new DatabaseSync(join(staged, "supervisor.db"));
      try {
        if (!db.prepare("SELECT 1 FROM local_runtime_instances WHERE is_default=1").get()) {
          const fallback = definitions.find(row => row.is_default === 1);
          if (!fallback) throw new Error("legacy_default_runtime_missing");
          db.prepare("INSERT INTO local_runtime_instances(runtime_id,display_name,storage_key,is_default,status,pending_action,created_at,updated_at) VALUES(?,?,?,1,'ready',NULL,?,?)")
            .run(fallback.runtime_id, fallback.display_name, fallback.storage_key, fallback.created_at, fallback.updated_at);
        }
      } finally { db.close(); }
      await copyOwnedTree(join(workspace, "users", `user-${owner}`), join(staged, "storage", "workspace", "users", `user-${owner}`));
    }
    if (await exists(join(root, "memory.db"))) await ownerDatabase(join(root, "memory.db"), join(staged, "memory.db"), owner);
    if (supervisor && table(supervisor, "desktop_connector_settings")) {
      const rows = supervisor.prepare("SELECT id,owner_id,connector_key,display_name,enabled,scopes,secret_ref,updated_at FROM desktop_connector_settings WHERE owner_id=?").all(owner);
      if (rows.length) {
        const oldSecrets = new EncryptedLocalRuntimeSecretStore(join(root, "private", "connector-secrets"));
        const newSecrets = new EncryptedLocalRuntimeSecretStore(join(staged, "private", "connector-secrets"));
        const db = new DatabaseSync(join(staged, "supervisor.db"));
        try {
          db.exec("CREATE TABLE IF NOT EXISTS desktop_connector_settings(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,connector_key TEXT NOT NULL,display_name TEXT NOT NULL,enabled INTEGER NOT NULL,scopes TEXT NOT NULL,secret_ref TEXT,updated_at INTEGER NOT NULL)");
          for (const row of rows) {
            const values = row.secret_ref ? await oldSecrets.read(String(row.secret_ref)) : undefined;
            if (row.secret_ref && !values) throw new Error("legacy_connector_credentials_missing");
            const reference = values ? await newSecrets.write(values) : null;
            db.prepare("INSERT INTO desktop_connector_settings VALUES(?,?,?,?,?,?,?,?)").run(row.id, owner, row.connector_key, row.display_name, row.enabled, row.scopes, reference, row.updated_at);
          }
        } finally { db.close(); }
      }
    }
    return { legacySharedConfiguration: hasSupervisor, migratedRuntimes: count };
  } finally { supervisor?.close(); }
}
