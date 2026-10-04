export interface AdminLoginPageState {
  readonly username?: string;
  readonly error?: string;
}

/** The unauthenticated Admin Web surface is a page, not a state inside the app shell. */
export function renderAdminLoginPage(state: AdminLoginPageState = {}): string {
  const username = escape(state.username ?? "");
  const error = state.error === undefined ? "" : `<p class="auth-error">${escape(state.error)}</p>`;
  return `<main class="auth-shell"><section class="auth-card"><div class="auth-brand"><div class="logo lg">A</div><div><strong>AgentLoop</strong><small>管理控制面</small></div></div><p class="auth-sub">登录后进入独立管理端，管理配置发布、Runtime 运维与审计记录。</p>${error}<form id="login-form" class="auth-form"><label class="field">用户名<input name="username" value="${username}" autocomplete="username" required placeholder="例如 admin"></label><label class="field">密码<input name="password" type="password" autocomplete="current-password" required placeholder="输入管理端密码"></label><div class="auth-actions"><button class="btn primary" type="submit">登录管理端</button></div></form></section></main>`;
}

function escape(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}
