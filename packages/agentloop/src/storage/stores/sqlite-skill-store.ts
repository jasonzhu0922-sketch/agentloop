import { conflict } from "../../shared/errors.ts";
import type { SqlConnection } from "../connection.ts";
import type {
  DiscoveredSkillSnapshot,
  SkillInsertRecord,
  SkillPackageMetadataUpdate,
  SkillRecord,
  SkillStore,
  SkillStoreSourceKind,
} from "./skill-store.ts";

interface SkillRow {
  id: string;
  owner_user_id: string;
  name: string;
  description: string;
  instructions: string;
  source_kind: string;
  source_url: string | null;
  source_revision: string | null;
  package_root: string | null;
  entrypoint_path: string | null;
  package_hash: string | null;
  package_file_count: number | null;
  package_total_bytes: number | null;
  content_hash: string;
  version: number;
  updated_at: number;
}

interface DiscoveredSkillRow {
  name: string;
  description: string;
  source_directory: string;
  package_hash: string;
  file_count: number;
  total_bytes: number;
  agent_loop_json: string | null;
  version: number;
  synced_at: number;
}

const SKILL_COLUMNS = `
  id, owner_user_id, name, description, instructions, source_kind,
  source_url, source_revision, package_root, entrypoint_path,
  package_hash, package_file_count, package_total_bytes,
  content_hash, version, updated_at
`;

/** Default {@link SkillStore} over the kernel-owned SQLite schema. */
export class SqliteSkillStore implements SkillStore {
  private readonly connection: SqlConnection;

  constructor(connection: SqlConnection) {
    if (connection.dialect !== "sqlite") {
      throw new TypeError("SqliteSkillStore requires a sqlite SqlConnection; provide a host SkillStore for other databases");
    }
    this.connection = connection;
  }

  async findIdByOwnerAndName(ownerUserId: string, name: string): Promise<{ id: string } | undefined> {
    return await this.connection.prepare(
      "SELECT id FROM skills WHERE owner_user_id = ? AND name = ?",
    ).get(ownerUserId, name) as { id: string } | undefined;
  }

  async listByOwner(ownerUserId: string): Promise<SkillRecord[]> {
    return (await this.connection.prepare(
      `SELECT ${SKILL_COLUMNS} FROM skills WHERE owner_user_id = ? ORDER BY name`,
    ).all(ownerUserId) as unknown as SkillRow[]).map(toRecord);
  }

  async listPackageSkills(): Promise<SkillRecord[]> {
    return (await this.connection.prepare(
      `SELECT ${SKILL_COLUMNS} FROM skills WHERE source_kind = 'package' ORDER BY owner_user_id, name`,
    ).all() as unknown as SkillRow[]).map(toRecord);
  }

  async listPackageSkillsWithoutSourceProvenance(): Promise<SkillRecord[]> {
    return (await this.connection.prepare(`
      SELECT ${SKILL_COLUMNS}
      FROM skills
      WHERE source_kind = 'package'
        AND source_url IS NULL
        AND source_revision IS NULL
      ORDER BY owner_user_id, name
    `).all() as unknown as SkillRow[]).map(toRecord);
  }

  async findByIdAndOwner(skillId: string, ownerUserId: string): Promise<SkillRecord | undefined> {
    const row = await this.connection.prepare(
      `SELECT ${SKILL_COLUMNS} FROM skills WHERE id = ? AND owner_user_id = ?`,
    ).get(skillId, ownerUserId) as unknown as SkillRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  async insert(input: SkillInsertRecord): Promise<void> {
    try {
      await this.connection.prepare(`
        INSERT INTO skills(
          id, owner_user_id, name, description, instructions, source_kind,
          source_url, source_revision, package_root, entrypoint_path,
          package_hash, package_file_count, package_total_bytes,
          content_hash, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        input.id,
        input.ownerUserId,
        input.name,
        input.description,
        input.instructions,
        input.sourceKind,
        input.sourceUrl ?? null,
        input.sourceRevision ?? null,
        input.packageRoot ?? null,
        input.entrypointPath ?? null,
        input.packageHash ?? null,
        input.packageFileCount ?? null,
        input.packageTotalBytes ?? null,
        input.contentHash,
        input.now,
        input.now,
      );
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) {
        throw conflict(`A private skill named "${input.name}" already exists`);
      }
      throw error;
    }
  }

  async updatePackageMetadata(input: SkillPackageMetadataUpdate): Promise<void> {
    try {
      await this.connection.prepare(`
        UPDATE skills
        SET name = ?,
            description = ?,
            instructions = ?,
            package_hash = ?,
            package_file_count = ?,
            package_total_bytes = ?,
            content_hash = ?,
            version = version + 1,
            updated_at = ?
        WHERE id = ? AND source_kind = 'package'
      `).run(
        input.name,
        input.description,
        input.instructions,
        input.packageHash,
        input.packageFileCount,
        input.packageTotalBytes,
        input.packageHash,
        input.now,
        input.id,
      );
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) {
        throw conflict(`A private skill named "${input.name}" already exists`);
      }
      throw error;
    }
  }

  async deletePackageSkillById(id: string): Promise<void> {
    await this.connection.prepare("DELETE FROM skills WHERE id = ? AND source_kind = 'package'").run(id);
  }

  async syncDiscoveredSkills(records: readonly DiscoveredSkillSnapshot[]): Promise<void> {
    const upsert = this.connection.prepare(`
      INSERT INTO discovered_skills(
        name, description, source_directory, package_hash,
        file_count, total_bytes, agent_loop_json, version, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(name) DO NOTHING
    `);
    const selectByName = this.connection.prepare(
      "SELECT name, description, source_directory, package_hash, file_count, total_bytes, agent_loop_json, version, synced_at FROM discovered_skills WHERE name = ?",
    );
    const update = this.connection.prepare(`
      UPDATE discovered_skills
      SET description = ?, source_directory = ?, package_hash = ?,
          file_count = ?, total_bytes = ?, agent_loop_json = ?,
          version = version + 1, synced_at = ?
      WHERE name = ?
    `);
    await this.connection.transaction(async () => {
      const currentNames = new Set(records.map((record) => record.name));
      for (const record of records) {
        const agentLoopJson = record.agentLoop === undefined ? null : JSON.stringify(record.agentLoop);
        const existing = await selectByName.get(record.name) as unknown as DiscoveredSkillRow | undefined;
        if (existing === undefined) {
          await upsert.run(
            record.name,
            record.description,
            record.sourceDirectory,
            record.packageHash,
            record.fileCount,
            record.totalBytes,
            agentLoopJson,
            record.syncedAt,
          );
          continue;
        }
        if (
          existing.description !== record.description
          || existing.source_directory !== record.sourceDirectory
          || existing.package_hash !== record.packageHash
          || existing.file_count !== record.fileCount
          || existing.total_bytes !== record.totalBytes
          || existing.agent_loop_json !== agentLoopJson
        ) {
          await update.run(
            record.description,
            record.sourceDirectory,
            record.packageHash,
            record.fileCount,
            record.totalBytes,
            agentLoopJson,
            record.syncedAt,
            record.name,
          );
        }
      }
      const persisted = await this.connection.prepare("SELECT name FROM discovered_skills").all() as Array<{ name: string }>;
      const remove = this.connection.prepare("DELETE FROM discovered_skills WHERE name = ?");
      for (const row of persisted) {
        if (!currentNames.has(row.name)) await remove.run(row.name);
      }
    });
  }

  async listDiscoveredSkills(): Promise<DiscoveredSkillSnapshot[]> {
    return (await this.connection.prepare(`
      SELECT name, description, source_directory, package_hash,
             file_count, total_bytes, agent_loop_json, version, synced_at
      FROM discovered_skills ORDER BY name
    `).all() as unknown as DiscoveredSkillRow[]).map((row) => ({
      name: row.name,
      description: row.description,
      sourceDirectory: row.source_directory,
      packageHash: row.package_hash,
      fileCount: row.file_count,
      totalBytes: row.total_bytes,
      ...(row.agent_loop_json === null ? {} : { agentLoop: JSON.parse(row.agent_loop_json) as unknown }),
      syncedAt: row.synced_at,
    }));
  }
}

function toRecord(row: SkillRow): SkillRecord {
  const sourceKind: SkillStoreSourceKind = row.source_kind === "package" ? "package" : "inline";
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    sourceKind,
    sourceUrl: row.source_url,
    sourceRevision: row.source_revision,
    packageRoot: row.package_root,
    entrypointPath: row.entrypoint_path,
    packageHash: row.package_hash,
    packageFileCount: row.package_file_count,
    packageTotalBytes: row.package_total_bytes,
    contentHash: row.content_hash,
    version: row.version,
    updatedAt: row.updated_at,
  };
}
