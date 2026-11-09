import type { ModelAdapter } from "./contracts.ts";
import type { CanonicalRunState } from "./canonical-run-state.ts";
import type { RunInputMessage } from "./run-input-repository.ts";
import { AppError } from "../shared/errors.ts";

export interface RunInputDecision {
  readonly kind: "answer" | "amend" | "clarify" | "cancel";
  readonly explanation: string;
  readonly effectiveGoal?: string;
  readonly userConstraints?: readonly string[];
  readonly taskIntent?: unknown;
}

/** Semantic decisions only. This call cannot execute Tools or grant permissions. */
export async function decideRunInput(input: {
  model: ModelAdapter;
  message: RunInputMessage;
  state?: CanonicalRunState;
  evidence: unknown;
  signal?: AbortSignal;
}): Promise<RunInputDecision> {
  const response = await input.model.complete({
    runId: input.message.runId,
    phase: "planning",
    systemPrompt: [
      "Interpret one user message steering an active plan-first Run. Return exactly one submit_run_input_decision call.",
      "answer: answer a progress/question using only the supplied persisted facts; unknowns remain unknown. The original goal continues.",
      "amend: the user clearly changes or supplements the goal. Preserve every prior obligation unless the user explicitly supersedes it. Provide the full effectiveGoal, full userConstraints and full taskIntent inventory, retaining stable targetIds for unchanged deliveries. The Runtime will revise and re-admit the Plan before acting.",
      "clarify: the message is ambiguous, contradicts an open HIL request, or requires a new attachment, source, permission, account or Runtime. Explain the precise missing decision. Never treat ordinary input as approval or an answer to a structured HIL request.",
      "cancel: only an explicit request to stop the current Run.",
      "Input does not grant new Tool, filesystem, model, Runtime or account authority. Source IDs and permissions remain bound.",
      "Use explanation as a concise user-visible answer/change explanation/question. Never claim an external action happened without its receipt.",
    ].join("\n"),
    runtimeContext: { id: `${input.message.runId}:input:${input.message.seq}`, phase: "planning",
      content: JSON.stringify({ canonicalState: input.state, persistedEvidence: input.evidence, message: input.message }) },
    messages: [{ role: "user", content: input.message.text }],
    tools: [{ name: "submit_run_input_decision", description: "Submit a semantic input decision; no execution authority.", inputSchema: {
      type: "object", additionalProperties: false, required: ["kind", "explanation", "effectiveGoal", "userConstraints", "taskIntent"], properties: {
        kind: { type: "string", enum: ["answer", "amend", "clarify", "cancel"] }, explanation: { type: "string", minLength: 1, maxLength: 8000 },
        effectiveGoal: { type: ["string", "null"] }, userConstraints: { type: ["array", "null"], items: { type: "string" } },
        taskIntent: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false,
          required: ["schema", "operation", "requiresExecution", "deliverables"], properties: {
            schema: { type: "string", enum: ["agentloop.conversationTaskIntent/v1"] },
            operation: { type: "string", enum: ["answer", "lookup", "analysis", "create_artifact", "transform_artifact", "composite"] }, requiresExecution: { type: "boolean" },
            deliverables: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", additionalProperties: false,
              required: ["targetId", "purpose", "expectedArtifactCount", "action", "kind", "surface", "format"], properties: {
                targetId: { type: "string" }, purpose: { type: "string" }, expectedArtifactCount: { type: "integer", minimum: 1, maximum: 8 },
                action: { type: "string", enum: ["none", "create", "modify", "transform"] }, kind: { type: "string", enum: ["none", "html", "document", "presentation", "spreadsheet", "image", "audio", "code"] },
                surface: { type: "string", enum: ["conversation", "workspace_artifact"] }, format: { type: ["string", "null"] },
              } } },
          } }] },
      },
    } }], toolChoice: { name: "submit_run_input_decision" },
  }, input.signal);
  const call = response.toolCalls[0];
  if (response.finishReason === "length" || response.toolCalls.length !== 1 || call?.name !== "submit_run_input_decision"
    || call.arguments === null || typeof call.arguments !== "object" || Array.isArray(call.arguments)) throw new AppError("PLANNING_ERROR", "Input decision must be one complete structured response", 422);
  const value = call.arguments as Record<string, unknown>;
  if (!["answer", "amend", "clarify", "cancel"].includes(String(value.kind)) || typeof value.explanation !== "string"
    || !value.explanation.trim() || value.explanation.length > 8000) throw new AppError("PLANNING_ERROR", "Input decision is malformed", 422);
  if (value.kind === "amend" && (typeof value.effectiveGoal !== "string" || !value.effectiveGoal.trim() || value.effectiveGoal.length > 16000
    || !Array.isArray(value.userConstraints) || value.userConstraints.some(v => typeof v !== "string" || v.length > 4000))) throw new AppError("PLANNING_ERROR", "Input amendment requires a complete goal and constraints", 422);
  return value as unknown as RunInputDecision;
}
