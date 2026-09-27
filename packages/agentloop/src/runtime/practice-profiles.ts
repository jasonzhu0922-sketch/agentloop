import { createHash } from "node:crypto";
import type { ArtifactKind, DeliverySurface, SourceNeed } from "./dynamic-prompt.ts";
import { sourceInputFamiliesForKinds, type SourceInputFamily } from "./source-family-observation.ts";
import type { StructuredTaskOperationProfile, StructuredTaskUnderstanding } from "./task-intent.ts";

export type PracticeInputFamily = SourceInputFamily;
export type PracticeProfileMode = "observe" | "active";
export type PracticeProfileSelectionPoint = "task_understanding" | "source_discovery";

/**
 * Deployment-owned professional guidance. Practice profiles may shape model
 * attention, but deliberately cannot expose Tools, select Skills, or change
 * Runtime evidence and completion authority.
 */
export interface PracticeProfile {
  readonly schema: "agentloop.practiceProfile/v1";
  readonly id: string;
  readonly version: string;
  /** A deployment may temporarily suppress one profile without deleting it. */
  readonly enabled?: boolean;
  readonly name?: string;
  readonly priority?: number;
  readonly appliesTo?: {
    readonly operationProfiles?: readonly StructuredTaskOperationProfile[];
    readonly artifactKinds?: readonly ArtifactKind[];
    readonly sourceNeeds?: readonly SourceNeed[];
    readonly deliverySurfaces?: readonly DeliverySurface[];
    /** Source families inferred from Runtime-owned uploaded-source metadata. */
    readonly inputFamilies?: readonly PracticeInputFamily[];
    /** Every normalized term must occur in the Runtime-owned task text. */
    readonly allTerms?: readonly string[];
    /** At least one normalized term must occur in the Runtime-owned task text. */
    readonly anyTerms?: readonly string[];
  };
  /**
   * Task-level professional guidance. The Runtime decides when it is useful
   * to project this guidance; configuration never targets lifecycle phases.
   */
  readonly guidance: {
    readonly instructions: readonly string[];
    readonly antiPatterns?: readonly string[];
  };
}

export interface PracticeProfileCatalog {
  readonly schema: "agentloop.practiceProfileCatalog/v1";
  /** Explicit deployment kill switch. Omission preserves the active legacy default. */
  readonly enabled?: boolean;
  /** Observe records deterministic matches; active additionally projects guidance to the model. */
  readonly mode?: PracticeProfileMode;
  readonly maxActiveProfiles?: number;
  readonly maxInstructions?: number;
  readonly profiles: readonly PracticeProfile[];
}

/** A selected, immutable guidance snapshot persisted with the admitted Plan. */
export interface PracticeProfileSelection {
  readonly schema: "agentloop.practiceProfileSelection/v1";
  readonly id: string;
  readonly version: string;
  readonly contentHash: string;
  readonly reason: string;
  readonly guidance: PracticeProfile["guidance"];
}

/** A persisted Runtime observation, distinct from a prompt-authority decision. */
export interface PracticeProfileResolution {
  readonly schema: "agentloop.practiceProfileResolution/v1";
  readonly catalogEnabled: boolean;
  readonly mode: PracticeProfileMode;
  readonly selectionPoint: PracticeProfileSelectionPoint;
  readonly observedInputFamilies: readonly PracticeInputFamily[];
  readonly profiles: readonly PracticeProfileSelection[];
  readonly guidanceInjected: boolean;
}

const ARTIFACT_KINDS = new Set<ArtifactKind>(["html", "document", "presentation", "spreadsheet", "image", "audio", "code", "none"]);
const SOURCE_NEEDS = new Set<SourceNeed>(["none", "lookup_lite", "source_grounded", "strict_user_source"]);
const DELIVERY_SURFACES = new Set<DeliverySurface>(["conversation", "workspace_artifact"]);
const OPERATION_PROFILES = new Set<StructuredTaskOperationProfile>([
  "data_analysis", "content_generation", "code_change", "web_research", "artifact_build", "direct_answer",
]);
const INPUT_FAMILIES = new Set<PracticeInputFamily>(["tabular", "document", "presentation", "image", "audio", "code", "unknown"]);
const DEFAULT_MAX_ACTIVE_PROFILES = 3;
const DEFAULT_MAX_INSTRUCTIONS = 8;

export function assertPracticeProfileCatalog(value: PracticeProfileCatalog): PracticeProfileCatalog {
  if (value.schema !== "agentloop.practiceProfileCatalog/v1") {
    throw new TypeError("practice profile catalog must use schema agentloop.practiceProfileCatalog/v1");
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new TypeError("practice profile catalog enabled must be boolean when provided");
  }
  if (value.mode !== undefined && value.mode !== "observe" && value.mode !== "active") {
    throw new TypeError("practice profile catalog mode must be observe or active when provided");
  }
  const maxActiveProfiles = positiveInteger(value.maxActiveProfiles, "maxActiveProfiles", DEFAULT_MAX_ACTIVE_PROFILES);
  const maxInstructions = positiveInteger(value.maxInstructions, "maxInstructions", DEFAULT_MAX_INSTRUCTIONS);
  if (!Array.isArray(value.profiles)) throw new TypeError("practice profile catalog profiles must be an array");
  const ids = new Set<string>();
  for (const profile of value.profiles) {
    assertPracticeProfile(profile, ids);
    ids.add(profile.id);
  }
  return {
    schema: value.schema,
    enabled: value.enabled ?? true,
    mode: value.mode ?? "active",
    maxActiveProfiles,
    maxInstructions,
    profiles: value.profiles,
  };
}

export function resolvePracticeProfiles(
  catalog: PracticeProfileCatalog | undefined,
  task: StructuredTaskUnderstanding,
  options: { readonly excludedProfileIds?: readonly string[] } = {},
): readonly PracticeProfileSelection[] {
  return resolvePracticeProfileResolution(catalog, task, {
    selectionPoint: "task_understanding",
    excludedProfileIds: options.excludedProfileIds,
  }).profiles;
}

export function resolvePracticeProfileResolution(
  catalog: PracticeProfileCatalog | undefined,
  task: StructuredTaskUnderstanding,
  input: {
    readonly selectionPoint: PracticeProfileSelectionPoint;
    readonly excludedProfileIds?: readonly string[];
  },
): PracticeProfileResolution {
  const observedInputFamilies = [...practiceInputFamiliesForSourceKinds(task.evidence.sourceKinds)].sort();
  if (catalog === undefined) {
    return {
      schema: "agentloop.practiceProfileResolution/v1",
      catalogEnabled: false,
      mode: "observe",
      selectionPoint: input.selectionPoint,
      observedInputFamilies,
      profiles: [],
      guidanceInjected: false,
    };
  }
  const checked = assertPracticeProfileCatalog(catalog);
  const catalogEnabled = checked.enabled !== false;
  const mode = checked.mode ?? "active";
  if (!catalogEnabled) {
    return {
      schema: "agentloop.practiceProfileResolution/v1",
      catalogEnabled,
      mode,
      selectionPoint: input.selectionPoint,
      observedInputFamilies,
      profiles: [],
      guidanceInjected: false,
    };
  }
  const maxActiveProfiles = checked.maxActiveProfiles ?? DEFAULT_MAX_ACTIVE_PROFILES;
  const maxInstructions = checked.maxInstructions ?? DEFAULT_MAX_INSTRUCTIONS;
  const excluded = new Set(input.excludedProfileIds ?? []);
  const remainingProfileBudget = Math.max(0, maxActiveProfiles - excluded.size);
  const active = checked.profiles
    .filter((profile) => profile.enabled !== false && !excluded.has(profile.id) && matches(profile, task))
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id))
    .slice(0, remainingProfileBudget);
  const seenInstructions = new Set<string>();
  const profiles: PracticeProfileSelection[] = active.map((profile) => ({
    schema: "agentloop.practiceProfileSelection/v1",
    id: profile.id,
    version: profile.version,
    contentHash: practiceProfileHash(profile),
    reason: matchingReason(profile, task),
    guidance: boundedGuidance(profile.guidance, maxInstructions, seenInstructions),
  }));
  return {
    schema: "agentloop.practiceProfileResolution/v1",
    catalogEnabled,
    mode,
    selectionPoint: input.selectionPoint,
    observedInputFamilies,
    profiles,
    guidanceInjected: mode === "active" && profiles.some((profile) => profile.guidance.instructions.length > 0),
  };
}

/** Runtime projects guidance only after it has selected the task-level snapshot. */
export function practiceGuidanceForPrompt(
  profiles: readonly PracticeProfileSelection[] | undefined,
): readonly { readonly id: string; readonly version: string; readonly contentHash: string; readonly reason: string; readonly guidance: PracticeProfile["guidance"] }[] {
  return (profiles ?? [])
    .map((profile) => ({
      id: profile.id,
      version: profile.version,
      contentHash: profile.contentHash,
      reason: profile.reason,
      guidance: profile.guidance,
    }))
    .filter((profile) => profile.guidance.instructions.length > 0);
}

function assertPracticeProfile(profile: PracticeProfile, ids: ReadonlySet<string>): void {
  if (profile === null || typeof profile !== "object" || profile.schema !== "agentloop.practiceProfile/v1") {
    throw new TypeError("practice profile must use schema agentloop.practiceProfile/v1");
  }
  if (!validIdentifier(profile.id) || ids.has(profile.id)) throw new TypeError(`practice profile id must be unique and non-empty: ${profile.id}`);
  if (typeof profile.version !== "string" || profile.version.trim().length === 0) throw new TypeError(`practice profile ${profile.id} version must be non-empty`);
  if (profile.enabled !== undefined && typeof profile.enabled !== "boolean") throw new TypeError(`practice profile ${profile.id} enabled must be boolean when provided`);
  if (profile.name !== undefined && (typeof profile.name !== "string" || profile.name.trim().length === 0)) throw new TypeError(`practice profile ${profile.id} name must be non-empty when provided`);
  if (profile.priority !== undefined && (!Number.isSafeInteger(profile.priority) || profile.priority < -100 || profile.priority > 100)) {
    throw new TypeError(`practice profile ${profile.id} priority must be an integer from -100 to 100`);
  }
  if (profile.guidance === null || typeof profile.guidance !== "object" || Array.isArray(profile.guidance)) throw new TypeError(`practice profile ${profile.id} guidance must be an object`);
  assertGuidanceLines(profile.guidance.instructions, `practice profile ${profile.id} guidance.instructions`);
  if (profile.guidance.antiPatterns !== undefined) assertGuidanceLines(profile.guidance.antiPatterns, `practice profile ${profile.id} guidance.antiPatterns`);
  const appliesTo = profile.appliesTo;
  if (appliesTo === undefined) return;
  assertSubset(appliesTo.operationProfiles, OPERATION_PROFILES, `practice profile ${profile.id} operationProfiles`);
  assertSubset(appliesTo.artifactKinds, ARTIFACT_KINDS, `practice profile ${profile.id} artifactKinds`);
  assertSubset(appliesTo.sourceNeeds, SOURCE_NEEDS, `practice profile ${profile.id} sourceNeeds`);
  assertSubset(appliesTo.deliverySurfaces, DELIVERY_SURFACES, `practice profile ${profile.id} deliverySurfaces`);
  assertSubset(appliesTo.inputFamilies, INPUT_FAMILIES, `practice profile ${profile.id} inputFamilies`);
  assertTerms(appliesTo.allTerms, `practice profile ${profile.id} allTerms`);
  assertTerms(appliesTo.anyTerms, `practice profile ${profile.id} anyTerms`);
}

function matches(profile: PracticeProfile, task: StructuredTaskUnderstanding): boolean {
  const appliesTo = profile.appliesTo;
  if (appliesTo === undefined) return true;
  if (appliesTo.operationProfiles !== undefined && !appliesTo.operationProfiles.some((item) => task.operationProfiles.includes(item))) return false;
  if (appliesTo.artifactKinds !== undefined && !appliesTo.artifactKinds.includes(task.deliverable.kind)) return false;
  if (appliesTo.sourceNeeds !== undefined && !appliesTo.sourceNeeds.includes(task.evidence.need)) return false;
  if (appliesTo.deliverySurfaces !== undefined && !appliesTo.deliverySurfaces.includes(task.deliverable.surface)) return false;
  if (appliesTo.inputFamilies !== undefined && !appliesTo.inputFamilies.some((family) => taskInputFamilies(task).has(family))) return false;
  const text = task.normalizedObjective;
  if (appliesTo.allTerms !== undefined && !appliesTo.allTerms.every((term) => text.includes(normalizeTerm(term)))) return false;
  if (appliesTo.anyTerms !== undefined && !appliesTo.anyTerms.some((term) => text.includes(normalizeTerm(term)))) return false;
  return true;
}

function matchingReason(profile: PracticeProfile, task: StructuredTaskUnderstanding): string {
  const dimensions: string[] = [];
  const appliesTo = profile.appliesTo;
  if (appliesTo?.operationProfiles?.some((item) => task.operationProfiles.includes(item))) dimensions.push("operation profile");
  if (appliesTo?.artifactKinds?.includes(task.deliverable.kind)) dimensions.push("artifact kind");
  if (appliesTo?.sourceNeeds?.includes(task.evidence.need)) dimensions.push("source need");
  if (appliesTo?.deliverySurfaces?.includes(task.deliverable.surface)) dimensions.push("delivery surface");
  if (appliesTo?.inputFamilies?.some((family) => taskInputFamilies(task).has(family))) dimensions.push("input family");
  if (appliesTo?.allTerms?.length || appliesTo?.anyTerms?.length) dimensions.push("configured terms");
  return dimensions.length === 0 ? "unconditional deployment profile" : `matched ${dimensions.join(", ")}`;
}

function practiceProfileHash(profile: PracticeProfile): string {
  return createHash("sha256").update(JSON.stringify({
    schema: profile.schema,
    id: profile.id,
    version: profile.version,
    ...(profile.enabled === undefined ? {} : { enabled: profile.enabled }),
    ...(profile.name === undefined ? {} : { name: profile.name }),
    ...(profile.priority === undefined ? {} : { priority: profile.priority }),
    ...(profile.appliesTo === undefined ? {} : { appliesTo: profile.appliesTo }),
    guidance: profile.guidance,
  })).digest("hex");
}

function boundedGuidance(
  guidance: PracticeProfile["guidance"],
  maximum: number,
  seenInstructions: Set<string>,
): PracticeProfileSelection["guidance"] {
  const instructions = guidance.instructions
    .filter((instruction) => !seenInstructions.has(instruction))
    .slice(0, Math.max(0, maximum - seenInstructions.size));
  for (const instruction of instructions) seenInstructions.add(instruction);
  return {
    instructions,
    ...(guidance.antiPatterns === undefined ? {} : { antiPatterns: [...new Set(guidance.antiPatterns)] }),
  };
}

function positiveInteger(value: number | undefined, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) throw new TypeError(`${field} must be an integer from 1 to 32`);
  return value;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,79}$/u.test(value);
}

function assertSubset<T extends string>(value: readonly T[] | undefined, allowed: ReadonlySet<T>, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length || value.some((item) => !allowed.has(item))) {
    throw new TypeError(`${field} must be a non-empty unique array of supported values`);
  }
}

function assertTerms(value: readonly string[] | undefined, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0 || value.some((term) => typeof term !== "string" || normalizeTerm(term).length === 0 || term.length > 120)) {
    throw new TypeError(`${field} must be a non-empty array of short non-empty strings`);
  }
}

function assertGuidanceLines(value: unknown, field: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((line) => typeof line !== "string" || line.trim().length === 0 || line.length > 2_000)) {
    throw new TypeError(`${field} must be a non-empty array of strings under 2000 characters`);
  }
}

export function practiceInputFamiliesForSourceKinds(sourceKinds: readonly string[]): ReadonlySet<PracticeInputFamily> {
  return sourceInputFamiliesForKinds(sourceKinds);
}

function taskInputFamilies(task: StructuredTaskUnderstanding): ReadonlySet<PracticeInputFamily> {
  return practiceInputFamiliesForSourceKinds(task.evidence.sourceKinds);
}

function normalizeTerm(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}
