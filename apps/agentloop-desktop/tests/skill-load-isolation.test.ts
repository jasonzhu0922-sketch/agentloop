import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { removeSkillPackage } from "@zhujun/agentloop";
import { startDesktop } from "../src/application.ts";
import { fixtureAuth } from "./fixtures/auth.ts";

test("Desktop login and model reads remain available with a malformed bundled Skill", async t => {
  const root = await mkdtemp(join(tmpdir(), "desktop-skill-isolation-"));
  const skill = join(root, "skills", "broken"); await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: broken\ndescription: A broken Skill\n---\n\nInstructions.\n");
  await writeFile(join(skill, "agentloop.skill.json"), "{invalid");
  const app = await startDesktop({ mode: "development", dataDirectory: join(root, "desktop"), cloudAuth: fixtureAuth(),
    bundledSkillDirectories: [join(root, "skills")], openBrowser: false });
  assert.equal(app.existing, false);
  t.after(async () => { try { await app.close(); } finally { await removeSkillPackage(root); } });
  const login = await fetch(`${app.origin}/api/auth/login`, { method: "POST",
    headers: { Origin: app.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "test@example.test", password: "fixture-only" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const call = (path: string) => fetch(`${app.origin}${path}`, { headers: { Cookie: cookie } });
  const runtimes = await call("/api/runtimes"); assert.equal(runtimes.status, 200);
  const { runtimes: [runtime] } = await runtimes.json();
  assert.equal(runtime.status, "ready");
  assert.equal(runtime.skillDiagnostics[0].skillName, "broken");
  const models = await call("/api/models"); assert.equal(models.status, 200);
  assert.deepEqual(await models.json(), { models: [] });
});

test("Runtime settings show quarantined Skill details while retaining the ready state", async () => {
  const source = await readFile(new URL("../web/capability-settings.js", import.meta.url), "utf8");
  class Element {
    children: Element[] = []; dataset: Record<string, string> = {}; textContent = ""; className = ""; parent?: Element;
    onclick?: () => unknown;
    classList = { toggle() {}, add() {} };
    append(...items: Element[]) { for (const item of items) { item.parent = this; this.children.push(item); } }
    prepend(...items: Element[]) { for (const item of items) item.parent = this; this.children.unshift(...items); }
    get lastElementChild() { return this.children.at(-1)!; }
    replaceChildren(...items: Element[]) { this.children = []; this.append(...items); }
    setAttribute() {} addEventListener() {} querySelector() { return null; } querySelectorAll() { return []; } focus() {}
  }
  const elements = new Map<string, Element>();
  const element = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const tab = new Element(); tab.dataset.settingsTab = "runtimes";
  const runtime = { id: "desktop-default", displayName: "Test Runtime", status: "ready", iconKey: "xuanwu", extensionSkillCount: 1, mcpServerCount: 0,
    skillDiagnostics: [{ skillName: "broken", message: "Invalid declaration <script>text only</script>" }] };
  const api = async (path: string) => {
    if (path === "/api/runtimes") return { runtimes: [runtime] };
    if (path === "/api/skills") return { skills: [{ packageId: "broken-id", skillName: "broken", validationStatus: "invalid" }] };
    if (path === "/api/mcp") return { servers: [] };
    if (path.endsWith("/configuration")) return { configuration: { skills: [{ packageId: "broken-id" }], mcpServers: [] } };
    throw Error(path);
  };
  const install = runInNewContext(source.replace(/^import .*;\n/, "").replace("export function", "function") + "\ninstallCapabilitySettings", {
    document: { createElement: () => new Element(), querySelectorAll: () => [tab] }, Node: Element,
    installModelSettings: () => ({ canLeave: () => true }), confirm: () => true,
  });
  install({ api, element, refreshModels() {}, status() {}, currentRuntime: () => runtime.id, refreshCapabilities() {} });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  tab.onclick!(); await settle();
  const flatten = (node: Element): Element[] => [node, ...node.children.flatMap(flatten)];
  const body = element("capability-body");
  assert.ok(flatten(body).some(node => node.textContent === "就绪"));
  assert.ok(flatten(body).some(node => node.textContent.includes("Skill 加载异常，已隔离")));
  flatten(body).find(node => node.textContent === "查看")!.onclick!(); await settle();
  assert.ok(flatten(body).some(node => node.textContent === "broken：Invalid declaration <script>text only</script>"));
  assert.ok(flatten(body).some(node => node.textContent === "broken · 加载异常，已隔离"));
  assert.ok(!flatten(body).some(node => node.textContent === "broken · 已启用"));
});
