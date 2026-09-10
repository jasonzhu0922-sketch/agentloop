import { badRequest } from "../shared/errors.ts";
import type { HumanLoopRequirement, HumanLoopResponseSchema } from "../runtime/human-loop.ts";
import type { RuntimeTool } from "./tool-registry.ts";

export const HUMAN_LOOP_TOOL_NAME = "request_human_loop";

export function createHumanLoopTool(): RuntimeTool<HumanLoopRequirement> {
  return {
    name: HUMAN_LOOP_TOOL_NAME,
    description: "Request structured user input, selection, confirmation, or approval when the current step cannot safely continue. This pauses the Run; do not use prose instead.",
    executionMode: "exclusive",
    replaySafe: true,
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["kind", "title", "prompt", "rationale", "evidenceRefs", "responseSchema", "resume"],
      properties: {
        kind: { type: "string", enum: ["selection", "input", "confirmation", "approval"] },
        title: { type: "string" }, prompt: { type: "string" }, rationale: { type: "string" },
        evidenceRefs: { type: "array", items: { type: "string" } },
        responseSchema: { type: "object" },
        resume: { type: "object" },
      },
    },
    parse(input): HumanLoopRequirement {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw badRequest("Human-in-the-Loop request must be an object");
      const value = input as Record<string, unknown>;
      const string = (name: string) => typeof value[name] === "string" && value[name].trim() ? value[name] : (() => { throw badRequest(`${name} is required`); })();
      const kind = string("kind");
      if (!["selection", "input", "confirmation", "approval"].includes(kind)) throw badRequest("Invalid Human-in-the-Loop kind");
      if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.some((item) => typeof item !== "string")) throw badRequest("evidenceRefs must be a string array");
      const responseSchema = value.responseSchema;
      const resume = value.resume;
      if (!responseSchema || typeof responseSchema !== "object" || Array.isArray(responseSchema) || !resume || typeof resume !== "object" || Array.isArray(resume)) throw badRequest("responseSchema and resume are required");
      const mode = (resume as Record<string, unknown>).mode;
      if (mode !== "continue_step" && mode !== "replan_step" && mode !== "recovery_review") throw badRequest("Invalid Human-in-the-Loop resume mode");
      return { kind: kind as HumanLoopRequirement["kind"], title: string("title"), prompt: string("prompt"), rationale: string("rationale"), evidenceRefs: value.evidenceRefs as string[], responseSchema: responseSchema as HumanLoopResponseSchema, resume: resume as HumanLoopRequirement["resume"] };
    },
    async execute(_context, input) { return { schema: "agentloop.humanLoopRequirement/v1", humanLoopRequirement: input }; },
  };
}
