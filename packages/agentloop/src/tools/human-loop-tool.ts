import { badRequest } from "../shared/errors.ts";
import { humanLoopRequirementFromUnknown, type HumanLoopRequirement } from "../runtime/human-loop.ts";
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
      const requirement = humanLoopRequirementFromUnknown(input);
      if (requirement === undefined) throw badRequest("Human-in-the-Loop request is invalid");
      return requirement;
    },
    async execute(_context, input) { return { schema: "agentloop.humanLoopRequirement/v1", humanLoopRequirement: input }; },
  };
}
