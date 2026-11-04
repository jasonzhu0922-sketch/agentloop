import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorInstance } from "../src/types.ts";
import { connectorOperationTools } from "../src/agentloop-adapter.ts";
import { resolveCapabilityRequirements } from "../../agentloop/src/planning/capability-requirements.ts";

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
  assert.deepEqual(tool.source?.aliases, [key, "fixture", connection]);
  assert.match(tool.description, new RegExp(operation.replaceAll(".", "\\.")));
});

test("normalization does not collide across different connector identities", () => {
  const base = project("provider", "connection-a", "read.one").name;
  assert.notEqual(project("provider", "connection_a", "read.one").name, base);
  assert.notEqual(project("provider", "connection-a", "read_one").name, base);
  assert.notEqual(project("provider-other", "connection-a", "read.one").name, base);
});

test("explicit Connector service and account names resolve only to an unambiguous authorized source", () => {
  const instance = (id: string, displayName: string): ConnectorInstance => ({
    definition: { manifest: { schema: "agentloop.connectorManifest/v1", key: "126-mail", version: "1.0.0",
      displayName: "126 邮箱", aliases: ["126mail", "126 邮箱"], description: "Mail", agentloopSdk: "*" }, capabilities: [] },
    connection: { id, connectorKey: "126-mail", displayName, ownerType: "user", ownerId: "owner", scopes: [], credentialRef: "fixture", status: "active" },
    operations: [{ id: "email.count", capabilityId: "email.count", mode: "read", inputSchema: { type: "object" }, executionMode: "parallel", replaySafe: true }],
    execute: async () => ({ operationId: "email.count", data: {} }), mapEvidence: () => [],
  });
  const tools = (item: ConnectorInstance) => connectorOperationTools(item, {
    runId: "run", actorUserId: "owner", connection: item.connection, credentialProvider: { get: async () => ({}) },
  });
  const first = tools(instance("first", "我的邮箱"));
  const both = [...first, ...tools(instance("second", "工作邮箱"))];
  const resolve = (reference: string, available = first) => resolveCapabilityRequirements([{ kind: "tool_source", reference }], [], available);
  for (const reference of ["126 邮箱", "126mail", "我的邮箱", "126-mail", "first"]) {
    assert.deepEqual(resolve(reference), { missing: [], skillIds: [], toolSourceIds: ["connector.126-mail.first"] });
  }
  assert.equal(first[0]!.source!.aliases!.filter((alias) => alias === "126 邮箱").length, 1);
  assert.deepEqual(resolve("126 邮箱", both).missing, [{ kind: "tool_source", reference: "126 邮箱" }]);
  assert.deepEqual(resolve("工作邮箱", both).toolSourceIds, ["connector.126-mail.second"]);
  assert.deepEqual(resolve("不存在的邮箱", both).missing, [{ kind: "tool_source", reference: "不存在的邮箱" }]);
});
