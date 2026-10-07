import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { previewProcessArtifact, upsertSql, type SqlConnection } from "@zhujun/agentloop";
import type { RuntimeArtifact, RuntimeArtifactPreview } from "../../shared/contracts.ts";
import { migrateRouterState } from "../persistence/state-migrations.ts";

export interface CatalogArtifact extends RuntimeArtifact {
  readonly sha256: string;
}

/**
 * Router-owned catalog over the existing shared workspace. It deliberately
 * records an immutable verified receipt rather than copying artifact bytes.
 * A later BlobStore catalog can implement the same interface.
 */
export class SharedWorkspaceArtifactCatalog {
  private readonly database: SqlConnection;
  private readonly workspaceRoot: string;
  private readyPromise?: Promise<void>;

  constructor(database: SqlConnection, workspaceRoot: string) {
    this.database = database;
    this.workspaceRoot = workspaceRoot;
  }

  async ready(): Promise<void> {
    await migrateRouterState(this.database);
  }

  /** Invoked only by the versioned schema migration registry. */
  async installSchema(): Promise<void> {
    this.readyPromise ??= this.initialize();
    await this.readyPromise;
  }

  async capture(input: {
    readonly assignmentId: string; readonly tenantId: string; readonly ownerUserId: string;
    readonly conversationId: string; readonly remoteRunId: string; readonly artifacts: readonly RuntimeArtifact[];
  }): Promise<readonly CatalogArtifact[]> {
    await this.ready();
    const workspaceRoot = join(this.workspaceRoot, "conversations", input.conversationId);
    const captured: CatalogArtifact[] = [];
    for (const artifact of input.artifacts) {
      if (artifact.runId !== input.remoteRunId) continue;
      const content = await readCatalogArtifact(artifact, workspaceRoot);
      const sha256 = createHash("sha256").update(content).digest("hex");
      await this.database.prepare(upsertSql({
        dialect: this.database.dialect,
        insert: "INSERT INTO mr_artifacts(id, assignment_id, tenant_id, owner_user_id, conversation_id, remote_run_id, path, name, byte_size, mime_type, role, source_tool, previewable, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        conflictTarget: "assignment_id, id",
        sqliteAndPostgresUpdate: "byte_size = excluded.byte_size, mime_type = excluded.mime_type, role = excluded.role, source_tool = excluded.source_tool, previewable = excluded.previewable, sha256 = excluded.sha256",
        tidbUpdate: "byte_size = VALUES(byte_size), mime_type = VALUES(mime_type), role = VALUES(role), source_tool = VALUES(source_tool), previewable = VALUES(previewable), sha256 = VALUES(sha256)",
      })).run(artifact.id, input.assignmentId, input.tenantId, input.ownerUserId, input.conversationId, input.remoteRunId, artifact.path, artifact.name, artifact.bytes, artifact.mimeType, artifact.role, artifact.sourceTool, artifact.previewable ? 1 : 0, sha256, Date.now());
      captured.push({ ...artifact, sha256 });
    }
    return captured;
  }

  async list(assignmentId: string): Promise<readonly CatalogArtifact[]> {
    const rows = await this.database.prepare(`SELECT id, remote_run_id, path, name, byte_size, mime_type, role, source_tool, previewable, sha256 FROM mr_artifacts WHERE assignment_id = ? ORDER BY path`).all(assignmentId) as Array<Record<string, unknown>>;
    return rows.map((row) => rowToArtifact(row));
  }

  async read(assignmentId: string, artifactId: string): Promise<{ readonly artifact: CatalogArtifact; readonly content: Uint8Array } | undefined> {
    const artifact = (await this.list(assignmentId)).find((item) => item.id === artifactId);
    if (artifact === undefined) return undefined;
    const content = await readCatalogArtifact(artifact, join(this.workspaceRoot, "conversations", await this.conversationId(assignmentId)));
    if (createHash("sha256").update(content).digest("hex") !== artifact.sha256) throw new Error("artifact_integrity_mismatch");
    return { artifact, content };
  }

  async preview(assignmentId: string, artifactId: string): Promise<RuntimeArtifactPreview | undefined> {
    const artifact = (await this.list(assignmentId)).find((item) => item.id === artifactId);
    if (artifact === undefined) return undefined;
    await this.read(assignmentId, artifactId);
    return previewProcessArtifact({ artifact, workspaceRoot: join(this.workspaceRoot, "conversations", await this.conversationId(assignmentId)) });
  }

  private async conversationId(assignmentId: string): Promise<string> {
    const row = await this.database.prepare("SELECT conversation_id FROM mr_artifacts WHERE assignment_id = ? LIMIT 1").get(assignmentId) as { conversation_id: string } | undefined;
    if (row === undefined) throw new Error("artifact_catalog_entry_not_found");
    return row.conversation_id;
  }

  private async initialize(): Promise<void> {
    await this.database.exec(this.database.dialect === "tidb" ? tidbArtifactTableSql(true) : artifactTableSql(true));
    // The catalog was introduced during this migration.  Keep early local
    // databases readable while correcting their accidental global artifact-ID
    // primary key; artifact IDs belong to a Run/Assignment namespace.
    if (this.database.dialect === "sqlite") {
      const columns = await this.database.prepare("PRAGMA table_info(mr_artifacts)").all() as Array<{ name: string; pk: number }>;
      if (hasGlobalArtifactIdPrimaryKey(columns)) await this.migrateGlobalArtifactIdPrimaryKey();
    }
    await this.database.exec("CREATE INDEX IF NOT EXISTS mr_artifacts_assignment_idx ON mr_artifacts(assignment_id, created_at)");
  }

  private async migrateGlobalArtifactIdPrimaryKey(): Promise<void> {
    await this.database.transaction(async () => {
      // Another Router replica may have won the migration race while this
      // process waited for SQLite's cross-process write lock.
      const columns = await this.database.prepare("PRAGMA table_info(mr_artifacts)").all() as Array<{ name: string; pk: number }>;
      if (!hasGlobalArtifactIdPrimaryKey(columns)) return;
      await this.database.exec("DROP INDEX IF EXISTS mr_artifacts_assignment_idx");
      await this.database.exec("ALTER TABLE mr_artifacts RENAME TO mr_artifacts_global_id_legacy");
      await this.database.exec(artifactTableSql(false));
      await this.database.exec(`
        INSERT INTO mr_artifacts(
          id, assignment_id, tenant_id, owner_user_id, conversation_id, remote_run_id,
          path, name, byte_size, mime_type, role, source_tool, previewable, sha256, created_at
        )
        SELECT
          id, assignment_id, tenant_id, owner_user_id, conversation_id, remote_run_id,
          path, name, byte_size, mime_type, role, source_tool, previewable, sha256, created_at
        FROM mr_artifacts_global_id_legacy
      `);
      await this.database.exec("DROP TABLE mr_artifacts_global_id_legacy");
    });
  }
}

export async function installArtifactCatalogSchema(database: SqlConnection): Promise<void> {
  await new SharedWorkspaceArtifactCatalog(database, ".").installSchema();
}

function hasGlobalArtifactIdPrimaryKey(columns: readonly { name: string; pk: number }[]): boolean {
  const primaryKey = columns.filter((column) => column.pk > 0).sort((left, right) => left.pk - right.pk).map((column) => column.name);
  return primaryKey.length === 1 && primaryKey[0] === "id";
}

function artifactTableSql(ifNotExists: boolean): string {
  return `
    CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}mr_artifacts (
      id TEXT NOT NULL,
      assignment_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      remote_run_id TEXT NOT NULL,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      role TEXT NOT NULL,
      source_tool TEXT NOT NULL,
      previewable INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(assignment_id, id)
    )
  `;
}

/** TiDB owns this DDL; do not derive it from the SQLite catalog schema. */
function tidbArtifactTableSql(ifNotExists: boolean): string {
  return `
    CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}mr_artifacts (
      id VARCHAR(191) NOT NULL,
      assignment_id VARCHAR(191) NOT NULL,
      tenant_id LONGTEXT NOT NULL,
      owner_user_id LONGTEXT NOT NULL,
      conversation_id LONGTEXT NOT NULL,
      remote_run_id LONGTEXT NOT NULL,
      path LONGTEXT NOT NULL,
      name LONGTEXT NOT NULL,
      byte_size BIGINT NOT NULL,
      mime_type LONGTEXT NOT NULL,
      role LONGTEXT NOT NULL,
      source_tool LONGTEXT NOT NULL,
      previewable BIGINT NOT NULL,
      sha256 LONGTEXT NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY(assignment_id, id)
    )
  `;
}

function rowToArtifact(row: Record<string, unknown>): CatalogArtifact {
  return {
    id: String(row.id), runId: String(row.remote_run_id), path: String(row.path), name: String(row.name), bytes: Number(row.byte_size), mimeType: String(row.mime_type),
    role: row.role === "final" ? "final" : "process", sourceTool: row.source_tool as CatalogArtifact["sourceTool"], previewable: Number(row.previewable) === 1, sha256: String(row.sha256),
  };
}

async function readCatalogArtifact(artifact: RuntimeArtifact, workspaceRoot: string): Promise<Buffer> {
  if (artifact.path.length === 0 || artifact.path.includes("\0")) throw new Error("artifact_path_invalid");
  const root = await realpath(workspaceRoot);
  const target = await realpath(isAbsolute(artifact.path) ? artifact.path : resolve(root, artifact.path));
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error("artifact_path_escapes_workspace");
  const file = await stat(target);
  if (!file.isFile() || file.size !== artifact.bytes || file.size > 50 * 1024 * 1024) throw new Error("artifact_unavailable");
  return await readFile(target);
}
