export type SkillStoreSourceKind = "inline" | "package";

export interface SkillRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly sourceKind: SkillStoreSourceKind;
  readonly sourceUrl: string | null;
  readonly sourceRevision: string | null;
  readonly packageRoot: string | null;
  readonly entrypointPath: string | null;
  readonly packageHash: string | null;
  readonly packageFileCount: number | null;
  readonly packageTotalBytes: number | null;
  readonly contentHash: string;
  readonly version: number;
  readonly updatedAt: number;
}

export interface SkillInsertRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly sourceKind: SkillStoreSourceKind;
  readonly sourceUrl?: string;
  readonly sourceRevision?: string;
  readonly packageRoot?: string;
  readonly entrypointPath?: string;
  readonly packageHash?: string;
  readonly packageFileCount?: number;
  readonly packageTotalBytes?: number;
  readonly contentHash: string;
  readonly now: number;
}

export interface SkillPackageMetadataUpdate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly packageHash: string;
  readonly packageFileCount: number;
  readonly packageTotalBytes: number;
  readonly now: number;
}

/**
 * Host-replaceable persistence boundary for Skills.
 *
 * Embedding applications may implement this interface over their own ORM,
 * tables, or service instead of accepting the kernel-owned SQLite schema.
 * When no store is injected, the default SQLite implementation persists into
 * the kernel schema over the provided connection.
 *
 * Contract notes for implementors:
 * - `insert` and `updatePackageMetadata` must reject a duplicate
 *   `(ownerUserId, name)` with the kernel conflict error (HTTP 409 semantics).
 * - All methods are promise-based, matching the async data-access boundary.
 * - Reads must never return rows owned by a different `ownerUserId`.
 */
export interface SkillStore {
  findIdByOwnerAndName(ownerUserId: string, name: string): Promise<{ id: string } | undefined>;
  listByOwner(ownerUserId: string): Promise<SkillRecord[]>;
  listPackageSkills(): Promise<SkillRecord[]>;
  listPackageSkillsWithoutSourceProvenance(): Promise<SkillRecord[]>;
  findByIdAndOwner(skillId: string, ownerUserId: string): Promise<SkillRecord | undefined>;
  insert(input: SkillInsertRecord): Promise<void>;
  updatePackageMetadata(input: SkillPackageMetadataUpdate): Promise<void>;
  deletePackageSkillById(id: string): Promise<void>;
}

/**
 * Optional capability interface for stores that want directory-discovery
 * snapshots mirrored into their persistence layer (audit trails, host-side
 * joins against business data). Stores implementing only {@link SkillStore}
 * keep discovery purely in memory.
 */
export interface SkillDiscoveryPersistence {
  /**
   * Reconcile the persisted catalog with the freshly discovered set: upsert
   * every record, bump versions on content change, and remove entries that no
   * longer exist under any configured directory.
   */
  syncDiscoveredSkills(records: readonly DiscoveredSkillSnapshot[]): Promise<void>;
  listDiscoveredSkills(): Promise<DiscoveredSkillSnapshot[]>;
}

export interface DiscoveredSkillSnapshot {
  readonly name: string;
  readonly description: string;
  /** Directory this package was discovered in; identifies the owning team under multi-directory setups. */
  readonly sourceDirectory: string;
  readonly packageHash: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  /** Opaque `agentloop:` frontmatter metadata; persisted verbatim for host consumption. */
  readonly agentLoop?: unknown;
  readonly syncedAt: number;
}
