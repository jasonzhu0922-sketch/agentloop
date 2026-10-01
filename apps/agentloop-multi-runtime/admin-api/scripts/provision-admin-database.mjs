import { TiDbConnection } from "@zhujun/agentloop";

const serverUrl = process.env.AGENTLOOP_ADMIN_SERVER_URL;
const databaseName = process.env.AGENTLOOP_ADMIN_DATABASE_NAME ?? "agentloop_admin";
if (serverUrl === undefined || !serverUrl.startsWith("mysql://")) throw new Error("AGENTLOOP_ADMIN_SERVER_URL must be an explicit TiDB mysql:// server URL without a database path");
if (new URL(serverUrl).pathname.replace(/^\/+|\/+$/g, "") !== "") throw new Error("AGENTLOOP_ADMIN_SERVER_URL must not include a database name");
if (!/^[_a-zA-Z][_a-zA-Z0-9]{0,63}$/.test(databaseName)) throw new Error("AGENTLOOP_ADMIN_DATABASE_NAME must be a simple TiDB database identifier");

if (!process.argv.includes("--apply")) {
  process.stdout.write(`${JSON.stringify({ mode: "dry_run", databaseName })}\n`);
  process.exitCode = 2;
} else {
  const server = await TiDbConnection.create(serverUrl);
  try {
    await server.prepare(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\``).run();
    process.stdout.write(`${JSON.stringify({ mode: "applied", databaseName })}\n`);
  } finally {
    await server.close();
  }
}
