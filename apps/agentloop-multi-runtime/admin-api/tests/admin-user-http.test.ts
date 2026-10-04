import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { AdminUser } from "../../control-plane/contracts/index.ts";
import { createAdminApiServer } from "../src/bootstrap/server.ts";
import type { AdminUserDirectoryPort } from "../src/application/admin-ports.ts";
import type { AdminAuthorizationPort, AdminPrincipal, WorkloadPrincipal } from "../src/authorization/ports.ts";

const user: AdminUser = { contractVersion: "control-plane/v1", userId: "admin-1", username: "ops", displayName: "Ops", role: "platform_admin", status: "active", revision: 1, createdAt: 1, updatedAt: 1 };

class Authorization implements AdminAuthorizationPort {
  public async adminPrincipal(value: string | undefined): Promise<AdminPrincipal | undefined> { return value === "Bearer admin" ? { actorId: "admin-actor", role: "platform_admin" } : undefined; }
  public async workloadPrincipal(_value: string | undefined): Promise<WorkloadPrincipal | undefined> { return undefined; }
}

test("Admin user routes authorize only Admin principals and never expose password material", async () => {
  const users: AdminUserDirectoryPort = {
    listAdminUsers: async () => [user],
    createAdminUser: async (input) => input.user,
    updateAdminUser: async () => user,
    transitionAdminUser: async () => user,
    setAdminUserPassword: async () => user,
  };
  const server = createAdminApiServer({ authorization: new Authorization(), users });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${baseUrl}/admin/v1/users`, { headers: { authorization: "Bearer runtime-user" } })).status, 403);
    const response = await fetch(`${baseUrl}/admin/v1/users`, { headers: { authorization: "Bearer admin" } });
    assert.deepEqual(await response.json(), { users: [user] });
    const created = await fetch(`${baseUrl}/admin/v1/users`, {
      method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json", "x-request-id": "admin-user-create" },
      body: JSON.stringify({ user: { ...user, userId: "admin-2", username: "new-ops" }, password: "a-secure-admin-password", expectedRevision: 0 }),
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json() as { passwordHash?: string }).passwordHash, undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
});
