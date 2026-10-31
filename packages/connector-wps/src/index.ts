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

export interface OnlineDocumentSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: "document" | "spreadsheet" | "pdf" | "folder";
  readonly url?: string;
  readonly modifiedAt?: string;
  readonly parentId?: string;
}

export interface OnlineDocument extends OnlineDocumentSummary {
  readonly text?: string;
  readonly sheets?: readonly {
    readonly id: string;
    readonly name: string;
    readonly columns?: readonly string[];
    readonly rows?: readonly readonly unknown[][];
  }[];
}

export interface WpsDocumentTransport {
  search(input: {
    readonly query: string;
    readonly limit?: number;
    readonly parentId?: string;
  }): Promise<readonly OnlineDocumentSummary[]>;
  read(input: {
    readonly documentId: string;
  }): Promise<OnlineDocument>;
  readSpreadsheet(input: {
    readonly documentId: string;
    readonly sheetId?: string;
  }): Promise<OnlineDocument>;
  close?(): Promise<void>;
}

export type WpsTransportFactory = (input: {
  readonly credentials: Readonly<Record<string, string>>;
  readonly connection: ConnectorConnectionInput["connection"];
}) => Promise<WpsDocumentTransport>;

const capabilities: readonly ConnectorCapabilityDefinition[] = [
  {
    id: "document.search",
    category: "source",
    label: "Search WPS online documents",
    description: "Search documents available to the authorized WPS account.",
    sourceKinds: ["document", "spreadsheet"],
    producesEvidenceKinds: ["source_summary", "source_urls", "explicit_caveats"],
    risk: "low",
    replaySafe: true,
  },
  {
    id: "document.read",
    category: "read",
    label: "Read a WPS online document",
    description: "Read an authorized WPS online document.",
    sourceKinds: ["document"],
    producesEvidenceKinds: ["source_summary", "source_urls", "explicit_caveats"],
    risk: "low",
    replaySafe: true,
  },
  {
    id: "spreadsheet.read",
    category: "read",
    label: "Read a WPS spreadsheet",
    description: "Read bounded sheet data from an authorized WPS spreadsheet.",
    sourceKinds: ["spreadsheet"],
    producesEvidenceKinds: ["schema_summary", "record_counts", "table_coverage", "explicit_caveats"],
    risk: "low",
    replaySafe: true,
  },
];

const operations: readonly ConnectorOperation[] = [
  {
    id: "document.search",
    capabilityId: "document.search",
    mode: "read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        parentId: { type: "string", maxLength: 300 },
      },
    },
    executionMode: "parallel",
    replaySafe: true,
    timeoutMs: 30_000,
  },
  {
    id: "document.read",
    capabilityId: "document.read",
    mode: "read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["documentId"],
      properties: {
        documentId: { type: "string", minLength: 1, maxLength: 300 },
      },
    },
    executionMode: "parallel",
    replaySafe: true,
    timeoutMs: 30_000,
  },
  {
    id: "spreadsheet.read",
    capabilityId: "spreadsheet.read",
    mode: "read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["documentId"],
      properties: {
        documentId: { type: "string", minLength: 1, maxLength: 300 },
        sheetId: { type: "string", maxLength: 300 },
      },
    },
    executionMode: "parallel",
    replaySafe: true,
    timeoutMs: 30_000,
  },
];

export const wpsDefinition: ConnectorDefinition = {
  manifest: {
    schema: "agentloop.connectorManifest/v1",
    key: "kingsoft-wps",
    version: "0.1.0",
    displayName: "金山在线文档",
    description: "Read-only Kingsoft/WPS online document connector for AgentLoop.",
    agentloopSdk: "^0.1.0",
    apiVersion: "document-transport",
  },
  capabilities,
};

export function createWpsConnector(
  transportFactory: WpsTransportFactory,
): ConnectorModule {
  return {
    definition: wpsDefinition,

    async connect(input: ConnectorConnectionInput): Promise<ConnectorInstance> {
      const credentials = await input.credentialProvider.get(input.connection.credentialRef);
      const transport = await transportFactory({
        credentials,
        connection: input.connection,
      });
      return {
        definition: wpsDefinition,
        connection: input.connection,
        operations,
        async execute(
          operationId: string,
          operationInput: unknown,
          _context: ConnectorExecutionContext,
        ): Promise<ConnectorExecutionResult> {
          const body = operationInput as Record<string, unknown>;
          if (operationId === "document.search") {
            return {
              operationId,
              data: await transport.search({
                query: String(body.query),
                ...(body.limit === undefined ? {} : { limit: Number(body.limit) }),
                ...(body.parentId === undefined ? {} : { parentId: String(body.parentId) }),
              }),
            };
          }
          if (operationId === "document.read") {
            return {
              operationId,
              data: await transport.read({ documentId: String(body.documentId) }),
            };
          }
          if (operationId === "spreadsheet.read") {
            return {
              operationId,
              data: await transport.readSpreadsheet({
                documentId: String(body.documentId),
                ...(body.sheetId === undefined ? {} : { sheetId: String(body.sheetId) }),
              }),
            };
          }
          throw new Error(`Unknown WPS operation: ${operationId}`);
        },
        mapEvidence(result: ConnectorExecutionResult, evidenceContext: ConnectorExecutionContext) {
          return [{
            schema: "agentloop.connectorEvidence/v1",
            evidenceId: `${evidenceContext.runId}:${result.operationId}:${Date.now()}`,
            connectorKey: wpsDefinition.manifest.key,
            connectionId: evidenceContext.connection.id,
            operationId: result.operationId,
            sourceRefs: result.sourceRefs ?? [],
            facts: [{ data: result.data }],
            evidenceKinds: result.operationId === "spreadsheet.read"
              ? ["schema_summary", "record_counts", "table_coverage", "explicit_caveats"]
              : ["source_summary", "source_urls", "explicit_caveats"],
            retrievedAt: Date.now(),
            caveats: [
              "WPS content is provided by the configured WpsDocumentTransport; write operations are not enabled.",
            ],
          }];
        },
      };
    },

    async project() {
      return {
        connectorKey: wpsDefinition.manifest.key,
        connectorVersion: wpsDefinition.manifest.version,
        capabilities,
        operations,
        runtimeTools: [],
      };
    },
  };
}
