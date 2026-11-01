import assert from "node:assert/strict";
import test from "node:test";
import { connectorOperationTools } from "../src/agentloop-adapter.ts";
import type { CanonicalConnectorEvidence, ConnectorInstance } from "../src/types.ts";
import { runtimeEvidenceKindArrays, runtimeEvidenceRecordsFromToolResult } from "../../agentloop/src/runtime/tool-result-evidence.ts";

function fixture(evidencePatch: Partial<CanonicalConnectorEvidence> = {}, fail = false) {
  const evidence: CanonicalConnectorEvidence = {
    schema: "agentloop.connectorEvidence/v1", evidenceId: "receipt", connectorKey: "arbitrary-source",
    connectionId: "connection", operationId: "inspect", sourceRefs: [{ receiptId: "receipt" }],
    facts: [{ kind: "record_counts", totalRecords: 123 }], evidenceKinds: ["record_counts", "explicit_caveats"],
    retrievedAt: 123, caveats: ["One declared collection only"], ...evidencePatch,
  };
  const instance: ConnectorInstance = {
    definition: {
      manifest: { schema: "agentloop.connectorManifest/v1", key: "arbitrary-source", version: "1.0.0", displayName: "fixture", description: "fixture", agentloopSdk: "*" },
      capabilities: [{ id: "records.inspect", category: "source", label: "Inspect", description: "Inspect records", producesEvidenceKinds: ["record_counts", "explicit_caveats"], risk: "low", replaySafe: true }],
    },
    connection: { id: "connection", connectorKey: "arbitrary-source", ownerType: "user", ownerId: "owner", scopes: [], credentialRef: "fixture", status: "active" },
    operations: [{ id: "inspect", capabilityId: "records.inspect", mode: "read", inputSchema: { type: "object" }, executionMode: "parallel", replaySafe: true }],
    execute: async () => { if (fail) throw new Error("source failed"); return { operationId: "inspect", data: { count: 123 } }; },
    mapEvidence: () => [evidence],
  };
  const tool = connectorOperationTools(instance, { runId: "run", actorUserId: "owner", connection: instance.connection, credentialProvider: { get: async () => ({}) } })[0]!;
  // The adapter does not use the tool grant: its credential/context binding is
  // supplied by the Connector runtime, just as in production.
  const execute = () => tool.execute({} as never, {});
  return { execute, instance, evidence };
}

test("Connector facts cross the same normal Runtime receipt boundary as MCP", async () => {
  const { execute, evidence } = fixture();
  const result = await execute() as { data: unknown; evidence: unknown; evidenceReceipt: Record<string, unknown> };
  assert.deepEqual(result.data, { count: 123 });
  assert.deepEqual(result.evidence, [evidence], "retain the original canonical audit evidence");
  assert.equal(result.evidenceReceipt.sourceType, "connector");
  const receipts = runtimeEvidenceRecordsFromToolResult(JSON.stringify(result));
  const receipt = receipts.find((item) => item.schema === "agentloop.toolEvidenceReceipt/v1");
  assert.ok(receipt, "the existing Runtime reader must observe the receipt without kernel changes");
  assert.deepEqual(receipt.facts, evidence.facts);
  assert.deepEqual(runtimeEvidenceKindArrays(receipt).satisfied, ["record_counts", "source_urls"]);
  assert.deepEqual(runtimeEvidenceKindArrays(receipt).caveated, ["explicit_caveats"]);
});

test("receipt cannot promote undeclared evidence or declaration-only facts", async () => {
  const extra = fixture({ evidenceKinds: ["record_counts", "structured_extraction_artifact", "artifact_path"] });
  const result = await extra.execute() as { evidenceReceipt: { evidenceKinds: { satisfied: string[] } } };
  assert.deepEqual(result.evidenceReceipt.evidenceKinds.satisfied, ["record_counts"]);
  const empty = await fixture({ facts: [] }).execute() as typeof result;
  assert.deepEqual(empty.evidenceReceipt.evidenceKinds.satisfied, []);
});

for (const patch of [{ connectorKey: "other" }, { connectionId: "other" }, { operationId: "other" }]) {
  test(`mismatched Connector evidence is rejected (${Object.keys(patch)[0]})`, async () => {
    await assert.rejects(fixture(patch).execute(), /does not match/);
  });
}

test("source failure cannot produce a successful receipt", async () => {
  await assert.rejects(fixture({}, true).execute(), /source failed/);
});
