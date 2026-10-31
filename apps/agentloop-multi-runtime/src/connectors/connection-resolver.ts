import type {
  ConnectorConnection,
  CredentialProvider,
} from "@zhujun/agentloop-connector-sdk";

export interface ConnectionResolver {
  resolve(connectionId: string): Promise<ConnectorConnection>;
}

export interface ConnectorConnectionRuntime {
  readonly resolver: ConnectionResolver;
  readonly credentialProvider: CredentialProvider;
}

export async function requireActiveConnection(
  runtime: ConnectorConnectionRuntime,
  connectionId: string,
): Promise<ConnectorConnection> {
  const connection = await runtime.resolver.resolve(connectionId);
  if (connection.status !== "active") {
    throw new Error(`Connector connection is not active: ${connectionId}`);
  }
  return connection;
}
