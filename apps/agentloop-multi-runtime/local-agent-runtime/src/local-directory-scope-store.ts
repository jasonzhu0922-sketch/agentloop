import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AppDatabase } from "@zhujun/agentloop";

export type LocalDirectoryScopeStatus = "active" | "revoked" | "unavailable";

export interface LocalDirectoryScope {
  readonly id: string;
  readonly displayName: string;
  readonly status: LocalDirectoryScopeStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface ScopeRow {
  id: string;
  display_name: string;
  path: string;
  status: LocalDirectoryScopeStatus;
  created_at: number;
  updated_at: number;
}

/** Local-only directory grants. The path column never leaves the Local Agent process. */
export class LocalDirectoryScopeStore {
  private readonly database: AppDatabase;

  constructor(database: AppDatabase) {
    this.database = database;
  }

  async ready(): Promise<void> {
    await this.database.exec(`
      CREATE TABLE IF NOT EXISTS local_directory_scopes (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('active', 'revoked', 'unavailable')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS local_directory_scopes_status_idx ON local_directory_scopes(status, updated_at DESC);
    `);
  }

  async list(): Promise<readonly LocalDirectoryScope[]> {
    await this.ready();
    // A revoked directory is no longer an authorization.  Do not surface old
    // tombstones from installations created before revoke became destructive.
    const rows = await this.database.prepare("SELECT id, display_name, path, status, created_at, updated_at FROM local_directory_scopes WHERE status <> 'revoked' ORDER BY updated_at DESC").all() as ScopeRow[];
    const result: LocalDirectoryScope[] = [];
    for (const row of rows) {
      let status = row.status;
      if (status === "active") {
        const stat = await lstat(row.path).catch(() => undefined);
        if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) {
          status = "unavailable";
          await this.database.prepare("UPDATE local_directory_scopes SET status = 'unavailable', updated_at = ? WHERE id = ?").run(Date.now(), row.id);
        }
      }
      result.push({ id: row.id, displayName: row.display_name, status, createdAt: row.created_at, updatedAt: row.updated_at });
    }
    return result;
  }

  async create(pathValue: unknown, displayNameValue?: unknown): Promise<LocalDirectoryScope> {
    await this.ready();
    if (typeof pathValue !== "string" || pathValue.length === 0 || !isAbsolute(pathValue)) throw new TypeError("directory path must be absolute");
    const stat = await lstat(pathValue).catch(() => undefined);
    if (stat === undefined) throw new TypeError("directory does not exist");
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("directory must be a real directory");
    const path = await realpath(pathValue);
    const displayName = typeof displayNameValue === "string" && displayNameValue.trim().length > 0 ? displayNameValue.trim().slice(0, 160) : path.split("/").at(-1) || path;
    const now = Date.now();
    const existing = await this.database.prepare("SELECT id, display_name, status, created_at, updated_at FROM local_directory_scopes WHERE path = ?").get(path) as Omit<ScopeRow, "path"> | undefined;
    if (existing !== undefined) {
      await this.database.prepare("UPDATE local_directory_scopes SET status = 'active', display_name = ?, updated_at = ? WHERE id = ?").run(displayName, now, existing.id);
      return { id: existing.id, displayName, status: "active", createdAt: existing.created_at, updatedAt: now };
    }
    const id = `lds_${randomUUID().replaceAll("-", "")}`;
    await this.database.prepare("INSERT INTO local_directory_scopes(id, display_name, path, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)").run(id, displayName, path, now, now);
    return { id, displayName, status: "active", createdAt: now, updatedAt: now };
  }

  async paths(ids: readonly string[]): Promise<readonly string[]> {
    await this.ready();
    if (ids.length > 12 || ids.some((id) => typeof id !== "string" || !/^lds_[a-f0-9-]+$/.test(id))) throw new TypeError("directoryScopeIds are invalid");
    const result: string[] = [];
    for (const id of ids) {
      const row = await this.database.prepare("SELECT path, status FROM local_directory_scopes WHERE id = ?").get(id) as { path: string; status: LocalDirectoryScopeStatus } | undefined;
      if (row === undefined || row.status !== "active") throw new TypeError(`directory scope is unavailable: ${id}`);
      const stat = await lstat(row.path).catch(() => undefined);
      if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError(`directory scope is unavailable: ${id}`);
      result.push(row.path);
    }
    return result;
  }

  async revoke(id: string): Promise<void> {
    await this.ready();
    // Revocation removes the device-local grant rather than retaining a UI
    // visible record that can be mistaken for an available source. A future
    // authorization of the same path creates a fresh grant identity.
    await this.database.prepare("DELETE FROM local_directory_scopes WHERE id = ?").run(id);
  }
}
