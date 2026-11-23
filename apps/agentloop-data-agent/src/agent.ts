import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppDatabase, AppError, RunService, SkillService, type ModelFactory, type PrivateSkill, type SqlConnection } from "@zhujun/agentloop";
import { bundledSkillDirectories } from "@zhujun/agentloop-skills";
import { fixedDataAnalysisPlanner } from "./fixed-planner.ts";
import { acquireLease, type HostLeaseOptions } from "./tidb-state.ts";
import { fixedSkillExecutionPolicy } from "./skill-policy.ts";
import { dataAgentModel } from "./data-agent-model.ts";
import { DATA_AGENT_FILE_SKILL_NAMES } from "./file-export.ts";

export const OWNER = "data-agent-local-owner";
export interface AgentOptions {
  connection: SqlConnection;
  fileDirectory: string;
  skillRoot: string;
  python: string;
  modelFactory: ModelFactory;
  modelKeys: readonly string[];
  defaultModelKey: string;
  /** Deployment-owned Planner contract-repair budget. */
  maxPlanningTurns?: number;
  /** Deployment-owned model-turn budget for each executable Plan step. */
  stepMaxTurns?: number;
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
  let leaseLostError: Error | undefined;
  const leaseLostHandlers = new Set<(error: Error) => void>();
  const onLeaseLost: HostLeaseOptions["onLost"] = error => {
    if (leaseLostError) return;
    leaseLostError = error;
    for (const handler of leaseLostHandlers) handler(error);
  };
  try {
    lease = await acquireLease(options.connection, { onLost: onLeaseLost });
    const hostLease = lease;
    const workspaceRoot = join(options.fileDirectory, "workspace");
    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    const database = await AppDatabase.open({ connection: options.connection });
    await database.exec(`CREATE TABLE IF NOT EXISTS data_agent_mcp_calls (
      id VARCHAR(191) PRIMARY KEY, scenario_id VARCHAR(64) NOT NULL, started_at BIGINT NOT NULL,
      payload_json LONGTEXT NOT NULL
    )`);
    const skills = new SkillService(database, {
      skillDirectories: bundledSkillDirectories(),
      skillPackageRoots: [resolve(options.skillRoot)],
      packageStoreRoot: join(options.fileDirectory, "skill-packages"),
      selectVisibleSkills: ({ skills }) => skills.filter(s =>
        s.name === "data-analysis" || DATA_AGENT_FILE_SKILL_NAMES.includes(s.name as typeof DATA_AGENT_FILE_SKILL_NAMES[number])),
    });
    await skills.refreshSkillDirectory();
    const available = await skills.resolveForConversation(OWNER);
    let skill: PrivateSkill | undefined = available.find(s => s.name === "data-analysis");
    if (!skill) throw new Error("data-analysis Skill 无法加载，请检查应用内的 Skill 包。");
    let fileSkills = available.filter(s => DATA_AGENT_FILE_SKILL_NAMES.includes(s.name as typeof DATA_AGENT_FILE_SKILL_NAMES[number]));
    const missingFileSkills = DATA_AGENT_FILE_SKILL_NAMES.filter(name => !fileSkills.some(item => item.name === name));
    if (missingFileSkills.length) throw new Error(`文件 Skill 无法加载：${missingFileSkills.join(", ")}`);
    const runs = new RunService({
      database, skills, workspaceRoot, sourceStorageRoot: join(workspaceRoot, "sources"),
      ownerScopedWorkspace: true,
      modelFactory: (onRetry, modelKey) => dataAgentModel(options.modelFactory(onRetry, modelKey)),
      modelKeys: options.modelKeys, defaultModelKey: options.defaultModelKey,
      requireExplicitModel: true, timeZone: "Asia/Shanghai",
      preactivateSkillNames: ["data-analysis"],
      contextPolicy: {
        proactiveCompactionTokens: 36_000,
        preserveRecentTokens: 10_000,
        pruneProtectTokens: 8_000,
        summaryMaxOutputTokens: 1_500,
        summaryToolResultCharacters: 1_000,
        largeToolResultProjectionCharacters: 5_000,
        largeToolResultPreviewCharacters: 1_000,
        deferProactiveCompactionForArtifactEvidence: false,
      },
      maxToolResultCharacters: 12_000,
      maxParallelToolCalls: 5,
      allowDeterministicStructuredCandidates: true,
      ...(options.maxPlanningTurns === undefined ? {} : { maxPlanningTurns: options.maxPlanningTurns }),
      ...(options.stepMaxTurns === undefined ? {} : { maxSteps: options.stepMaxTurns }),
      runEventLogSink: options.runEventLogSink,
      plannerFactory: () => fixedDataAnalysisPlanner(skill!, fileSkills, {
        ...(options.maxPlanningTurns === undefined ? {} : { maxPlanningTurns: options.maxPlanningTurns }),
      }),
      toolExecutionPlugins: [await fixedSkillExecutionPolicy(skill, fileSkills)],
      computerExecutableAliases: { python3: options.python },
      computerCommandEnvironment: { PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      systemPrompt: [
        "你是集团经营问数 Agent。data-analysis 始终负责 group 场景的真实数据查询；文件 Skill 只在用户明确要求导出文件时启用。",
        "data-analysis 已由宿主在步骤开始时绑定并激活，不要再次调用 load_skill。明确要求 Excel/CSV、Word、PDF、PPT 或 HTML 看板时，再加载对应的 xlsx、docx、pdf、pptx 或 build-dashboard Skill。Markdown 使用安全工作区写文件工具，不虚构不存在的 Skill。",
        "目录和 SQL 查询只能通过此 Skill；不能自己建连接、读取凭据、调用另一个问数服务或使用记忆猜数据。",
        "文件必须消费 data-analysis 的真实查询 Result，不得为了导出重新查询、改写口径或编造数据。把结果写成 data-agent.file-export/v1 JSON 规格，再调用 data-analysis 清单中的 scripts/file_export.py 固定生成器；禁止编写或运行临时 Python/Node 生成脚本。最终文件写入工作区并绑定 deliveryTargetId，完成 verify_artifact_acceptance 后再交付。",
        "用户没有明确要求文件时，只返回聊天答案，不创建附件。用户要求文件时，最终回答简短说明文件已生成，下载入口由页面展示。",
        "用户只需看到答案和影响答案的口径；完整 SQL、参数、目录版本与回执留在当前 Run。",
        "过程正文每个阶段用一至三句自然语言说明当前判断、已确认的信息和下一步，保留对用户有用的真实来源、口径与阶段结论；避免 stdout、JSON、SQL、字段清单等内部细节，也避免‘让我先……’‘我先……’‘接下来我将……’等自言自语，不为前端展示编造过程。",
        "知识未命中、多个候选、字段格式未知或 SQL 失败先自主检索与有界只读探查；这些现象本身不触发 HIL。只有查证后仍有多个合理业务解释且答案不同、需要用户决定时才澄清。编码格式与内部计划错误由系统处理，不交给用户选择。",
        "执行 SQL 优先在 --request-json 内传 query_plan:{context_id:返回值}，服务端恢复完整证据，不手写 plan_seed，也不要再传 --query-plan。context_id 是不透明引用，禁止读取或猜测 .data-agent-contexts 隐藏文件；需要核对字段时只读取 get-query-context 命令自己声明的 --output 文件，并使用不带 @workspace/ 的相对文件名。期间编码缺失时先做完整的范围探查，将返回的 probe_ref 放入 query_plan.probe_refs，保留同样精确筛选，由执行器重新验证并承接技术编码；机器探查不填 HIL decision_refs 或 resolved_gap_refs。计划结构错误按诊断修复一次，仍失败就报告技术阻塞。",
        "不支持的工作说明范围；真实故障如实报告，不冒充无数据。同一失败命令和参数组合不得原样重复提交。",
        "Read each retrieve-knowledge output once initially using the focused fields supplied by the application. Paginate only when the relevant source or definition is actually missing; do not page merely to exhaust the catalog.",
        "When a data_client receipt contains model_summary, treat it as the primary decision view for the shown candidates and fields. Do not read the saved JSON or call read_result unless model_summary.more is true and the required source, definition, or field is actually absent.",
        "Once a source is selected, call get-query-context once with every already-known metric_ref and required column name. Do not follow it with get-metrics, search-columns, or get-columns for information that could have been requested in that same context call.",
        "When the user asks for counts inside an explicitly named dataset, calculate them inside that dataset. Do not add a reference or master table merely because it defines a similarly named total.",
        "Do not run a second verification query when the successful result already directly answers the question and there is no concrete conflict, truncation, NULL, or execution warning.",
        "The final answer must start with the business result, avoid internal narration such as information is ready or can now be submitted, and state each result only once. For a simple lookup, use at most three short bullets plus one necessary scope sentence.",
        "For data-analysis computer_run_command, command must be the string python3 and args must begin with scripts/data_client.py or scripts/file_export.py. File export may only use scripts/file_export.py with a data-agent.file-export/v1 JSON spec; never write or run a temporary executable script. Never place an object or array in command.",
        "For read_result, first read with resultId only. Never guess /sql or /sources; use only resultPointer from the Result envelope, and use computer_read_json for sourcePointer.",
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
      onHostLeaseLost(handler: (error: Error) => void) {
        if (leaseLostError) queueMicrotask(() => handler(leaseLostError!));
        else leaseLostHandlers.add(handler);
        return () => leaseLostHandlers.delete(handler);
      },
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
            const refreshed = await skills.resolveForConversation(OWNER);
            skill = refreshed.find(s => s.name === "data-analysis");
            fileSkills = refreshed.filter(s => DATA_AGENT_FILE_SKILL_NAMES.includes(s.name as typeof DATA_AGENT_FILE_SKILL_NAMES[number]));
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
          let releaseError: unknown;
          try { await hostLease.release(); } catch (error) { releaseError = error; }
          try { await database.close(); } catch (error) {
            // Always attempt both cleanup phases. A lost lease commonly means
            // the release UPDATE can fail for the same database outage; that
            // must not leave the pool alive and keep shutdown hanging.
            if (releaseError === undefined) throw error;
          }
          if (releaseError !== undefined) throw releaseError;
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
