import { once } from "node:events";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteConnection } from "@zhujun/agentloop";
import { IdentityService } from "@zhujun/agentloop-identity";
import { createAccountServer } from "../../../agentloop-account-service/src/server.ts";
import { CloudAccountAuth } from "../../src/auth/cloud-auth.ts";
import { startDesktop } from "../../src/application.ts";
import { modelPort } from "../../../../packages/agentloop-local-runtime/tests/fixtures/models.ts";

// Manual QA: real account hashing/session service and real Kernel, deterministic
// model, entirely temporary databases. Never load user data or real credentials.
const root = await mkdtemp(join(tmpdir(), "desktop-account-preview-"));
const skills = join(root, "skills"); await mkdir(skills);
const database = new SqliteConnection(join(root, "accounts.db"));
const identity = new IdentityService(database); await identity.ready();
const cloud = createAccountServer(identity); cloud.listen(0, "127.0.0.1"); await once(cloud, "listening");
const address = cloud.address(); if (!address || typeof address === "string") throw new Error("fixture_bind_failed");
const app = await startDesktop({ mode: "development", dataDirectory: join(root, "desktop"), models: modelPort(),
  cloudAuth: new CloudAccountAuth(`http://127.0.0.1:${address.port}`), bundledSkillDirectories: [skills], openBrowser: false });
console.log(JSON.stringify({ fixture: true, origin: app.origin, accountOrigin: `http://127.0.0.1:${address.port}` }));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  void (async () => { if (!app.existing) await app.close(); await new Promise<void>(resolve => { cloud.close(() => resolve()); cloud.closeAllConnections(); }); await database.close(); })()
    .catch(() => console.error("fixture_shutdown_refused"));
});
