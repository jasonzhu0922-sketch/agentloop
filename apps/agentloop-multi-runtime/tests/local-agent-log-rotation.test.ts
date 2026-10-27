import assert from "node:assert/strict";
import { readFile, readdir, rm, stat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { LOG_ROTATION_BYTES, RotatingLogWritable, runRotatingLogLauncher } from "../distribution/rotating-log-launcher.mjs";

test("Local Agent log sinks split large writes at the configured byte limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-log-rotation-"));
  try {
    const path = join(root, "agent.out.log");
    await new Promise<void>((resolve, reject) => {
      const sink = new RotatingLogWritable(path, 10);
      sink.once("finish", resolve);
      sink.once("error", reject);
      Readable.from([Buffer.from("0123456789ABCDEFGHIJKLMNOP")]).pipe(sink);
    });
    assert.equal((await stat(path)).size, 6);
    assert.equal(await readFile(`${path}.1`, "utf8"), "0123456789");
    assert.equal(await readFile(`${path}.2`, "utf8"), "ABCDEFGHIJ");
    assert.ok((await readdir(root)).every((name) => name === "agent.out.log" || /^agent\.out\.log\.\d+$/.test(name)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Local Agent launcher rotates stdout and stderr independently at 20 MiB", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-log-launcher-"));
  try {
    const result = await runRotatingLogLauncher({
      command: [process.execPath],
      args: ["--input-type=module", "-e", "process.stdout.write('o'.repeat(25)); process.stderr.write('e'.repeat(25));"],
      logRoot: root,
      maxBytes: 10,
    });
    assert.equal(result.code, 0);
    assert.equal(LOG_ROTATION_BYTES, 20 * 1024 * 1024);
    assert.equal((await stat(join(root, "agent.out.log"))).size, 5);
    assert.equal((await stat(join(root, "agent.err.log"))).size, 5);
    assert.equal((await stat(join(root, "agent.out.log.1"))).size, 10);
    assert.equal((await stat(join(root, "agent.out.log.2"))).size, 10);
    assert.equal((await stat(join(root, "agent.err.log.1"))).size, 10);
    assert.equal((await stat(join(root, "agent.err.log.2"))).size, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
