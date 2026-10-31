import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { localConnectorCatalog } from "../local-agent-runtime/src/service/local-connector-catalog.ts";

test("Local Agent exposes named first-party Connector presets instead of asking users for module paths", () => {
  const catalog = localConnectorCatalog("/workspace/apps/agentloop-multi-runtime");
  assert.deepEqual(catalog.map((item) => item.displayName), ["飞书", "126 邮箱", "金山文档"]);
  const mail = catalog.find((item) => item.key === "126-mail");
  assert.deepEqual(mail?.binding.fields.map((field) => field.key), ["email", "authorizationCode"]);
  assert.equal(mail?.template.exportName, "createConfigured126MailConnector");
  assert.equal(mail?.template.modulePath.endsWith("/packages/connector-126-mail/src/index.ts"), true);
  assert.match(mail?.setupHint ?? "", /客户端授权码/);
  const wps = catalog.find((item) => item.key === "kingsoft-wps");
  assert.equal(wps?.binding.kind, "oauth");
  assert.deepEqual(wps?.binding.fields, []);
  assert.equal(wps?.template.config.endpoint, undefined);
});

test("packaged Local Agent catalog resolves the Connector bundle shipped with the Agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-connector-catalog-"));
  try {
    await mkdir(join(root, "connectors"));
    await writeFile(join(root, "connectors", "feishu.mjs"), "export {};\n");
    const catalog = localConnectorCatalog(root);
    assert.equal(catalog[0]?.template.modulePath, join(root, "connectors", "feishu.mjs"));
  } finally {
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});
