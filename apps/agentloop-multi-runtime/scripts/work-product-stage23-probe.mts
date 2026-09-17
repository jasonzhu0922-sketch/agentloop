/** Isolated HTTP Host probe. --live uses the configured default provider after deterministic bootstrap.
 * No production Router registration, historical DB access, recovery or external task data.
 * Run after npm run build:kernel. Outputs are retained in a new temporary directory for audit.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppDatabase, LlmProviderRegistry, RunService, SkillService } from "@zhujun/agentloop";
import type { ModelAdapter, ModelInvocation, ModelResponse, Planner } from "@zhujun/agentloop";
import { AgentLoopRuntimeHost } from "../src/runtime/runtime-host.ts";
import { createRuntimeHostHttpServer } from "../src/http/runtime-host-http.ts";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const live = process.argv.includes("--live");
const repeats = Number(process.argv.find((arg) => arg.startsWith("--repeats="))?.split("=")[1] ?? (live ? 3 : 1));
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3) throw new Error("--repeats must be 1..3");
if (live && existsSync(join(appRoot, ".env"))) process.loadEnvFile(join(appRoot, ".env"));
const providers = live ? await LlmProviderRegistry.fromConfigFile(join(appRoot, "config/llm-providers.json")) : undefined;
if (providers !== undefined) providers.create(); // Fail before starting a Host if credentials are unavailable.
const root = await mkdtemp(join(tmpdir(), "agentloop-work-product-stage23-"));
const workspace = join(root, "workspace");
await mkdir(workspace);
const database = new AppDatabase(join(root, "agentloop.db"));
const owner = "stage23-probe-user";
const reports: Record<string, unknown>[] = [];
let currentCase = "A";
let metrics: { liveCalls: number; inputTokens: number; outputTokens: number; contexts: number; maxContextCharacters: number };
const resultForCall = (id: string, name: string, args: Record<string, unknown>, content = ""): ModelResponse => ({
  content, finishReason: "tool_calls", toolCalls: [{ id, name, arguments: args }],
});
const write = (id: string, path: string, content: string) => resultForCall(id, "computer_write_file", { path, content, mode: "create" });
const run = (id: string, file: string) => resultForCall(id, "computer_run_command", { command: "node", args: [file], cwd: ".", timeoutMs: 10000 });
const verify = () => resultForCall("verify-target", "verify_artifact_acceptance", { artifactPath: currentCase === "file-control" ? "control.json" : "target.json", artifactKind: "json" });
const modelFactory = (): ModelAdapter => {
  const scenario = currentCase;
  let round = 0;
  const base = providers?.create();
  const bootstrap = scenario === "A" ? [
    write("seed-candidate", "target.json", JSON.stringify({ title: "report", status: "draft", items: [1, 2, 3] })),
    write("seed-finalizer", "finalize.cjs", 'const fs=require("node:fs");const data=JSON.parse(fs.readFileSync("target.json","utf8"));data.status="final";fs.writeFileSync("target.json",JSON.stringify(data));'),
  ] : scenario === "B" ? [
    write("seed-generator", "generator.cjs", 'const fs=require("node:fs");const items=Array.fromValues([1,2,3]);fs.writeFileSync("target.json",JSON.stringify({title:"report",status:"final",items}));'),
    write("seed-experiment", "experiment.json", '{"experiment":true}'),
    run("seed-failure", "generator.cjs"),
  ] : [];
  return {
    limits: base?.limits ?? { contextWindowTokens: 128000, maxOutputTokens: 8192 },
    ...(base?.estimateInputTokens === undefined ? {} : { estimateInputTokens: (request: ModelInvocation) => base.estimateInputTokens!(request) }),
    complete: async (request, signal) => {
      const state = request.runtimeContext?.content.match(/"workProductContext":(\{.*)/);
      if (state) { metrics.contexts++; metrics.maxContextCharacters = Math.max(metrics.maxContextCharacters, request.runtimeContext!.content.length); }
      if (request.phase === "execution" && round < bootstrap.length) return bootstrap[round++];
      if (base !== undefined) {
        metrics.liveCalls++;
        const response = await base.complete(request, signal);
        metrics.inputTokens += response.usage?.inputTokens ?? 0;
        metrics.outputTokens += response.usage?.outputTokens ?? 0;
        return response;
      }
      const after = round++ - bootstrap.length;
      if (scenario === "A") return after === 0 ? run("finalize", "finalize.cjs") : after === 1 ? verify() : { content: "target.json 已完成并检查。", toolCalls: [], finishReason: "stop" };
      if (scenario === "B") return after === 0 ? resultForCall("fix-generator", "computer_patch_file", { path: "generator.cjs", oldText: "Array.fromValues", newText: "Array.from" })
        : after === 1 ? run("generate", "generator.cjs") : after === 2 ? verify() : { content: "target.json 已完成并检查；experiment.json 仅为实验。", toolCalls: [], finishReason: "stop" };
      if (scenario === "file-control") return after === 0 ? write("control-write", "control.json", '{"ok":true}') : after === 1 ? verify() : { content: "control.json 已完成。", toolCalls: [], finishReason: "stop" };
      return { content: "4", toolCalls: [], finishReason: "stop" };
    },
  };
};
const planner: Planner = { plan: async (task) => ({
  schema: "agentloop.outcomePlan/v2", shape: "single_leaf", goal: task.input, selectedSkillIds: [], selectedSkillRoles: [],
  steps: [{ id: "deliver", role: "deliver", objective: task.input, dependencies: [], skillIds: [],
    requiredCapabilities: currentCase === "answer-control" ? ["conversation_delivery"] : ["workspace_artifact_write", "workspace_file_read", "artifact_acceptance"],
    evidenceContract: { requiredKinds: currentCase === "answer-control" ? ["delivery_receipt"] : ["artifact_path", "artifact_non_empty", "artifact_acceptance", "delivery_receipt"], caveatPolicy: "none" },
    successCriteria: [{ id: "goal", description: task.input, source: "task" }],
  }],
}) };
const runs = new RunService({ database, skills: new SkillService(database), workspaceRoot: workspace, modelFactory,
  plannerFactory: () => planner, maxSteps: 12 });
const host = new AgentLoopRuntimeHost(runs, { importForRun: async () => [] });
const token = randomUUID();
const server = createRuntimeHostHttpServer(host, { dispatchToken: token });
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const address = server.address();
if (address === null || typeof address === "string") throw new Error("No isolated Host address");
const endpoint = `http://127.0.0.1:${address.port}`;
const tasks: Record<string, string> = {
  A: "阶段测试 A：已有 target.json 候选（status=draft）和未执行的 finalize.cjs。保留 title=report、items=[1,2,3]，执行已有脚本把 status 改为 final。不要重新生成整套文件。检查 target.json 并交付。",
  B: "阶段测试 B：generator.cjs 生成 target.json 时发生 API 错误；experiment.json 只是实验，不是目标交付。修复已有生成器的单个错误并运行，得到 target.json，内容必须是 title=report、status=final、items=[1,2,3]。保留实验文件，检查并交付目标。",
  "answer-control": "请直接回答 2+2 的结果，不创建文件。",
  "file-control": '请创建并检查 control.json，内容为 {"ok":true}，然后交付。',
};
console.log(JSON.stringify({ mode: live ? "live-continuation-after-scripted-bootstrap" : "scripted", root, endpoint, model: providers?.defaultModelKey ?? "scripted",
  kernelIndexSha256: createHash("sha256").update(readFileSync(resolve(appRoot, "../../packages/agentloop/dist/index.js"))).digest("hex") }));
try {
  for (const scenario of ["A", "B", "answer-control", "file-control"]) for (let attempt = 1; attempt <= (["A", "B"].includes(scenario) ? repeats : 1); attempt++) {
    currentCase = scenario;
    metrics = { liveCalls: 0, inputTokens: 0, outputTokens: 0, contexts: 0, maxContextCharacters: 0 };
    const conversationId = randomUUID();
    console.log(JSON.stringify({ event: "probe.started", scenario, attempt }));
    const dispatch = await fetch(`${endpoint}/v1/runtime-dispatches`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ schema: "agentloop.runtimeDispatch/v1", assignmentId: randomUUID(), dispatchKey: randomUUID(), subject: { tenantId: "probe", userId: owner }, conversationId,
        input: tasks[scenario], allowDangerousTools: true, resourceRefs: [] }) });
    if (!dispatch.ok) throw new Error(`Probe dispatch HTTP ${dispatch.status}`);
    const { remoteRunId } = await dispatch.json() as { remoteRunId: string };
    let status = await runs.get(owner, remoteRunId);
    const deadline = Date.now() + 180000;
    while (status.status === "running" && Date.now() < deadline) {
      if ((await runs.recoveryForRun(owner, remoteRunId)).state?.state === "waiting_recovery") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
      status = await runs.get(owner, remoteRunId);
    }
    if (status.status === "running") { await runs.cancel(owner, remoteRunId); status = await runs.get(owner, remoteRunId); }
    const events = await runs.events(owner, remoteRunId);
    let content: unknown;
    try { content = JSON.parse(await readFile(join(workspace, "conversations", conversationId, scenario === "file-control" ? "control.json" : "target.json"), "utf8")); } catch {}
    const actual = content as Record<string, unknown> | undefined;
    const contentPassed = scenario === "answer-control" ? /4/.test(status.output ?? "") : scenario === "file-control" ? actual?.ok === true
      : actual?.title === "report" && actual?.status === "final" && JSON.stringify(actual?.items) === "[1,2,3]";
    const terminal = events.some((event) => event.type === "terminal.delivery_committed");
    const plan = await runs.plan(owner, remoteRunId);
    const outcome = await database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?").get(remoteRunId) as { status: string; reason_code: string } | undefined;
    const calls = events.filter((event) => event.type === "assistant.committed").flatMap((event) =>
      Array.isArray(event.data.toolCalls) ? event.data.toolCalls as { name: string; arguments: unknown }[] : []);
    const signatures = calls.map((call) => JSON.stringify([call.name, call.arguments]));
    const report = { scenario, attempt, runId: remoteRunId, status: status.status, contentPassed, terminal,
      planStatus: plan.plan.status, approvedAssessments: plan.assessments.filter((assessment) => assessment.approved).length,
      outcomeStatus: outcome?.status, outcomeReason: outcome?.reason_code,
      repeatedToolRequests: signatures.length - new Set(signatures).size,
      sharedContextSeen: metrics.contexts > 0, ...metrics, toolCalls: events.filter((event) => event.type === "tool.completed").length,
      declarations: events.filter((event) => event.type === "assistant.committed" && event.data.workProductDeclaration !== undefined).length,
      observedEvents: events.filter((event) => event.type === "tool.completed" && event.data.workProductSequence !== undefined).length,
      ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
    };
    reports.push(report); console.log(JSON.stringify(report));
    if (status.status !== "completed" || !contentPassed || !terminal || outcome?.status !== "completed"
      || (scenario !== "answer-control" && !report.sharedContextSeen)) process.exitCode = 1;
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.close();
  await writeFile(join(root, "results.json"), JSON.stringify({ live, reports }, null, 2));
  console.log(JSON.stringify({ report: join(root, "results.json"), retainedForAudit: true }));
}
