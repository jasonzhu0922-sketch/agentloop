import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppDatabase, AppError, RunService, SkillService, type ModelFactory, type PrivateSkill, type SqlConnection } from "@zhujun/agentloop";
import { fixedDataAnalysisPlanner } from "./fixed-planner.ts";
import { acquireLease } from "./tidb-state.ts";
import { fixedSkillExecutionPolicy } from "./skill-policy.ts";

export const OWNER = "data-agent-local-owner";
export interface AgentOptions {
  connection: SqlConnection;
  fileDirectory: string;
  skillRoot: string;
  python: string;
  modelFactory: ModelFactory;
  modelKeys: readonly string[];
  defaultModelKey: string;
  runEventLogSink?: (line: string) => void;
}
export interface StartMessage { requestId: string; conversationId: string; input: string; modelKey: string }

export interface DataAgentMcpCall {
  id: string;
  tool: string;
  scenarioId: string;
  status: string;
  runId?: string;
  requestId?: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  arguments: Record<string, unknown>;
  events: readonly Record<string, unknown>[];
  result?: unknown;
  error?: string;
}

export interface DataAgentMcpCallStore {
  save(call: DataAgentMcpCall, create?: boolean): Promise<void>;
  list(limit?: number): Promise<readonly DataAgentMcpCall[]>;
  get(id: string): Promise<DataAgentMcpCall | undefined>;
}

export async function createDataAgent(options: AgentOptions) {
  if (options.connection.dialect !== "tidb") throw new TypeError("问数 Agent 仅支持 TiDB 持久化");
  let lease: Awaited<ReturnType<typeof acquireLease>> | undefined;
  try {
    lease = await acquireLease(options.connection);
    const hostLease = lease;
    const workspaceRoot = join(options.fileDirectory, "workspace");
    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    const database = await AppDatabase.open({ connection: options.connection });
    await database.exec(`CREATE TABLE IF NOT EXISTS data_agent_mcp_calls (
      id VARCHAR(191) PRIMARY KEY, scenario_id VARCHAR(64) NOT NULL, started_at BIGINT NOT NULL,
      payload_json LONGTEXT NOT NULL
    )`);
    const skills = new SkillService(database, {
      skillPackageRoots: [resolve(options.skillRoot)],
      packageStoreRoot: join(options.fileDirectory, "skill-packages"),
      selectVisibleSkills: ({ skills }) => skills.filter(s => s.name === "data-analysis"),
    });
    await skills.refreshSkillDirectory();
    const available = await skills.resolveForConversation(OWNER);
    let skill: PrivateSkill | undefined = available.find(s => s.name === "data-analysis");
    if (!skill) throw new Error("data-analysis Skill 无法加载，请检查应用内的 Skill 包。");
    const runs = new RunService({
      database, skills, workspaceRoot, sourceStorageRoot: join(workspaceRoot, "sources"),
      ownerScopedWorkspace: true,
      modelFactory: options.modelFactory, modelKeys: options.modelKeys, defaultModelKey: options.defaultModelKey,
      requireExplicitModel: true, timeZone: "Asia/Shanghai",
      runEventLogSink: options.runEventLogSink,
      plannerFactory: () => fixedDataAnalysisPlanner(skill!),
      toolExecutionPlugins: [await fixedSkillExecutionPolicy(skill)],
      computerExecutableAliases: { python3: options.python },
      computerCommandEnvironment: { PYTHONDONTWRITEBYTECODE: "1" },
      systemPrompt: [
        "你是集团经营问数 Agent。应用已固定 data-analysis 主 Skill 和 group 场景，不选择或推荐其他 Skill。",
        "先 load_skill 加载该 Skill，并按其 references 与正式执行动作完成领域推理、SQL、核对和回答。",
        "目录和 SQL 查询只能通过此 Skill；不能自己建连接、读取凭据、调用另一个问数服务或使用记忆猜数据。",
        "用户只需看到答案和影响答案的口径；完整 SQL、参数、目录版本与回执留在当前 Run。",
        "不支持的工作说明范围；实体、指标或期间歧义使用 request_human_loop。真实故障如实报告，不冒充无数据。",
      ].join("\n"),
    });
    // This app's admission ledger binds client retries in the same transaction as the Kernel Run.
    await database.exec(`CREATE TABLE IF NOT EXISTS data_agent_requests (
      request_id VARCHAR(191) PRIMARY KEY, fingerprint VARCHAR(64) NOT NULL, run_id VARCHAR(191) NOT NULL UNIQUE
    )`);
    await runs.reconcileInterruptedRuns();
    let queue = Promise.resolve();
    let closing = false;
    let closeOperation: Promise<void> | undefined;
    const inFlight = new Set<string>();
    let modelKeys = options.modelKeys;
    function start(message: StartMessage) {
      const operation = queue.then(async () => {
        if (closing) throw new AppError("CONFLICT", "服务正在关闭", 409);
        await hostLease.assert();
        if (!modelKeys.includes(message.modelKey)) throw new AppError("BAD_REQUEST", "模型不可用", 400);
        const fingerprint = createHash("sha256").update(JSON.stringify(message)).digest("hex");
        const prior = await database.prepare("SELECT fingerprint, run_id FROM data_agent_requests WHERE request_id = ?")
          .get(message.requestId) as { fingerprint: string; run_id: string } | undefined;
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new AppError("CONFLICT", "该请求 ID 已用于不同消息", 409);
          return runs.get(OWNER, prior.run_id);
        }
        const active = await database.prepare("SELECT id FROM runs WHERE owner_user_id = ? AND conversation_id = ? AND status = 'running'")
          .get(OWNER, message.conversationId);
        if (active) throw new AppError("CONFLICT", "请先完成或停止当前查询", 409);
        if (inFlight.size >= 4) throw new AppError("CONFLICT", "查询并发已满，请稍后重试", 429);
        await runs.ensureConversation(OWNER, message.conversationId, message.input);
        const run = await runs.startConversation(OWNER, message.input, {
          conversationId: message.conversationId, modelKey: message.modelKey, allowDangerousTools: true,
        }, { persist: async record => {
          await database.prepare("INSERT INTO data_agent_requests(request_id, fingerprint, run_id) VALUES (?, ?, ?)")
            .run(message.requestId, fingerprint, record.id);
        } });
        inFlight.add(run.id);
        void runs.whenRunIdle(run.id).finally(() => inFlight.delete(run.id));
        return run;
      });
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    }
    const mcpCalls: DataAgentMcpCallStore = {
      async save(call, create = false) {
        let payload = JSON.stringify(call);
        // MCP records are an audit projection. Keep large result bodies and
        // caller payloads out of TiDB; the canonical Run and its file receipts
        // remain the source of complete output evidence.
        if (payload.length > 900_000) payload = JSON.stringify({
          ...call,
          arguments: { keys: Object.keys(call.arguments), truncated: true },
          events: call.events.slice(-20),
          result: undefined,
          payload_truncated: true,
        });
        if (payload.length > 1_000_000) payload = JSON.stringify({ id: call.id, tool: call.tool, scenarioId: call.scenarioId, status: call.status,
          runId: call.runId, startedAt: call.startedAt, finishedAt: call.finishedAt, durationMs: call.durationMs,
          arguments: {}, events: [], payload_truncated: true });
        if (create) {
          await database.prepare("INSERT INTO data_agent_mcp_calls(id, scenario_id, started_at, payload_json) VALUES (?, ?, ?, ?)")
            .run(call.id, call.scenarioId, call.startedAt, payload);
        } else {
          await database.prepare("UPDATE data_agent_mcp_calls SET payload_json = ? WHERE id = ? AND scenario_id = ?")
            .run(payload, call.id, call.scenarioId);
        }
      },
      async list(limit = 50) {
        const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
        const rows = await database.prepare("SELECT payload_json FROM data_agent_mcp_calls ORDER BY started_at DESC, id DESC LIMIT ?").all(bounded) as { payload_json: string }[];
        return rows.map(row => JSON.parse(row.payload_json) as DataAgentMcpCall);
      },
      async get(id) {
        const row = await database.prepare("SELECT payload_json FROM data_agent_mcp_calls WHERE id = ?").get(id) as { payload_json: string } | undefined;
        return row ? JSON.parse(row.payload_json) as DataAgentMcpCall : undefined;
      },
    };
    return {
      runs, start, mcpCalls,
      get defaultModelKey() { return options.defaultModelKey; },
      get skill() { return { id: skill!.id, name: skill!.name, contentHash: skill!.contentHash }; },
      setModelKeys(keys: readonly string[]) { modelKeys = keys; runs.setModelKeys(keys); },
      /** Serialize host configuration with Run admission, including waiting HIL. */
      configure<T>(action: () => Promise<T>, refreshPackage = false): Promise<T> {
        const operation = queue.then(async () => {
          if (closing) throw new AppError("CONFLICT", "应用正在关闭", 409);
          await hostLease.assert();
          const active = await database.prepare("SELECT id FROM runs WHERE owner_user_id = ? AND status NOT IN ('completed', 'failed', 'cancelled') LIMIT 1").get(OWNER);
          if (active) throw new AppError("CONFLICT", "请先完成或停止正在进行的分析，再保存配置", 409);
          const result = await action();
          if (refreshPackage) {
            await skills.refreshSkillDirectory();
            skill = (await skills.resolveForConversation(OWNER)).find(s => s.name === "data-analysis");
            if (!skill) throw new Error("data-analysis Skill 无法加载");
          }
          return result;
        });
        queue = operation.then(() => undefined, () => undefined);
        return operation;
      },
      close() {
        return closeOperation ??= (async () => {
          closing = true;
          await queue;
          // Shutdown owns cancellation; closing a database beneath live model/tool work is unsafe.
          // A terminal Run may still be unwinding its persisted delivery events.
          // Include it when awaiting liveness, especially after a resumed HIL.
          const rows = await database.prepare("SELECT id, status FROM runs WHERE owner_user_id = ?").all(OWNER) as { id: string; status: string }[];
          for (const row of rows) {
            if (await runs.currentHumanLoop(OWNER, row.id)) await runs.whenRunIdle(row.id);
            else if (row.status === "running" && runs.isRunExecuting(row.id)) await runs.cancel(OWNER, row.id);
          }
          await Promise.all([...new Set([...inFlight, ...rows.map(r => r.id)])].map(id => runs.whenRunIdle(id)));
          await hostLease.release();
          await database.close();
        })();
      },
    };
  } catch (error) {
    // Cleanup must not replace the initialization failure with a closed-pool error.
    try { await lease?.release(); } catch { /* AppDatabase may already have closed the connection. */ }
    try { await options.connection.close(); } catch { /* Preserve the original initialization error. */ }
    throw error;
  }
}
export type DataAgent = Awaited<ReturnType<typeof createDataAgent>>;
