import { badRequest } from "../shared/errors.ts";
import { humanLoopRequirementFromUnknown, type HumanLoopRequirement } from "../runtime/human-loop.ts";
import type { RuntimeTool } from "./tool-registry.ts";

export const HUMAN_LOOP_TOOL_NAME = "request_human_loop";

export function createHumanLoopTool(): RuntimeTool<HumanLoopRequirement> {
  return {
    name: HUMAN_LOOP_TOOL_NAME,
    description: "Request structured user input, selection, confirmation, or approval when the current step cannot safely continue. This pauses the Run; do not use prose instead. responseSchema is the Human-in-the-Loop response schema below, not a JSON Schema: choose exactly one of select, form, or confirm. resume must contain mode (normally continue_step); never substitute nextAction or an instruction string.",
    executionMode: "exclusive",
    replaySafe: true,
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["kind", "title", "prompt", "rationale", "evidenceRefs", "responseSchema", "resume"],
      properties: {
        kind: { type: "string", enum: ["selection", "input", "confirmation", "approval"] },
        title: { type: "string" }, prompt: { type: "string" }, rationale: { type: "string" },
        evidenceRefs: { type: "array", items: { type: "string" } },
        responseSchema: {
          oneOf: [
            {
              type: "object", additionalProperties: false,
              required: ["type", "minSelections", "maxSelections", "options"],
              properties: {
                type: { type: "string", enum: ["select"] },
                minSelections: { type: "integer", minimum: 0 },
                maxSelections: { type: "integer", minimum: 0 },
                options: {
                  type: "array", minItems: 1,
                  items: {
                    type: "object", additionalProperties: false,
                    required: ["id", "label"],
                    properties: {
                      id: { type: "string", minLength: 1 },
                      label: { type: "string", minLength: 1 },
                      description: { type: "string" },
                      evidenceRefs: { type: "array", items: { type: "string" } },
                    },
                  },
                },
              },
            },
            {
              type: "object", additionalProperties: false,
              required: ["type", "fields"],
              properties: {
                type: { type: "string", enum: ["form"] },
                fields: {
                  type: "array", minItems: 1,
                  items: {
                    type: "object", additionalProperties: false,
                    required: ["id", "label", "valueType", "required"],
                    properties: {
                      id: { type: "string", minLength: 1 },
                      label: { type: "string", minLength: 1 },
                      valueType: { type: "string", enum: ["text", "textarea", "date", "number", "file_ref"] },
                      required: { type: "boolean" },
                      description: { type: "string" },
                      maxLength: { type: "integer", minimum: 1 },
                    },
                  },
                },
              },
            },
            {
              type: "object", additionalProperties: false,
              required: ["type", "acceptLabel", "rejectLabel"],
              properties: {
                type: { type: "string", enum: ["confirm"] },
                acceptLabel: { type: "string", minLength: 1 },
                rejectLabel: { type: "string", minLength: 1 },
                requireReasonOnReject: { type: "boolean" },
              },
            },
          ],
        },
        resume: {
          type: "object", additionalProperties: false,
          required: ["mode"],
          properties: {
            mode: { type: "string", enum: ["continue_step", "replan_step", "recovery_review"] },
            targetStepId: { type: "string", minLength: 1 },
          },
        },
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
