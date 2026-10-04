import assert from "node:assert/strict";
import test from "node:test";
import { renderAdminLoginPage } from "../src/app/login-page.ts";

test("Admin Web unauthenticated state is a standalone user-style login page", () => {
  const html = renderAdminLoginPage({ username: "admin", error: "登录失败" });
  assert.match(html, /class="auth-shell"/);
  assert.match(html, /class="auth-card"/);
  assert.match(html, /id="login-form"/);
  assert.match(html, /name="username"/);
  assert.match(html, /name="password"/);
  assert.match(html, /登录失败/);
  assert.doesNotMatch(html, /admin-shell|sidebar|scopeId|settings-form/);
});
