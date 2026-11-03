import { localAccountId, type CloudAuthPort } from "../../src/auth/cloud-auth.ts";
export const fixturePrincipal = { userId: "test-user", tenantId: "test-tenant", email: "test@example.test" };
export const TEST_OWNER = localAccountId("https://accounts.example.test", fixturePrincipal);
/** Explicit test injection only. The CLI has no fake-login or development-identity fallback. */
export function fixtureAuth(): CloudAuthPort {
  return { issuer: "https://accounts.example.test",
    async authenticate() { return { token: "synthetic-test-token-".repeat(3), expiresAt: Date.now() + 3_600_000, principal: fixturePrincipal }; },
    async current() { return fixturePrincipal; }, async logout() {},
  };
}
