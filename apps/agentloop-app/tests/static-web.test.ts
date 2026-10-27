import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentLoopServer } from "../src/http/server.ts";

test("packaged web assets are served with the API on one local origin", async () => {
  const webRoot = await mkdtemp(join(tmpdir(), "agentloop-web-test-"));
  await mkdir(join(webRoot, "assets"));
  await writeFile(join(webRoot, "index.html"), "<html>AgentLoop</html>");
  await writeFile(join(webRoot, "assets", "app.js"), "console.log('AgentLoop')");
  const server = createAgentLoopServer({} as Parameters<typeof createAgentLoopServer>[0], { webRoot });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), /AgentLoop/);

    const asset = await fetch(`${origin}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") ?? "", /javascript/);

    const api = await fetch(`${origin}/healthz`);
    assert.equal(api.status, 200);
    assert.deepEqual(await api.json(), { status: "ok" });

    const missing = await fetch(`${origin}/assets/missing.js`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(webRoot, { recursive: true, force: true });
  }
});
