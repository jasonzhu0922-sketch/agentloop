import { createHash } from "node:crypto";
import type {
  ConnectorCapabilityDefinition,
  ConnectorExecutionContext,
  ConnectorInstance,
  ConnectorOperation,
  ConnectorProjection,
} from "./types.ts";
import type {
  RuntimeTool,
  ToolSourceCapability,
  ToolSourceDescriptor,
} from "@zhujun/agentloop";

export interface PlanningCapabilityProjection {
  readonly id: string;
  readonly category: string;
  readonly label: string;
  readonly description: string;
  readonly sourceIds: readonly string[];
  readonly produces: readonly string[];
  readonly sourceKinds: readonly string[];
  readonly sideEffect: "none" | "workspace_write" | "external_read" | "external_write";
  readonly risk: "low" | "medium" | "high";
}

export function connectorSourceDescriptor(
  instance: ConnectorInstance,
): ToolSourceDescriptor {
  const manifest = instance.definition.manifest;
  const capabilities: ToolSourceCapability[] = instance.definition.capabilities.map((capability) => ({
    id: capability.id,
    category: capability.category,
    label: capability.label,
    description: capability.description,
    producesEvidenceKinds: capability.producesEvidenceKinds,
    sourceKinds: capability.sourceKinds,
  }));
  return {
    id: `connector.${manifest.key}.${instance.connection.id}`,
    transport: "connector",
    aliases: [manifest.key, instance.connection.id],
    capabilities,
  };
}

export function connectorPlanningCapabilities(
  instance: ConnectorInstance,
): readonly PlanningCapabilityProjection[] {
  const sourceId = `connector.${instance.definition.manifest.key}.${instance.connection.id}`;
  return instance.definition.capabilities.map((capability) => ({
    id: capability.id,
    category: capability.category,
    label: capability.label,
    description: capability.description,
    sourceIds: [sourceId],
    produces: capability.producesEvidenceKinds ?? [],
    sourceKinds: capability.sourceKinds ?? [],
    sideEffect: capability.category === "write" ? "external_write" : "external_read",
    risk: capability.risk,
  }));
}

export function connectorOperationTools(
  instance: ConnectorInstance,
  context: ConnectorExecutionContext,
): readonly RuntimeTool[] {
  const source = connectorSourceDescriptor(instance);
  return instance.operations.map((operation) => ({
    name: operationToolName(instance, operation),
    description: operationDescription(instance.definition.capabilities, operation),
    source,
    inputSchema: operation.inputSchema,
    executionMode: operation.executionMode,
    replaySafe: operation.replaySafe,
    timeoutMs: operation.timeoutMs,
    parse(input: unknown): unknown {
      return input;
    },
    async execute(_toolContext, input: unknown): Promise<unknown> {
      const result = await instance.execute(operation.id, input, context);
      return {
        ...result,
        evidence: instance.mapEvidence(result, context),
      };
    },
  }));
}

function safeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "connection";
}

function operationToolName(instance: ConnectorInstance, operation: ConnectorOperation): string {
  const key = instance.definition.manifest.key;
  // Provider function names have a 64-character limit. Full Connection IDs
  // belong in source metadata, not the wire identifier. Hash the complete tuple
  // so truncation/normalization cannot merge different connections or actions.
  const identity = JSON.stringify([key, instance.connection.id, operation.id]);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 20);
  return `connector_${safeIdentifier(key).slice(0, 16)}_${safeIdentifier(operation.id).slice(0, 16)}_${digest}`;
}

function operationDescription(
  capabilities: readonly ConnectorCapabilityDefinition[],
  operation: ConnectorOperation,
): string {
  const capability = capabilities.find((item) => item.id === operation.capabilityId);
  const prefix = capability === undefined ? operation.id : capability.description;
  return `${prefix} (Connector operation: ${operation.id})`;
}
