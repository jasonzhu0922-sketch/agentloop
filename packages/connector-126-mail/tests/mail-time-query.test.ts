import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ImapFlow, type FetchMessageObject } from "imapflow";
import { create126MailConnector, createConfigured126MailConnector, type MailCountResult, type MailSearchResult } from "../src/index.ts";
import { connectorOperationTools, connectorPlanningCapabilities } from "../../connector-sdk/src/agentloop-adapter.ts";
import { admittedEvidenceKindsForCommittedResult, type RuntimeToolProgressPolicy } from "../../agentloop/src/runtime/tool-progress-policy.ts";

async function fixture(t: TestContext, records: Array<{ uid: number; internalDate?: string; sentAt?: string }>, options: { incomplete?: boolean; failedSearch?: boolean; uids?: number[]; duplicatedMetadata?: boolean } = {}) {
  const searches: Record<string, unknown>[] = [];
  const fetches: Record<string, unknown>[] = [];
  let released = 0;
  t.mock.method(ImapFlow.prototype, "connect", async () => undefined);
  t.mock.method(ImapFlow.prototype, "logout", async () => undefined);
  t.mock.method(ImapFlow.prototype, "getMailboxLock", async (folder, input) => {
    assert.equal(folder, "INBOX"); assert.equal(input.readOnly, true);
    return { release() { released += 1; } };
  });
  t.mock.method(ImapFlow.prototype, "search", async (input, imapOptions) => {
    assert.equal(imapOptions.uid, true); searches.push(input);
    return options.failedSearch ? false : options.uids ?? records.map((record) => record.uid);
  });
  t.mock.method(ImapFlow.prototype, "fetchAll", async (ids: number[], input, imapOptions) => {
    assert.equal(imapOptions.uid, true); fetches.push(input);
    const rows = records.filter((record) => ids.includes(record.uid)).map((record) => ({
      uid: record.uid, ...(record.internalDate === undefined ? {} : { internalDate: new Date(record.internalDate) }),
      envelope: { date: new Date(record.sentAt ?? "2025-07-09T00:00:00Z"), subject: "synthetic fixture" },
    })) as FetchMessageObject[];
    return options.incomplete ? rows.slice(1) : options.duplicatedMetadata ? [...rows, rows[0]] : rows;
  });
  const module = createConfigured126MailConnector({ config: {}, fetch: globalThis.fetch });
  const credentialProvider = { get: async () => ({ email: "fixture@126.com", authorizationCode: "not-a-real-secret" }) };
  const instance = await module.connect({
    connection: { id: "mail", connectorKey: "126-mail", ownerType: "user", ownerId: "owner", scopes: [], credentialRef: "fixture", status: "active" }, credentialProvider,
  });
  const context = { runId: "test", actorUserId: "owner", connection: instance.connection, credentialProvider };
  const execute = async (operation: string, input: unknown) => (await instance.execute(operation, input, context)).data;
  return { execute, searches, fetches, released: () => released, instance, context };
}

const range = { receivedAtGte: "2026-10-28T00:00:00+08:00", receivedAtLt: "2026-11-02T00:00:00+08:00", timeZone: "Asia/Shanghai" };

test("count uses exact received-time bounds, includes zero days and ignores conflicting sent headers", async (t) => {
  const f = await fixture(t, [
    { uid: 1, internalDate: "2026-10-27T15:59:59Z" }, // before inclusive local midnight
    { uid: 2, internalDate: "2026-10-27T16:00:00Z" }, // exact start
    { uid: 3, internalDate: "2026-10-30T16:00:00Z" },
    { uid: 4, internalDate: "2026-11-01T15:59:59Z" },
    { uid: 5, internalDate: "2026-11-01T16:00:00Z" }, // exact exclusive end
  ]);
  const result = await f.execute("email.count", range) as MailCountResult;
  assert.deepEqual(result.dailyCounts, [
    { date: "2026-10-28", weekday: "Wednesday", count: 1 }, { date: "2026-10-29", weekday: "Thursday", count: 0 }, { date: "2026-10-30", weekday: "Friday", count: 0 }, { date: "2026-10-31", weekday: "Saturday", count: 1 }, { date: "2026-11-01", weekday: "Sunday", count: 1 },
  ]);
  assert.equal(result.count, 3); assert.equal(result.complete, true);
  assert.equal(result.scope.timestampField, "IMAP.INTERNALDATE");
  assert.equal(result.scope.folder, "INBOX");
  assert.equal(f.searches[0].text, undefined, "a date range is not a text query");
  assert.ok(f.searches[0].since instanceof Date); assert.ok(f.searches[0].before instanceof Date);
  assert.deepEqual(f.fetches, [{ internalDate: true }], "statistics must never read envelopes, bodies or attachments");
  assert.equal(f.released(), 1);
});

test("exact counting is not capped by the 100-message search page", async (t) => {
  const f = await fixture(t, Array.from({ length: 1205 }, (_, index) => ({ uid: index + 1, internalDate: "2026-11-01T03:00:00Z" })));
  const result = await f.execute("email.count", range) as MailCountResult;
  assert.equal(result.count, 1205); assert.equal(f.fetches.length, 3);
});

test("search pagination reports exact totals and incomplete pages instead of apparent exhaustive counts", async (t) => {
  const f = await fixture(t, Array.from({ length: 105 }, (_, index) => ({ uid: index + 1, internalDate: "2026-11-01T03:00:00Z" })));
  const result = await f.execute("email.search", { ...range, limit: 100 }) as MailSearchResult;
  assert.equal(result.messages.length, 100); assert.equal(result.totalMatches, 105);
  assert.equal(result.complete, false); assert.equal(result.nextOffset, 100);
  assert.equal(result.temporalCoverage.complete, false);
  const last = await f.execute("email.search", { ...range, offset: result.nextOffset, limit: 100 }) as MailSearchResult;
  assert.equal(last.messages.length, 5); assert.equal(last.nextOffset, undefined);
});

test("literal date keywords remain literal text and cannot attest received-time coverage", async (t) => {
  const f = await fixture(t, []);
  const result = await f.execute("email.search", { query: "2026-10-28" }) as MailSearchResult;
  assert.deepEqual(f.searches, [{ text: "2026-10-28" }]);
  assert.equal(result.scope.receivedAtGte, undefined);
  assert.equal(result.temporalCoverage.complete, false);
});

test("a successful empty time-bounded search proves zero only for its declared folder and range", async (t) => {
  const f = await fixture(t, []);
  const result = await f.execute("email.count", range) as MailCountResult;
  assert.equal(result.count, 0); assert.equal(result.complete, true);
  assert.equal(result.dailyCounts.length, 5);
  assert.ok(result.dailyCounts.every((day) => day.count === 0));
  assert.equal(result.temporalCoverage.startInclusive, "2026-10-27T16:00:00.000Z");
});

test("invalid time bounds and unbound counts fail before any mailbox operation", async (t) => {
  const f = await fixture(t, []);
  for (const input of [{ query: "2026-10-28" }, { ...range, receivedAtLt: undefined }, { ...range, receivedAtGte: "2026-10-28" }, { ...range, timeZone: "invalid-zone" }, { ...range, receivedAtLt: range.receivedAtGte }]) {
    await assert.rejects(f.execute("email.count", input));
  }
  assert.equal(f.searches.length, 0);
});

for (const kind of ["missing-date", "missing-record", "failed-search"] as const) {
  test(`partial or unavailable metadata does not become a zero count (${kind})`, async (t) => {
    const f = await fixture(t, [{ uid: 1, ...(kind === "missing-date" ? {} : { internalDate: "2026-11-01T03:00:00Z" }) }], { incomplete: kind === "missing-record", failedSearch: kind === "failed-search" });
    await assert.rejects(f.execute("email.count", range), /INTERNALDATE|incomplete|complete UID/);
    assert.equal(f.released(), 1);
  });
}

test("count is discoverable through the same declared Connector operation catalog", async (t) => {
  const f = await fixture(t, []);
  const operation = f.instance.operations.find((item) => item.capabilityId === "email.count");
  assert.ok(operation);
  assert.deepEqual(operation.inputSchema.required, ["receivedAtGte", "receivedAtLt", "timeZone"]);
});

test("126 count exposes verifiable source counts through normal discovery and post-commit evidence admission", async (t) => {
  const f = await fixture(t, [{ uid: 1, internalDate: "2026-11-01T03:00:00Z" }]);
  const capability = connectorPlanningCapabilities(f.instance).find((item) => item.id === "email.count")!;
  assert.ok(capability.produces.includes("record_counts"));
  assert.ok(capability.produces.includes("schema_summary"));
  assert.ok(!capability.produces.includes("structured_extraction_artifact"), "inline data is not a materialized artifact");
  const tool = connectorOperationTools(f.instance, f.context).find((item) => item.description.includes("Connector operation: email.count"))!;
  const result = await tool.execute({} as never, range) as { evidenceReceipt: { facts: Array<Record<string, unknown>>; sourceRefs: Array<Record<string, unknown>>; caveats: string[] } };
  const receipt = result.evidenceReceipt;
  const fact = receipt.facts.find((item) => item.kind === "record_counts")!;
  assert.equal(fact.totalRecords, 1);
  assert.equal(fact.countSemantics, "matching_messages_in_scope");
  assert.equal((fact.dailyCounts as unknown[]).length, 5);
  assert.equal(receipt.sourceRefs[0].connectionId, "mail");
  assert.match(String(receipt.sourceRefs[0].contentHash), /^[a-f0-9]{64}$/);
  assert.ok(receipt.caveats.some((item) => item.includes("not all mailbox folders")));
  const policy: RuntimeToolProgressPolicy = {
    schema: "agentloop.runtimeToolProgressPolicy/v1", requiredEvidenceKinds: ["record_counts", "schema_summary"], targetIds: [],
    evidenceProducers: ["record_counts", "schema_summary"].map((evidenceKind) => ({ evidenceKind: evidenceKind as "record_counts" | "schema_summary", capabilityId: capability.id, resolvedToolNames: [tool.name] })),
    workflowEvidenceActions: [], maxExploratoryPrimarySteps: 1, maxExploratoryGraceSteps: 1,
    exploratoryToolNames: [], setupToolNames: [], evidenceProducingToolNames: [tool.name], repairDirective: "", diagnosticRepairDirective: "",
  };
  const admitted = admittedEvidenceKindsForCommittedResult({
    evidence: { toolCallId: "source-call", toolName: tool.name, isError: false, result: JSON.stringify(result) }, policy,
  });
  assert.ok(admitted.includes("record_counts"), "the unchanged Runtime must admit actual Connector counts, not only model summaries");
  assert.ok(admitted.includes("schema_summary"));
  assert.ok(!admitted.includes("structured_extraction_artifact"));
});

test("partial search evidence retains exact matching totals without claiming a full record set", async (t) => {
  const f = await fixture(t, Array.from({ length: 105 }, (_, index) => ({ uid: index + 1, internalDate: "2026-11-01T03:00:00Z" })));
  const result = await f.instance.execute("email.search", { ...range, limit: 20 }, f.context);
  const evidence = f.instance.mapEvidence(result, f.context)[0];
  const fact = evidence.facts.find((item) => item.kind === "record_counts")!;
  assert.equal(fact.totalRecords, 105); assert.equal(fact.returnedRecords, 20);
  assert.equal(fact.complete, false); assert.equal(fact.nextOffset, 20);
  assert.ok(evidence.caveats.some((item) => item.includes("partial search page")));
});

test("malformed custom count results are not certified as exact evidence", async (t) => {
  const f = await fixture(t, []);
  const valid = await f.execute("email.count", range) as MailCountResult;
  const invalid = [
    { ...valid, count: 1 }, { ...valid, complete: false },
    { ...valid, dailyCounts: valid.dailyCounts.slice(1) },
    { ...valid, dailyCounts: valid.dailyCounts.map((day) => ({ ...day, count: -1 })) },
    { ...valid, dailyCounts: valid.dailyCounts.map((day) => ({ ...day, weekday: "Monday" })) },
    { ...valid, scope: { ...valid.scope, folder: "other" } },
    { ...valid, scope: { ...valid.scope, textQuery: "2026" } },
    { ...valid, temporalCoverage: { ...valid.temporalCoverage, complete: false } },
    { ...valid, temporalCoverage: { ...valid.temporalCoverage, endExclusive: "2026-11-01T00:00:00Z" } },
  ];
  for (const data of invalid) {
    const connector = create126MailConnector(async () => ({
      count: async () => data as MailCountResult,
      search: async () => { throw new Error("not used"); }, read: async () => { throw new Error("not used"); },
    }));
    const instance = await connector.connect({ connection: f.instance.connection, credentialProvider: f.context.credentialProvider });
    await assert.rejects(instance.execute("email.count", range, f.context), /incomplete, inconsistent or outside/);
  }
});

test("duplicate or invalid IMAP source identities cannot yield a complete count", async (t) => {
  for (const options of [{ uids: [1, 1] }, { uids: [0] }, { uids: [1.5] }, { uids: [0x1_0000_0000] }, { duplicatedMetadata: true }]) {
    const f = await fixture(t, [{ uid: 1, internalDate: "2026-11-01T03:00:00Z" }], options);
    await assert.rejects(f.execute("email.count", range), /duplicate or invalid UIDs|metadata is incomplete/);
    assert.equal(f.released(), 1);
  }
});

test("custom search cannot attest fabricated totals, complete pages or received-time scope", async (t) => {
  const f = await fixture(t, [{ uid: 1, internalDate: "2026-11-01T03:00:00Z" }]);
  const valid = await f.execute("email.search", range) as MailSearchResult;
  const invalid = [
    { ...valid, totalMatches: 2 }, { ...valid, returnedCount: 2 }, { ...valid, complete: false },
    { ...valid, totalMatchesExact: false }, { ...valid, nextOffset: 1 },
    { ...valid, scope: { ...valid.scope, timeZone: "UTC" } },
    { ...valid, messages: valid.messages.map((message) => ({ ...message, receivedAt: "2025-01-01T00:00:00Z" })) },
  ];
  for (const data of invalid) {
    const connector = create126MailConnector(async () => ({
      search: async () => data as MailSearchResult,
      count: async () => { throw new Error("not used"); }, read: async () => { throw new Error("not used"); },
    }));
    const instance = await connector.connect({ connection: f.instance.connection, credentialProvider: f.context.credentialProvider });
    await assert.rejects(instance.execute("email.search", range, f.context), /inconsistent pagination|outside the requested received-time/);
  }
});

test("text-restricted count evidence cannot silently describe all received mail", async (t) => {
  const f = await fixture(t, []);
  const result = await f.instance.execute("email.count", { ...range, query: "literal-text" }, f.context);
  const evidence = f.instance.mapEvidence(result, f.context)[0];
  assert.equal((evidence.sourceRefs[0].scope as Record<string, unknown>).textQuery, "literal-text");
  assert.ok(evidence.caveats.some((item) => item.includes("not all received mail")));
});
