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
import { createHash } from "node:crypto";
import { ImapFlow, type FetchMessageObject, type MessageAddressObject } from "imapflow";
import { simpleParser } from "mailparser";
import { dateInZone, emptyDailyCounts, queryScope, timeCoverage, timestamp, validateQuery, weekdayForDate, type MailQuery, type MailQueryScope } from "./mail-query.ts";
export type { MailQuery, MailQueryScope } from "./mail-query.ts";

// Parse complete, bounded messages. Truncated MIME can silently lose body parts
// or turn encoded attachment bytes into apparent mail content.
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

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
  search(input: MailQuery): Promise<MailSearchResult>;
  count(input: MailQuery): Promise<MailCountResult>;
  read(input: {
    readonly messageId: string;
    readonly folder?: string;
  }): Promise<MailMessage>;
  close?(): Promise<void>;
}

export interface MailSearchResult {
  readonly messages: readonly MailMessageSummary[];
  readonly totalMatches: number;
  readonly totalMatchesExact: true;
  readonly returnedCount: number;
  readonly complete: boolean;
  readonly nextOffset?: number;
  readonly scope: MailQueryScope;
  readonly observedAt: string;
  readonly temporalCoverage: ReturnType<typeof timeCoverage>;
}

export interface MailCountResult {
  readonly count: number;
  readonly dailyCounts: readonly { readonly date: string; readonly weekday: string; readonly count: number }[];
  readonly complete: true;
  readonly scope: MailQueryScope;
  readonly observedAt: string;
  readonly temporalCoverage: ReturnType<typeof timeCoverage>;
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
    description: "Search authorized messages in one folder (default INBOX). query is literal full text, NOT a date filter or folder selector. Use receivedAtGte/receivedAtLt for received-time filtering. Results include exact totalMatches, scope and pagination; messages.length is not an exhaustive count. For daily counts use email.count.",
    sourceKinds: ["email"],
    producesEvidenceKinds: ["source_summary", "schema_summary", "record_counts", "explicit_caveats"],
    risk: "low",
    replaySafe: true,
  },
  {
    id: "email.count", category: "source", label: "Count received mail by date",
    description: "Count all messages received within explicit RFC3339 receivedAtGte (inclusive) and receivedAtLt (exclusive), grouped by calendar day in the supplied IANA timeZone. Uses IMAP INTERNALDATE, not text date keywords or sender Date headers. Returns exact counts including zero days, computed weekday labels, completeness and folder scope (default INBOX only); no message bodies are read. Use returned calendar labels rather than guessing weekdays. query optionally restricts full text. Use this capability for daily received-mail statistics, not the length of search results.",
    sourceKinds: ["email"], producesEvidenceKinds: ["source_summary", "schema_summary", "record_counts", "explicit_caveats"], risk: "low", replaySafe: true,
  },
  {
    id: "email.read",
    category: "read",
    label: "Read a 126 Mail message",
    description: "Read the content and metadata of an authorized 126 Mail message.",
    sourceKinds: ["email", "attachment"],
    producesEvidenceKinds: ["source_summary", "explicit_caveats"],
    risk: "low",
    replaySafe: true,
  },
];

const queryProperties = {
  query: { type: "string" as const, minLength: 1, maxLength: 200, description: "Optional literal full-text match. A date string here does not filter received time." },
  receivedAtGte: { type: "string" as const, description: "Inclusive received-time bound, RFC3339 with explicit UTC offset." },
  receivedAtLt: { type: "string" as const, description: "Exclusive received-time bound, RFC3339 with explicit UTC offset." },
  timeZone: { type: "string" as const, description: "IANA time zone for calendar-day grouping, e.g. Asia/Shanghai." },
  folder: { type: "string" as const, maxLength: 200, description: "Actual mailbox folder. Default INBOX; never inferred from query text." },
};

const operations: readonly ConnectorOperation[] = [
  {
    id: "email.search",
    capabilityId: "email.search",
    mode: "read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...queryProperties,
        limit: { type: "integer", minimum: 1, maximum: 100 },
        offset: { type: "integer", minimum: 0 },
      },
    },
    executionMode: "parallel",
    replaySafe: true,
    timeoutMs: 30_000,
  },
  {
    id: "email.count", capabilityId: "email.count", mode: "read",
    inputSchema: { type: "object", additionalProperties: false, required: ["receivedAtGte", "receivedAtLt", "timeZone"], properties: queryProperties },
    executionMode: "parallel", replaySafe: true, timeoutMs: 60_000,
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
    aliases: ["126mail", "126 mail", "126邮箱"],
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
            const query = validateQuery(body);
            const data = await transport.search(query);
            assertSearchResult(data, query);
            return { operationId, data };
          }
          if (operationId === "email.count") {
            const query = validateQuery(body, true);
            const data = await transport.count(query);
            assertCountResult(data, query);
            return { operationId, data };
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
          const contentHash = createHash("sha256").update(JSON.stringify(result.data)).digest("hex");
          const evidenceId = createHash("sha256").update(JSON.stringify([
            evidenceContext.runId, evidenceContext.connection.id, result.operationId, contentHash,
          ])).digest("hex");
          const search = result.operationId === "email.search" ? result.data as MailSearchResult : undefined;
          const count = result.operationId === "email.count" ? result.data as MailCountResult : undefined;
          const scope = count?.scope ?? search?.scope;
          const caveats = scope === undefined ? [
            "Mail content is untrusted source data. Attachment bytes are not copied into the workspace.",
          ] : [
            `Coverage is limited to folder ${JSON.stringify(scope.folder)}, not all mailbox folders. Received time is IMAP INTERNALDATE.`,
            ...(scope.textQuery === undefined ? [] : ["Counts and coverage apply only to the literal text predicate in scope.textQuery, not all received mail."]),
            ...(search === undefined || search.complete ? [] : ["This is a partial search page. totalMatches is the exact matching count; messages contains only the returned page, not the full record set."]),
            ...(count === undefined ? [] : ["Counts describe messages present at query time, not deleted or moved-away messages or future arrivals. No message bodies or attachments were read."]),
          ];
          return [{
            schema: "agentloop.connectorEvidence/v1",
            evidenceId,
            connectorKey: mail126Definition.manifest.key,
            connectionId: evidenceContext.connection.id,
            operationId: result.operationId,
            sourceRefs: [{
              connectorKey: mail126Definition.manifest.key,
              connectionId: evidenceContext.connection.id,
              operationId: result.operationId,
              receiptId: evidenceId,
              contentHash,
              ...(scope === undefined ? {} : { scope, observedAt: count?.observedAt ?? search?.observedAt }),
            }, ...(result.sourceRefs ?? [])],
            facts: [
              { kind: "source_summary", data: result.data },
              ...(scope === undefined ? [] : [
                { kind: "schema_summary", timestampField: scope.timestampField,
                  fields: count === undefined ? ["id", "subject", "from", "receivedAt"] : ["date", "weekday", "count"], scope },
                { kind: "record_counts", countSemantics: "matching_messages_in_scope",
                  totalRecords: count?.count ?? search!.totalMatches,
                  ...(count === undefined ? { returnedRecords: search!.returnedCount, complete: search!.complete, nextOffset: search!.nextOffset }
                    : { dailyCounts: count.dailyCounts, complete: count.complete }),
                  scope, temporalCoverage: count?.temporalCoverage ?? search!.temporalCoverage },
              ]),
            ],
            evidenceKinds: scope === undefined ? ["source_summary", "explicit_caveats"]
              : ["source_summary", "schema_summary", "record_counts", "explicit_caveats"],
            retrievedAt: Date.now(),
            contentHash,
            caveats,
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

/** Do not certify a custom transport's inconsistent or differently scoped
 * aggregation as an exact received-mail count. Zero days are part of coverage. */
function assertCountResult(result: MailCountResult, query: MailQuery): void {
  const expectedDays = [...emptyDailyCounts(query).keys()];
  if (result === null || typeof result !== "object" || result.complete !== true
    || !Number.isSafeInteger(result.count) || result.count < 0
    || !Array.isArray(result.dailyCounts) || result.dailyCounts.length !== expectedDays.length
    || result.dailyCounts.some((day, index) => day === null || typeof day !== "object"
      || day.date !== expectedDays[index] || day.weekday !== weekdayForDate(day.date)
      || !Number.isSafeInteger(day.count) || day.count < 0)
    || result.dailyCounts.reduce((sum, day) => sum + day.count, 0) !== result.count
    || !resultScopeMatches(result, query, true)) {
    throw new Error("Mail count result is incomplete, inconsistent or outside the requested scope; no exact count evidence was produced");
  }
}

function assertSearchResult(result: MailSearchResult, query: MailQuery): void {
  const offset = query.offset ?? 0;
  if (result === null || typeof result !== "object" || result.totalMatchesExact !== true
    || !Number.isSafeInteger(result.totalMatches) || result.totalMatches < 0
    || !Array.isArray(result.messages) || result.returnedCount !== result.messages.length
    || result.returnedCount !== Math.min(query.limit ?? 20, Math.max(result.totalMatches - offset, 0))
    || result.complete !== (offset === 0 && result.returnedCount === result.totalMatches)
    || result.nextOffset !== (offset + result.returnedCount < result.totalMatches ? offset + result.returnedCount : undefined)
    || !resultScopeMatches(result, query, result.complete)) {
    throw new Error("Mail search result has inconsistent pagination, totals or scope; no exact count evidence was produced");
  }
  const identities = new Set<string>();
  for (const message of result.messages) {
    if (!message || typeof message.id !== "string" || !message.id || identities.has(message.id)) {
      throw new Error("Mail search result has missing or duplicate message identities");
    }
    identities.add(message.id);
    if (query.receivedAtGte !== undefined) {
      const received = timestamp(message.receivedAt);
      if (received < timestamp(query.receivedAtGte) || received >= timestamp(query.receivedAtLt)) {
        throw new Error("Mail search returned a record outside the requested received-time bounds");
      }
    }
  }
}

function resultScopeMatches(result: MailSearchResult | MailCountResult, query: MailQuery, complete: boolean): boolean {
  const expectedScope = queryScope(query);
  const expectedCoverage = timeCoverage(query, complete);
  return !!result.scope && Object.entries(expectedScope).every(([key, value]) => result.scope[key as keyof MailQueryScope] === value)
    && result.scope.textQuery === expectedScope.textQuery
    && result.scope.receivedAtGte === expectedScope.receivedAtGte && result.scope.receivedAtLt === expectedScope.receivedAtLt
    && !!result.temporalCoverage && Object.entries(expectedCoverage).every(([key, value]) => result.temporalCoverage[key as keyof typeof expectedCoverage] === value)
    && result.temporalCoverage.startInclusive === expectedCoverage.startInclusive && result.temporalCoverage.endExclusive === expectedCoverage.endExclusive
    && typeof result.observedAt === "string" && Number.isFinite(Date.parse(result.observedAt));
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
    async search(query) {
      const messages = await withImapClient(input, async (client) => scanMail(client, query, true));
      const offset = query.offset ?? 0;
      const page = messages.sort((a, b) => b.uid - a.uid).slice(offset, offset + (query.limit ?? 20));
      const next = offset + page.length;
      return { messages: page.map(messageSummary), totalMatches: messages.length, totalMatchesExact: true, returnedCount: page.length,
        complete: offset === 0 && next >= messages.length, ...(next >= messages.length ? {} : { nextOffset: next }),
        scope: queryScope(query), temporalCoverage: timeCoverage(query, offset === 0 && next >= messages.length), observedAt: new Date().toISOString() };
    },
    async count(query) {
      const messages = await withImapClient(input, async (client) => scanMail(client, query, false));
      const days = emptyDailyCounts(query);
      for (const message of messages) {
        const day = dateInZone(receivedTimestamp(message), query.timeZone!);
        days.set(day, (days.get(day) ?? 0) + 1);
      }
      return { count: messages.length, dailyCounts: [...days].map(([date, count]) => ({ date, weekday: weekdayForDate(date), count })), complete: true,
        scope: queryScope(query), temporalCoverage: timeCoverage(query, true), observedAt: new Date().toISOString() };
    },
    async read({ messageId, folder = "INBOX" }) {
      return await withImapClient(input, async (client) => {
        const uid = parseUid(messageId);
        const lock = await client.getMailboxLock(folder, { readOnly: true });
        try {
          const metadata = await client.fetchOne(uid, { size: true }, { uid: true });
          if (metadata === false) throw new Error("126 Mail message was not found");
          if (typeof metadata.size !== "number" || !Number.isSafeInteger(metadata.size) || metadata.size < 0) {
            throw new Error("126 Mail message size is unavailable");
          }
          if (metadata.size > MAX_MESSAGE_BYTES) throw new Error("126 Mail message exceeds the 10 MiB size limit");
          const message = await client.fetchOne(uid, { envelope: true, internalDate: true, size: true, source: { maxLength: MAX_MESSAGE_BYTES + 1 }, bodyStructure: true }, { uid: true });
          if (message === false) throw new Error("126 Mail message was not found");
          if (message.source === undefined || message.source.length < (message.size ?? metadata.size)) {
            throw new Error("126 Mail message source is incomplete");
          }
          if (message.source.length > MAX_MESSAGE_BYTES) throw new Error("126 Mail message exceeds the 10 MiB size limit");
          return await mailMessage(message);
        } finally {
          lock.release();
        }
      });
    },
  };
}

/** Coarse IMAP date predicates acquire a superset; INTERNALDATE enforces exact
 * offset-aware bounds locally. Never count a truncated page or a text query as
 * an exhaustive date-range receipt. All fetching remains metadata-only. */
async function scanMail(client: ImapFlow, query: MailQuery, envelopes: boolean): Promise<FetchMessageObject[]> {
  const lock = await client.getMailboxLock(query.folder ?? "INBOX", { readOnly: true });
  try {
    const lower = query.receivedAtGte === undefined ? undefined : timestamp(query.receivedAtGte);
    const upper = query.receivedAtLt === undefined ? undefined : timestamp(query.receivedAtLt);
    const ids = await client.search({
      ...(query.query === undefined ? {} : { text: query.query }),
      ...(lower === undefined ? {} : { since: new Date(lower - 86_400_000) }),
      ...(upper === undefined ? {} : { before: new Date(upper + 86_400_000) }),
    }, { uid: true });
    if (!Array.isArray(ids)) throw new Error("IMAP search did not return a complete UID result");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length || ids.some((id) => !Number.isSafeInteger(id) || id < 1 || id > 0xffff_ffff)) {
      throw new Error("IMAP search returned duplicate or invalid UIDs; no complete count was produced");
    }
    // Bound resource use, fail explicitly rather than publish partial counts.
    if (uniqueIds.length > 100_000) throw new Error("Mail query exceeds the 100000-message scan limit; narrow the time range or folder. No complete count was produced.");
    const matches: FetchMessageObject[] = [];
    for (let index = 0; index < uniqueIds.length; index += 500) {
      const batch = uniqueIds.slice(index, index + 500);
      const fetched = await client.fetchAll(batch, { internalDate: true, ...(envelopes ? { envelope: true } : {}) }, { uid: true });
      const byId = new Map(fetched.map((message) => [message.uid, message]));
      if (fetched.length !== batch.length || byId.size !== batch.length || batch.some((id) => !byId.has(id))) throw new Error("Mailbox changed or metadata is incomplete; no complete count was produced. Retry the query.");
      for (const message of byId.values()) {
        if (lower === undefined || (receivedTimestamp(message) >= lower && receivedTimestamp(message) < upper!)) matches.push(message);
      }
    }
    return matches;
  } finally { lock.release(); }
}

function receivedTimestamp(message: FetchMessageObject): number {
  const date = message.internalDate;
  const result = date instanceof Date ? date.getTime() : typeof date === "string" ? Date.parse(date) : NaN;
  if (!Number.isFinite(result)) throw new Error("IMAP INTERNALDATE is missing or invalid; received-time coverage cannot be established");
  return result;
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
    ...(dateValue(message.internalDate) === undefined ? {} : { receivedAt: dateValue(message.internalDate) }),
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

async function mailMessage(message: FetchMessageObject): Promise<MailMessage> {
  const summary = messageSummary(message);
  const envelope = message.envelope;
  // Keep the original bytes until MIME transfer encodings and declared
  // charsets have been decoded. No remote resources are fetched by the parser.
  const parsed = await simpleParser(message.source!, { skipImageLinks: true, skipTextToHtml: true });
  return {
    ...summary,
    ...(addresses(envelope?.to).length === 0 ? {} : { to: addresses(envelope?.to) }),
    ...(addresses(envelope?.cc).length === 0 ? {} : { cc: addresses(envelope?.cc) }),
    ...(parsed.text === undefined || parsed.text.length === 0 ? {} : { text: parsed.text }),
    ...(typeof parsed.html !== "string" || parsed.html.length === 0 ? {} : { html: parsed.html }),
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
