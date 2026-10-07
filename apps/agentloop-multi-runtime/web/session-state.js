/**
 * Browser session authority shared by page orchestration and API clients.
 * It contains identity and Local Agent session credentials, but no DOM or
 * transport behavior.
 */
export function createSessionState({ storage, authTokenKey, activeUserKey }) {
  let user;
  let localToken = "";
  let localExpiresAt = 0;
  return {
    get authToken() { return storage.getItem(authTokenKey) || ""; },
    get user() { return user; },
    get localSessionToken() { return localToken; },
    get localSessionExpiresAt() { return localExpiresAt; },
    setUser(value) { user = value; },
    setLocalSession(token, expiresAt) { localToken = token; localExpiresAt = expiresAt; },
    clearLocalSession() { localToken = ""; localExpiresAt = 0; },
    clearIdentity() {
      user = undefined;
      localToken = "";
      localExpiresAt = 0;
      storage.removeItem(authTokenKey);
      storage.removeItem(activeUserKey);
    },
  };
}
