import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import type { SqlConnection } from "../storage/connection.ts";
import { SqliteSkillStore } from "../storage/stores/sqlite-skill-store.ts";
import type {
  SkillDiscoveryPersistence,
  SkillInsertRecord,
  SkillRecord,
  SkillStore,
} from "../storage/stores/skill-store.ts";
import { AppError, badRequest, conflict, forbidden, notFound } from "../shared/errors.ts";
import { requireString } from "../shared/validation.ts";
import {
  assertPathInside,
  copySkillPackage,
  inspectSkillPackage,
  readSkillAgentLoopMetadata,
  removeSkillPackage,
} from "./skill-package.ts";
import { discoveredSkillId } from "./skill-identity.ts";
import type { SkillAgentLoopMetadata } from "./skill-package.ts";
import { discoverSkillDirectory } from "./skill-directory.ts";
import type { SkillDirectoryEntry } from "./skill-directory.ts";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

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
  readonly agentLoop?: SkillAgentLoopMetadata;
  readonly updatedAt: number;
}

export interface PrivateSkill extends SkillSummary {
  readonly ownerUserId: string;
  readonly instructions: string;
}

export interface SkillServiceOptions {
  readonly packageStoreRoot?: string;
  readonly allowedImportRoots?: readonly string[];
  /**
   * Single Skill discovery directory.
   *
   * @deprecated Prefer {@link skillDirectories}; this value is merged in as the
   * first entry of the discovery list and remains supported for compatibility.
   */
  readonly skillDirectory?: string;
  /**
   * Skill discovery directories whose packages are merged into one catalog.
   * Names must be unique across every configured directory; duplicates fail
   * closed at discovery time.
   */
  readonly skillDirectories?: readonly string[];
  /**
   * Host-controlled visibility filter applied to the merged candidate set
   * (global directory Skills plus user-private Skills). The filtered output is
   * authoritative for the catalog API, conversation planning, and sub-agent
   * binding alike; throwing inside the hook fails the requesting operation
   * closed instead of falling back to the unfiltered set.
   *
   * Visibility is not authorization: runtime capability enforcement still
   * happens through Capability Grants and Plan admission independently.
   */
  readonly selectVisibleSkills?: (context: SkillVisibilityContext) =>
    readonly PrivateSkill[] | Promise<readonly PrivateSkill[]>;
  /**
   * Host-replaceable persistence boundary. When omitted, Skills persist into
   * the kernel-owned SQLite schema over the provided connection; when
   * provided, the kernel performs every Skill read/write through this store
   * and never touches the default schema.
   */
  readonly skillStore?: SkillStore;
}

export interface SkillVisibilityContext {
  /** Owner whose candidate set is being resolved; opaque to the kernel. */
  readonly userId: string;
  /** Full merged candidate set before visibility filtering. */
  readonly skills: readonly PrivateSkill[];
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

export interface SkillDirectorySyncResult {
  readonly discoveredSkills: readonly DiscoveredSkillSummary[];
  readonly prunedLegacySkillCount: number;
  readonly refreshedInstalledSkillCount: number;
}

export class SkillService {
  private readonly store: SkillStore;
  private readonly packageStore?: string;
  private readonly allowedImportRoots: readonly string[];
  private readonly configuredSkillDirectories: readonly string[];
  private readonly selectVisibleSkills: SkillServiceOptions["selectVisibleSkills"];
  private directoryEntries: readonly SkillDirectoryEntry[] = [];

  constructor(database?: SqlConnection, options: SkillServiceOptions = {}) {
    if (options.skillStore !== undefined) {
      this.store = options.skillStore;
    } else if (database !== undefined) {
      this.store = new SqliteSkillStore(database);
    } else {
      throw new TypeError("SkillService requires either a database connection or a skillStore");
    }
    this.selectVisibleSkills = options.selectVisibleSkills;
    if (options.packageStoreRoot !== undefined) {
      mkdirSync(resolve(options.packageStoreRoot), { recursive: true, mode: 0o700 });
      this.packageStore = realpathSync(resolve(options.packageStoreRoot));
    }
    this.allowedImportRoots = (options.allowedImportRoots ?? []).map((root) => realpathSync(resolve(root)));
    const configuredDirectories = [
      ...(options.skillDirectory === undefined ? [] : [options.skillDirectory]),
      ...(options.skillDirectories ?? []),
    ];
    const directoriesByPath = new Map<string, string>();
    for (const directory of configuredDirectories) {
      const canonical = realpathSync(resolve(directory));
      if (!directoriesByPath.has(canonical)) directoriesByPath.set(canonical, canonical);
    }
    this.configuredSkillDirectories = [...directoriesByPath.values()];
  }

  get packageStoreRoot(): string | undefined {
    return this.packageStore;
  }

  /** All configured Skill discovery directories, canonicalized and deduplicated. */
  get skillDirectories(): readonly string[] {
    return this.configuredSkillDirectories;
  }

  /**
   * @deprecated Use {@link skillDirectories}. Returns the first configured
   * directory so single-directory deployments keep working unchanged.
   */
  get skillDirectory(): string | undefined {
    return this.configuredSkillDirectories[0];
  }

  async refreshSkillDirectory(): Promise<DiscoveredSkillSummary[]> {
    const entries: SkillDirectoryEntry[] = [];
    for (const directory of this.configuredSkillDirectories) {
      entries.push(...await discoverSkillDirectory(directory));
    }
    assertUniqueDiscoveredNames(entries);
    this.directoryEntries = entries;
    await this.syncDiscoveryPersistence(entries);
    return this.discovered();
  }

  /**
   * Startup reconciliation for every configured Skill directory. This is the
   * preferred application boot path: it validates configured roots, refreshes
   * the discovered catalog, prunes stale directory-backed packages, and updates
   * metadata for installed packages whose source package changed.
   */
  async syncSkillDirectories(): Promise<SkillDirectorySyncResult> {
    const discoveredSkills = await this.refreshSkillDirectory();
    const prunedLegacySkillCount = await this.pruneLegacyDirectoryPackageSkills();
    const refreshedInstalledSkillCount = await this.refreshInstalledPackageMetadata();
    return { discoveredSkills, prunedLegacySkillCount, refreshedInstalledSkillCount };
  }

  /**
   * Mirror the discovery snapshot into the persistence layer when the store
   * opts in via {@link SkillDiscoveryPersistence}. Stores without the
   * capability keep discovery purely in memory.
   */
  private async syncDiscoveryPersistence(entries: readonly SkillDirectoryEntry[]): Promise<void> {
    const persistence = this.store as Partial<SkillDiscoveryPersistence>;
    if (typeof persistence.syncDiscoveredSkills !== "function") return;
    const syncedAt = Date.now();
    await persistence.syncDiscoveredSkills(entries.map((entry) => ({
      name: entry.inspection.name,
      description: entry.inspection.description,
      sourceDirectory: entry.sourceDirectory,
      packageHash: entry.inspection.packageHash,
      fileCount: entry.inspection.fileCount,
      totalBytes: entry.inspection.totalBytes,
      ...(entry.inspection.agentLoop === undefined ? {} : { agentLoop: entry.inspection.agentLoop }),
      syncedAt,
    })));
  }

  async pruneLegacyDirectoryPackageSkills(): Promise<number> {
    const discoveredNames = new Set(this.directoryEntries.map((entry) => entry.inspection.name));
    const staleRecords: SkillRecord[] = [];
    for (const record of await this.store.listPackageSkillsWithoutSourceProvenance()) {
      if (
        !discoveredNames.has(record.name)
        || this.isOutsideCurrentPackageStore(record.packageRoot)
        || await this.isMissingPackageDirectory(record.packageRoot)
      ) {
        staleRecords.push(record);
      }
    }
    for (const record of staleRecords) {
      await this.store.deletePackageSkillById(record.id);
      if (this.packageStore === undefined || record.packageRoot === null) continue;
      try {
        assertPathInside(resolve(record.packageRoot), this.packageStore, "Skill package root");
      } catch {
        continue;
      }
      await removeSkillPackage(record.packageRoot).catch(() => undefined);
    }
    return staleRecords.length;
  }

  private isOutsideCurrentPackageStore(packageRoot: string | null): boolean {
    if (this.packageStore === undefined || packageRoot === null) return false;
    try {
      assertPathInside(resolve(packageRoot), this.packageStore, "Skill package root");
      return false;
    } catch {
      return true;
    }
  }

  private async isMissingPackageDirectory(packageRoot: string | null): Promise<boolean> {
    if (packageRoot === null) return true;
    return fs.stat(resolve(packageRoot))
      .then((stat) => !stat.isDirectory())
      .catch(() => true);
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
    return (await this.availableForOwner(ownerUserId)).map(toSkillSummary);
  }

  async resolveForAgent(ownerUserId: string, boundSkillIds: readonly string[]): Promise<PrivateSkill[]> {
    const explicitlyBound = await Promise.all(boundSkillIds.map((skillId) => this.resolveAvailableSkill(ownerUserId, skillId)));
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
    return this.applyVisibility(ownerUserId, [...merged.values()]
      .sort((left, right) => left.name.localeCompare(right.name, "en")));
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

  async create(
    ownerUserId: string,
    input: {
      name: unknown;
      description: unknown;
      instructions: unknown;
    },
  ): Promise<PrivateSkill> {
    const name = requireString(input.name, "name", { max: 80, pattern: SKILL_NAME_PATTERN });
    this.assertNotDiscoveredSkillName(name);
    const description = requireString(input.description, "description", { max: 500 });
    const instructions = requireString(input.instructions, "instructions", { max: 200_000 });
    const id = randomUUID();
    const now = Date.now();
    const contentHash = createHash("sha256").update(instructions).digest("hex");
    await this.insert({
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
      ...skillAgentLoopMetadata(instructions),
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
    const existing = await this.store.findIdByOwnerAndName(ownerUserId, source.name);
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
      await this.insert({
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
      return await this.get(ownerUserId, id);
    } catch (error) {
      if (copied !== undefined) await removeSkillPackage(copied.root).catch(() => undefined);
      throw error;
    }
  }

  async list(ownerUserId: string): Promise<SkillSummary[]> {
    return (await this.store.listByOwner(ownerUserId)).map(toSummary);
  }

  async get(ownerUserId: string, skillId: string): Promise<PrivateSkill> {
    const record = await this.store.findByIdAndOwner(skillId, ownerUserId);
    // Return the same response for a missing and a foreign-owned skill to avoid
    // turning identifiers into an ownership oracle.
    if (record === undefined) throw notFound("Skill");
    return toPrivateSkill(record);
  }

  async getMany(ownerUserId: string, skillIds: readonly string[]): Promise<PrivateSkill[]> {
    return await Promise.all(skillIds.map((skillId) => this.get(ownerUserId, skillId)));
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
    for (const record of await this.store.listPackageSkills()) {
      const packageSource = parsePackageSource(record);
      const current = await inspectSkillPackage(packageSource.root);
      if (
        record.name === current.name
        && record.description === current.description
        && record.instructions === current.instructions
        && record.packageHash === current.packageHash
        && record.packageFileCount === current.fileCount
        && record.packageTotalBytes === current.totalBytes
        && record.contentHash === current.packageHash
      ) {
        continue;
      }
      await this.store.updatePackageMetadata({
        id: record.id,
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

  private async availableForOwner(ownerUserId: string): Promise<PrivateSkill[]> {
    const discoveredNames = new Set(this.directoryEntries.map((entry) => entry.inspection.name));
    const privateSkills = await this.getMany(ownerUserId, (await this.list(ownerUserId))
      .filter((skill) => !discoveredNames.has(skill.name))
      .map((skill) => skill.id));
    const candidates = [...privateSkills, ...this.discoveredPrivateSkills(ownerUserId)]
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    return this.applyVisibility(ownerUserId, candidates);
  }

  private async applyVisibility(userId: string, skills: readonly PrivateSkill[]): Promise<PrivateSkill[]> {
    if (this.selectVisibleSkills === undefined) return [...skills];
    return [...await this.selectVisibleSkills({ userId, skills })];
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
      ...(entry.inspection.agentLoop === undefined ? {} : { agentLoop: entry.inspection.agentLoop }),
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

  private async resolveAvailableSkill(ownerUserId: string, skillId: string): Promise<PrivateSkill> {
    const discovered = this.discoveredPrivateSkills(ownerUserId).find((skill) => skill.id === skillId);
    if (discovered !== undefined) return discovered;
    return await this.get(ownerUserId, skillId);
  }

  private assertNotDiscoveredSkillName(name: string): void {
    if (this.directoryEntries.some((entry) => entry.inspection.name === name)) {
      throw conflict(`A discovered Skill named "${name}" already exists`);
    }
  }

  private async insert(input: SkillInsertRecord): Promise<void> {
    await this.store.insert(input);
  }
}

function assertUniqueDiscoveredNames(entries: readonly SkillDirectoryEntry[]): void {
  const byName = new Map<string, string>();
  for (const entry of entries) {
    const name = entry.inspection.name;
    const existingDirectory = byName.get(name);
    if (existingDirectory !== undefined) {
      throw new AppError(
        "SKILL_PACKAGE_INVALID",
        `Skill name "${name}" is discovered in multiple configured directories: ${existingDirectory} and ${entry.sourceDirectory}`,
        422,
      );
    }
    byName.set(name, entry.sourceDirectory);
  }
}

function toSummary(record: SkillRecord): SkillSummary {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    version: record.version,
    sourceKind: record.sourceKind,
    contentHash: record.contentHash,
    ...(record.sourceKind === "package" ? { package: parsePackageSource(record) } : {}),
    ...skillAgentLoopMetadata(record.instructions),
    updatedAt: record.updatedAt,
  };
}

function toPrivateSkill(record: SkillRecord): PrivateSkill {
  return {
    ...toSummary(record),
    ownerUserId: record.ownerUserId,
    instructions: record.instructions,
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
    ...(skill.agentLoop === undefined ? {} : { agentLoop: skill.agentLoop }),
    updatedAt: skill.updatedAt,
  };
}

function skillAgentLoopMetadata(instructions: string): Pick<SkillSummary, "agentLoop"> {
  const agentLoop = readSkillAgentLoopMetadata(instructions);
  return agentLoop === undefined ? {} : { agentLoop };
}

function parsePackageSource(record: SkillRecord): SkillPackageSource {
  if (
    record.packageRoot === null
    || record.entrypointPath === null
    || record.packageHash === null
    || record.packageFileCount === null
    || record.packageTotalBytes === null
  ) {
    throw new Error(`Stored package Skill ${record.id} has incomplete package metadata`);
  }
  if ((record.sourceUrl === null) !== (record.sourceRevision === null)) {
    throw new Error(`Stored package Skill ${record.id} has incomplete source provenance`);
  }
  return {
    root: record.packageRoot,
    entrypointPath: record.entrypointPath,
    packageHash: record.packageHash,
    fileCount: record.packageFileCount,
    totalBytes: record.packageTotalBytes,
    ...(record.sourceUrl === null ? {} : { url: record.sourceUrl, revision: record.sourceRevision! }),
  };
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
