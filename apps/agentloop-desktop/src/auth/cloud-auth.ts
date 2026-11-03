import { AccountServiceClient, IdentityError } from "@zhujun/agentloop-identity";
import { HttpError } from "../security/loopback.ts";
export { localAccountId, type CloudAuthPort, type CloudPrincipal, type CloudSession } from "@zhujun/agentloop-identity";

/** Translate only public identity errors; never expose raw network/provider messages. */
export class CloudAccountAuth extends AccountServiceClient {
  private async translated<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (error instanceof IdentityError) throw new HttpError(error.status, error.code);
      throw new HttpError(503, "cloud_auth_unavailable");
    }
  }
  override authenticate(mode: "login" | "register", email: string, password: string) { return this.translated(() => super.authenticate(mode, email, password)); }
  override current(token: string) { return this.translated(() => super.current(token)); }
  override logout(token: string) { return this.translated(() => super.logout(token)); }
}
