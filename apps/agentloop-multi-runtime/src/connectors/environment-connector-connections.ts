import type {
  ConnectorConnection,
  CredentialProvider,
} from "@zhujun/agentloop-connector-sdk";
import type {
  ConnectionResolver,
  ConnectorConnectionRuntime,
} from "./connection-resolver.ts";

export function connectorConnectionsFromEnvironment(
  value = process.env.CONNECTOR_CONNECTIONS_JSON,
): readonly ConnectorConnection[] {
  if (value === undefined || value.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("CONNECTOR_CONNECTIONS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("CONNECTOR_CONNECTIONS_JSON must be an array");
  return parsed.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`CONNECTOR_CONNECTIONS_JSON[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const stringField = (name: string): string => {
      const field = record[name];
      if (typeof field !== "string" || field.trim().length === 0) {
        throw new Error(`CONNECTOR_CONNECTIONS_JSON[${index}].${name} is required`);
      }
      return field;
    };
    const status = stringField("status");
    if (!["active", "expired", "revoked", "error"].includes(status)) {
      throw new Error(`CONNECTOR_CONNECTIONS_JSON[${index}].status is invalid`);
    }
    const scopes = record.scopes;
    if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) {
      throw new Error(`CONNECTOR_CONNECTIONS_JSON[${index}].scopes must be an array`);
    }
    const ownerType = stringField("ownerType");
    if (ownerType !== "user" && ownerType !== "workspace") {
      throw new Error(`CONNECTOR_CONNECTIONS_JSON[${index}].ownerType is invalid`);
    }
    return {
      id: stringField("id"),
      connectorKey: stringField("connectorKey"),
      ownerType,
      ownerId: stringField("ownerId"),
      ...(record.externalAccountId === undefined ? {} : { externalAccountId: String(record.externalAccountId) }),
      scopes,
      credentialRef: stringField("credentialRef"),
      status,
    } as ConnectorConnection;
  });
}

export function environmentConnectorRuntime(
  connections = connectorConnectionsFromEnvironment(),
  environment: NodeJS.ProcessEnv = process.env,
): ConnectorConnectionRuntime {
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  const resolver: ConnectionResolver = {
    async resolve(connectionId: string): Promise<ConnectorConnection> {
      const connection = byId.get(connectionId);
      if (connection === undefined) throw new Error(`Connector connection not found: ${connectionId}`);
      return connection;
    },
  };
  const credentialProvider: CredentialProvider = {
    async get(credentialRef: string): Promise<Readonly<Record<string, string>> {
      const raw = environment[credentialRef];
      if (raw === undefined || raw.length === 0) {
        throw new Error(`Connector credential is not configured: ${credentialRef}`);
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          return Object.fromEntries(
            Object.entries(parsed).map(([key, value]) => [key, String(value)]),
          );
        }
      } catch {
        // A plain value is treated as an access token for simple OAuth connectors.
      }
      return { accessToken: raw };
    },
  };
  return { resolver, credentialProvider };
}
