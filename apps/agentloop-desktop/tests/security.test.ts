import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { DevelopmentSessions } from "../src/security/loopback.ts";
import { loopbackOrigin } from "../src/platform/instance-lock.ts";

test("development Sessions expire, reject duplicate cookies and bound live sessions", () => {
  let now = 0; const sessions = new DevelopmentSessions(() => now);
  const req = (headers: Record<string, string> = {}) => ({ headers }) as IncomingMessage;
  const response = { setHeader() {} } as unknown as ServerResponse;
  const first = sessions.issue(req(), response);
  const cookie = `${sessions.cookieName}=${first.token}`;
  assert.equal(sessions.issue(req({ cookie }), response), first);
  assert.equal(sessions.require(req({ cookie, "x-desktop-csrf": first.csrf }), true), first);
  assert.throws(() => sessions.require(req({ cookie: `${cookie}; ${cookie}` }), false), /session_required/);
  for (let index = 1; index < 32; index++) sessions.issue(req(), response);
  assert.throws(() => sessions.issue(req(), response), /session_limit/);
  now = first.expiresAt;
  assert.throws(() => sessions.require(req({ cookie }), false), /session_required/);
  assert.notEqual(sessions.issue(req(), response).token, first.token);
  sessions.clear(); assert.throws(() => sessions.require(req({ cookie }), false), /session_required/);
});

test("instance discovery accepts only canonical plain IPv4 loopback origins", () => {
  assert.equal(loopbackOrigin("http://127.0.0.1:12345"), "http://127.0.0.1:12345");
  for (const origin of ["https://example.test", "http://localhost:12345", "http://127.0.0.1:12345/", "http://user:pass@127.0.0.1:12345", "http://127.0.0.1:12345?token=secret", "http://127.0.0.1:12345/#secret", "http://0.0.0.0:12345"]) assert.throws(() => loopbackOrigin(origin));
});
