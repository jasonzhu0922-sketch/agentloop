/** Opt-in live acceptance. Reads an existing model account without changing it.
 * node apps/agentloop-desktop/scripts/accept-skill-upload.ts <model-account> [output-directory]
 * Uses real model calls, an isolated Desktop account, real scripts and a local read-only MCP fixture.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LlmProviderRegistry, projectSkillAgentLoopMetadata } from "@zhujun/agentloop";
import { EncryptedLocalRuntimeSecretStore } from "@zhujun/agentloop-local-runtime";
import { startDesktop } from "../src/application.ts";
import { fixtureAuth, TEST_OWNER } from "../tests/fixtures/auth.ts";

const sourceAccount = process.argv[2];
if (!sourceAccount) throw new Error("model_account_argument_required");
const output = resolve(process.argv[3] ?? await mkdtemp(join(tmpdir(), "skill-upload-acceptance-")));
await mkdir(output, { recursive: true });
const source = new DatabaseSync(join(sourceAccount, "supervisor.db"), { readOnly: true });
const row = source.prepare("SELECT configuration_json, secret_storage_key FROM local_model_configuration WHERE singleton=1").get()!;
source.close();
const saved = JSON.parse(row.configuration_json as string);
const environment = await new EncryptedLocalRuntimeSecretStore(join(sourceAccount, "private", "model-secrets")).read(row.secret_storage_key as string);
assert.ok(environment, "saved_model_credentials_unavailable");
const providers: Record<string, unknown> = {}, models: Record<string, unknown> = {};
const ordered: string[] = [];
for (const provider of saved.providers.filter((item: any) => item.models.length)) {
  providers[provider.key] = { kind: "openai-compatible", baseUrl: provider.baseUrl, apiKeyEnv: `LOCAL_MODEL_KEY_${provider.key.toUpperCase().replace(/-/g, "_")}`, defaultModel: provider.models[0].providerModel, protocol: "responses" };
  for (const { key, ...model } of provider.models) { models[key] = { ...model, providerKey: provider.key }; ordered.push(key); }
}
assert.ok(ordered.length);
const registry = LlmProviderRegistry.fromConfigObject({ defaultProvider: saved.providers.find((item: any) => item.models.length).key, defaultModelKey: ordered[0], providers, models }, environment);
const observations: any[] = [];
const modelsPort = { modelKeys: () => ordered, create: (key: string, onRetry?: any) => {
  const adapter = registry.create(key, onRetry);
  return new Proxy(adapter, { get(target, property) {
    if (property === "complete") return async (...args: any[]) => {
      const startedAt = Date.now();
      try { const result = await (target.complete as any)(...args); observations.push({ modelKey: key, runId: args[0].runId, phase: args[0].phase, elapsedMs: Date.now() - startedAt, finishReason: result.finishReason, toolNames: result.toolCalls.map((call: any) => call.name) }); return result; }
      catch { observations.push({ modelKey: key, runId: args[0].runId, phase: args[0].phase, elapsedMs: Date.now() - startedAt, error: "provider_call_failed" }); throw new Error("live_provider_call_failed"); }
    };
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
} };
const uniqueRecord = { receipt: `acceptance-${randomUUID()}`, units: 37, amount: 4819 };
const mcpCalls: any[] = [];
const mcp = createServer((request, response) => { void (async () => {
  if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const message = JSON.parse(Buffer.concat(chunks).toString());
  if (message.method.startsWith("notifications/")) { response.writeHead(202); response.end(); return; }
  let result: unknown;
  if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "acceptance-source", version: "1.0" } };
  else if (message.method === "tools/list") result = { tools: [{ name: "read_record", description: "Read the single acceptance record, including its unique receipt, units and amount.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }] };
  else if (message.method === "tools/call") { mcpCalls.push(message.params); result = { content: [{ type: "text", text: JSON.stringify(uniqueRecord) }], isError: false }; }
  else result = {};
  response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
})().catch(() => { response.writeHead(500); response.end(); }); });
await new Promise<void>(done => mcp.listen(0, "127.0.0.1", done));
const address = mcp.address(); assert.ok(address && typeof address !== "string");
const root = await mkdtemp(join(tmpdir(), "skill-upload-live-desktop-"));
const empty = join(output, "empty-skills"); await mkdir(empty, { recursive: true });
const python = execFileSync(process.env.AGENTLOOP_TEST_PYTHON ?? "python3", ["-I", "-B", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const app = await startDesktop({ mode: "development", dataDirectory: root, models: modelsPort, cloudAuth: fixtureAuth(), bundledSkillDirectories: [empty],
  computerCommandEnvironment: { RUNTIME_PYTHON: python, PATH: [dirname(python), dirname(process.execPath), process.env.PATH ?? ""].join(delimiter), PYTHONPATH: "", PYTHONHOME: "", VIRTUAL_ENV: "" }, openBrowser: false, port: 0 });
assert.equal(app.existing, false); if (app.existing) throw new Error("isolated_instance_required");
let auth: { cookie: string; csrf: string } | undefined;
const json = async (path: string, body?: unknown) => {
  const response = await fetch(app.origin + path, { method: body === undefined ? "GET" : "POST", headers: { ...auth && { Cookie: auth.cookie }, ...body !== undefined && { Origin: app.origin, "Content-Type": "application/json", ...auth && { "X-Desktop-CSRF": auth.csrf } } }, ...body !== undefined && { body: JSON.stringify(body) } });
  const result = await response.json(); assert.equal(response.status, 200, `${path}: ${JSON.stringify(result)}`);
  return { result, response };
};
const api = async (path: string, body?: unknown) => (await json(path, body)).result;
const report: any = { startedAt: new Date().toISOString(), isolatedDataDirectory: root, modelKeys: ordered, cases: [], fixture: "Local read-only MCP acceptance service; model and package scripts execute for real." };
await writeFile(join(output, "location.json"), JSON.stringify({ root, origin: app.origin, owner: TEST_OWNER }));
const frontmatter = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
const script = "import csv, json\nfrom pathlib import Path\nrows=list(csv.DictReader((Path(__file__).parent.parent/'data.csv').open()))\nprint(json.dumps({'rows':len(rows),'total':sum(int(r['amount']) for r in rows)}))\n";
const definitions = [
  { name: "acceptance-instructions", files: { "SKILL.md": frontmatter("acceptance-instructions", "按引用资料给出验收流程口令", "读取 [流程](references/workflow.md)，按资料的三步顺序回答并保留校验口令。"), "references/workflow.md": "验收流程：\n1. 核对范围\n2. 检查来源\n3. 报告结果\n校验口令：松柏-4937\n" }, input: "请使用 acceptance-instructions，执行包内流程，将三步顺序和校验口令直接回复在对话里。", expected: ["松柏-4937", "核对范围", "检查来源", "报告结果"] },
  { name: "acceptance-script", files: { "SKILL.md": frontmatter("acceptance-script", "运行包内 Python 脚本统计记录总额", "执行 python3 scripts/run.py，脚本读取包内 data.csv，回复真实 stdout 中的行数和总额。不可用心算代替执行。"), "scripts/run.py": script, "data.csv": "amount\n173\n284\n396\n" }, input: "请使用 acceptance-script，实际执行它的脚本，告诉我记录行数和总额，只需对话回复。", expected: ["3", "853"] },
  { name: "acceptance-manifest", files: { "SKILL.md": frontmatter("acceptance-manifest", "使用包内声明的执行接口统计记录", "按 agentloop.executors.json 中的 summarize 动作实际执行脚本，直接回复记录行数和总额。"), "scripts/run.py": script, "data.csv": "amount\n311\n427\n659\n", "agentloop.executors.json": JSON.stringify({ schema: "agentloop.skillExecutors/v1", executors: [{ id: "records", description: "Summarize packaged records", command: "python3", script: "scripts/run.py", actions: [{ id: "summarize", description: "Read data.csv and return rows and total", inputs: [], args: ["scripts/run.py"], result: "JSON with rows and total" }] }] }) }, input: "请使用 acceptance-manifest，按它的执行接口实际执行统计，回复记录行数和总额。", expected: ["3", "1397"] },
  { name: "acceptance-connection", files: { "SKILL.md": frontmatter("acceptance-connection", "从指定外部 MCP 连接读取验收记录", "依赖 MCP 服务 acceptance-source。调用这个服务的 read_record 读取唯一记录，直接报告回执、units 和 amount；禁止编造或从其他来源替代。"), "agentloop.skill.json": JSON.stringify({ schema: "agentloop.skillDeclaration/v1", identity: { name: "acceptance-connection", description: "从指定外部 MCP 连接读取验收记录" }, activation: { semanticTags: ["acceptance-record"], intentExamples: ["读取验收记录"] }, workflow: { roles: ["support"], artifactKinds: ["none"], sourceKinds: ["api"], qaKinds: [], requiredSkills: [] }, requirements: { mcpServers: ["acceptance-source"] } }) }, input: "请使用 acceptance-connection，通过 acceptance-source 读取当前验收记录并报告回执、units 和 amount，只需对话回复。", expected: [uniqueRecord.receipt, "37", "4819"] },
];
try {
  const login = await json("/api/auth/login", { email: "test@example.test", password: "synthetic-test-password" });
  auth = { cookie: login.response.headers.get("set-cookie")!.split(";")[0]!, csrf: login.result.csrfToken };
  for (const definition of definitions) {
    console.log(`Uploading ${definition.name}`);
    const record: any = { name: definition.name, status: "running" }; report.cases.push(record);
    await mkdir(join(output, definition.name), { recursive: true });
    try {
      const beforeUpload = await api("/api/runtimes/desktop-default/configuration");
      const uploaded = (await api("/api/skills/import", { files: Object.entries(definition.files).map(([path, content]) => ({ path: `${definition.name}/${path}`, contentBase64: Buffer.from(content).toString("base64") })) })).skills[0];
      record.package = uploaded;
      const metadata = await api(`/api/skills/${uploaded.packageId}/metadata`); record.metadata = metadata;
      assert.deepEqual(metadata.declaration.workflow.artifactKinds, ["none"], "fixture_skills_return_answers_without_delivered_files");
      let setup = await api(`/api/skills/${uploaded.packageId}/setup`, {}); record.initialSetup = setup;
      if (definition.name === "acceptance-connection") {
        assert.ok(setup.requirements.checks.some((check: any) => check.kind === "mcp" && check.status === "missing"));
        const serverInput = { key: "acceptance-source", displayName: "验收数据源", transport: "http", url: `http://127.0.0.1:${address.port}/mcp`, auth: { kind: "none" }, trust: "trusted", capabilities: [{ id: "acceptance.record_read", category: "data_asset", sourceKinds: ["api"], producesEvidenceKinds: ["source_summary", "explicit_caveats"] }] };
        const server = (await api("/api/mcp", { server: serverInput })).server;
        assert.equal((await api(`/api/mcp/${server.id}/test`, { server: serverInput })).ok, true);
        await api("/api/runtimes/desktop-default/stop", {});
        const settings = await api("/api/runtimes/desktop-default/configuration");
        await api("/api/runtimes/desktop-default/configuration", { revision: settings.revision, configuration: { iconKey: settings.configuration.iconKey, skillPackageIds: settings.configuration.skills.map((skill: any) => skill.packageId), mcpServerIds: [server.id] } });
        await api("/api/runtimes/desktop-default/start", {});
        setup = await api(`/api/skills/${uploaded.packageId}/setup`, {});
        record.connectionSetup = setup;
      }
      if (definition.name !== "acceptance-connection") assert.deepEqual(await api("/api/runtimes/desktop-default/configuration"), beforeUpload, "upload must not select the Skill for a Runtime");
      await api("/api/runtimes/desktop-default/stop", {});
      const settings = await api("/api/runtimes/desktop-default/configuration");
      await api("/api/runtimes/desktop-default/configuration", { revision: settings.revision, configuration: { iconKey: settings.configuration.iconKey, skillPackageIds: [...settings.configuration.skills.map((skill: any) => skill.packageId), uploaded.packageId], mcpServerIds: settings.configuration.mcpServerIds } });
      await api("/api/runtimes/desktop-default/start", {});
      record.deviceSetup = await api(`/api/skills/${uploaded.packageId}/setup`, {});
      assert.equal(record.deviceSetup.scope, "device");
      assert.ok(record.deviceSetup.selectedBy.some((runtime: any) => runtime.id === "desktop-default"));
      const catalogDb = new DatabaseSync(join(root, "accounts", TEST_OWNER, "runtime.db"), { readOnly: true });
      try { record.runtimeCatalog = catalogDb.prepare("SELECT name, package_hash, agent_loop_json FROM discovered_skills WHERE name=?").get(definition.name); } finally { catalogDb.close(); }
      assert.equal(record.runtimeCatalog.package_hash, metadata.packageHash);
      assert.deepEqual(JSON.parse(record.runtimeCatalog.agent_loop_json), projectSkillAgentLoopMetadata(metadata.declaration));
      const started = (await api("/api/runs", { requestId: randomUUID(), input: definition.input, modelKey: `local:${ordered[0]}` })).run;
      record.runId = started.id; console.log(`Running ${definition.name}: ${started.id}`);
      let run = started, afterSeq = 0; const events: any[] = [], deadline = Date.now() + 15 * 60_000;
      while (!['completed', 'failed', 'cancelled', 'waiting_user'].includes(run.status) && Date.now() < deadline) {
        const batch = (await api(`/api/runs/${started.id}/events?afterSeq=${afterSeq}`)).events;
        events.push(...batch); if (batch.length) afterSeq = batch.at(-1).seq;
        run = (await api(`/api/runs/${started.id}`)).run;
        await new Promise(done => setTimeout(done, 1000));
      }
      events.push(...(await api(`/api/runs/${started.id}/events?afterSeq=${afterSeq}`)).events);
      record.run = run;
      await writeFile(join(output, definition.name, "events.json"), JSON.stringify(events, null, 2));
      assert.equal(run.status, "completed");
      for (const expected of definition.expected) assert.ok(run.output.replace(/,/g, "").includes(expected), `missing_result:${expected}`);
      const completed = events.filter(event => event.type === "tool.completed" && !event.data?.isError);
      const planned = events.filter(event => event.type === "tool.planned");
      record.toolCalls = planned.map(event => event.data);
      assert.ok(completed.some(event => event.data.toolName === "load_skill" && JSON.stringify(event.data).includes(definition.name)), "own_skill_not_loaded");
      const plan = events.find(event => event.type === "plan.admitted");
      assert.ok(plan?.data.selectedSkillIds?.includes(`discovered:${definition.name}`) || plan?.data.steps?.some((step: any) => step.skillIds?.includes(`discovered:${definition.name}`)), "own_skill_not_bound_to_plan");
      if (definition.name === "acceptance-instructions") assert.ok(planned.some(event => event.data.toolName === "computer_read_file" && event.data.arguments?.path === `@skills/${definition.name}/references/workflow.md`), "reference_not_read");
      if (definition.name.includes("script") || definition.name.includes("manifest")) {
        assert.ok(planned.some(event => event.data.toolName === "computer_run_command" && JSON.stringify(event.data.arguments).includes(`@skills/${definition.name}`) && JSON.stringify(event.data.arguments).includes("scripts/run.py")), "own_script_not_executed");
        assert.ok(completed.some(event => event.data.toolName === "computer_run_command" && JSON.stringify(event.data.result).includes(definition.expected[1])), "missing_script_stdout");
      }
      if (definition.name === "acceptance-connection") { assert.ok(mcpCalls.some(call => call.name === "read_record")); assert.ok(completed.some(event => event.data.toolName?.includes("acceptance_source") && JSON.stringify(event.data.result).includes(uniqueRecord.receipt))); }
      record.status = "passed";
    } catch (error) { record.status = "failed"; record.error = error instanceof Error ? error.message : "acceptance_failed"; console.log(`Failed ${definition.name}: ${record.error}`); }
    await writeFile(join(output, "report.json"), JSON.stringify({ ...report, modelCalls: observations, mcpCalls }, null, 2));
  }
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, "report.json"), JSON.stringify({ ...report, modelCalls: observations, mcpCalls }, null, 2));
  await app.close(); await new Promise<void>(done => { mcp.close(() => done()); mcp.closeAllConnections(); });
}
console.log(`Evidence: ${output}`);
if (report.cases.some((record: any) => record.status !== "passed")) process.exitCode = 1;
