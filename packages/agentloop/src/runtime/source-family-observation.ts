import type { AgentLoopToolEvidence } from "./contracts.ts";

/**
 * Neutral source-kind discovery from committed structured results. The caller
 * decides what to do with these facts; this utility never selects a Skill,
 * grants a Tool, or interprets domain data.
 */
export function observedSourceKindsFromToolEvidence(evidence: readonly AgentLoopToolEvidence[]): readonly string[] {
  const sourceKinds = new Set<string>();
  for (const item of evidence) {
    if (item.isError) continue;
    const record = parseStructuredToolResult(item.result);
    if (record === undefined || !trustedSourceDiscoverySchema(record.schema)) continue;
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
  }
  return [...sourceKinds].sort();
}

function trustedSourceDiscoverySchema(value: unknown): boolean {
  return value === "agentloop.sourceSummary/v1"
    || value === "agentloop.visibleTableExtraction/v1"
    || value === "agentloop.tableExtractionArtifact/v1";
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
