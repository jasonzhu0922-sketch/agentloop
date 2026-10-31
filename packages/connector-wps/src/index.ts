import type {
  ConnectorCapabilityDefinition,
  ConnectorConnectionInput,
  ConnectorDefinition,
  ConnectorExecutionContext,
  ConnectorExecutionResult,
  ConnectorInstance,
  ConnectorModuleFactoryContext,
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
  readonly driveId?: string;
}

export interface OnlineDocument extends OnlineDocumentSummary {
  readonly text?: string;
  readonly sheets?: readonly {
    readonly id: string;
    readonly name: string;
    readonly columns?: readonly string[];
    readonly rows?: readonly (readonly unknown[])[];
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
    readonly driveId?: string;
  }): Promise<OnlineDocument>;
  readSpreadsheet(input: {
    readonly documentId: string;
    readonly sheetId?: string;
    readonly driveId?: string;
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
        driveId: { type: "string", minLength: 1, maxLength: 300 },
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
        driveId: { type: "string", minLength: 1, maxLength: 300 },
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
              data: await transport.read({
                documentId: String(body.documentId),
                ...(body.driveId === undefined ? {} : { driveId: String(body.driveId) }),
              }),
            };
          }
          if (operationId === "spreadsheet.read") {
            return {
              operationId,
              data: await transport.readSpreadsheet({
                documentId: String(body.documentId),
                ...(body.sheetId === undefined ? {} : { sheetId: String(body.sheetId) }),
                ...(body.driveId === undefined ? {} : { driveId: String(body.driveId) }),
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

/**
 * Connects WPS's standard Cloud Document REST APIs with the user access token
 * obtained by the Local Agent OAuth flow. No user-facing endpoint or token
 * field is needed: the API origin is WPS-owned and the token stays in the
 * Local Agent encrypted Secret Store.
 */
export function createConfiguredWpsConnector(
  context: ConnectorModuleFactoryContext,
): ConnectorModule {
  return createWpsConnector(async ({ credentials }) => createWpsRestTransport(context.fetch, credentials));
}

const WPS_OPEN_API_ORIGIN = "https://openapi.wps.cn";
const SPREADSHEET_RANGE_LIMIT = "A1:Z200";

async function createWpsRestTransport(
  fetcher: typeof globalThis.fetch,
  credentials: Readonly<Record<string, string>>,
): Promise<WpsDocumentTransport> {
  const accessToken = credentials.accessToken;
  if (typeof accessToken !== "string" || accessToken.length === 0) throw new Error("WPS connection requires an accessToken credential");
  const request = async (path: string, query?: Readonly<Record<string, string>>): Promise<unknown> => {
    const url = new URL(path, WPS_OPEN_API_ORIGIN);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const response = await fetcher(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(`WPS REST request failed (${response.status})`);
    return unwrapWpsResponse(body);
  };
  const driveIdFor = async (documentId: string, driveId?: string): Promise<string> => {
    if (driveId !== undefined && driveId.length > 0) return driveId;
    const metadata = await request(`/v7/files/${encodeURIComponent(documentId)}/meta`, { with_drive: "true" });
    const resolved = stringAt(metadata, ["drive_id", "driveId"]);
    if (resolved === undefined) throw new Error("WPS document read requires driveId; provide the driveId returned by document.search.");
    return resolved;
  };
  return {
    async search(input) {
      const data = await request("/v7/files/search", {
        keyword: input.query,
        page_size: String(input.limit ?? 20),
        ...(input.parentId === undefined ? {} : { parent_id: input.parentId }),
      });
      return searchResults(data);
    },
    async read(input) {
      const driveId = await driveIdFor(input.documentId, input.driveId);
      const data = await request(`/v7/drives/${encodeURIComponent(driveId)}/files/${encodeURIComponent(input.documentId)}/content`, { format: "markdown" });
      return { id: input.documentId, name: fileName(data) ?? input.documentId, kind: "document", text: markdownContent(data) };
    },
    async readSpreadsheet(input) {
      const worksheets = worksheetsFrom(await request(`/v7/sheets/${encodeURIComponent(input.documentId)}/worksheets`));
      const selected = input.sheetId === undefined ? worksheets : worksheets.filter((sheet) => sheet.id === input.sheetId);
      if (selected.length === 0) throw new Error(`WPS spreadsheet worksheet not found: ${input.sheetId}`);
      const sheets = await Promise.all(selected.map(async (sheet) => {
        const data = await request(`/v7/sheets/${encodeURIComponent(input.documentId)}/worksheets/${encodeURIComponent(sheet.id)}/range_data`, { range: SPREADSHEET_RANGE_LIMIT });
        return { ...sheet, ...rangeData(data) };
      }));
      return { id: input.documentId, name: input.documentId, kind: "spreadsheet", sheets };
    },
  };
}

function unwrapWpsResponse(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("WPS REST response was not JSON object");
  const body = value as Record<string, unknown>;
  if (body.code !== undefined && body.code !== 0 && body.code !== "0") {
    const message = stringAt(body, ["msg", "message", "error_description"]) ?? "unknown error";
    throw new Error(`WPS REST request failed: ${message}`);
  }
  return body.data ?? body;
}

function stringAt(value: unknown, keys: readonly string[]): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) if (typeof record[key] === "string" && record[key].length > 0) return record[key] as string;
  for (const nested of [record.data, record.file, record.meta]) {
    const found = stringAt(nested, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

function searchResults(value: unknown): readonly OnlineDocumentSummary[] {
  const records = arrayAt(value, ["files", "items", "list", "data"]);
  return records.map((entry) => {
    const record = asRecord(entry);
    if (record === undefined) throw new Error("WPS search response contained a non-object file");
    const id = stringAt(record, ["id", "file_id", "fileId"]);
    if (id === undefined) throw new Error("WPS search response contained a file without an id");
    const type = stringAt(record, ["kind", "type", "file_type", "fileType"]);
    return {
      id,
      name: stringAt(record, ["name", "file_name", "fileName", "title"]) ?? id,
      kind: documentKind(type),
      ...(stringAt(record, ["url", "web_url", "webUrl"]) === undefined ? {} : { url: stringAt(record, ["url", "web_url", "webUrl"])! }),
      ...(stringAt(record, ["modified_at", "modifiedAt", "modify_time", "updated_at"]) === undefined ? {} : { modifiedAt: stringAt(record, ["modified_at", "modifiedAt", "modify_time", "updated_at"])! }),
      ...(stringAt(record, ["parent_id", "parentId"]) === undefined ? {} : { parentId: stringAt(record, ["parent_id", "parentId"])! }),
      ...(stringAt(record, ["drive_id", "driveId"]) === undefined ? {} : { driveId: stringAt(record, ["drive_id", "driveId"])! }),
    };
  });
}

function markdownContent(value: unknown): string {
  const content = stringAt(value, ["content", "markdown", "text"]);
  if (content !== undefined) return content;
  throw new Error("WPS document content response did not include Markdown content");
}

function worksheetsFrom(value: unknown): readonly { readonly id: string; readonly name: string }[] {
  return arrayAt(value, ["worksheets", "sheets", "list", "data"]).map((entry) => {
    const sheet = asRecord(entry);
    if (sheet === undefined) throw new Error("WPS worksheet response contained a non-object sheet");
    const id = stringAt(sheet, ["id", "worksheet_id", "worksheetId"]);
    if (id === undefined) throw new Error("WPS worksheet response contained a sheet without an id");
    return { id, name: stringAt(sheet, ["name", "title", "worksheet_name", "worksheetName"]) ?? id };
  });
}

function rangeData(value: unknown): { readonly columns?: readonly string[]; readonly rows?: readonly (readonly unknown[])[] } {
  const record = objectAt(value, ["range_data", "rangeData"]) ?? asRecord(value);
  const rawColumns = arrayAtOptional(record?.columns ?? record?.column_names);
  const rawRows = arrayAtOptional(record?.values ?? record?.rows ?? record?.data);
  const columns = rawColumns?.map(String);
  const rows = rawRows?.map((row) => Array.isArray(row) ? row : [row]);
  return { ...(columns === undefined ? {} : { columns }), ...(rows === undefined ? {} : { rows }) };
}

function documentKind(value: string | undefined): OnlineDocumentSummary["kind"] {
  const type = value?.toLowerCase() ?? "";
  if (type.includes("folder")) return "folder";
  if (type.includes("pdf")) return "pdf";
  if (type.includes("sheet") || type.includes("excel") || type.includes("xls") || type.includes("et")) return "spreadsheet";
  return "document";
}

function fileName(value: unknown): string | undefined { return stringAt(value, ["name", "file_name", "fileName", "title"]); }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function objectAt(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  for (const key of keys) {
    const nested = asRecord(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function arrayAt(value: unknown, keys: readonly string[]): readonly unknown[] {
  return arrayAtOptional(value, keys) ?? [];
}

function arrayAtOptional(value: unknown, keys: readonly string[] = []): readonly unknown[] | undefined {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (record === undefined) return undefined;
  for (const key of keys) if (Array.isArray(record[key])) return record[key] as readonly unknown[];
  return undefined;
}
