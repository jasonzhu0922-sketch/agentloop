import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeIntegrationDeliveryClient } from "../src/runtime-host/application/integrations/integration-delivery-client.ts";

test("RuntimeIntegrationDeliveryClient loads under Node strip-only TypeScript and preserves delivery requests", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const client = new RuntimeIntegrationDeliveryClient({
    deliveryUrl: "https://control-plane.example/",
    workloadToken: "workload-token",
    request: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ contractVersion: "control-plane/v1", grantId: "grant-a" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const request = {
    contractVersion: "control-plane/v1",
    invocationId: "invocation-a",
    runId: "run-a",
    integration: "enterprise_info",
    action: "search",
    bindingId: "binding-a",
    releaseId: "release-a",
    contentHash: "a".repeat(64),
    skillNames: ["enterprise-info"],
    requestedAt: 1_000,
  } as const;
  await client.requestGrant(request);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://control-plane.example/delivery/v1/credential-grants");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.deepEqual(calls[0]?.init?.headers, { authorization: "Bearer workload-token", "content-type": "application/json" });
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { request });
});
