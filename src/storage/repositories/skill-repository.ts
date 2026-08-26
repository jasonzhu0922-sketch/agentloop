import type { SqlConnection } from "../connection.ts";
import { conflict } from "../../shared/errors.ts";

export type SkillSourceKind = "inline" | "package";

export interface SkillRow {
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

const SKILL_COLUMNS = `
  id, owner_user_id, name, description, instructions, source_kind,
  source_url, source_revision, package_root, entrypoint_path,
  package_hash, package_file_count, package_total_bytes,
  content_hash, version, updated_at
`;

export class SkillRepository {
  private readonly connection: SqlConnection;

  constructor(connection: SqlConnection) {
    this.connection = connection;
  }

  findIdByOwnerAndName(ownerUserId: string, name: string): { id: string } | undefined {
    return this.connection.prepare(
      "SELECT id FROM skills WHERE owner_user_id = ? AND name = ?",
    ).get(ownerUserId, name) as { id: string } | undefined;
  }

  listByOwner(ownerUserId: string): SkillRow[] {
    return this.connection.prepare(`SELECT ${SKILL_COLUMNS} FROM skills WHERE owner_user_id = ? ORDER BY name`)
      .all(ownerUserId) as unknown as SkillRow[];
  }

  listPackageSkills(): SkillRow[] {
    return this.connection.prepare(`SELECT ${SKILL_COLUMNS} FROM skills WHERE source_kind = 'package' ORDER BY owner_user_id, name`)
      .all() as unknown as SkillRow[];
  }

  listPackageSkillsWithoutSourceProvenance(): SkillRow[] {
    return this.connection.prepare(`
      SELECT ${SKILL_COLUMNS}
      FROM skills
      WHERE source_kind = 'package'
        AND source_url IS NULL
        AND source_revision IS NULL
      ORDER BY owner_user_id, name
    `).all() as unknown as SkillRow[];
  }

  findByIdAndOwner(skillId: string, ownerUserId: string): SkillRow | undefined {
    return this.connection.prepare(`SELECT ${SKILL_COLUMNS} FROM skills WHERE id = ? AND owner_user_id = ?`)
      .get(skillId, ownerUserId) as SkillRow | undefined;
  }

  insert(input: {
    id: string;
    ownerUserId: string;
    name: string;
    description: string;
    instructions: string;
    sourceKind: SkillSourceKind;
    sourceUrl?: string;
    sourceRevision?: string;
    packageRoot?: string;
    entrypointPath?: string;
    packageHash?: string;
    packageFileCount?: number;
    packageTotalBytes?: number;
    contentHash: string;
    now: number;
  }): void {
    try {
      this.connection.prepare(`
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

  updatePackageMetadata(input: {
    id: string;
    name: string;
    description: string;
    instructions: string;
    packageHash: string;
    packageFileCount: number;
    packageTotalBytes: number;
    now: number;
  }): void {
    try {
      this.connection.prepare(`
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

  deletePackageSkillById(id: string): void {
    this.connection.prepare("DELETE FROM skills WHERE id = ? AND source_kind = 'package'").run(id);
  }
}
