export interface WebSessionState {
  readonly authToken: string;
  readonly user: { readonly id: string; readonly email: string } | undefined;
  readonly localSessionToken: string;
  readonly localSessionExpiresAt: number;
  setUser(value: { readonly id: string; readonly email: string } | undefined): void;
  setLocalSession(token: string, expiresAt: number): void;
  clearLocalSession(): void;
  clearIdentity(): void;
}
export function createSessionState(input: {
  storage: Storage;
  authTokenKey: string;
  activeUserKey: string;
}): WebSessionState;
