import type {
  ConnectorCapabilityDefinition,
  ConnectorConnectionInput,
  ConnectorDefinition,
  ConnectorExecutionContext,
  ConnectorExecutionResult,
  ConnectorInstance,
  ConnectorModule,
  ConnectorOperation,
} from "@zhujun/agentloop-connector-sdk";

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
    apiVersion: "mail-transport",
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
