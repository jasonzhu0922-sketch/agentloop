import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import type { SqlConnection } from "../storage/connection.ts";
import { SkillRepository, type SkillRow } from "../storage/repositories/skill-repository.ts";
import { AppError, badRequest, conflict, forbidden, notFound } from "../shared/errors.ts";
import { requireString } from "../shared/validation.ts";
import {
  assertPathInside,
  copySkillPackage,
  inspectSkillPackage,
  removeSkillPackage,
} from "./skill-package.ts";
import { discoverSkillDirectory } from "./skill-directory.ts";
import type { SkillDirectoryEntry } from "./skill-directory.ts";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DISCOVERED_SKILL_ID_PREFIX = "discovered:";

export type SkillSourceKind = "inline" | "package";

export interface SkillPackageSource {
  /** Optional verified upstream provenance for a directory-discovered package. */
  readonly url?: string;
  readonly revision?: string;
  readonly root: string;
  readonly entrypointPath: string;
  readonly packageHash: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface SkillSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: number;
  readonly sourceKind: SkillSourceKind;
  readonly contentHash: string;
  readonly package?: SkillPackageSource;
  readonly updatedAt: number;
}

export interface PrivateSkill extends SkillSummary {
  readonly ownerUserId: string;
  readonly instructions: string;
}

export interface SkillServiceOptions {
  readonly packageStoreRoot?: string;
  readonly allowedImportRoots?: readonly string[];
  readonly skillDirectory?: string;
}

export interface DiscoveredSkillSummary {
  readonly name: string;
  readonly description: string;
  readonly sourceDirectory: string;
  readonly sourceUrl?: string;
  readonly sourceRevision?: string;
  readonly packageHash: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export class SkillService {
  private readonly skills: SkillRepository;
  private readonly packageStore?: string;
  private readonly allowedImportRoots: readonly string[];
  private readonly configuredSkillDirectory?: string;
  private directoryEntries: readonly SkillDirectoryEntry[] = [];

  constructor(database: SqlConnection, options: SkillServiceOptions = {}) {
    this.skills = new SkillRepository(database);
    if (options.packageStoreRoot !== undefined) {
      mkdirSync(resolve(options.packageStoreRoot), { recursive: true, mode: 0o700 });
      this.packageStore = realpathSync(resolve(options.packageStoreRoot));
    }
    this.allowedImportRoots = (options.allowedImportRoots ?? []).map((root) => realpathSync(resolve(root)));
    if (options.skillDirectory !== undefined) {
      this.configuredSkillDirectory = realpathSync(resolve(options.skillDirectory));
    }
  }

  get packageStoreRoot(): string | undefined {
    return this.packageStore;
  }

  get skillDirectory(): string | undefined {
    return this.configuredSkillDirectory;
  }

  async refreshSkillDirectory(): Promise<DiscoveredSkillSummary[]> {
    this.directoryEntries = this.configuredSkillDirectory === undefined
      ? []
      : await discoverSkillDirectory(this.configuredSkillDirectory);
    return this.discovered();
  }

  discovered(): DiscoveredSkillSummary[] {
    return this.directoryEntries.map((entry) => ({
      name: entry.inspection.name,
      description: entry.inspection.description,
      sourceDirectory: entry.sourceDirectory,
      packageHash: entry.inspection.packageHash,
      fileCount: entry.inspection.fileCount,
      totalBytes: entry.inspection.totalBytes,
      ...(entry.sourceUrl === undefined ? {} : {
        sourceUrl: entry.sourceUrl,
        sourceRevision: entry.sourceRevision,
      }),
    }));
  }

  async listAvailable(ownerUserId: string): Promise<SkillSummary[]> {
    return this.availableForOwner(ownerUserId).map(toSkillSummary);
  }

  async resolveForAgent(ownerUserId: string, boundSkillIds: readonly string[]): Promise<PrivateSkill[]> {
    const explicitlyBound = boundSkillIds.map((skillId) => this.resolveAvailableSkill(ownerUserId, skillId));
    const discovered = this.discoveredPrivateSkills(ownerUserId);
    const merged = new Map<string, PrivateSkill>();
    for (const skill of [...explicitlyBound, ...discovered]) merged.set(skill.id, skill);
    const names = new Set<string>();
    for (const skill of merged.values()) {
      if (names.has(skill.name)) {
        throw conflict(`More than one authorized Skill is named "${skill.name}"`);
      }
      names.add(skill.name);
    }
    return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name, "en"));
  }

  /**
   * A conversation belongs to its user, not to the Skill that happened to
   * start it. Conversation Runs can therefore consider the user's complete
   * private catalog; Plan admission still selects and binds only the Skills
   * needed by the current request.
   */
  async resolveForConversation(ownerUserId: string): Promise<PrivateSkill[]> {
    return this.availableForOwner(ownerUserId);
  }

  create(
    ownerUserId: string,
    input: {
      name: unknown;
      description: unknown;
      instructions: unknown;
    },
  ): PrivateSkill {
    const name = requireString(input.name, "name", { max: 80, pattern: SKILL_NAME_PATTERN });
    this.assertNotDiscoveredSkillName(name);
    const description = requireString(input.description, "description", { max: 500 });
    const instructions = requireString(input.instructions, "instructions", { max: 200_000 });
    const id = randomUUID();
    const now = Date.now();
    const contentHash = createHash("sha256").update(instructions).digest("hex");
    this.insert({
      id,
      ownerUserId,
      name,
      description,
      instructions,
      sourceKind: "inline",
      contentHash,
      now,
    });
    return {
      id,
      ownerUserId,
      name,
      description,
      instructions,
      sourceKind: "inline",
      version: 1,
      contentHash,
      updatedAt: now,
    };
  }

  async installFromDirectory(
    ownerUserId: string,
    input: {
      sourceDirectory: unknown;
      sourceUrl: unknown;
      sourceRevision: unknown;
      expectedPackageHash: unknown;
    },
  ): Promise<PrivateSkill> {
    if (this.packageStore === undefined) {
      throw new AppError("SKILL_PACKAGE_INVALID", "Skill package storage is not configured", 503);
    }
    if (this.allowedImportRoots.length === 0) {
      throw forbidden("No server-approved Skill import roots are configured");
    }
    const sourceDirectory = requireString(input.sourceDirectory, "sourceDirectory", { max: 4_000 });
    const sourceUrl = requireHttpsUrl(input.sourceUrl);
    const sourceRevision = requireString(input.sourceRevision, "sourceRevision", {
      max: 40,
      pattern: SOURCE_REVISION_PATTERN,
    });
    const expectedPackageHash = requireString(input.expectedPackageHash, "expectedPackageHash", {
      max: 64,
      pattern: SHA256_PATTERN,
    });
    const canonicalSource = await fs.realpath(resolve(sourceDirectory)).catch(() => {
      throw badRequest("sourceDirectory does not exist");
    });
    if (!this.allowedImportRoots.some((root) => {
      try {
        assertPathInside(canonicalSource, root, "sourceDirectory");
        return true;
      } catch {
        return false;
      }
    })) {
      throw forbidden("sourceDirectory is outside the server-approved Skill import roots");
    }

    const source = await inspectSkillPackage(canonicalSource);
    this.assertNotDiscoveredSkillName(source.name);
    if (source.packageHash !== expectedPackageHash) {
      throw new AppError(
        "SKILL_PACKAGE_INVALID",
        "Skill package does not match expectedPackageHash",
        422,
        { expectedPackageHash, actualPackageHash: source.packageHash },
      );
    }
    const existing = this.skills.findIdByOwnerAndName(ownerUserId, source.name);
    if (existing !== undefined) throw conflict(`A private skill named "${source.name}" already exists`);

    const id = randomUUID();
    const ownerRoot = resolve(this.packageStore, ownerUserId);
    assertPathInside(ownerRoot, this.packageStore, "Skill package owner root");
    await fs.mkdir(ownerRoot, { recursive: true, mode: 0o700 });
    const destination = resolve(ownerRoot, id);
    let copied: Awaited<ReturnType<typeof copySkillPackage>> | undefined;
    try {
      copied = await copySkillPackage(source, destination);
      const now = Date.now();
      this.insert({
        id,
        ownerUserId,
        name: copied.name,
        description: copied.description,
        instructions: copied.instructions,
        sourceKind: "package",
        sourceUrl,
        sourceRevision,
        packageRoot: copied.root,
        entrypointPath: copied.entrypointPath,
        packageHash: copied.packageHash,
        packageFileCount: copied.fileCount,
        packageTotalBytes: copied.totalBytes,
        contentHash: copied.packageHash,
        now,
      });
      return this.get(ownerUserId, id);
    } catch (error) {
      if (copied !== undefined) await removeSkillPackage(copied.root).catch(() => undefined);
      throw error;
    }
  }

  list(ownerUserId: string): SkillSummary[] {
    const rows = this.skills.listByOwner(ownerUserId);
    return rows.map(toSummary);
  }

  get(ownerUserId: string, skillId: string): PrivateSkill {
    const row = this.skills.findByIdAndOwner(skillId, ownerUserId);
    // Return the same response for a missing and a foreign-owned skill to avoid
    // turning identifiers into an ownership oracle.
    if (row === undefined) throw notFound("Skill");
    return toPrivateSkill(row);
  }

  getMany(ownerUserId: string, skillIds: readonly string[]): PrivateSkill[] {
    return skillIds.map((skillId) => this.get(ownerUserId, skillId));
  }

  async assertIntegrity(skills: readonly PrivateSkill[]): Promise<void> {
    for (const skill of skills) {
      if (skill.sourceKind !== "package" || skill.package === undefined) continue;
      const current = await inspectSkillPackage(skill.package.root).catch((error) => {
        throw new AppError(
          "SKILL_PACKAGE_MUTATED",
          `Skill package ${skill.name} is unavailable or invalid: ${error instanceof Error ? error.message : "unknown error"}`,
          409,
        );
      });
      if (
        current.packageHash !== skill.package.packageHash
        || current.instructions !== skill.instructions
        || current.name !== skill.name
      ) {
        throw new AppError(
          "SKILL_PACKAGE_MUTATED",
          `Skill package ${skill.name} no longer matches its installed hash`,
          409,
          { skillId: skill.id, expectedHash: skill.package.packageHash, actualHash: current.packageHash },
        );
      }
    }
  }

  async refreshInstalledPackageMetadata(): Promise<number> {
    let updated = 0;
    for (const row of this.skills.listPackageSkills()) {
      const packageSource = parsePackageSource(row);
      const current = await inspectSkillPackage(packageSource.root);
      if (
        row.name === current.name
        && row.description === current.description
        && row.instructions === current.instructions
        && row.package_hash === current.packageHash
        && row.package_file_count === current.fileCount
        && row.package_total_bytes === current.totalBytes
        && row.content_hash === current.packageHash
      ) {
        continue;
      }
      this.skills.updatePackageMetadata({
        id: row.id,
        name: current.name,
        description: current.description,
        instructions: current.instructions,
        packageHash: current.packageHash,
        packageFileCount: current.fileCount,
        packageTotalBytes: current.totalBytes,
        now: Date.now(),
      });
      updated += 1;
    }
    return updated;
  }

  private availableForOwner(ownerUserId: string): PrivateSkill[] {
    const discoveredNames = new Set(this.directoryEntries.map((entry) => entry.inspection.name));
    const privateSkills = this.getMany(ownerUserId, this.list(ownerUserId)
      .filter((skill) => !discoveredNames.has(skill.name))
      .map((skill) => skill.id));
    return [...privateSkills, ...this.discoveredPrivateSkills(ownerUserId)]
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
  }

  private discoveredPrivateSkills(ownerUserId: string): PrivateSkill[] {
    return this.directoryEntries.map((entry) => ({
      id: discoveredSkillId(entry.inspection.name),
      ownerUserId,
      name: entry.inspection.name,
      description: entry.inspection.description,
      instructions: entry.inspection.instructions,
      sourceKind: "package",
      version: 1,
      contentHash: entry.inspection.packageHash,
      updatedAt: 0,
      package: {
        root: entry.sourceDirectory,
        entrypointPath: entry.inspection.entrypointPath,
        packageHash: entry.inspection.packageHash,
        fileCount: entry.inspection.fileCount,
        totalBytes: entry.inspection.totalBytes,
        ...(entry.sourceUrl === undefined ? {} : {
          url: entry.sourceUrl,
          revision: entry.sourceRevision,
        }),
      },
    }));
  }

  private resolveAvailableSkill(ownerUserId: string, skillId: string): PrivateSkill {
    const discovered = this.discoveredPrivateSkills(ownerUserId).find((skill) => skill.id === skillId);
    if (discovered !== undefined) return discovered;
    return this.get(ownerUserId, skillId);
  }

  private assertNotDiscoveredSkillName(name: string): void {
    if (this.directoryEntries.some((entry) => entry.inspection.name === name)) {
      throw conflict(`A discovered Skill named "${name}" already exists`);
    }
  }

  private insert(input: {
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
    this.skills.insert(input);
  }
}

function toSummary(row: SkillRow): SkillSummary {
  const sourceKind = parseSourceKind(row.source_kind);
  const packageSource = sourceKind === "package" ? parsePackageSource(row) : undefined;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    sourceKind,
    contentHash: row.content_hash,
    ...(packageSource === undefined ? {} : { package: packageSource }),
    updatedAt: row.updated_at,
  };
}

function toPrivateSkill(row: SkillRow): PrivateSkill {
  return {
    ...toSummary(row),
    ownerUserId: row.owner_user_id,
    instructions: row.instructions,
  };
}

function toSkillSummary(skill: PrivateSkill): SkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    sourceKind: skill.sourceKind,
    contentHash: skill.contentHash,
    ...(skill.package === undefined ? {} : { package: skill.package }),
    updatedAt: skill.updatedAt,
  };
}

function parsePackageSource(row: SkillRow): SkillPackageSource {
  if (
    row.package_root === null
    || row.entrypoint_path === null
    || row.package_hash === null
    || row.package_file_count === null
    || row.package_total_bytes === null
  ) {
    throw new Error(`Stored package Skill ${row.id} has incomplete package metadata`);
  }
  if ((row.source_url === null) !== (row.source_revision === null)) {
    throw new Error(`Stored package Skill ${row.id} has incomplete source provenance`);
  }
  return {
    root: row.package_root,
    entrypointPath: row.entrypoint_path,
    packageHash: row.package_hash,
    fileCount: row.package_file_count,
    totalBytes: row.package_total_bytes,
    ...(row.source_url === null ? {} : { url: row.source_url, revision: row.source_revision! }),
  };
}

function parseSourceKind(value: string): SkillSourceKind {
  if (value === "inline" || value === "package") return value;
  throw new Error(`Stored Skill has invalid source kind ${value}`);
}

function discoveredSkillId(name: string): string {
  return `${DISCOVERED_SKILL_ID_PREFIX}${name}`;
}

function requireHttpsUrl(value: unknown): string {
  const source = requireString(value, "sourceUrl", { max: 2_000 });
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw badRequest("sourceUrl must be an absolute HTTPS URL");
  }
  if (url.protocol !== "https:") throw badRequest("sourceUrl must use HTTPS");
  url.hash = "";
  return url.toString();
}
