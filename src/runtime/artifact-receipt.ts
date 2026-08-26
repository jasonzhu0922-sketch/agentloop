import { createHash } from "node:crypto";

export const ARTIFACT_RECEIPT_SCHEMA = "agentloop.artifactReceipt/v1" as const;
export const CONTEXT_ARTIFACT_PROJECTION_SCHEMA = "agentloop.contextArtifactProjection/v1" as const;

export interface ArtifactReceipt {
  readonly schema: typeof ARTIFACT_RECEIPT_SCHEMA;
  readonly receiptId: string;
  readonly sourceTool: string;
  readonly artifact: {
    readonly path: string;
    readonly artifactKind?: string;
    readonly renderMode?: string;
    readonly acceptanceProfile?: string;
    readonly pageCount?: number;
    readonly bytes: number;
    readonly characters: number;
    readonly totalLines: number;
    readonly sha256: string;
    readonly specSha256?: string;
  };
  readonly inspection: {
    readonly sha256: string;
    readonly characters: number;
    readonly totalLines: number;
    readonly outline: readonly unknown[];
    readonly outlineTruncated: boolean;
    readonly sampleRangeCount: number;
  };
  readonly evidenceKinds: {
    readonly satisfied: readonly string[];
    readonly caveated: readonly string[];
    readonly failed: readonly string[];
  };
  readonly canonicalEvidence: {
    readonly fullInspectionInToolResult: true;
  };
}

export interface ArtifactReceiptSource {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly characters: number;
  readonly totalLines: number;
  readonly inspection: {
    readonly sha256: string;
    readonly characters: number;
    readonly totalLines: number;
    readonly outline: readonly unknown[];
    readonly outlineTruncated: boolean;
    readonly sampleRanges: readonly unknown[];
  };
}

export interface ArtifactReceiptMetadata {
  readonly artifactKind?: string;
  readonly renderMode?: string;
  readonly acceptanceProfile?: string;
  readonly pageCount?: number;
  readonly specSha256?: string;
}

export function buildArtifactReceipt(
  sourceTool: string,
  receipt: ArtifactReceiptSource,
  metadata: ArtifactReceiptMetadata = {},
): ArtifactReceipt {
  const artifact = omitUndefined({
    path: receipt.path,
    artifactKind: metadata.artifactKind,
    renderMode: metadata.renderMode,
    acceptanceProfile: metadata.acceptanceProfile,
    pageCount: metadata.pageCount,
    bytes: receipt.bytes,
    characters: receipt.characters,
    totalLines: receipt.totalLines,
    sha256: receipt.sha256,
    specSha256: metadata.specSha256,
  }) as ArtifactReceipt["artifact"];
  return {
    schema: ARTIFACT_RECEIPT_SCHEMA,
    receiptId: artifactReceiptId(receipt.path, receipt.sha256),
    sourceTool,
    artifact,
    inspection: {
      sha256: receipt.inspection.sha256,
      characters: receipt.inspection.characters,
      totalLines: receipt.inspection.totalLines,
      outline: receipt.inspection.outline.slice(0, 24),
      outlineTruncated: receipt.inspection.outlineTruncated,
      sampleRangeCount: receipt.inspection.sampleRanges.length,
    },
    evidenceKinds: {
      satisfied: [
        "artifact_path",
        "artifact_non_empty",
        "artifact_integrity",
        "artifact_inspection",
        ...(metadata.acceptanceProfile === undefined ? [] : ["format_matches_request"]),
      ],
      caveated: [],
      failed: [],
    },
    canonicalEvidence: {
      fullInspectionInToolResult: true,
    },
  };
}

function artifactReceiptId(path: string, sha256: string): string {
  return `artifact:${createHash("sha256").update(`${path}\0${sha256}`).digest("hex")}`;
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
