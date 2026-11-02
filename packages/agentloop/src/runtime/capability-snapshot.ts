import type { RuntimeTool, ToolSourceCapability } from "../tools/tool-registry.ts";

/** The authority boundary represented by a capability inventory. */
export type RuntimeCapabilitySnapshotScope =
  | "run_authorized"
  | "runtime_configured"
  | "platform_catalog";

/** A source's observed state within the snapshot's scope; this never grants invocation authority. */
export type RuntimeCapabilitySourceState =
  | "selected_for_run"
  | "configured_for_runtime"
  | "loaded_for_runtime"
  | "load_failed"
  | "available_in_catalog";

/**
 * A server-authored, redacted inventory. It is descriptive only: it never
 * grants a Tool and never contains a source identifier, credential, endpoint,
 * config value, or Tool input schema.
 */
export interface RuntimeCapabilitySnapshot {
  readonly schema: "agentloop.runtimeCapabilitySnapshot/v1";
  readonly scope: RuntimeCapabilitySnapshotScope;
  readonly capturedAt: number;
  readonly sources: readonly RuntimeCapabilitySnapshotSource[];
}

export interface RuntimeCapabilitySnapshotSource {
  readonly label: string;
  readonly transport?: string;
  readonly state: RuntimeCapabilitySourceState;
  readonly capabilities: readonly RuntimeCapabilitySnapshotCapability[];
  readonly operations: readonly RuntimeCapabilitySnapshotOperation[];
}

export interface RuntimeCapabilitySnapshotCapability {
  readonly id: string;
  readonly category: string;
  readonly label?: string;
  readonly description?: string;
  readonly producesEvidenceKinds?: readonly string[];
  readonly sourceKinds?: readonly string[];
}

export interface RuntimeCapabilitySnapshotOperation {
  readonly label: string;
  readonly description: string;
}

/** A host-owned, already-safe projection. `identityValues` are redacted, never emitted. */
export interface RuntimeCapabilitySnapshotSourceInput {
  readonly label: string;
  readonly transport?: string;
  readonly state: RuntimeCapabilitySourceState;
  readonly capabilities?: readonly ToolSourceCapability[];
  readonly operations?: readonly RuntimeCapabilitySnapshotOperation[];
  readonly identityValues?: readonly string[];
}

/** Build an immutable, redacted inventory from already-authorized Run Tools. */
export function createRuntimeCapabilitySnapshot(
  tools: readonly RuntimeTool<unknown>[],
  capturedAt: number,
): RuntimeCapabilitySnapshot {
  return createRuntimeCapabilitySnapshotFromSources({
    scope: "run_authorized",
    capturedAt,
    sources: tools.filter((tool) => tool.source !== undefined).map((tool) => {
      const source = tool.source!;
      return {
        label: source.displayName ?? neutralSourceLabel(source.transport),
        ...(source.transport === undefined ? {} : { transport: source.transport }),
        state: "selected_for_run" as const,
        capabilities: source.capabilities,
        operations: [{ label: source.toolName ?? tool.name, description: tool.description }],
        identityValues: [source.id, ...(source.aliases ?? [])],
      };
    }),
  });
}

/**
 * Turns host-declared, non-secret source metadata into the same immutable
 * document used for run inventories. It intentionally accepts no URL,
 * auth/config, schema, or executable Tool objects.
 */
export function createRuntimeCapabilitySnapshotFromSources(input: {
  readonly scope: RuntimeCapabilitySnapshotScope;
  readonly capturedAt: number;
  readonly sources: readonly RuntimeCapabilitySnapshotSourceInput[];
}): RuntimeCapabilitySnapshot {
  const sources = new Map<string, {
    label: string;
    transport?: string;
    state: RuntimeCapabilitySourceState;
    capabilities: Map<string, RuntimeCapabilitySnapshotCapability>;
    operations: Map<string, RuntimeCapabilitySnapshotOperation>;
  }>();
  for (const item of input.sources) {
    const identities = item.identityValues ?? [];
    const key = JSON.stringify([item.label, item.transport ?? "", item.state]);
    const source = sources.get(key) ?? {
      label: item.label,
      ...(item.transport === undefined ? {} : { transport: item.transport }),
      state: item.state,
      capabilities: new Map(),
      operations: new Map(),
    };
    for (const capability of item.capabilities ?? []) {
      const projected = projectCapability(capability, identities);
      source.capabilities.set(capabilityKey(projected), projected);
    }
    for (const operation of item.operations ?? []) {
      const projected: RuntimeCapabilitySnapshotOperation = Object.freeze({
        label: redactUnsafeMetadata(redactSourceIdentity(operation.label, identities)),
        description: redactUnsafeMetadata(redactSourceIdentity(operation.description, identities)),
      });
      source.operations.set(`${projected.label}\u0000${projected.description}`, projected);
    }
    sources.set(key, source);
  }
  return Object.freeze({
    schema: "agentloop.runtimeCapabilitySnapshot/v1",
    scope: input.scope,
    capturedAt: input.capturedAt,
    sources: Object.freeze([...sources.values()].map((source) => Object.freeze({
      label: source.label,
      ...(source.transport === undefined ? {} : { transport: source.transport }),
      state: source.state,
      capabilities: Object.freeze([...source.capabilities.values()].sort(compareCapability)),
      operations: Object.freeze([...source.operations.values()]
        .sort((left, right) => left.label.localeCompare(right.label, "en"))
        .map((operation) => Object.freeze({ ...operation }))),
    })).sort((left, right) => left.label.localeCompare(right.label, "en"))),
  });
}

/** Rebase host metadata at Run creation so resolver, reply, and assessor share one frozen instant. */
export function freezeRuntimeCapabilitySnapshot(
  snapshot: RuntimeCapabilitySnapshot,
  capturedAt: number,
): RuntimeCapabilitySnapshot {
  return createRuntimeCapabilitySnapshotFromSources({
    scope: snapshot.scope,
    capturedAt,
    sources: snapshot.sources.map((source) => ({
      label: source.label,
      ...(source.transport === undefined ? {} : { transport: source.transport }),
      state: source.state,
      capabilities: source.capabilities,
      operations: source.operations,
    })),
  });
}

/**
 * Deterministically chooses the factual scope requested by the user. This is
 * vocabulary about scope, never a provider-name router: new services inherit
 * the same behavior without Planner branches.
 */
export function requestedRuntimeCapabilityScope(input: string): RuntimeCapabilitySnapshotScope | undefined {
  const inventory = /(?:能力|功能|服务|工具|权限|支持|能做什么|可以做什么|目录|清单|capabilit(?:y|ies)|feature|service|tool|permission|catalog|what\s+can|what.*available)/iu.test(input);
  if (!inventory) return undefined;
  if (/(?:产品|平台|可安装|支持哪些|supported|installable|product\s+catalog)/iu.test(input)) return "platform_catalog";
  if (/(?:所有|系统|已接入|已配置|已安装|mcp|目录|catalog|configured|installed|connected|system[-\s]?wide|all\s+(?:mcp|tools|services))/iu.test(input)) return "runtime_configured";
  if (/(?:当前|现在|本次|已授权|授权的|已启用|可用的|currently|current|authorized|enabled|available)/iu.test(input)) return "run_authorized";
  return undefined;
}

/** Compatibility helper for callers that only care about the selected-Run scope. */
export function requestsCurrentCapabilityInventory(input: string): boolean {
  return requestedRuntimeCapabilityScope(input) === "run_authorized";
}

function neutralSourceLabel(transport: string | undefined): string {
  if (transport === "connector") return "Authorized connector";
  if (transport === "mcp") return "Authorized MCP service";
  return "Authorized service";
}

function projectCapability(capability: ToolSourceCapability, prohibitedIdentityValues: readonly string[]): RuntimeCapabilitySnapshotCapability {
  return Object.freeze({
    id: capability.id,
    category: capability.category,
    ...(capability.label === undefined ? {} : { label: redactUnsafeMetadata(redactSourceIdentity(capability.label, prohibitedIdentityValues)) }),
    ...(capability.description === undefined ? {} : { description: redactUnsafeMetadata(redactSourceIdentity(capability.description, prohibitedIdentityValues)) }),
    ...(capability.producesEvidenceKinds === undefined ? {} : { producesEvidenceKinds: Object.freeze([...capability.producesEvidenceKinds]) }),
    ...(capability.sourceKinds === undefined ? {} : { sourceKinds: Object.freeze([...capability.sourceKinds]) }),
  });
}

function redactSourceIdentity(value: string, prohibitedIdentityValues: readonly string[]): string {
  let redacted = value;
  for (const identity of prohibitedIdentityValues) if (identity.length > 0) redacted = redacted.split(identity).join("[redacted]");
  return redacted;
}

/** Metadata from a Tool description is informative, never a configuration channel. */
function redactUnsafeMetadata(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[redacted-url]")
    .replace(/\b(api[-_ ]?key|access[-_ ]?token|authorization|credential|secret|password)\s*[:=]\s*[^\s,;)}\]]+/giu, "$1: [redacted]");
}

function capabilityKey(capability: RuntimeCapabilitySnapshotCapability): string { return JSON.stringify(capability); }
function compareCapability(left: RuntimeCapabilitySnapshotCapability, right: RuntimeCapabilitySnapshotCapability): number {
  return left.id.localeCompare(right.id, "en") || left.category.localeCompare(right.category, "en");
}
