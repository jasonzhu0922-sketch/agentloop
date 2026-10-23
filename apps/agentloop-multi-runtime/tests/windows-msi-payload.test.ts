import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { windowsMsiPayload } from "../scripts/windows-msi-payload.mjs";

test("MSI payload includes tray dependencies, Resources, and root assets with stable upgrade identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-msi-payload-"));
  try {
    const files = ["AgentLoop Local Runtime.exe", "tray-native.dll", "Resources/agent.exe", "assets/template & icon.png"];
    const identities = [];
    for (const version of ["old", "new"]) {
      const payload = join(root, version);
      for (const file of files) {
        const target = join(payload, file);
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, version);
      }
      const source = await windowsMsiPayload(payload);
      const mappings = [...source.matchAll(/<File Id="([^"]+)" Source="([^"]+)" KeyPath="yes"/g)];
      assert.equal(mappings.length, files.length);
      assert.ok(mappings.some(([, id, path]) => id === "TrayExecutable" && path!.endsWith("AgentLoop Local Runtime.exe")));
      for (const file of files) assert.ok(source.includes(join(payload, file).replaceAll("&", "&amp;")), file);
      const components = [...source.matchAll(/<Component Id="([^"]+)" Guid="\*"/g)].map(([, id]) => id);
      assert.equal(new Set(components).size, files.length);
      identities.push(components);
    }
    assert.deepEqual(identities[0], identities[1], "build location and version must not change component identities");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
