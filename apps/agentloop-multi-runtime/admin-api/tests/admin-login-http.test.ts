import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createAdminApiServer } from "../src/bootstrap/server.ts";
import { hashAdminPassword, PasswordAuthorization } from "../src/authorization/password-authorization.ts";

test("Admin HTTP exposes username/password login without exposing password material", async () => {
  const server = createAdminApiServer({ authorization: new PasswordAuthorization({ username: "ops", passwordHash: hashAdminPassword("a-secure-local-password"), actorId: "ops-1", role: "operator" }) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
  try {
    const invalid = await fetch(`${baseUrl}/admin/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "ops", password: "wrong" }) });
    assert.equal(invalid.status, 401);
    const valid = await fetch(`${baseUrl}/admin/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "ops", password: "a-secure-local-password" }) });
    assert.equal(valid.status, 200);
    const body = await valid.json() as { accessToken: string; expiresAt: number; password?: string };
    assert.match(body.accessToken, /^adm_/);
    assert.equal(typeof body.expiresAt, "number");
    assert.equal(body.password, undefined);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
