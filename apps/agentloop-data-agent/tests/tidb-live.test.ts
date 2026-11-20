import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import mysql from "mysql2/promise";
import { inspectSkillPackage, removeSkillPackage, type ModelInvocation, type ModelResponse } from "@zhujun/agentloop";
import { createDataAgent, OWNER, type DataAgent } from "../src/agent.ts";
import { connectState } from "../src/tidb-state.ts";

const stateUrl = process.env.DATA_AGENT_TIDB_URL;
function call(name: string, args: Record<string, unknown>): ModelResponse {
  return { content: "", finishReason: "tool_calls", toolCalls: [{ id: randomUUID(), name, arguments: args }] };
}
const pause = () => new Promise(resolve => setTimeout(resolve, 80));
async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const until = Date.now() + 45_000;
  while (true) { const value = await read(); if (ready(value)) return value; if (Date.now() > until) throw new Error("Live fixture timed out"); await pause(); }
}

test("real TiDB Kernel: fixed binding, native HIL, idempotency, disk evidence and reopen", { skip: !stateUrl, timeout: 300_000 }, async (t) => {
  const url = new URL(stateUrl!);
  const admin = await mysql.createConnection({ host: url.hostname, port: Number(url.port || 4000), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    ...(url.searchParams.get("ssl") === "true" ? { ssl: {} } : {}) });
  const schema = `data_agent_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  const testUrl = new URL(url); testUrl.pathname = `/${schema}`;
  const root = await mkdtemp(join(tmpdir(), "data-agent-live-"));
  const skillRoot = join(root, "data-analysis");
  await mkdir(join(skillRoot, "scripts"), { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "---\nname: data-analysis\ndescription: Query fixture evidence\n---\nLoad this Skill, confirm the scope using HIL, then run scripts/probe.py. Answer using its sample value.\n");
  await writeFile(join(skillRoot, "agentloop.skill.json"), JSON.stringify({ schema: "agentloop.skillDeclaration/v1", identity: { name: "data-analysis", description: "Query fixture evidence" },
    activation: { semanticTags: ["data-query"], intentExamples: ["查询样本数值"] },
    workflow: { roles: ["primary_builder", "source_provider"], sourceKinds: ["database"], artifactKinds: ["none"], qaKinds: [], requiredSkills: [] },
    execution: { manifest: "agentloop.executors.json" }, compatibility: { executionProfiles: ["local_script"], producesEvidenceKinds: ["source_summary", "record_counts"] } }));
  await writeFile(join(skillRoot, "agentloop.executors.json"), JSON.stringify({ schema: "agentloop.skillExecutors/v1", executors: [{ id: "probe", description: "Fixture probe", command: "python3", script: "scripts/probe.py", actions: [{ id: "query", description: "Read fixture", result: "Sample and complete evidence file receipt", inputs: [{ name: "output", description: "Output file", required: true }], args: ["--output", "{{output}}"], producesEvidenceKinds: ["source_summary", "record_counts"] }] }] }));
  await writeFile(join(skillRoot, "scripts/probe.py"), `import json,sys,pathlib,hashlib\np=pathlib.Path(sys.argv[2]);p.parent.mkdir(parents=True,exist_ok=True)\nb=b'fixture data\\n'*200000\np.write_bytes(b)\nprint(json.dumps({'sample':42,'path':str(p),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'evidenceReceipt':{'schema':'agentloop.toolEvidenceReceipt/v1','evidenceKinds':{'satisfied':['source_summary','record_counts'],'caveated':[],'failed':[]}}}))\n`);
  let agent: DataAgent | undefined;
  let execution = 0, plannerCalls = 0;
  const model = {
    limits: { contextWindowTokens: 1_000_000, maxOutputTokens: 8192 },
    async complete(request: ModelInvocation): Promise<ModelResponse> {
      if (request.runId.startsWith("conversation-turn:")) return call("resolve_conversation_turn", {
        mode: "execute", relation: "new_goal", inputMode: "none", effectiveGoal: "查询样本数值", evidenceStrategy: "source_grounded",
        sourceBinding: { mode: "none", visibleDirectoryIds: [] }, userConstraints: [], memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: [],
        taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "lookup", requiresExecution: true, deliverables: [{ targetId: "answer", purpose: "查询样本数值", expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }] },
      });
      if (request.phase === "planning") { plannerCalls++; throw new Error("The fixed app must not ask the model to choose a Skill"); }
      const assessment = request.tools.find(t => t.name === "submit_assessment");
      if (assessment) {
        const properties = (assessment.inputSchema as any).properties;
        const criteria = properties.criteria.items.properties.criterionId.enum as string[];
        const skills = properties.skills.items.properties.skillId.enum as string[];
        return call("submit_assessment", { criteria: criteria.map(criterionId => ({ criterionId, satisfied: true, rationale: "The completed probe Result contains sample 42.", evidenceRefs: ["candidateOutput"], contractCheck: { status: "valid", rationale: "Matches the requested sample" } })),
          skills: skills.map(skillId => ({ skillId, status: "followed", followed: true, rationale: "Loaded the Skill and completed the declared probe after HIL", evidenceRefs: ["load_skill"] })), feedback: "", failedBoundary: null, concernResolutions: [] });
      }
      assert.equal(request.tools.some(t => /memory_recall|execution_insight/.test(t.name)), false);
      execution++;
      if (execution === 1) return call("load_skill", { name: "data-analysis" });
      if (execution === 2) return call("request_human_loop", { kind: "selection", title: "确认范围", prompt: "请选择样本范围", rationale: "Fixture scope", evidenceRefs: [], responseSchema: { type: "select", minSelections: 1, maxSelections: 1, options: [{ id: "confirmed", label: "样本范围" }] }, resume: { mode: "continue_step" } });
      if (execution === 3) return call("computer_run_command", { command: "python3", cwd: "@skills/data-analysis", args: ["scripts/probe.py", "--output", "@workspace/large-evidence.csv"] });
      return { content: "样本数值为 42。", finishReason: "stop", toolCalls: [] };
    },
  };
  const options = { fileDirectory: join(root, "files"), skillRoot, python: process.env.DATA_AGENT_PYTHON ?? "python3", modelFactory: () => model, modelKeys: ["test"], defaultModelKey: "test" };
  try {
    t.diagnostic("Initializing real TiDB runtime");
    await inspectSkillPackage(skillRoot);
    agent = await createDataAgent({ ...options, connection: await connectState(testUrl.toString()) });
    const message = { requestId: randomUUID(), conversationId: randomUUID(), input: "查询样本数值", modelKey: "test" };
    const run = await agent.start(message); t.diagnostic("Run started: " + run.id);
    const retry = await agent.start(message);
    assert.equal(retry.id, run.id);
    await assert.rejects(agent.start({ ...message, input: "Different" }), /不同消息/);
    const hil = await waitFor(async () => {
      const current = await agent!.runs.get(OWNER, run.id);
      if (current.status !== "running") assert.fail(JSON.stringify((await agent!.runs.events(OWNER, run.id)).filter(e => /failed|rejected/.test(e.type))));
      return agent!.runs.currentHumanLoop(OWNER, run.id);
    }, value => Boolean(value));
    t.diagnostic("Native HIL persisted");
    assert.equal(execution, 2, "query cannot execute before user confirmation");
    await agent.close(); agent = undefined; t.diagnostic("Host closed");
    agent = await createDataAgent({ ...options, connection: await connectState(testUrl.toString()) });
    assert.equal((await agent.runs.currentHumanLoop(OWNER, run.id))!.id, hil!.id, "paused HIL survives host restart");
    await assert.rejects(agent.runs.respondHumanLoop(OWNER, run.id, hil!.id, ["confirmed"], hil!.revision + 1));
    t.diagnostic("Host reopened with HIL");
    await agent.runs.respondHumanLoop(OWNER, run.id, hil!.id, ["confirmed"], hil!.revision);
    const completed = await waitFor(() => agent!.runs.get(OWNER, run.id), value => value.status !== "running");
    const events = await agent.runs.events(OWNER, run.id);
    assert.equal(completed.status, "completed", JSON.stringify(events.filter(e => /failed|rejected/.test(e.type))));
    assert.match(completed.output!, /42/);
    const { plan } = await agent.runs.plan(OWNER, run.id);
    assert.deepEqual(plan.selectedSkillIds, [agent.skill.id]); assert.equal(plannerCalls, 0);
    assert.ok(events.some(e => e.type === "human_loop.answered"));
    assert.equal(events.some(e => e.type.startsWith("memory.")), false);
    const evidence = events.find(e => e.type === "tool.completed" && e.data.toolName === "computer_run_command");
    assert.ok(evidence, "declared Skill command must complete");
    const [sizes] = await admin.query(`SELECT MAX(OCTET_LENGTH(metadata_json)) AS bytes FROM \`${schema}\`.runtime_actions`);
    assert.ok(Number((sizes as { bytes: number }[])[0].bytes) < 1_000_000, "large file bytes stay off TiDB Action rows");
    const diskFile = join(options.fileDirectory, "workspace", "users");
    const files = await readdir(diskFile, { recursive: true });
    const saved = join(diskFile, files.find(name => name.endsWith('large-evidence.csv'))!);
    assert.ok((await stat(saved)).size > 2_000_000);
    await agent.close(); agent = undefined; t.diagnostic("Host closed");
    agent = await createDataAgent({ ...options, connection: await connectState(testUrl.toString()) });
    assert.equal((await agent.runs.getConversation(OWNER, message.conversationId)).runs[0].id, run.id);
    assert.equal((await agent.start(message)).id, run.id);
    assert.ok((await readFile(saved)).length > 2_000_000);
    const [memoryTables] = await admin.query(`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME LIKE 'memory%'`, [schema]);
    assert.deepEqual(memoryTables, []);
  } finally {
    await agent?.close();
    await removeSkillPackage(join(options.fileDirectory, "skill-packages"));
    await rm(root, { recursive: true, force: true });
    await admin.query(`DROP DATABASE \`${schema}\``); await admin.end();
  }
});
