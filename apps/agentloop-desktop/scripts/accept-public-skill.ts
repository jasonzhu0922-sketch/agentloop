/** Opt-in public Skill acceptance, using the actual Desktop UI and a real model.
 * node apps/agentloop-desktop/scripts/accept-public-skill.ts <model-account> <evidence-directory>
 * The directory must contain the unchanged upstream slack-gif-creator.zip and source.json.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

import { chromium } from "playwright-core";

const sourceReceipt = JSON.parse(await readFile(join(output, "source.json"), "utf8"));
const root = await mkdtemp(join(tmpdir(), "public-skill-desktop-"));
const empty = join(output, "empty-bundled-skills"); await mkdir(empty, { recursive: true });
const python = execFileSync(process.env.AGENTLOOP_TEST_PYTHON ?? "python3", ["-I", "-B", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const pipConfig = process.env.AGENTLOOP_ACCEPTANCE_PIP_CONFIG;
const app = await startDesktop({ mode: "development", dataDirectory: root, models: modelsPort, cloudAuth: fixtureAuth(),
  bundledSkillDirectories: [empty], computerCommandEnvironment: { RUNTIME_PYTHON: python,
    PATH: [dirname(python), dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
    PYTHONPATH: "", PYTHONHOME: "", VIRTUAL_ENV: "", ...(pipConfig ? { PIP_CONFIG_FILE: resolve(pipConfig) } : {}) }, openBrowser: false, port: 0 });
if (app.existing) throw new Error("isolated_instance_required");
const report: any = { startedAt: new Date().toISOString(), source: sourceReceipt, dataDirectory: root, origin: app.origin,
  modelKeys: ordered, pipConfiguration: pipConfig ? "host-supplied pip configuration" : "pip default index",
  ...(pipConfig ? { pipConfigSha256: createHash("sha256").update(await readFile(pipConfig)).digest("hex") } : {}),
  status: "running", checks: {} };
await writeFile(join(output, "location.json"), JSON.stringify({ root, origin: app.origin, owner: TEST_OWNER }));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
const page = await context.newPage(); page.setDefaultTimeout(90_000);
const persist = () => writeFile(join(output, "report.json"), JSON.stringify({ ...report, modelCalls: observations }, null, 2));
try {
  await page.goto(app.origin + "/login");
  await page.locator("#auth-email").fill("test@example.test");
  await page.locator("#auth-password").fill("synthetic-test-password");
  await page.locator("#auth-submit").click();
  await page.waitForURL(app.origin + "/");
  await page.locator("#send:not([disabled])").waitFor();
  const session = await (await context.request.get(app.origin + "/api/session")).json();
  async function api(path: string, data?: unknown) {
    const response = data === undefined ? await context.request.get(app.origin + path)
      : await context.request.post(app.origin + path, { headers: { Origin: app.origin, "X-Desktop-CSRF": session.csrfToken }, data });
    const result = await response.json(); assert.ok(response.ok(), `${path}: ${JSON.stringify(result)}`); return result;
  }
  const beforeUpload = await api("/api/runtimes/desktop-default/configuration");
  await page.locator("#model-settings-open").click();
  await page.locator('[data-settings-tab="skills"]').click();
  console.log("Uploading unchanged public Skill ZIP through Desktop UI");
  const importedResponse = page.waitForResponse(response => response.url().endsWith("/api/skills/import") && response.request().method() === "POST", { timeout: 180_000 });
  await page.getByLabel("选择 Skill ZIP", { exact: true }).setInputFiles(join(output, "slack-gif-creator.zip"));
  const imported = await importedResponse; report.uploadStatus = imported.status();
  const upload = await imported.json(); assert.equal(imported.status(), 200, JSON.stringify(upload));
  const pkg = upload.skills.find((item: any) => item.skillName === "slack-gif-creator");
  assert.ok(pkg); report.package = pkg;
  await page.getByText("Skill 已加入本机共享库", { exact: false }).waitFor();
  assert.deepEqual(await api("/api/runtimes/desktop-default/configuration"), beforeUpload);
  assert.equal(await page.getByLabel("目标 Runtime", { exact: true }).count(), 0);
  report.checks.uploadDoesNotSelectRuntime = true;
  report.metadata = await api(`/api/skills/${pkg.packageId}/metadata`);
  const libraryRoot = join(root, "accounts", TEST_OWNER, "skill-library", `uploaded-${report.metadata.packageHash}`);
  for (const entry of sourceReceipt.files) assert.equal(createHash("sha256").update(await readFile(join(libraryRoot, entry.path))).digest("hex"), entry.sha256, entry.path);
  report.checks.packageBytesUnchanged = true;
  await page.locator("#model-settings").screenshot({ path: join(output, "01-uploaded.png") });
  report.initialDiagnosis = await api(`/api/skills/${pkg.packageId}/requirements/diagnose`, {});
  await persist();
  console.log("Diagnosis:", report.initialDiagnosis.checks.map((check: any) => `${check.label}:${check.status}`).join(", "));
  if (report.initialDiagnosis.canInstall) {
    await page.getByRole("button", { name: "依赖诊断", exact: true }).click();
    await page.getByRole("button", { name: "查看 Python 依赖安装方案", exact: true }).click();
    await page.locator("#model-settings").screenshot({ path: join(output, "02-install-plan.png") });
    const installedResponse = page.waitForResponse(response => response.url().endsWith("/requirements/install") && response.request().method() === "POST");
    await page.getByRole("button", { name: "安装 Python 依赖", exact: true }).click();
    const installation = await installedResponse; assert.equal(installation.status(), 202);
    let job = await installation.json(); report.installationId = job.id; console.log("Installing missing shared dependencies", job.id);
    const deadline = Date.now() + 7 * 60_000;
    let phase = job.phase;
    while (job.status === "running" && Date.now() < deadline) {
      await new Promise(done => setTimeout(done, 1000)); job = await api(`/api/skill-installations/${job.id}`);
      if (job.phase !== phase) { phase = job.phase; console.log("Installation phase", phase); }
    }
    report.installation = job; await persist();
    assert.equal(job.status, "completed", job.error ?? job.log);
    await page.getByText("Python 依赖已安装并通过检查。", { exact: true }).waitFor();
    await page.locator("#model-settings").screenshot({ path: join(output, "03-installed.png") });
  }
  report.finalDiagnosis = await api(`/api/skills/${pkg.packageId}/requirements/diagnose`, {});
  assert.ok(report.finalDiagnosis.checks.filter((check: any) => check.kind === "python").every((check: any) => ["satisfied", "skipped"].includes(check.status)));
  await page.locator('[data-settings-tab="runtimes"]').click();
  let card = page.locator(".runtime-manager-card").filter({ hasText: "默认" });
  await card.getByRole("button", { name: /操作 / }).click(); await card.getByRole("button", { name: "停止", exact: true }).click();
  card = page.locator(".runtime-manager-card").filter({ hasText: "默认" });
  await card.getByRole("button", { name: /操作 / }).click(); await card.getByRole("button", { name: "配置", exact: true }).click();
  await page.locator(".runtime-skill-option").filter({ hasText: "slack-gif-creator" }).locator('input[type="checkbox"]').check();
  await page.locator("#model-settings").screenshot({ path: join(output, "04-runtime-selection.png") });
  await page.locator(".runtime-config-actions").getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("Runtime 配置已保存。", { exact: true }).waitFor();
  card = page.locator(".runtime-manager-card").filter({ hasText: "默认" });
  await card.getByRole("button", { name: /操作 / }).click(); await card.getByRole("button", { name: "启动", exact: true }).click();
  await page.getByText("生命周期操作已提交", { exact: false }).waitFor();
  await page.locator("#model-settings-close").click();
  const catalog = new DatabaseSync(join(root, "accounts", TEST_OWNER, "runtime.db"), { readOnly: true });
  try { report.catalog = catalog.prepare("SELECT name, package_hash, agent_loop_json FROM discovered_skills WHERE name=?").get(pkg.skillName); } finally { catalog.close(); }
  assert.equal(report.catalog.package_hash, report.metadata.packageHash);
  assert.deepEqual(JSON.parse(report.catalog.agent_loop_json), projectSkillAgentLoopMetadata(report.metadata.declaration));
  const input = "请使用我上传的 slack-gif-creator Skill，制作一个聊天用的紫色呼吸圆点加载动图。要求：128×128 像素，白色背景，紫色圆点平滑呼吸，至少 12 帧，10 fps 左右，无限循环。请按照这个 Skill 的说明，实际调用它包内的 GIFBuilder 生成，并用它提供的 validators 校验。交付一个可以下载的 loading.gif 文件，回复简要说明尺寸、帧数、时长和校验结果；不要只给代码。";
  await page.locator("#model").selectOption(`local:${ordered[0]}`);
  await page.locator("#message").fill(input); report.input = input;
  const runResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/runs" && response.request().method() === "POST");
  await page.locator("#send").click();
  const runStarted = await runResponse; const started = (await runStarted.json()).run; assert.ok(started?.id); report.runId = started.id;
  console.log("Real Run", started.id); await persist();
  let run = started, afterSeq = 0; const events: any[] = [], deadline = Date.now() + 15 * 60_000;
  while (!['completed', 'failed', 'cancelled', 'waiting_user'].includes(run.status) && Date.now() < deadline) {
    const batch = (await api(`/api/runs/${run.id}/events?afterSeq=${afterSeq}`)).events;
    events.push(...batch); if (batch.length) afterSeq = batch.at(-1).seq;
    run = (await api(`/api/runs/${run.id}`)).run;
    const progress = batch.filter((event: any) => ["tool.completed", "tool.failed", "run.completed", "run.failed"].includes(event.type)).at(-1);
    if (progress) console.log("Run", run.status, progress.type, progress.data?.toolName ?? "");
    await new Promise(done => setTimeout(done, 1000));
  }
  events.push(...(await api(`/api/runs/${run.id}/events?afterSeq=${afterSeq}`)).events);
  report.run = run; await writeFile(join(output, "events.json"), JSON.stringify(events, null, 2)); await persist();
  assert.equal(run.status, "completed", run.errorCode ?? run.output);
  const completed = events.filter(event => event.type === "tool.completed" && !event.data?.isError);
  assert.ok(completed.some(event => event.data.toolName === "load_skill" && JSON.stringify(event.data).includes(pkg.skillName)), "uploaded_skill_must_be_loaded");
  const plan = events.find(event => event.type === "plan.admitted");
  assert.ok(plan?.data.selectedSkillIds?.includes(`discovered:${pkg.skillName}`) || plan?.data.steps?.some((step: any) => step.skillIds?.includes(`discovered:${pkg.skillName}`)), "uploaded_skill_must_be_bound_to_plan");
  const commands = events.filter(event => event.type === "tool.planned" && event.data.toolName === "computer_run_command");
  report.commands = commands.map(event => event.data);
  assert.ok(commands.some(event => event.data.arguments?.cwd === `@skills/${pkg.skillName}`), "command_must_execute_in_uploaded_package");
  const generatedScript = events.find(event => event.type === "tool.planned" && event.data.toolName === "computer_write_file"
    && /from core\.gif_builder import GIFBuilder/u.test(event.data.arguments?.content ?? "")
    && /from core\.validators import/u.test(event.data.arguments?.content ?? ""));
  assert.ok(generatedScript, "generation_must_import_upstream_builder_and_validators");
  const artifacts = (await api(`/api/runs/${run.id}/artifacts`)).artifacts; report.artifacts = artifacts;
  const gif = artifacts.find((artifact: any) => artifact.name.toLowerCase().endsWith(".gif")); assert.ok(gif, "downloadable_gif_required");
  const downloaded = await context.request.get(app.origin + `/api/runs/${run.id}/artifacts/${gif.id}/download`);
  assert.equal(downloaded.status(), 200); await writeFile(join(output, "loading.gif"), await downloaded.body());
  const verification = JSON.parse(execFileSync(python, ["-I", "-B", "-c", "import json,sys,hashlib\nfrom PIL import Image,ImageSequence\nim=Image.open(sys.argv[1]);frames=[f.convert('RGB').tobytes() for f in ImageSequence.Iterator(im)];im.seek(0)\ndurations=[]\nfor f in ImageSequence.Iterator(im): durations.append(f.info.get('duration',0))\nprint(json.dumps({'format':im.format,'width':im.width,'height':im.height,'frames':len(frames),'uniqueFrames':len(set(frames)),'durationMs':sum(durations),'loop':im.info.get('loop'),'sha256':hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest()}))", join(output, "loading.gif")], { encoding: "utf8" }));
  report.verification = verification;
  assert.equal(verification.format, "GIF"); assert.equal(verification.width, 128); assert.equal(verification.height, 128);
  assert.ok(verification.frames >= 12); assert.ok(verification.uniqueFrames >= 6); assert.equal(verification.loop, 0);
  assert.equal(verification.sha256, gif.sha256, "downloaded_GIF_must_match_Runtime_artifact");
  await page.waitForTimeout(2000); await page.screenshot({ path: join(output, "05-result.png"), fullPage: true });
  report.status = "passed"; console.log("Verified GIF", JSON.stringify(verification));
} catch (error) {
  report.status = "failed"; report.error = error instanceof Error ? error.message : "acceptance_failed";
  await page.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1; console.log("Acceptance failed", report.error);
} finally {
  report.finishedAt = new Date().toISOString(); await persist();
  await browser.close(); await app.close();
}
console.log("Evidence:", output);
