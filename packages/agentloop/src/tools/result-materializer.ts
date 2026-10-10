import { badRequest, forbidden, notFound } from "../shared/errors.ts";
import { requireRecord, requireString } from "../shared/validation.ts";
import type { ComputerExecutor } from "../computer/computer-executor.ts";
import { buildArtifactReceipt } from "../runtime/artifact-receipt.ts";
import {
  RUNTIME_RESULT_EVIDENCE_BUNDLE_SCHEMA,
  serializeRuntimeResultEvidenceBundle,
} from "../runtime/result-evidence-bundle.ts";
import type { RuntimeResultRepository } from "../runtime/runtime-result-repository.ts";
import { executorForContext } from "./computer-tools.ts";
import type { RuntimeTool, ToolExecutionContext } from "./tool-registry.ts";

export const RESULT_JSON_MATERIALIZER_NAME = "materialize_result_json";

interface MaterializeResultJsonInput {
  readonly resultIds: readonly string[];
  readonly path: string;
}

/** Runtime-owned materialization of a bounded, authorized JSON Result set. */
export function createResultJsonMaterializer(
  repository: RuntimeResultRepository,
  executor: ComputerExecutor,
): RuntimeTool<MaterializeResultJsonInput> {
  return {
    name: RESULT_JSON_MATERIALIZER_NAME,
    description: [
      "Materialize authorized JSON Runtime Results as one valid, Runtime-written workspace JSON evidence bundle.",
      "Pass opaque resultIds and a new workspace-relative .json path. Runtime preserves every result identity, producer metadata, and payload hash; never recreate or aggregate tool output through computer_write_file.",
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["resultIds", "path"],
      properties: {
        resultIds: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: { type: "string", minLength: 4, maxLength: 120 },
        },
        path: { type: "string", minLength: 6, maxLength: 4_000 },
      },
    },
    executionMode: "exclusive",
    replaySafe: false,
    parse(value: unknown): MaterializeResultJsonInput {
      const record = requireRecord(value, "materialize_result_json arguments");
      if (!Array.isArray(record.resultIds) || record.resultIds.length < 1 || record.resultIds.length > 32) {
        throw badRequest("resultIds must contain between 1 and 32 opaque Runtime result ids");
      }
      const resultIds = record.resultIds.map((value, index) => {
        const resultId = requireString(value, `resultIds[${index}]`, { min: 4, max: 120 });
        if (!/^rr_[0-9a-f-]{36}$/u.test(resultId)) throw badRequest("resultIds must contain opaque Runtime result ids");
        return resultId;
      });
      if (new Set(resultIds).size !== resultIds.length) throw badRequest("resultIds must not contain duplicates");
      const path = requireString(record.path, "path", { min: 6, max: 4_000 });
      if (!path.endsWith(".json")) throw badRequest("path must end with .json");
      return { resultIds, path };
    },
    async preflight(context, input) {
      await Promise.all(input.resultIds.map((resultId) => readAuthorizedJsonResult(repository, context, resultId)));
      await executorForContext(executor, context).prepareWritableFile(input.path, "create");
    },
    async execute(context, input) {
      const records = await Promise.all(input.resultIds.map((resultId) => readAuthorizedJsonResult(repository, context, resultId)));
      const receipt = await executorForContext(executor, context).writeFile(
        input.path,
        serializeRuntimeResultEvidenceBundle(records),
        "create",
      );
      const evidenceReceipt = {
        schema: "agentloop.toolEvidenceReceipt/v1" as const,
        sourceType: "runtime_result_materialization",
        receiptId: receipt.sha256,
        sourceRefs: records.map((record) => ({
          result: record.ref,
          kind: record.kind,
          ...(record.producer.toolName === undefined ? {} : { toolName: record.producer.toolName }),
          sha256: record.payload.sha256,
        })),
        facts: [{
          kind: "structured_extraction_artifact",
          path: receipt.path,
          bytes: receipt.bytes,
          sha256: receipt.sha256,
          sourceResultRefs: records.map((record) => record.ref),
          sourcePayloadSha256es: records.map((record) => record.payload.sha256),
        }],
        caveats: [],
        evidenceKinds: {
          satisfied: ["structured_extraction_artifact", "artifact_path", "artifact_non_empty"],
          caveated: [],
          failed: [],
        },
      };
      return {
        schema: "agentloop.runtimeResultMaterialization/v2",
        evidenceBundleSchema: RUNTIME_RESULT_EVIDENCE_BUNDLE_SCHEMA,
        sourceResultRefs: records.map((record) => record.ref),
        artifact: { path: receipt.path, bytes: receipt.bytes, sha256: receipt.sha256 },
        artifactReceipt: buildArtifactReceipt(RESULT_JSON_MATERIALIZER_NAME, receipt, {
          artifactKind: "json",
          writeMode: receipt.mode,
          writtenBytes: receipt.writtenBytes,
        }),
        evidenceReceipt,
      };
    },
  };
}

async function readAuthorizedJsonResult(
  repository: RuntimeResultRepository,
  context: ToolExecutionContext,
  resultId: string,
) {
  const planId = context.grant.planId;
  const stepId = context.grant.stepId;
  if (planId === undefined || stepId === undefined) {
    throw forbidden("Runtime result materialization requires a Plan-step-scoped Runtime grant");
  }
  const record = await repository.readAuthorized({
    resultId,
    runId: context.grant.runId,
    planId,
    stepId,
    actorUserId: context.grant.actorUserId,
    ...(context.grant.conversationId === undefined ? {} : { conversationId: context.grant.conversationId }),
  });
  if (record === undefined) throw notFound("Runtime result");
  if (record.payload.contentFormat !== "json") throw badRequest("Only JSON Runtime Results can be materialized as JSON artifacts");
  return record;
}
