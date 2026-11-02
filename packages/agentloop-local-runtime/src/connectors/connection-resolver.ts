import type {
  ConnectorConnection,
  CredentialProvider,
} from "@zhujun/agentloop-connector-sdk";

export interface ConnectionResolver {
  resolve(
    connectionId: string,
    scope?: { readonly actorUserId: string; readonly workspaceId?: string },
  ): Promise<ConnectorConnection>;
}

export interface ConnectorConnectionRuntime {
  readonly resolver: ConnectionResolver;
  readonly credentialProvider: CredentialProvider;
}

export async function requireActiveConnection(
  runtime: ConnectorConnectionRuntime,
  connectionId: string,
  scope?: { readonly actorUserId: string; readonly workspaceId?: string },
): Promise<ConnectorConnection> {
  const connection = await runtime.resolver.resolve(connectionId, scope);
  if (connection.status !== "active") {
    throw new Error(`Connector connection is not active: ${connectionId}`);
  }
  return connection;
}
