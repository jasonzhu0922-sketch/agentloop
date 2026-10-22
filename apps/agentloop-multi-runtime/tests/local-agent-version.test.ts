import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";

test("bundled Agent reports the package version overridden for the installer", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-release-version-"));
  try {
    const directory = join(root, "local-agent-runtime/src/config");
    await mkdir(directory, { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "9.8.7" }));
    const source = await readFile(new URL("../local-agent-runtime/src/config/local-agent-version.ts", import.meta.url), "utf8");
    const entry = join(directory, "version.ts");
    await writeFile(entry, source + "\nconsole.log(LOCAL_AGENT_VERSION);\n");
    for (const format of ["esm", "cjs"] as const) {
      const outfile = join(root, format === "esm" ? "agent.mjs" : "agent.cjs");
      await build({ entryPoints: [entry], bundle: true, platform: "node", format, outfile });
      assert.equal(execFileSync(process.execPath, [outfile], { encoding: "utf8" }).trim(), "9.8.7");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
