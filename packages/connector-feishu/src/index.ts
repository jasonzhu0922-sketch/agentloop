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

const FEISHU_BASE_URL = "https://open.feishu.cn/open-apis";

const capabilities: readonly ConnectorCapabilityDefinition[] = [
  {
    id: "document.search",
    category: "source",
    label: "Search Feishu documents",
    description: "Search documents available to the authorized Feishu account.",
    sourceKinds: ["document"],
    producesEvidenceKinds: ["source_summary", "source_urls", "explicit_caveats"],
    risk: "low",
    replaySafe: true,
  },
  {
    id: "document.read",
    category: "read",
    label: "Read a Feishu document",
    description: "Read the content of an authorized Feishu document.",
    sourceKinds: ["document"],
    producesEvidenceKinds: ["source_summary", "source_urls", "explicit_caveats"],
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
        pageToken: { type: "string" },
        pageSize: { type: "integer", minimum: 1, maximum: 50 },
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
        documentId: { type: "string", minLength: 1 },
      },
    },
    executionMode: "parallel",
    replaySafe: true,
    timeoutMs: 30_000,
  },
];

export const feishuDefinition: ConnectorDefinition = {
  manifest: {
    schema: "agentloop.connectorManifest/v1",
    key: "feishu",
    version: "0.1.0",
    displayName: "飞书",
    description: "Read-only Feishu document connector for AgentLoop.",
    agentloopSdk: "^0.1.0",
    apiVersion: "open-apis",
  },
  capabilities,
};

export const feishuConnector: ConnectorModule = {
  definition: feishuDefinition,

  async connect(input: ConnectorConnectionInput): Promise<ConnectorInstance> {
    const credentials = await input.credentialProvider.get(input.connection.credentialRef);
    const accessToken = credentials.accessToken;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new Error("Feishu connection requires an accessToken credential");
    }

    return {
      definition: feishuDefinition,
      connection: input.connection,
      operations,
      async execute(
        operationId: string,
        operationInput: unknown,
        context: ConnectorExecutionContext,
      ): Promise<ConnectorExecutionResult> {
        const operation = operations.find((item) => item.id === operationId);
        if (operation === undefined) throw new Error(`Unknown Feishu operation: ${operationId}`);
        const body = operationInput as Record<string, unknown>;
        const path = operationId === "document.search"
          ? "/search/v2/object"
          : `/docx/v1/documents/${encodeURIComponent(String(body.documentId))}/raw_content`;
        const response = await fetch(`${FEISHU_BASE_URL}${path}`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(body),
          signal: context.signal,
        });
        const responseText = await response.text();
        if (!response.ok) {
          throw new Error(`Feishu API request failed (${response.status}): ${responseText.slice(0, 500)}`);
        }
        let data: unknown;
        try {
          data = JSON.parse(responseText);
        } catch {
          data = { raw: responseText };
        }
        return {
          operationId,
          data,
          externalRequestId: response.headers.get("x-request-id") ?? undefined,
        };
      },
      mapEvidence(result: ConnectorExecutionResult, evidenceContext: ConnectorExecutionContext) {
        return [{
          schema: "agentloop.connectorEvidence/v1",
          evidenceId: `${evidenceContext.runId}:${result.operationId}:${Date.now()}`,
          connectorKey: feishuDefinition.manifest.key,
          connectionId: evidenceContext.connection.id,
          operationId: result.operationId,
          sourceRefs: result.sourceRefs ?? [],
          facts: [{ data: result.data }],
          evidenceKinds: ["source_summary", "explicit_caveats"],
          retrievedAt: Date.now(),
          caveats: ["Feishu API response is preserved as connector evidence; source-level extraction is performed by the next normalization layer."],
        }];
      },
    };
  },

  async project(input) {
    return {
      connectorKey: feishuDefinition.manifest.key,
      connectorVersion: feishuDefinition.manifest.version,
      capabilities,
      operations,
      runtimeTools: [],
    };
  },
};
