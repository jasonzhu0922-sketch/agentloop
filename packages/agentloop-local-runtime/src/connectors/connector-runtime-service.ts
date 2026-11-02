import type {
  ConnectorConnection,
  ConnectorInstance,
  CredentialProvider,
  ConnectorProjection,
} from "@zhujun/agentloop-connector-sdk";
import {
  connectorOperationTools,
  connectorPlanningCapabilities,
  connectorSourceDescriptor,
} from "@zhujun/agentloop-connector-sdk";
import type { RuntimeTool, ToolSourceDescriptor } from "@zhujun/agentloop";

import { ConnectorRegistry } from "./connector-registry.ts";
import {
  requireActiveConnection,
  type ConnectorConnectionRuntime,
} from "./connection-resolver.ts";

export interface ConnectorRunContext {
  readonly connectionId: string;
  readonly runId: string;
  readonly actorUserId: string;
  readonly workspaceId?: string;
}

export interface MaterializedConnectorRuntime {
  readonly connection: ConnectorConnection;
  readonly instance: ConnectorInstance;
  readonly projection: ConnectorProjection;
  readonly source: ToolSourceDescriptor;
  readonly tools: readonly RuntimeTool[];
}

/**
 * Resolves an authorized Connection, creates its Connector instance, and
 * materializes the immutable tool projection used by one Run.
 */
export class ConnectorRuntimeService {
  private readonly registry: ConnectorRegistry;
  private readonly connectionRuntime: ConnectorConnectionRuntime;

  constructor(
    registry: ConnectorRegistry,
    connectionRuntime: ConnectorConnectionRuntime,
  ) {
    this.registry = registry;
    this.connectionRuntime = connectionRuntime;
  }

  async materialize(
    context: ConnectorRunContext,
  ): Promise<MaterializedConnectorRuntime> {
    const connection = await requireActiveConnection(
      this.connectionRuntime,
      context.connectionId,
      {
        actorUserId: context.actorUserId,
        ...(context.workspaceId === undefined ? {} : { workspaceId: context.workspaceId }),
      },
    );
    const instance = await this.registry.connect({
      connectorKey: connection.connectorKey,
      connection,
      credentialProvider: this.connectionRuntime.credentialProvider,
    });
    const executionContext = {
      runId: context.runId,
      actorUserId: context.actorUserId,
      ...(context.workspaceId === undefined ? {} : { workspaceId: context.workspaceId }),
      connection,
      credentialProvider: this.connectionRuntime.credentialProvider,
    };
    const source = connectorSourceDescriptor(instance);
    const tools = connectorOperationTools(instance, executionContext);
    const projection: ConnectorProjection = {
      connectorKey: instance.definition.manifest.key,
      connectorVersion: instance.definition.manifest.version,
      capabilities: instance.definition.capabilities,
      operations: instance.operations,
      runtimeTools: tools,
    };
    return { connection, instance, projection, source, tools };
  }

  /**
   * RunToolProvider implementation used by AgentLoop Kernel. The returned
   * tools are scoped to the supplied Connection IDs and Run context.
   */
  async resolve(input: {
    readonly runId: string;
    readonly actorUserId: string;
    readonly conversationId?: string;
    readonly workspaceId?: string;
    readonly connectionIds: readonly string[];
  }): Promise<readonly import("@zhujun/agentloop").RuntimeTool<unknown>[]> {
    const materialized = await this.materializeMany(
      input.connectionIds.map((connectionId) => ({
        connectionId,
        runId: input.runId,
        actorUserId: input.actorUserId,
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      })),
    );
    return materialized.flatMap((item) => item.tools);
  }

  async materializeMany(
    contexts: readonly ConnectorRunContext[],
  ): Promise<readonly MaterializedConnectorRuntime[]> {
    const results: MaterializedConnectorRuntime[] = [];
    for (const context of contexts) {
      results.push(await this.materialize(context));
    }
    return results;
  }

  planningCapabilities(materialized: MaterializedConnectorRuntime): ReturnType<typeof connectorPlanningCapabilities> {
    return connectorPlanningCapabilities(materialized.instance);
  }
}
