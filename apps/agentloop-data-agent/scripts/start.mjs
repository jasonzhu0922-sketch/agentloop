import { createConnection } from "node:net";
import { spawn } from "node:child_process";

const port = Number(process.env.DATA_AGENT_PORT ?? "8810");

function localPortState(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) return Promise.resolve(undefined);
  return new Promise(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port: value });
    const timer = setTimeout(() => { socket.destroy(); resolve(undefined); }, 500);
    const finish = state => { clearTimeout(timer); socket.destroy(); resolve(state); };
    socket.once("connect", () => finish("occupied"));
    socket.once("error", error => finish(error?.code === "EACCES" || error?.code === "EPERM" ? undefined : "free"));
  });
}

const state = await localPortState(port);
if (state === "occupied") {
  console.error(`经营问数服务已占用本机端口 127.0.0.1:${port}。请先停止已有 data-agent 进程，或设置 DATA_AGENT_PORT 后重试。`);
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, ["--env-file-if-exists=.env", "src/main.ts", ...process.argv.slice(2)], {
    cwd: process.cwd(), env: process.env, stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
  child.once("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143); });
}
