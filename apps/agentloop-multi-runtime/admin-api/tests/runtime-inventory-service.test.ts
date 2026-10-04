import assert from "node:assert/strict";
import test from "node:test";
import { RouterRuntimeInventoryService } from "../src/application/runtime-inventory-service.ts";

test("Router Runtime inventory adapter preserves the authoritative instance snapshot", async () => {
  let authorization: string | undefined;
  const service = new RouterRuntimeInventoryService({
    baseUrl: "http://router.test/",
    token: "router-secret",
    request: async (input, init) => {
      assert.equal(String(input), "http://router.test/v1/internal/admin/runtimes?page=1&pageSize=20");
      authorization = new Headers(init?.headers).get("authorization") ?? undefined;
      return new Response(JSON.stringify({ items: [{ id: "local-a", displayName: "本地 Runtime", profile: "artifact", kind: "local", deviceId: "device-a", scopeId: "tenant-a", status: "ready", capabilities: ["files"], maxConcurrentRuns: 2, activeRunCount: 1, queuedRunCount: 0, catalogVersion: "catalog-3", startedAt: 123, lastHeartbeatAt: 123 }], page: 1, pageSize: 20, total: 1, pageCount: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(await service.list({ page: 1, pageSize: 20 }), { items: [{ id: "local-a", displayName: "本地 Runtime", plane: "local", profile: "artifact", deviceId: "device-a", scopeId: "tenant-a", status: "ready", capabilities: ["files"], maxConcurrentRuns: 2, activeRunCount: 1, queuedRunCount: 0, catalogVersion: "catalog-3", startedAt: 123, lastHeartbeatAt: 123 }], page: 1, pageSize: 20, total: 1, pageCount: 1 });
  assert.equal(authorization, "Bearer router-secret");
});
