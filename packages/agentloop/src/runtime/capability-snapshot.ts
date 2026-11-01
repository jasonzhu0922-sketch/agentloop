import type { RuntimeTool, ToolSourceCapability } from "../tools/tool-registry.ts";

/**
 * A server-authored inventory of source capability metadata selected for one
 * Run. It is descriptive only: it never grants a Tool and never contains a
 * Tool input schema, source identifier, credential, endpoint, or config.
 */
export interface RuntimeCapabilitySnapshot {
  readonly schema: "agentloop.runtimeCapabilitySnapshot/v1";
  readonly capturedAt: number;
  readonly sources: readonly RuntimeCapabilitySnapshotSource[];
}

export interface RuntimeCapabilitySnapshotSource {
  readonly label: string;
  readonly transport?: string;
  readonly authorization: "selected_for_run";
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

/** Build an immutable, redacted inventory from already-authorized Run Tools. */
export function createRuntimeCapabilitySnapshot(
  tools: readonly RuntimeTool<unknown>[],
  capturedAt: number,
): RuntimeCapabilitySnapshot {
  const sources = new Map<string, {
    label: string;
    transport?: string;
    capabilities: Map<string, RuntimeCapabilitySnapshotCapability>;
    operations: Map<string, RuntimeCapabilitySnapshotOperation>;
  }>();
  for (const tool of tools) {
    if (tool.source === undefined) continue;
    // A source id or alias can encode a connection id. Only an explicitly
    // approved display name is user-facing; otherwise use a neutral kind.
    const label = tool.source.displayName ?? neutralSourceLabel(tool.source.transport);
    const key = JSON.stringify([label, tool.source.transport ?? ""]);
    const source = sources.get(key) ?? {
      label,
      ...(tool.source.transport === undefined ? {} : { transport: tool.source.transport }),
      capabilities: new Map(),
      operations: new Map(),
    };
    const prohibitedIdentityValues = [tool.source.id, ...(tool.source.aliases ?? [])];
    for (const capability of tool.source.capabilities) {
      const projected = projectCapability(capability, prohibitedIdentityValues);
      source.capabilities.set(capabilityKey(projected), projected);
    }
    const operation: RuntimeCapabilitySnapshotOperation = {
      label: redactSourceIdentity(tool.description, prohibitedIdentityValues),
      description: redactSourceIdentity(tool.description, prohibitedIdentityValues),
    };
    source.operations.set(`${operation.label}\u0000${operation.description}`, operation);
    sources.set(key, source);
  }
  return Object.freeze({
    schema: "agentloop.runtimeCapabilitySnapshot/v1",
    capturedAt,
    sources: Object.freeze([...sources.values()].map((source) => Object.freeze({
      label: source.label,
      ...(source.transport === undefined ? {} : { transport: source.transport }),
      authorization: "selected_for_run" as const,
      capabilities: Object.freeze([...source.capabilities.values()].sort(compareCapability)),
      operations: Object.freeze([...source.operations.values()]
        .sort((left, right) => left.label.localeCompare(right.label, "en"))
        .map((operation) => Object.freeze({ ...operation }))),
    })).sort((left, right) => left.label.localeCompare(right.label, "en"))),
  });
}

/**
 * This does not classify work or authorize execution. It merely determines
 * whether a reply needs the already-captured inventory as factual context.
 */
export function requestsCurrentCapabilityInventory(input: string): boolean {
  const current = /(?:当前|现在|已授权|授权的|已启用|可用的|已配置|已连接|currently|current|authorized|enabled|available|configured|connected)/iu.test(input);
  const inventory = /(?:能力|功能|服务|工具|权限|支持|能做什么|可以做什么|capabilit(?:y|ies)|feature|service|tool|permission|what\s+can|what.*available)/iu.test(input);
  return current && inventory;
}

function neutralSourceLabel(transport: string | undefined): string {
  if (transport === "connector") return "Authorized connector";
  if (transport === "mcp") return "Authorized MCP service";
  return "Authorized service";
}

function projectCapability(
  capability: ToolSourceCapability,
  prohibitedIdentityValues: readonly string[],
): RuntimeCapabilitySnapshotCapability {
  return Object.freeze({
    id: capability.id,
    category: capability.category,
    ...(capability.label === undefined ? {} : { label: redactSourceIdentity(capability.label, prohibitedIdentityValues) }),
    ...(capability.description === undefined ? {} : { description: redactSourceIdentity(capability.description, prohibitedIdentityValues) }),
    ...(capability.producesEvidenceKinds === undefined ? {} : { producesEvidenceKinds: Object.freeze([...capability.producesEvidenceKinds]) }),
    ...(capability.sourceKinds === undefined ? {} : { sourceKinds: Object.freeze([...capability.sourceKinds]) }),
  });
}

function redactSourceIdentity(value: string, prohibitedIdentityValues: readonly string[]): string {
  let redacted = value;
  for (const identity of prohibitedIdentityValues) {
    if (identity.length > 0) redacted = redacted.split(identity).join("[redacted]");
  }
  return redacted;
}

function capabilityKey(capability: RuntimeCapabilitySnapshotCapability): string {
  return JSON.stringify(capability);
}

function compareCapability(left: RuntimeCapabilitySnapshotCapability, right: RuntimeCapabilitySnapshotCapability): number {
  return left.id.localeCompare(right.id, "en") || left.category.localeCompare(right.category, "en");
}
