import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorInstance } from "../src/types.ts";
import { connectorOperationTools } from "../src/agentloop-adapter.ts";

function project(key: string, connectionId: string, operationId: string) {
  const instance: ConnectorInstance = {
    definition: { manifest: { schema: "agentloop.connectorManifest/v1", key, version: "1.0.0", displayName: "fixture", description: "fixture", agentloopSdk: "*" }, capabilities: [] },
    connection: { id: connectionId, connectorKey: key, ownerType: "user", ownerId: "owner", scopes: [], credentialRef: "fixture", status: "active" },
    operations: [{ id: operationId, capabilityId: "fixture.inspect", mode: "read", inputSchema: { type: "object" }, executionMode: "parallel", replaySafe: true }],
    execute: async () => ({ operationId, data: {} }), mapEvidence: () => [],
  };
  return connectorOperationTools(instance, { runId: "run", actorUserId: "owner", connection: instance.connection, credentialProvider: { get: async () => ({}) } })[0]!;
}

test("Connector wire names are bounded, deterministic and retain complete source identity", () => {
  const key = "long-provider-".repeat(8);
  const connection = "local_connection_local_connector_2ad239a2-94bf-4dc8-9bc8-f22f5fde5c4e";
  const operation = "documents.very-long-operation-".repeat(5);
  const tool = project(key, connection, operation);
  assert.match(tool.name, /^[A-Za-z0-9_]{1,64}$/);
  assert.equal(project(key, connection, operation).name, tool.name);
  assert.notEqual(project(key, `${connection}-other`, operation).name, tool.name);
  assert.notEqual(project(key, connection, `${operation}-other`).name, tool.name);
  assert.deepEqual(tool.source?.aliases, [key, connection]);
  assert.match(tool.description, new RegExp(operation.replaceAll(".", "\\.")));
});

test("normalization does not collide across different connector identities", () => {
  const base = project("provider", "connection-a", "read.one").name;
  assert.notEqual(project("provider", "connection_a", "read.one").name, base);
  assert.notEqual(project("provider", "connection-a", "read_one").name, base);
  assert.notEqual(project("provider-other", "connection-a", "read.one").name, base);
});
