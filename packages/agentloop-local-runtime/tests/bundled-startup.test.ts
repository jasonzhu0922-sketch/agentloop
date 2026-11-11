import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalRuntimeManager } from "@zhujun/agentloop-local-runtime";

test("the default bundled Skill catalog allows Runtime startup and model reads after reopen", async t => {
  const root = await mkdtemp(join(tmpdir(), "bundled-runtime-startup-"));
  t.after(async () => {
    // Runtime-owned Skill snapshots are intentionally immutable.
    const writable = async (path: string): Promise<void> => {
      await chmod(path, 0o700);
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory()) await writable(join(path, entry.name));
      }
    };
    await writable(root);
    await rm(root, { recursive: true, force: true });
  });
  // Use the shipped catalog: an empty test Skill directory hides invalid
  // bundled declarations that otherwise fail every Desktop account Runtime.
  const options = { dataDirectory: root, defaultRuntimeId: "desktop-default" };
  for (let attempt = 0; attempt < 2; attempt++) {
    const manager = await createLocalRuntimeManager(options);
    try {
      assert.equal((await manager.runtimes())[0]?.status, "ready");
      assert.deepEqual(await manager.runtime("desktop-default").models(), []);
    } finally {
      await manager.close();
    }
  }
});
