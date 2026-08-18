import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { TuiApiClient, TuiApiError } from "../src/tui/api-client.ts";
import { parseSelection } from "../src/tui/selection.ts";

test("TUI API client uses the existing authenticated HTTP API and keeps the token in memory", async () => {
  const requests: Array<{ url?: string; authorization?: string; body: string }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    if (request.url === "/healthz") return send(response, 200, { status: "ok" });
    if (request.url === "/v1/auth/login") {
      return send(response, 200, { user: { id: "user-1", email: "owner@example.com" }, token: "session-token", expiresAt: 1 });
    }
    if (request.url === "/v1/agents") return send(response, 200, { agents: [] });
    return send(response, 404, { error: { code: "NOT_FOUND", message: "Route", traceId: "trace-1" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const client = new TuiApiClient(`http://127.0.0.1:${address.port}`);
  try {
    await client.health();
    const result = await client.login("owner@example.com", "correct horse battery staple");
    assert.equal(result.user.email, "owner@example.com");
    assert.equal(client.authenticated, true);
    await client.agents();
    assert.deepEqual(JSON.parse(requests[1].body), { email: "owner@example.com", password: "correct horse battery staple" });
    assert.equal(requests[2].authorization, "Bearer session-token");
    client.clearToken();
    assert.equal(client.authenticated, false);
    await assert.rejects(
      () => client.agents(),
      (error: unknown) => error instanceof TuiApiError && error.status === 401,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("TUI selection parsing preserves user order, removes duplicates, and rejects invalid choices", () => {
  assert.deepEqual(parseSelection("3, 1, 3", ["one", "two", "three"]), ["three", "one"]);
  assert.deepEqual(parseSelection("", ["one"]), []);
  assert.throws(() => parseSelection("0", ["one"]), /1 到 1/);
});

function send(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}
