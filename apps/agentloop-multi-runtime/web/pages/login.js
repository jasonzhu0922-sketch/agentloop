const api = String(globalThis.AGENTLOOP_ROUTER_URL || "/api").replace(/\/+$/, "");
const AUTH_TOKEN_KEY = "agentloop.multi-runtime.auth-token.v1";
const ACTIVE_USER_KEY = "agentloop.multi-runtime.active-user.v1";
const $ = (id) => document.getElementById(id);
const registering = location.pathname === "/register";

configureMode(registering);
$("auth-form").addEventListener("submit", (event) => { event.preventDefault(); void authenticate(); });

function configureMode(isRegistering) {
  document.title = isRegistering ? "创建 AgentLoop 账号" : "登录 AgentLoop";
  $("auth-form").dataset.mode = isRegistering ? "register" : "login";
  $("auth-title").textContent = isRegistering ? "创建账号" : "欢迎回来";
  $("auth-subtitle").textContent = isRegistering ? "创建后会自动建立你的个人工作区。" : "登录后继续使用你的工作区。";
  $("auth-submit").textContent = isRegistering ? "创建账号" : "登录";
  $("auth-switch-copy").textContent = isRegistering ? "已有账号？" : "还没有账号？";
  $("auth-mode-toggle").textContent = isRegistering ? "登录" : "创建账号";
  $("auth-mode-toggle").href = isRegistering ? "/login" : "/register";
  $("auth-password").autocomplete = isRegistering ? "new-password" : "current-password";
}

async function authenticate() {
  const mode = $("auth-form").dataset.mode;
  const error = $("auth-error");
  const submit = $("auth-submit");
  error.hidden = true;
  submit.disabled = true;
  try {
    const response = await fetch(`${api}/v1/auth/${mode}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: $("auth-email").value.trim(), password: $("auth-password").value }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.token !== "string" || typeof body.user?.id !== "string") {
      throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
    }
    sessionStorage.setItem(AUTH_TOKEN_KEY, body.token);
    sessionStorage.setItem(ACTIVE_USER_KEY, body.user.id);
    location.replace(safeNextLocation());
  } catch (cause) {
    error.textContent = `无法${mode === "register" ? "创建账号" : "登录"}：${cause instanceof Error ? cause.message : String(cause)}`;
    error.hidden = false;
  } finally {
    submit.disabled = false;
  }
}

function safeNextLocation() {
  const next = new URLSearchParams(location.search).get("next");
  return next !== null && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}
