export const ADMIN_SESSION_TOKEN_KEY = "agentloop.admin.token";

export function clearAdminSession(storage: Pick<Storage, "removeItem">): void {
  storage.removeItem(ADMIN_SESSION_TOKEN_KEY);
}
