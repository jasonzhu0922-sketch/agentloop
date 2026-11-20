import { badRequest, forbidden } from "../shared/errors.ts";
import type { AgentLoopMemoryPlugin } from "../runtime/memory-plugin.ts";
import type { RuntimeTool } from "./tool-registry.ts";

interface RecallInput {
  readonly query: string;
  readonly layer?: "strategy" | "environment";
  readonly resourceContext: readonly { readonly key: string; readonly value: string }[];
}

/** Query the current owner's independently published task knowledge. Results
 * are bounded advice, never a capability grant or proof of current facts. */
export function createMemoryRecallTool(memory: AgentLoopMemoryPlugin, authorizeRun: (actorUserId: string, runId: string) => Promise<void>): RuntimeTool<RecallInput> {
  return {
    name: "recall_task_knowledge", effect: "read", executionMode: "exclusive", replaySafe: true,
    description: [
      "Look up reusable subtask strategies or resource/environment knowledge when this step has a concrete information gap: where to look, how to operate, or what to verify.",
      "Query using the CURRENT information need, not the entire task. Supply resourceContext only from resources/versions already identified in the current task; missing exact selectors deliberately exclude scoped knowledge.",
      "Use before repeated exploration or after an unexpected result; do not call after every tool. An empty result is normal.",
      "For a blocked prerequisite, query conditional stop/retry/change-path strategies as well as environment knowledge; omit layer to consider both. A strategy card marked maturity=candidate is an evidence-grounded hypothesis, not a proven decision or instruction to stop. Check its current trigger, exclusions, authorized alternatives and resume conditions before acting. Never stop solely because of remembered past unavailability; if current evidence establishes no admissible continuation, report the block honestly rather than rewording an unmet result as success.",
      "Check applicability, recheck rules and current Skill/Tool contracts before use. Bind parameters from this task, verify remembered resource facts, and never treat historical knowledge as current execution evidence or new permission.",
    ].join(" "),
    inputSchema: { type: "object", additionalProperties: false, required: ["query"], properties: {
      query: { type: "string", minLength: 1, maxLength: 600 }, layer: { enum: ["strategy", "environment"] },
      resourceContext: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false,
        required: ["key", "value"], properties: { key: { type: "string", pattern: "^[a-zA-Z][\\w.:-]{0,119}$" }, value: { type: "string", minLength: 1, maxLength: 200 } } } },
    } },
    parse(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("arguments must be an object");
      const row = value as Record<string, any>;
      if (Object.keys(row).some(key => !["query", "layer", "resourceContext"].includes(key))
        || typeof row.query !== "string" || !row.query.trim() || row.query.length > 600
        || row.layer !== undefined && !["strategy", "environment"].includes(row.layer)) throw badRequest("invalid knowledge query");
      const resourceContext = row.resourceContext ?? [];
      if (!Array.isArray(resourceContext) || resourceContext.length > 12 || resourceContext.some(item => !item || typeof item !== "object" || Array.isArray(item)
        || Object.keys(item).some(key => !["key", "value"].includes(key))
        || typeof item.key !== "string" || !/^[a-zA-Z][\w.:-]{0,119}$/u.test(item.key)
        || ["constructor", "prototype", "__proto__", "goal", "knowledgeOnly", "knowledgeLayer", "stepId", "planId"].includes(item.key)
        || typeof item.value !== "string" || !item.value.trim() || item.value.length > 200)
        || new Set(resourceContext.map(item => item.key)).size !== resourceContext.length) throw badRequest("invalid resourceContext selectors");
      return { query: row.query.trim(), ...(row.layer ? { layer: row.layer } : {}), resourceContext };
    },
    async execute({ grant }, input) {
      if (!grant.planId || !grant.stepId) throw forbidden("Knowledge recall requires a Plan-step-scoped grant");
      await authorizeRun(grant.actorUserId, grant.runId);
      const projection = await memory.recall({ runId: grant.runId, target: "execution",
        stepContext: { ...Object.fromEntries(input.resourceContext.map(item => [item.key, item.value])),
          goal: input.query, knowledgeOnly: true, knowledgeLayer: input.layer, planId: grant.planId, stepId: grant.stepId },
        budget: { maxItems: 4, maxTokens: 1600 } });
      const knowledgeCards = projection?.target === "execution" ? projection.knowledgeCards ?? [] : [];
      return { schema: "agentloop.taskKnowledgeRecall/v1", runId: grant.runId, planId: grant.planId, stepId: grant.stepId,
        ...(projection ? { projectionId: projection.id } : {}), knowledgeCards,
        status: knowledgeCards.length ? "found" : "empty", requiresVerification: true };
    },
  };
}
