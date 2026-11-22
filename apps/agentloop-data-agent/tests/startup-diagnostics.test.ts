import assert from "node:assert/strict";
import test from "node:test";
import { describeStartupError } from "../src/startup-diagnostics.ts";
import { ActiveHostLeaseError } from "../src/tidb-state.ts";

test("startup diagnostics identifies a network permission boundary without exposing credentials", () => {
  const error = Object.assign(new Error("connect EPERM 10.251.40.47:6000"), {
    code: "EPERM", syscall: "connect", address: "10.251.40.47", port: 6000,
  });
  const message = describeStartupError(error, "mysql://root:secret@example.invalid:4000/runtime");
  assert.match(message, /EPERM/);
  assert.match(message, /10\.251\.40\.47:6000/);
  assert.doesNotMatch(message, /secret|example\.invalid/);
});

test("startup diagnostics distinguishes a refused TiDB listener", () => {
  const error = Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED", syscall: "connect",
  });
  assert.equal(
    describeStartupError(error, "mysql://root@example.invalid:6000/runtime"),
    "TiDB 拒绝连接（ECONNREFUSED）：example.invalid:6000。请确认 TiDB 正在监听该地址和端口。",
  );
});

test("startup diagnostics explains an active host lease in plain language", () => {
  const message = describeStartupError(new ActiveHostLeaseError(91_000, 1_000), "mysql://root:secret@example.invalid/runtime");
  assert.match(message, /另一个 data-agent 进程/);
  assert.match(message, /等待租约自动过期/);
  assert.doesNotMatch(message, /secret|example\.invalid/);
});

