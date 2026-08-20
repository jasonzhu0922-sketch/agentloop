import { useState } from "react";
import { api } from "../lib/api";
import { useAgentLoop } from "../state/context";

export function AuthScreen(): React.ReactNode {
  const { actions } = useAgentLoop();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError("");
    try {
      const body = await (mode === "login" ? api.login(email, password) : api.register(email, password));
      actions.setToken(body.token);
      await actions.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    }
  };

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-brand">
          <div className="logo lg">A</div>
          <div>
            <strong>AgentLoop</strong>
            <small>可追踪的智能体工作台</small>
          </div>
        </div>
        <p className="auth-sub">登录后即可开始多轮对话。每次指令都会先制定计划、执行，并生成可核验的结果。</p>
        {error !== "" ? <p className="auth-error">{error}</p> : null}
        <form className="auth-form" onSubmit={(e) => void submit(e)}>
          <label className="field">
            邮箱
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              placeholder="you@example.com"
              required
            />
          </label>
          <label className="field">
            密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <div className="auth-actions">
            <button
              type="submit"
              className="btn primary"
              onClick={() => setMode("login")}
            >
              登录
            </button>
            <button
              type="submit"
              className="btn ghost"
              onClick={() => setMode("register")}
            >
              注册新账号
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
