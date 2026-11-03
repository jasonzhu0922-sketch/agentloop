import { AccountServiceClient } from "./client.ts";
import { IdentityError } from "./service.ts";

/** Same authority for Router and Desktop when the account service is deployed separately. */
export class RemoteIdentityService {
  private readonly client: AccountServiceClient;
  // Router may call an account-service on a private container network. The
  // public Desktop client keeps the stricter HTTPS/loopback policy.
  constructor(baseUrl: string) { this.client = new AccountServiceClient(baseUrl, { allowInternalHttp: true }); }
  async ready(): Promise<void> { /* The remote service owns schema and availability. Never create a second user database. */ }
  private credentials(email: unknown, password: unknown): { email: string; password: string } {
    if (typeof email !== "string" || email.length > 254) throw new IdentityError(400, "invalid_email");
    if (typeof password !== "string" || password.length > 256) throw new IdentityError(400, "invalid_password");
    return { email, password };
  }
  async register(email: unknown, password: unknown) {
    const input = this.credentials(email, password); return this.client.authenticate("register", input.email, input.password);
  }
  async login(email: unknown, password: unknown) {
    const input = this.credentials(email, password); return this.client.authenticate("login", input.email, input.password);
  }
  private token(authorization: string | string[] | undefined): string {
    const match = (Array.isArray(authorization) ? authorization[0] : authorization)?.match(/^Bearer\s+([A-Za-z0-9_-]{32,512})$/i);
    if (!match) throw new IdentityError(401, "authentication_required");
    return match[1]!;
  }
  async authenticate(authorization: string | string[] | undefined) { return this.client.current(this.token(authorization)); }
  async revoke(authorization: string | string[] | undefined) { await this.client.logout(this.token(authorization)); }
}
