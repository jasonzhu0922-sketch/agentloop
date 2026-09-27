import type { AgentLoopToolEvidence } from "./contracts.ts";

/** Neutral source-content family; this is not a Profile-selection decision. */
export type SourceInputFamily = "tabular" | "document" | "presentation" | "image" | "audio" | "code" | "unknown";

/** Neutral, durable facts discovered from a committed source Tool result. */
export interface SourceFamilyObservation {
  readonly schema: "agentloop.sourceFamilyObservation/v1";
  readonly sourceKinds: readonly string[];
  readonly inputFamilies: readonly SourceInputFamily[];
  readonly sourceToolCallIds: readonly string[];
}

/**
 * Neutral source-kind discovery from committed structured results. The caller
 * decides what to do with these facts; this utility never selects a Skill,
 * grants a Tool, or interprets domain data.
 */
export function observedSourceKindsFromToolEvidence(evidence: readonly AgentLoopToolEvidence[]): readonly string[] {
  return observeSourceFamiliesFromToolEvidence(evidence).sourceKinds;
}

/**
 * Canonical Runtime observation point for source-family facts. It consumes
 * only successful, schema-tagged Tool results and never interprets business
 * content or selects a Profile itself.
 */
export function observeSourceFamiliesFromToolEvidence(evidence: readonly AgentLoopToolEvidence[]): SourceFamilyObservation {
  const sourceKinds = new Set<string>();
  const sourceToolCallIds = new Set<string>();
  for (const item of evidence) {
    if (item.isError) continue;
    const record = parseStructuredToolResult(item.result);
    if (record === undefined || !trustedSourceDiscoverySchema(record.schema)) continue;
    const before = sourceKinds.size;
    const extensions = record.extensions;
    if (isRecord(extensions)) {
      for (const extension of Object.keys(extensions)) addObservedSourceKind(sourceKinds, extension);
    }
    if (Array.isArray(record.files)) {
      for (const file of record.files) {
        if (!isRecord(file)) continue;
        if (typeof file.path === "string") addObservedSourceKind(sourceKinds, file.path);
      }
    }
    for (const path of stringArray(record.matches)) addObservedSourceKind(sourceKinds, path);
    for (const path of stringArray(record.samplePaths)) addObservedSourceKind(sourceKinds, path);
    if (sourceKinds.size > before) sourceToolCallIds.add(item.toolCallId);
  }
  const sortedSourceKinds = [...sourceKinds].sort();
  return {
    schema: "agentloop.sourceFamilyObservation/v1",
    sourceKinds: sortedSourceKinds,
    inputFamilies: [...sourceInputFamiliesForKinds(sortedSourceKinds)].sort(),
    sourceToolCallIds: [...sourceToolCallIds].sort(),
  };
}

function trustedSourceDiscoverySchema(value: unknown): boolean {
  return value === "agentloop.sourceSummary/v1"
    || value === "agentloop.visibleTableExtraction/v1"
    || value === "agentloop.tableExtractionArtifact/v1"
    || value === "agentloop.visibleFindFiles/v1";
}

function addObservedSourceKind(target: Set<string>, value: string): void {
  const extension = /\.([a-z0-9]{1,12})$/iu.exec(value.trim().toLowerCase())?.[1];
  if (extension !== undefined) target.add(extension);
}

function parseStructuredToolResult(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function sourceInputFamiliesForKinds(sourceKinds: readonly string[]): ReadonlySet<SourceInputFamily> {
  const families = new Set<SourceInputFamily>();
  for (const sourceKind of sourceKinds) {
    const value = sourceKind.toLowerCase();
    if (/(?:csv|tsv|xlsx|xlsm|xls|parquet|ndjson|json)/u.test(value)) families.add("tabular");
    else if (/(?:pdf|docx?|odt|rtf)/u.test(value)) families.add("document");
    else if (/(?:pptx?|key)/u.test(value)) families.add("presentation");
    else if (/(?:png|jpe?g|gif|webp|svg)/u.test(value)) families.add("image");
    else if (/(?:mp3|wav|m4a|aac|flac|ogg)/u.test(value)) families.add("audio");
    else if (/(?:js|ts|py|java|go|rs|cpp|json|yaml|yml)/u.test(value)) families.add("code");
    else families.add("unknown");
  }
  return families;
}
