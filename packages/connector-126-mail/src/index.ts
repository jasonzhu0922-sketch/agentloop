import type {
  ConnectorCapabilityDefinition,
  ConnectorConnectionInput,
  ConnectorDefinition,
  ConnectorExecutionContext,
  ConnectorExecutionResult,
  ConnectorInstance,
  ConnectorModule,
  ConnectorOperation,
  ConnectorModuleFactoryContext,
} from "@zhujun/agentloop-connector-sdk";
import { ImapFlow, type FetchMessageObject, type MessageAddressObject } from "imapflow";

export interface MailMessageSummary {
  readonly id: string;
  readonly threadId?: string;
  readonly subject: string;
  readonly from: string;
  readonly receivedAt?: string;
  readonly preview?: string;
  readonly locator?: string;
}

export interface MailMessage extends MailMessageSummary {
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly text?: string;
  readonly html?: string;
  readonly attachments?: readonly {
    readonly id: string;
    readonly name: string;
    readonly mediaType?: string;
    readonly byteSize?: number;
  }[];
}

export interface MailTransport {
  search(input: {
    readonly query: string;
    readonly limit?: number;
    readonly folder?: string;
  }): Promise<readonly MailMessageSummary[]>;
  read(input: {
    readonly messageId: string;
    readonly folder?: string;
  }): Promise<MailMessage>;
  close?(): Promise<void>;
}

export type MailTransportFactory = (input: {
  readonly credentials: Readonly<Record<string, string>>;
  readonly connection: ConnectorConnectionInput["connection"];
}) => Promise<MailTransport>;

const capabilities: readonly ConnectorCapabilityDefinition[] = [
  {
    id: "email.search",
    category: "source",
    label: "Search 126 Mail messages",
    description: "Search messages available to the authorized 126 Mail account.",
    sourceKinds: ["email"],
    producesEvidenceKinds: ["source_summary", "source_urls", "explicit_caveats"],
    risk: "low",
    replaySafe: true,
  },
  {
    id: "email.read",
    category: "read",
    label: "Read a 126 Mail message",
    description: "Read the content and metadata of an authorized 126 Mail message.",
    sourceKinds: ["email", "attachment"],
    producesEvidenceKinds: ["source_summary", "source_urls", "explicit_caveats"],
    risk: "low",
    replaySafe: true,
  },
];

const operations: readonly ConnectorOperation[] = [
  {
    id: "email.search",
    capabilityId: "email.search",
    mode: "read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        folder: { type: "string", maxLength: 200 },
      },
    },
    executionMode: "parallel",
    replaySafe: true,
    timeoutMs: 30_000,
  },
  {
    id: "email.read",
    capabilityId: "email.read",
    mode: "read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["messageId"],
      properties: {
        messageId: { type: "string", minLength: 1, maxLength: 300 },
        folder: { type: "string", maxLength: 200 },
      },
    },
    executionMode: "parallel",
    replaySafe: true,
    timeoutMs: 30_000,
  },
];

export const mail126Definition: ConnectorDefinition = {
  manifest: {
    schema: "agentloop.connectorManifest/v1",
    key: "126-mail",
    version: "0.1.0",
    displayName: "126 邮箱",
    description: "Read-only 126 Mail connector for AgentLoop.",
    agentloopSdk: "^0.1.0",
    apiVersion: "imap",
  },
  capabilities,
};

export function create126MailConnector(
  transportFactory: MailTransportFactory,
): ConnectorModule {
  return {
    definition: mail126Definition,

    async connect(input: ConnectorConnectionInput): Promise<ConnectorInstance> {
      const credentials = await input.credentialProvider.get(input.connection.credentialRef);
      const transport = await transportFactory({
        credentials,
        connection: input.connection,
      });
      return {
        definition: mail126Definition,
        connection: input.connection,
        operations,
        async execute(
          operationId: string,
          operationInput: unknown,
          _context: ConnectorExecutionContext,
        ): Promise<ConnectorExecutionResult> {
          const body = operationInput as Record<string, unknown>;
          if (operationId === "email.search") {
            return {
              operationId,
              data: await transport.search({
                query: String(body.query),
                ...(body.limit === undefined ? {} : { limit: Number(body.limit) }),
                ...(body.folder === undefined ? {} : { folder: String(body.folder) }),
              }),
            };
          }
          if (operationId === "email.read") {
            return {
              operationId,
              data: await transport.read({
                messageId: String(body.messageId),
                ...(body.folder === undefined ? {} : { folder: String(body.folder) }),
              }),
            };
          }
          throw new Error(`Unknown 126 Mail operation: ${operationId}`);
        },
        mapEvidence(result: ConnectorExecutionResult, evidenceContext: ConnectorExecutionContext) {
          return [{
            schema: "agentloop.connectorEvidence/v1",
            evidenceId: `${evidenceContext.runId}:${result.operationId}:${Date.now()}`,
            connectorKey: mail126Definition.manifest.key,
            connectionId: evidenceContext.connection.id,
            operationId: result.operationId,
            sourceRefs: result.sourceRefs ?? [],
            facts: [{ data: result.data }],
            evidenceKinds: ["source_summary", "explicit_caveats"],
            retrievedAt: Date.now(),
            caveats: [
              "Mail content is provided by the configured MailTransport; attachment bytes are not automatically copied into the AgentLoop workspace.",
            ],
          }];
        },
      };
    },

    async project() {
      return {
        connectorKey: mail126Definition.manifest.key,
        connectorVersion: mail126Definition.manifest.version,
        capabilities,
        operations,
        runtimeTools: [],
      };
    },
  };
}


/**
 * Direct 126 Mail IMAP Connector. The account and authorization code remain
 * in the Local Agent secret store; neither is sent through the Router.
 */
export function createConfigured126MailConnector(
  context: ConnectorModuleFactoryContext,
): ConnectorModule {
  const host = optionalConfigString(context.config, "host", "imap.126.com");
  const port = optionalConfigPort(context.config, "port", 993);
  const secure = optionalConfigBoolean(context.config, "secure", true);
  return create126MailConnector(async ({ credentials }) => createImapTransport({ credentials, host, port, secure }));
}

function createImapTransport(input: {
  credentials: Readonly<Record<string, string>>,
  host: string;
  port: number;
  secure: boolean;
}): MailTransport {
  return {
    async search({ query, limit = 20, folder = "INBOX" }) {
      return await withImapClient(input, async (client) => {
        const lock = await client.getMailboxLock(folder, { readOnly: true });
        try {
          const ids = await client.search({ text: query }, { uid: true });
          if (!Array.isArray(ids) || ids.length === 0) return [];
          const newest = ids.slice(Math.max(0, ids.length - limit)).reverse();
          const messages = await client.fetchAll(newest, { envelope: true, internalDate: true }, { uid: true });
          return messages.map(messageSummary);
        } finally {
          lock.release();
        }
      });
    },
    async read({ messageId, folder = "INBOX" }) {
      return await withImapClient(input, async (client) => {
        const uid = parseUid(messageId);
        const lock = await client.getMailboxLock(folder, { readOnly: true });
        try {
          const message = await client.fetchOne(uid, { envelope: true, internalDate: true, source: { maxLength: 512_000 }, bodyStructure: true }, { uid: true });
          if (message === false) throw new Error("126 Mail message was not found");
          return mailMessage(message);
        } finally {
          lock.release();
        }
      });
    },
  };
}

async function withImapClient<T>(input: {
  credentials: Readonly<Record<string, string>>,
  host: string;
  port: number;
  secure: boolean;
}, action: (client: ImapFlow) => Promise<T>): Promise<T> {
  const user = credentialString(input.credentials, ["email", "username"]);
  const pass = credentialString(input.credentials, ["authorizationCode", "password"]);
  const client = new ImapFlow({
    host: input.host,
    port: input.port,
    secure: input.secure,
    auth: { user, pass },
    logger: false,
    disableAutoIdle: true,
  });
  await client.connect();
  try {
    return await action(client);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

function messageSummary(message: FetchMessageObject): MailMessageSummary {
  const envelope = message.envelope;
  return {
    id: String(message.uid),
    ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
    subject: envelope?.subject ?? "(无主题)",
    from: addresses(envelope?.from).join(", ") || "(未知发件人)",
    ...(dateValue(message.internalDate ?? envelope?.date) === undefined ? {} : { receivedAt: dateValue(message.internalDate ?? envelope?.date) }),
  };
}

function optionalConfigString(config: Readonly<Record<string, unknown>>, key: string, fallback: string): string {
  const value = config[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error(`126 Mail Connector config ${key} must be a string`);
  return value;
}

function optionalConfigPort(config: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const value = config[key];
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65_535) throw new Error(`126 Mail Connector config ${key} must be a valid port`);
  return value as number;
}

function optionalConfigBoolean(config: Readonly<Record<string, unknown>>, key: string, fallback: boolean): boolean {
  const value = config[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`126 Mail Connector config ${key} must be a boolean`);
  return value;
}

function credentialString(credentials: Readonly<Record<string, string>>, keys: readonly string[]): string {
  const value = keys.map((key) => credentials[key]).find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
  if (value === undefined) throw new Error(`126 Mail connection requires ${keys.join(" or ")}`);
  return value;
}

function parseUid(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("126 Mail messageId must be an IMAP UID");
  const uid = Number(value);
  if (!Number.isSafeInteger(uid) || uid < 1) throw new Error("126 Mail messageId must be an IMAP UID");
  return uid;
}

function mailMessage(message: FetchMessageObject): MailMessage {
  const summary = messageSummary(message);
  const envelope = message.envelope;
  const source = message.source?.toString("utf8");
  const text = source === undefined ? undefined : messageBody(source);
  return {
    ...summary,
    ...(addresses(envelope?.to).length === 0 ? {} : { to: addresses(envelope?.to) }),
    ...(addresses(envelope?.cc).length === 0 ? {} : { cc: addresses(envelope?.cc) }),
    ...(text === undefined || text.length === 0 ? {} : { text }),
    ...(message.bodyStructure === undefined ? {} : { attachments: attachments(message.bodyStructure) }),
  };
}

function addresses(value: readonly MessageAddressObject[] | undefined): string[] {
  return (value ?? []).map((item) => item.address ?? item.name).filter((item): item is string => typeof item === "string" && item.length > 0);
}

function dateValue(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function messageBody(source: string): string {
  const boundary = source.search(/\r?\n\r?\n/);
  return (boundary < 0 ? source : source.slice(boundary)).trim().slice(0, 512_000);
}

function attachments(node: NonNullable<FetchMessageObject["bodyStructure"]>): MailMessage["attachments"] {
  const collected: Array<{
    id: string;
    name: string;
    mediaType?: string;
    byteSize?: number;
  }> = [];
  const visit = (part: typeof node) => {
    if (part.disposition === "attachment") {
      collected.push({
        id: part.part ?? "attachment",
        name: part.dispositionParameters?.filename ?? part.id ?? "attachment",
        ...(part.type.length === 0 ? {} : { mediaType: part.type }),
        ...(part.size === undefined ? {} : { byteSize: part.size }),
      });
    }
    part.childNodes?.forEach(visit);
  };
  visit(node);
  return collected;
}
