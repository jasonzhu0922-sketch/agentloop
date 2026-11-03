import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SqliteConnection } from "@zhujun/agentloop";
import { IdentityService } from "@zhujun/agentloop-identity";
import { createAccountServer } from "./server.ts";

async function main() {
  const host = process.env.ACCOUNT_SERVICE_HOST ?? "127.0.0.1";
  const port = Number(process.env.ACCOUNT_SERVICE_PORT ?? "8795");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("account_port_invalid");
  const path = resolve(process.env.ACCOUNT_SERVICE_DATABASE_PATH ?? "data/accounts.db");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const database = new SqliteConnection(path);
  const identity = new IdentityService(database);
  try { await identity.ready(); } catch (error) { await database.close(); throw error; }
  const server = createAccountServer(identity);
  try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => { server.off("error", reject); resolve(); }); }); }
  catch (error) { await database.close(); throw error; }
  console.log(`AgentLoop Account Service listening on port ${port}; use an HTTPS ingress for remote clients.`);
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
    if (closing) return; closing = true;
    server.close(() => { void database.close().catch(() => { process.exitCode = 1; }); }); server.closeIdleConnections();
  });
}
if (import.meta.main) void main().catch(() => { console.error("Account service startup failed; check port and account database configuration."); process.exitCode = 1; });
