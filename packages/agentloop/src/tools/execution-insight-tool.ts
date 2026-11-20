import { badRequest, forbidden, notFound } from "../shared/errors.ts";
import type { RuntimeResultRepository } from "../runtime/runtime-result-repository.ts";
import { isRuntimeResultId, RUNTIME_RESULT_ID_PATTERN } from "../runtime/runtime-result.ts";
import type { RuntimeTool } from "./tool-registry.ts";

interface ExecutionInsight {
  readonly resultIds: readonly string[];
  readonly purpose: string;
  readonly finding: string;
  readonly informationStatus: "fulfilled" | "partial" | "unfulfilled" | "unknown";
  readonly nextAction?: string;
  readonly evidence?: readonly { readonly resultId: string; readonly pointer: string }[];
}

/** Public interpretation of observed operations, never reasoning, proof of
 * correctness, completion authority, or a request to persist durable memory. */
export function createExecutionInsightTool(results: RuntimeResultRepository): RuntimeTool<ExecutionInsight> {
  const boundedText = { type: "string", minLength: 1, maxLength: 600 };
  return {
    name: "record_execution_insight", effect: "read", executionMode: "exclusive", replaySafe: true,
    description: [
      "Record a concise public finding from this step's already committed Tool Results when it changes the execution path or establishes a reusable method or boundary.",
      "Use after meaningful discoveries, empty results, changed approaches or verification; do not call for every operation.",
      "Record one bounded claim per finding, preserving prerequisites and uncertainty. State the information need, finding, whether that need was fulfilled, and any next action. Cite exact resultIds from this Run and step.",
      "A failed operation can still provide useful evidence. When a prerequisite blocks progress, select a small structured error/diagnostic value using evidence, distinguish the observed failure from a suspected cause, and state what authorized alternative or changed condition could make progress possible. Do not generalize a single failure into permanent resource unavailability or repeat unchanged calls just to create more evidence.",
      "For reusable resource/interface/schema knowledge, optionally select up to four small exact JSON values using evidence [{resultId,pointer}]. Pointers address the persisted Result envelope (as in read_result). Runtime copies these values, not your paraphrase; each selected value must fit 600 characters. Select metadata or method definitions, never data rows or logs.",
      "Do not copy rows, logs, prompts, credentials or private reasoning. Necessary source/schema/version identifiers and short method descriptions may be included.",
      "This records your interpretation with provenance. It does not verify the finding, create a user preference, satisfy Assessment or prove task completion.",
    ].join(" "),
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["resultIds", "purpose", "finding", "informationStatus"],
      properties: {
        resultIds: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true,
          items: { type: "string", pattern: RUNTIME_RESULT_ID_PATTERN } },
        purpose: boundedText, finding: boundedText,
        informationStatus: { enum: ["fulfilled", "partial", "unfulfilled", "unknown"] },
        nextAction: boundedText,
        evidence: { type: "array", minItems: 1, maxItems: 4, items: { type: "object", additionalProperties: false,
          required: ["resultId", "pointer"], properties: { resultId: { type: "string", pattern: RUNTIME_RESULT_ID_PATTERN }, pointer: { type: "string", minLength: 1, maxLength: 600 } } } },
      },
    },
    parse(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("arguments must be an object");
      const row = value as Record<string, unknown>;
      if (Object.keys(row).some(key => !["resultIds", "purpose", "finding", "informationStatus", "nextAction", "evidence"].includes(key))) throw badRequest("unknown insight field");
      if (!Array.isArray(row.resultIds) || !row.resultIds.length || row.resultIds.length > 4
        || row.resultIds.some(id => !isRuntimeResultId(id)) || new Set(row.resultIds).size !== row.resultIds.length) throw badRequest("resultIds must contain 1 to 4 distinct complete Runtime Result IDs");
      const text = (key: string) => {
        const item = row[key];
        if (typeof item !== "string" || !item.trim() || item.length > 600) throw badRequest(`${key} must contain 1 to 600 characters`);
        return item.trim();
      };
      if (!["fulfilled", "partial", "unfulfilled", "unknown"].includes(String(row.informationStatus))) throw badRequest("invalid informationStatus");
      if (row.evidence !== undefined && (!Array.isArray(row.evidence) || !row.evidence.length || row.evidence.length > 4 || row.evidence.some(item =>
        !item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !["resultId", "pointer"].includes(key))
        || !(row.resultIds as string[]).includes(item.resultId) || typeof item.pointer !== "string" || !item.pointer.startsWith("/") || item.pointer.length > 600
        || /~(?![01])/u.test(item.pointer)))) throw badRequest("evidence requires 1 to 4 pointers into the cited resultIds");
      return { resultIds: row.resultIds as string[], purpose: text("purpose"), finding: text("finding"),
        informationStatus: row.informationStatus as ExecutionInsight["informationStatus"],
        ...(row.evidence === undefined ? {} : { evidence: row.evidence as ExecutionInsight["evidence"] }),
        ...(row.nextAction === undefined ? {} : { nextAction: text("nextAction") }) };
    },
    async execute({ grant }, input) {
      if (!grant.planId || !grant.stepId) throw forbidden("Execution insights require a Plan-step-scoped grant");
      const sourceRefs: Array<{ resultId: string; actionId: string; toolName?: string }> = [];
      const groundedEvidence: Array<{ resultId: string; pointer: string; value: unknown; actionId: string; toolName?: string }> = [];
      for (const resultId of input.resultIds) {
        const record = await results.readAuthorized({ resultId, runId: grant.runId, planId: grant.planId,
          stepId: grant.stepId, actorUserId: grant.actorUserId, conversationId: grant.conversationId });
        if (!record || record.kind !== "tool" || record.producer.runId !== grant.runId
          || record.producer.planId !== grant.planId || record.producer.stepId !== grant.stepId
          || !record.producer.actionId || ["record_execution_insight", "recall_task_knowledge"].includes(record.producer.toolName ?? "")) throw notFound("Current-step environment Tool Result");
        sourceRefs.push({ resultId, actionId: record.producer.actionId, toolName: record.producer.toolName });
        for (const selection of input.evidence?.filter(item => item.resultId === resultId) ?? []) {
          if (record.payload.contentFormat !== "json") throw badRequest("Evidence selection requires a JSON Result; read a narrow structured value first");
          let value: unknown = JSON.parse(record.payload.content);
          for (const part of selection.pointer.slice(1).split("/")) {
            const key = part.replace(/~1/gu, "/").replace(/~0/gu, "~");
            if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) throw badRequest("Evidence pointer does not exist in the cited Result");
            value = (value as Record<string, unknown>)[key];
          }
          if (JSON.stringify(value).length > 600) throw badRequest("Evidence value exceeds 600 characters; select a narrower pointer");
          groundedEvidence.push({ ...selection, value, actionId: record.producer.actionId, toolName: record.producer.toolName });
        }
      }
      return { schema: "agentloop.executionInsight/v1", authority: "model_interpretation", ...input, sourceRefs,
        ...(groundedEvidence.length ? { groundedEvidence } : {}) };
    },
  };
}
