import type { ModelToolCall, ModelToolDefinition } from "./contracts.ts";

/** Identity binding only; this neither accepts a proposal nor invents absorption. */
export function decisionContextEvidenceReferences(calls: readonly ModelToolCall[], names: readonly string[], bindings: Readonly<Record<string, string>> = {}): string[] {
  return [...new Set([...decisionContextArgumentUpdates(calls, names, bindings),
    ...decisionContextArgumentDecisions(calls, names, bindings).map(entry => entry.decision)].flatMap(update =>
    isRecord(update) && Array.isArray(update.evidence) ? update.evidence.filter((id): id is string => typeof id === "string") : []))];
}

/** Native argument encoding of existing progress updates; never passed to a host Tool. */
export const DECISION_CONTEXT_ARGUMENT = "_agentloopContext";
export function decisionContextToolDefinitions(tools: readonly ModelToolDefinition[], hasObservations: boolean) {
  const names = new Set<string>();
  const definitions = tools.map(tool => {
    const schema = tool.inputSchema as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown> | undefined;
    // Host-owned collisions and non-object schemas remain opaque.
    if (schema.type !== "object" || properties?.[DECISION_CONTEXT_ARGUMENT] !== undefined) return tool;
    names.add(tool.name);
    return { ...tool, inputSchema: { ...schema, required: [...new Set([...(Array.isArray(schema.required) ? schema.required : []), DECISION_CONTEXT_ARGUMENT])],
      properties: { ...properties, [DECISION_CONTEXT_ARGUMENT]: {
      type: "object", additionalProperties: false, required: ["decision"],
      // Bounds and authority are checked by the durable reducer. Keep native
      // types/required fields here; long repeated descriptions and bounds on
      // every domain Tool inflated otherwise identical host requests.
      properties: {
        decision: { type: "object", additionalProperties: false, required: ["target", "progress", "remaining", "purpose", "evidence", "disposition"], properties: {
          target: { type: "string" }, progress: { type: "string" }, remaining: { type: "string" },
          purpose: { type: "string" }, evidence: { type: "array", items: { type: "string" } },
          disposition: { type: "string", enum: ["carry", "retain"] },
        } },
        // No local evidence exists on the first decision. User authority and
        // prior-Run prose are never synthetically converted into local Results.
        ...(hasObservations ? { updates: { type: "array", items: {
        type: "object", additionalProperties: false,
        // One explicit content disposition, shared by execution and recovery.
        required: ["id", "category", "text", "scope", "certainty", "evidence", "disposition"],
        properties: {
          kind: {type:"string",enum:["context"]},
          id: {type:"string"},
          category: {type:"string",enum:["observation","inference","unknown","conflict","decision","commitment"]},
          text: {type:"string"},scope:{type:"string"},
          certainty:{type:"string",enum:["observed","tentative","unknown"]},
          evidence:{type:"array",items:{type:"string"}},
          disposition:{type:"string",enum:["carry","retain"]},
          resolves:{type:"array",items:{type:"string"}},
          version:{type:"object",additionalProperties:false,required:["path","versionId"],properties:{path:{type:"string"},versionId:{type:"string"}}},
        },
      } } } : {}),
      },
    } } } };
  });
  return { names, definitions };
}
/** A decision belongs to its actual action, not an independent progress store. */
export function decisionContextArgumentDecisions(calls: readonly ModelToolCall[], names: readonly string[] = [], bindings: Readonly<Record<string, string>> = {}): { toolCallId: string; decision: Record<string, unknown> }[] {
  return calls.flatMap(call => {
    if (!names.includes(call.name) || !isRecord(call.arguments)) return [];
    const envelope = call.arguments[DECISION_CONTEXT_ARGUMENT];
    if (!isRecord(envelope) || !isRecord(envelope.decision)) return [];
    return [{ toolCallId: call.id, decision: { ...envelope.decision,
      evidence: bindDecisionContextEvidence(envelope.decision.evidence, bindings) } }];
  });
}
export function toolCallWithoutDecisionContext(call: ModelToolCall, names: ReadonlySet<string>): ModelToolCall {
  if (!names.has(call.name) || !isRecord(call.arguments) || !(DECISION_CONTEXT_ARGUMENT in call.arguments)) return call;
  const { [DECISION_CONTEXT_ARGUMENT]: _, ...args } = call.arguments;
  return { ...call, arguments: args };
}
/** Only consume metadata explicitly offered by the persisted kernel checkpoint. */
export function decisionContextArgumentUpdates(calls: readonly ModelToolCall[], names: readonly string[] = [], bindings: Readonly<Record<string, string>> = {}): unknown[] {
  return calls.flatMap(call => {
    if (!names.includes(call.name) || !isRecord(call.arguments) || !(DECISION_CONTEXT_ARGUMENT in call.arguments)) return [];
    const value = call.arguments[DECISION_CONTEXT_ARGUMENT];
    if (isRecord(value) && value.updates === undefined) return [];
    return isRecord(value) && Array.isArray(value.updates) ? value.updates.map(update =>
      isRecord(update) && (update.kind === undefined || update.kind === "context")
        // Native transport is already context-only. This supplies a syntactic
        // discriminator, never a fact, authority, scope or absorption claim.
        ? { ...update, kind: "context",
          evidence: bindDecisionContextEvidence(update.evidence, bindings),
        }
        : { kind: "context", id: "invalid-native-context" })
      : [{ kind: "context", id: "invalid-native-context" }];
  });
}
/** Exact aliases only. Ambiguous identities and collisions with real call IDs
 * are not bindings. Persist only bindings actually cited in the checkpoint. */
export function decisionContextReferenceBindings(references: readonly { readonly ref: string; readonly toolCallId: string; readonly resultId?: string }[]): Readonly<Record<string, string>> {
  const candidates = new Map<string, Set<string>>();
  const callIds = new Set(references.map(ref => ref.toolCallId));
  for (const reference of references) for (const key of [reference.ref, reference.resultId]) {
    if (key === undefined) continue;
    const owners = candidates.get(key) ?? new Set<string>();
    owners.add(reference.toolCallId); candidates.set(key, owners);
  }
  return Object.fromEntries([...candidates].flatMap(([key, owners]) => owners.size === 1
    && (!callIds.has(key) || owners.has(key)) ? [[key, [...owners][0]]] : []));
}
function bindDecisionContextEvidence(value: unknown, bindings: Readonly<Record<string, string>>): unknown {
  // Missing/foreign references stay invalid. Never fuzzy-match an identity.
  return Array.isArray(value) ? value.map(ref => typeof ref === "string" && Object.hasOwn(bindings, ref) ? bindings[ref] : ref) : value;
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
