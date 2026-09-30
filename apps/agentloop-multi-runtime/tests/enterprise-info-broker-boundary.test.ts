import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { readSkillExecutionManifest } from "@zhujun/agentloop";

const execute = promisify(execFile);
const script = new URL("../custom-skills/enterprise-info/scripts/enterprise_info.py", import.meta.url).pathname;
const skillRoot = new URL("../custom-skills/enterprise-info/", import.meta.url).pathname;

test("enterprise-info script uses the broker result while retaining identity binding and HIL shaping", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentloop-enterprise-script-"));
  const socketPath = join(directory, "broker.sock");
  const server = createServer((socket) => {
    socket.resume();
    socket.once("end", () => {
      socket.end(JSON.stringify({ ok: true, result: { queries: [{ name: "Example Co", action: "search", result: { items: [
        { id: "one", name: "Example Co A", credit_no: "credit-a" }, { id: "two", name: "Example Co B", credit_no: "credit-b" },
      ] } }] } }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  try {
    const { stdout } = await execute("python3", [script, "--action", "search", "--name", "Example Co"], {
      env: { PATH: process.env.PATH ?? "", AGENTLOOP_INTEGRATION_BROKER_SOCKET: socketPath, AGENTLOOP_INTEGRATION_PERMIT: "permit-a" },
    });
    const result = JSON.parse(stdout) as { humanLoopRequirement?: { responseSchema?: { options?: unknown[] } }; evidenceReceipt?: { sourceRefs?: Array<{ uri?: string }> } };
    assert.equal(result.humanLoopRequirement?.responseSchema?.options?.length, 2);
    assert.deepEqual(result.evidenceReceipt?.sourceRefs, [{ uri: "integration://enterprise_info", title: "Example Co enterprise search" }]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    await rm(directory, { recursive: true, force: true });
  }
});

test("enterprise-info script fails closed without a broker permit and has no direct credential/configuration implementation", async () => {
  await assert.rejects(
    () => execute("python3", [script, "--action", "search", "--name", "Example Co"], { env: { PATH: process.env.PATH ?? "" } }),
    (error: unknown) => error !== null && typeof error === "object" && "stderr" in error && String((error as { stderr: unknown }).stderr).includes("integration_not_authorized"),
  );
  const source = await readFile(script, "utf8");
  assert.doesNotMatch(source, /ENTERPRISE_INFO_ENV_FILE|read_config|dotenv|client_secret|access_token|urllib|requests\./i);
  assert.match(source, /AGENTLOOP_INTEGRATION_BROKER_SOCKET/);
  const [entrypoint] = await readSkillExecutionManifest(skillRoot);
  assert.equal(entrypoint?.integration, "enterprise_info");
  assert.deepEqual(entrypoint?.actions.map((action) => action.id), ["search", "detail"]);
});
