import type { ConversationTaskIntent } from "./task-intent.ts";
import { artifactFormatMatchesKind } from "./tool-progress-policy.ts";

export const CONVERSATION_TASK_INTENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "operation", "requiresExecution", "deliverables"],
  properties: {
    schema: { type: "string", enum: ["agentloop.conversationTaskIntent/v1"] },
    operation: {
      type: "string",
      enum: ["answer", "lookup", "analysis", "create_artifact", "transform_artifact", "composite"],
    },
    requiresExecution: { type: "boolean" },
    deliverables: {
      type: "array",
      description: "Terminal user-requested outputs only. Never include scripts, temporary files, manifests, specs, or other implementation artifacts unless the user explicitly requested that item as a delivered output.",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["targetId", "purpose", "expectedArtifactCount", "action", "kind", "surface"],
        properties: {
          targetId: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
          purpose: { type: "string", minLength: 1, maxLength: 500 },
          expectedArtifactCount: { type: "integer", minimum: 1, maximum: 8 },
          action: { type: "string", enum: ["none", "create", "modify", "transform"] },
          kind: { type: "string", enum: ["html", "document", "presentation", "spreadsheet", "image", "audio", "code", "none"] },
          format: { type: "string", minLength: 1, maxLength: 32,
            description: "Optional physical file format compatible with kind, such as png, svg, pdf, docx or xlsx. Content or presentation types belong in purpose. Omit when the user did not constrain the physical encoding." },
          surface: { type: "string", enum: ["conversation", "workspace_artifact"] },
        },
      },
    },
  },
} as const;

export function parseConversationTaskIntent(
  value: unknown,
  onInvalid?: (feedback: string) => void,
): ConversationTaskIntent | undefined {
  const reject = (feedback: string): undefined => { onInvalid?.(feedback); return undefined; };
  const record = optionalRecord(value);
  if (record.schema !== "agentloop.conversationTaskIntent/v1") return reject("taskIntent.schema must be agentloop.conversationTaskIntent/v1.");
  const operations = new Set(["answer", "lookup", "analysis", "create_artifact", "transform_artifact", "composite"]);
  if (typeof record.operation !== "string" || !operations.has(record.operation)) return reject("taskIntent.operation must be one of answer, lookup, analysis, create_artifact, transform_artifact, or composite.");
  if (typeof record.requiresExecution !== "boolean") return reject("taskIntent.requiresExecution must be a boolean and must agree with mode=execute.");
  if (!Array.isArray(record.deliverables) || record.deliverables.length > 8) return reject("taskIntent.deliverables must be an array containing at most 8 terminal output families.");
  const actions = new Set(["none", "create", "modify", "transform"]);
  const kinds = new Set(["html", "document", "presentation", "spreadsheet", "image", "audio", "code", "none"]);
  const surfaces = new Set(["conversation", "workspace_artifact"]);
  const targetIds = new Set<string>();
  const deliverables: ConversationTaskIntent["deliverables"][number][] = [];
  for (const [index, item] of record.deliverables.entries()) {
    const deliverable = optionalRecord(item);
    const action = deliverable.action;
    const kind = deliverable.kind;
    const surface = deliverable.surface;
    const format = deliverable.format === null ? undefined : deliverable.format;
    const targetId = deliverable.targetId;
    const purpose = deliverable.purpose;
    const expectedArtifactCount = deliverable.expectedArtifactCount;
    const path = `taskIntent.deliverables[${index}]`;
    if (typeof targetId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(targetId) || targetId.length > 128) {
      return reject(`${path}.targetId must match ^[A-Za-z0-9][A-Za-z0-9._-]*$ and be at most 128 characters. Use an ASCII identifier; put the user-visible title in purpose.`);
    }
    if (targetIds.has(targetId)) return reject(`${path}.targetId must be unique across taskIntent.deliverables.`);
    if (typeof purpose !== "string" || purpose.trim().length === 0 || purpose.length > 500) return reject(`${path}.purpose must be a non-empty string no longer than 500 characters.`);
    if (typeof action !== "string" || !actions.has(action)) return reject(`${path}.action must be one of none, create, modify, or transform.`);
    if (typeof kind !== "string" || !kinds.has(kind)) return reject(`${path}.kind must be one of html, document, presentation, spreadsheet, image, audio, code, or none. Put a concrete file format in format.`);
    if (typeof surface !== "string" || !surfaces.has(surface)) return reject(`${path}.surface must be conversation or workspace_artifact.`);
    if (!Number.isInteger(expectedArtifactCount) || (expectedArtifactCount as number) < 1 || (expectedArtifactCount as number) > 8) {
      return reject(`${path}.expectedArtifactCount must be an integer from 1 to 8. Preserve the number of terminal artifacts explicitly requested by the user; use 1 only when exactly one artifact is requested.`);
    }
    if ((expectedArtifactCount as number) > 1 && targetId.length > 126) return reject(`${path}.targetId must be at most 126 characters when expectedArtifactCount is greater than 1, leaving room for per-artifact IDs.`);
    if (format !== undefined && (typeof format !== "string" || format.trim().length === 0 || format.length > 32)) return reject(`${path}.format must be a non-empty string no longer than 32 characters when present.`);
    if (typeof format === "string" && !artifactFormatMatchesKind(format, kind)) {
      return reject(`${path}.format=${JSON.stringify(format)} cannot be satisfied by a physical ${kind} artifact. Put content and presentation requirements in purpose. Use a compatible physical file format only when required by the user; otherwise omit format. Do not change the requested content or silently substitute another required encoding.`);
    }
    targetIds.add(targetId);
    deliverables.push({
      targetId: targetId.trim(),
      purpose: purpose.trim(),
      expectedArtifactCount: expectedArtifactCount as number,
      action: action as ConversationTaskIntent["deliverables"][number]["action"],
      kind: kind as ConversationTaskIntent["deliverables"][number]["kind"],
      ...(format === undefined ? {} : { format: (format as string).trim() }),
      surface: surface as ConversationTaskIntent["deliverables"][number]["surface"],
    });
  }
  if (deliverables.reduce((count, item) => count + (item.surface === "workspace_artifact" ? item.expectedArtifactCount : 0), 0) > 8) {
    return reject("taskIntent.deliverables must request at most 8 workspace artifacts in total across all output families. Preserve explicit user cardinality; do not silently reduce the requested count.");
  }
  return {
    schema: "agentloop.conversationTaskIntent/v1",
    operation: record.operation as ConversationTaskIntent["operation"],
    requiresExecution: record.requiresExecution,
    deliverables,
  };
}


function optionalRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
