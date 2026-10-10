import { createHash } from "node:crypto";
import type { RuntimeResultRecord } from "./runtime-result.ts";

export const RUNTIME_RESULT_EVIDENCE_BUNDLE_SCHEMA = "agentloop.runtimeResultEvidenceBundle/v1" as const;

export interface RuntimeResultEvidenceBundleDocument {
  readonly schema: typeof RUNTIME_RESULT_EVIDENCE_BUNDLE_SCHEMA;
  readonly sources: readonly {
    readonly sourceResultRef: RuntimeResultRecord["ref"];
    readonly source: {
      readonly kind: RuntimeResultRecord["kind"];
      readonly toolName?: string;
      readonly resultSchema?: string;
      readonly sha256: string;
    };
    readonly value: unknown;
  }[];
}

/** Shared canonical form for Runtime materialization and Assessment verification. */
export function buildRuntimeResultEvidenceBundle(records: readonly RuntimeResultRecord[]): RuntimeResultEvidenceBundleDocument {
  return {
    schema: RUNTIME_RESULT_EVIDENCE_BUNDLE_SCHEMA,
    sources: records.map((record) => ({
      sourceResultRef: record.ref,
      source: {
        kind: record.kind,
        ...(record.producer.toolName === undefined ? {} : { toolName: record.producer.toolName }),
        ...(record.payload.resultSchema === undefined ? {} : { resultSchema: record.payload.resultSchema }),
        sha256: record.payload.sha256,
      },
      value: JSON.parse(record.payload.content) as unknown,
    })),
  };
}

export function serializeRuntimeResultEvidenceBundle(records: readonly RuntimeResultRecord[]): string {
  return `${JSON.stringify(buildRuntimeResultEvidenceBundle(records), null, 2)}\n`;
}

export function runtimeResultEvidenceBundleDigest(records: readonly RuntimeResultRecord[]): { readonly sha256: string; readonly bytes: number } {
  const content = serializeRuntimeResultEvidenceBundle(records);
  return { sha256: createHash("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content) };
}
