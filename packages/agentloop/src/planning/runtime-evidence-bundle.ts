import type { ToolEvidence } from "./contracts.ts";
import { parseJsonRecord } from "../runtime/tool-result-evidence.ts";
import type { RuntimeResultRef } from "../runtime/runtime-result.ts";
import { runtimeResultEvidenceBundleDigest } from "../runtime/result-evidence-bundle.ts";
import type { RuntimeResultRepository } from "../runtime/runtime-result-repository.ts";

const MATERIALIZER_TOOL_NAME = "materialize_result_json";
const MATERIALIZATION_SCHEMA = "agentloop.runtimeResultMaterialization/v2";
const BUNDLE_SCHEMA = "agentloop.runtimeResultEvidenceBundle/v1";

export interface VerifiedRuntimeEvidenceBundle {
  readonly toolCallId: string;
  readonly materializationResultRef: RuntimeResultRef;
  readonly sourceResultRefs: readonly RuntimeResultRef[];
  readonly artifact: { readonly path: string; readonly bytes: number; readonly sha256: string };
}

export interface RejectedRuntimeEvidenceBundle {
  readonly toolCallId: string;
  readonly reason: string;
}

export interface AssessmentEvidenceBundles {
  readonly schema: "agentloop.assessmentEvidenceBundles/v1";
  readonly materializationAttempted: boolean;
  readonly verified: readonly VerifiedRuntimeEvidenceBundle[];
  readonly rejected: readonly RejectedRuntimeEvidenceBundle[];
}

/**
 * Assessment-owned verification of result materialization. The materializer
 * only produces a candidate bundle; no tool-returned evidence label can make
 * it authoritative until this verifier rereads every source Result.
 */
export class AssessmentEvidenceBundleVerifier {
  private readonly results: RuntimeResultRepository;

  constructor(results: RuntimeResultRepository) {
    this.results = results;
  }

  async verify(input: {
    readonly runId: string;
    readonly planId: string;
    readonly stepId: string;
    readonly actorUserId?: string;
    readonly conversationId?: string;
    readonly toolCalls: readonly ToolEvidence[];
  }): Promise<AssessmentEvidenceBundles> {
    const candidates = input.toolCalls.filter((toolCall) =>
      !toolCall.isError && toolCall.toolName === MATERIALIZER_TOOL_NAME
    );
    const verified: VerifiedRuntimeEvidenceBundle[] = [];
    const rejected: RejectedRuntimeEvidenceBundle[] = [];
    for (const toolCall of candidates) {
      const resultRef = toolCall.resultRef;
      if (resultRef === undefined) {
        rejected.push({ toolCallId: toolCall.toolCallId, reason: "materialization action has no committed Runtime Result" });
        continue;
      }
      const materializationResult = await this.results.readAuthorized({
        resultId: resultRef.resultId,
        runId: input.runId,
        planId: input.planId,
        stepId: input.stepId,
        ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      });
      if (materializationResult?.kind !== "tool" || materializationResult.payload.contentFormat !== "json") {
        rejected.push({ toolCallId: toolCall.toolCallId, reason: "materialization result is not an authorized JSON Tool Result" });
        continue;
      }
      const materialization = parseJsonRecord(materializationResult.payload.content);
      const sourceResultRefs = parseSourceResultRefs(materialization);
      const artifact = parseArtifact(materialization?.artifact);
      if (
        materialization?.schema !== MATERIALIZATION_SCHEMA
        || materialization.evidenceBundleSchema !== BUNDLE_SCHEMA
        || sourceResultRefs === undefined
        || artifact === undefined
      ) {
        rejected.push({ toolCallId: toolCall.toolCallId, reason: "materialization result has an invalid evidence-bundle envelope" });
        continue;
      }
      const sources = await Promise.all(sourceResultRefs.map((source) => this.results.readAuthorized({
        resultId: source.resultId,
        runId: input.runId,
        planId: input.planId,
        stepId: input.stepId,
        ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      })));
      if (sources.some((source) => source?.payload.contentFormat !== "json")) {
        rejected.push({ toolCallId: toolCall.toolCallId, reason: "one or more bundled source Results are unavailable or not JSON" });
        continue;
      }
      const records = sources.filter((source): source is NonNullable<typeof source> => source !== undefined);
      const digest = runtimeResultEvidenceBundleDigest(records);
      if (artifact.sha256 !== digest.sha256 || artifact.bytes !== digest.bytes) {
        rejected.push({ toolCallId: toolCall.toolCallId, reason: "bundle artifact hash or byte count does not match the authorized source Results" });
        continue;
      }
      verified.push({
        toolCallId: toolCall.toolCallId,
        materializationResultRef: materializationResult.ref,
        sourceResultRefs,
        artifact,
      });
    }
    return {
      schema: "agentloop.assessmentEvidenceBundles/v1",
      materializationAttempted: candidates.length > 0,
      verified,
      rejected,
    };
  }
}

function parseSourceResultRefs(value: Record<string, unknown> | undefined): RuntimeResultRef[] | undefined {
  if (!Array.isArray(value?.sourceResultRefs) || value.sourceResultRefs.length < 1 || value.sourceResultRefs.length > 32) return undefined;
  const refs: RuntimeResultRef[] = [];
  for (const item of value.sourceResultRefs) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    if (record.schema !== "agentloop.resultRef/v1" || typeof record.resultId !== "string" || !/^rr_[0-9a-f-]{36}$/u.test(record.resultId)) {
      return undefined;
    }
    refs.push({ schema: "agentloop.resultRef/v1", resultId: record.resultId });
  }
  return new Set(refs.map((ref) => ref.resultId)).size === refs.length ? refs : undefined;
}

function parseArtifact(value: unknown): { readonly path: string; readonly bytes: number; readonly sha256: string } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.path !== "string" || record.path.trim().length === 0
    || !Number.isSafeInteger(record.bytes) || (record.bytes as number) < 1
    || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.sha256)
  ) return undefined;
  return { path: record.path, bytes: record.bytes as number, sha256: record.sha256 };
}
