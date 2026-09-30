import { createAdminApiServer } from "./bootstrap/server.ts";

const port = Number(process.env.ADMIN_API_PORT ?? "8792");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new TypeError("ADMIN_API_PORT must be a TCP port");

createAdminApiServer().listen(port, "127.0.0.1", () => {
  process.stdout.write(`AgentLoop Admin API scaffold listening on 127.0.0.1:${port}\n`);
});
