import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import test from "node:test";
import { createDevRuntimeControl } from "../web/dev-runtime-control.mjs";

function response() {
  return {
    headersSent: false,
    status: 0,
    body: undefined as any,
    writeHead(status: number) { this.status = status; this.headersSent = true; },
    end(value: Buffer | string) { this.body = JSON.parse(String(value)); },
  };
}

async function call(control: any, method: string, path: string, token: string, payload?: unknown) {
  const request = new PassThrough() as any;
  request.method = method;
  request.headers = { authorization: `Bearer ${token}` };
  const result = response();
  const pending = control.handle(request, result, path);
  request.end(payload === undefined ? undefined : JSON.stringify(payload));
  await pending;
  return result;
}

test("development cloud Skill control validates and persists a ZIP without invoking production operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-dev-control-"));
  const token = "development-token";
  try {
    const control = createDevRuntimeControl({ root, token });
    const archive = new JSZip();
    archive.file("custom-skills/demo/SKILL.md", "---\ndescription: Demo\n---\n# Demo\n");
    archive.file("custom-skills/demo/run.js", "console.log('demo')\n");
    archive.file("__MACOSX/._demo", "Finder metadata");
    archive.file("__MACOSX/demo/._SKILL.md", "Finder metadata");
    archive.file(".DS_Store", "Finder metadata");
    const bytes = await archive.generateAsync({ type: "nodebuffer" });
    assert.equal((await call(control, "GET", "/skill-configuration", token)).body.skills.length, 0);
    const started = await call(control, "POST", "/skill-configuration", token, { archiveName: "demo.zip", archiveBase64: bytes.toString("base64") });
    assert.equal(started.status, 202);
    await new Promise(resolve => setTimeout(resolve, 30));
    const done = await call(control, "GET", "/runtime-reload", token);
    assert.equal(done.body.status, "succeeded");
    assert.equal(done.body.skills[0].name, "demo");
    assert.match(await readFile(join(root, "active", "demo", "SKILL.md"), "utf8"), /Demo/);
    const removeStarted = await call(control, "DELETE", "/skill-configuration", token, { skillName: "demo" });
    assert.equal(removeStarted.status, 202);
    await new Promise(resolve => setTimeout(resolve, 30));
    const removeDone = await call(control, "GET", "/runtime-reload", token);
    assert.equal(removeDone.body.status, "succeeded");
    assert.deepEqual(removeDone.body.skills, []);

    const secret = new JSZip();
    secret.file("demo/SKILL.md", "# Demo\n");
    secret.file("demo/.env", "SECRET=should-not-upload\n");
    const secretBytes = await secret.generateAsync({ type: "nodebuffer" });
    const rejected = await call(control, "POST", "/skill-configuration", token, { archiveName: "secret.zip", archiveBase64: secretBytes.toString("base64") });
    assert.equal(rejected.status, 202);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await call(control, "GET", "/runtime-reload", token)).body.phase, "invalid_configuration");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("development cloud model control persists the applied catalog for the next Runtime restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-dev-model-control-"));
  const configurationPath = join(root, "config", "llm-providers.json");
  const original = { defaultModelKey: "old-model", providers: { provider: { defaultModel: "old-model" } }, models: { "old-model": { providerKey: "provider", providerModel: "old-model" } } };
  await mkdir(dirname(configurationPath), { recursive: true });
  await writeFile(configurationPath, `${JSON.stringify(original)}\n`);
  try {
    const control = createDevRuntimeControl({ root: join(root, "control"), configurationPath, token: "development-token" });
    const next = { defaultModelKey: "new-model", providers: { provider: { defaultModel: "new-model" } }, models: { "new-model": { providerKey: "provider", providerModel: "new-model", displayName: "New model" } } };
    const started = await call(control, "POST", "/model-configuration", "development-token", { configuration: next, credentialUpdates: {} });
    assert.equal(started.status, 202);
    assert.deepEqual(JSON.parse(await readFile(configurationPath, "utf8")), next);

    const restartedControl = createDevRuntimeControl({ root: join(root, "control"), configurationPath, token: "development-token" });
    const loaded = await call(restartedControl, "GET", "/model-configuration", "development-token");
    assert.deepEqual(loaded.body.configuration.models, next.models);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
