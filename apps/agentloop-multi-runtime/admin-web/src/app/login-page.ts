export interface AdminLoginPageState {
  readonly username?: string;
  readonly error?: string;
}

/** The unauthenticated Admin Web surface is a page, not a state inside the app shell. */
export function renderAdminLoginPage(state: AdminLoginPageState = {}): string {
  const username = escape(state.username ?? "");
  const error = state.error === undefined ? "" : `<p class="auth-error">${escape(state.error)}</p>`;
  return `<main class="auth-shell"><div class="auth-page"><section class="auth-intro" aria-label="AgentLoop 管理端说明"><div class="auth-brand"><div class="logo lg">A</div><strong>AgentLoop</strong></div><div class="auth-intro-copy"><p class="auth-eyebrow">ADMIN CONTROL PLANE</p><h1>统一管理<br>云边运行时</h1><p>集中维护模型配置、Runtime 运维与审计记录，让每一次变更都清晰可追溯。</p></div></section><section class="auth-card-wrap"><section class="auth-card"><form id="login-form" class="auth-form"><div class="auth-heading"><h2>欢迎回来</h2><p class="auth-sub">登录后进入独立管理端。</p></div>${error}<label class="field">用户名<input name="username" value="${username}" autocomplete="username" required placeholder="例如 admin"></label><label class="field">密码<input name="password" type="password" autocomplete="current-password" required placeholder="输入管理端密码"></label><div class="auth-actions"><button class="btn primary" type="submit">登录管理端</button></div></form></section></section></div></main>`;
}

function escape(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}
