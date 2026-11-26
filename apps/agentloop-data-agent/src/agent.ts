import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppDatabase, AppError, RunService, SkillService, openRuntimeState, runtimePersistence, RuntimeHostStateRepository, RuntimeRecordMaintenance, FileRuntimeArchiveStore, createRuntimeHistory, RuntimeHistoryView, type RuntimeHistoryConfig, type RuntimeHistoryStore, type RuntimeArchiveStore, type RuntimeStateConfig, type RuntimePersistence, type ModelFactory, type PrivateSkill, type SqlConnection } from "@zhujun/agentloop";
import { fixedDataAnalysisPlanner } from "./fixed-planner.ts";
import { fixedSkillExecutionPolicy } from "./skill-policy.ts";

export const OWNER = "data-agent-local-owner";
export interface AgentOptions {
  /** Catalogue/control persistence, separate from Runtime execution state. */
  connection: SqlConnection;
  stateConfig?: RuntimeStateConfig;
  /** Stable deployment partition; different live processes must use different IDs. */
  runtimeId?: string;
  runtimeHistoryConfig?: RuntimeHistoryConfig;
  runtimeHistoryStore?: RuntimeHistoryStore;
  runtimeArchiveStore?: RuntimeArchiveStore;
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
  let state: RuntimePersistence | undefined;
  let maintenance: RuntimeRecordMaintenance | undefined;
  let history: ReturnType<typeof createRuntimeHistory> | undefined;
  let database: AppDatabase | undefined;
  if ("runtimeState" in options && options.runtimeState) throw new TypeError("Legacy changeset state requires explicit migration; use stateConfig");
  if (!options.stateConfig && options.connection.dialect !== "sqlite") throw new TypeError("Runtime execution requires sqlite or redis stateConfig");
  try {
    const workspaceRoot = join(options.fileDirectory, "workspace");
    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    database = await AppDatabase.open({ connection: options.connection });
    state = options.stateConfig ? await openRuntimeState(options.stateConfig) : runtimePersistence(database);
    const archiveStore = options.runtimeArchiveStore ?? new FileRuntimeArchiveStore(join(options.fileDirectory, "runtime-archives"));
    if (state.historyOutbox) history = createRuntimeHistory({ state, namespace: options.stateConfig!.backend === "redis" ? options.stateConfig!.namespace : "sqlite",
      config: options.runtimeHistoryConfig, store: options.runtimeHistoryStore, content: archiveStore,
      onError: error => console.error("Runtime history projection:", error.message) });
    history?.worker?.start();
    const runtimeId = options.runtimeId ?? `${hostname()}:${process.env.DATA_AGENT_PORT ?? process.env.REPORT_AGENT_PORT ?? "local"}`;
    const hostState = new RuntimeHostStateRepository(state, "data-agent");
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
    executionRuntimeId: runtimeId,
      database: state, skills, workspaceRoot, sourceStorageRoot: join(workspaceRoot, "sources"),
      ownerScopedWorkspace: true,
      modelFactory: options.modelFactory, modelKeys: options.modelKeys, defaultModelKey: options.defaultModelKey,
      requireExplicitModel: true, timeZone: "Asia/Shanghai",
      ...(options.maxPlanningTurns === undefined ? {} : { maxPlanningTurns: options.maxPlanningTurns }),
      ...(options.stepMaxTurns === undefined ? {} : { maxSteps: options.stepMaxTurns }),
      runEventLogSink: options.runEventLogSink,
      plannerFactory: () => fixedDataAnalysisPlanner(skill!, {
        ...(options.maxPlanningTurns === undefined ? {} : { maxPlanningTurns: options.maxPlanningTurns }),
      }),
      toolExecutionPlugins: [await fixedSkillExecutionPolicy(skill)],
      computerExecutableAliases: { python3: options.python },
      computerCommandEnvironment: { PYTHONDONTWRITEBYTECODE: "1" },
      systemPrompt: [
        "你是集团经营问数 Agent。应用已固定 data-analysis 主 Skill 和 group 场景，不选择或推荐其他 Skill。",
        "先 load_skill 加载该 Skill，并按其 references 与正式执行动作完成领域推理、SQL、核对和回答。",
        "目录和 SQL 查询只能通过此 Skill；不能自己建连接、读取凭据、调用另一个问数服务或使用记忆猜数据。",
        "工具状态机固定为 load_skill → retrieve-knowledge → get-query-context → 读取 plan_seed/绑定 → get-metrics → 歧义立即 request_human_loop → 同一 plan_seed 生成 query_plan → 一次受控 SQL；恢复时优先复用本 Run 已成功的 query_context、plan_seed 和 HIL decision，目录版本未变化时不得重做前置检索。HIL 解决语义缺口后，在 query_plan 同时写入 resolved_gap_refs:[gap_id] 和 decision_refs:[{request_id,selected_option_id}]，不能让已回答的缺口继续以 unresolved 阻断，也不能删除 semantic_bindings 绕过。query_context 文件可以直接作为 --query-plan，执行器会提取 plan_seed；request-json 文件与 --query-plan 二选一，不能同时传入。禁止手写或删减 semantic_bindings，禁止把 resolution_notes、domain_plan、user_decisions 放进 query_plan 顶层。结果后处理只能用声明的 compute-result，禁止用 computer_search_text、computer_write_file、python3 -c 或临时脚本绕过 Skill，query_plan_* 同一错误只自动修复一次；计划包装或 schema 错误重复时报告技术阻塞，不请求用户选择内部 JSON 结构；HIL 只用于会改变答案的业务口径歧义，且不得改变用户要求的聚合粒度或降级为原始明细。",
        "用户只需看到答案和影响答案的口径；完整 SQL、参数、目录版本与回执留在当前 Run。",
        "不支持的工作说明范围；只有实体候选会改变答案、没有候选/来源，或指标与期间业务定义会改变答案时才使用 request_human_loop。用户已给出的物理编码、唯一命中和可证明同口径候选直接继续；计划包装、schema、绑定字段和执行器错误属于技术故障，自动修复一次后如实报告，不向用户询问内部 JSON。",
      ].join("\n"),
    });
    if (options.stateConfig) {
      maintenance = new RuntimeRecordMaintenance({ state, namespace: options.stateConfig.backend === "redis" ? options.stateConfig.namespace : options.stateConfig.filename,
        archive: archiveStore, artifacts: runId => runs.processArtifacts(OWNER, runId),
        artifactContent: async artifact => (await runs.readProcessArtifact(OWNER,artifact.runId,artifact.id)).content });
      maintenance.start();
    }
    await runs.initializeRunEvents();
    const owned = options.stateConfig ? (await state.records.find("runtime_executors", { runtime_id: runtimeId })).map(row => row.remote_run_id) : undefined;
    await runs.reconcileInterruptedRuns(owned);
    let queue = Promise.resolve();
    let closing = false;
    let closeOperation: Promise<void> | undefined;
    const inFlight = new Set<string>();
    let modelKeys = options.modelKeys;
    function start(message: StartMessage) {
      const operation = queue.then(async () => {
        if (closing) throw new AppError("CONFLICT", "服务正在关闭", 409);
        if (!modelKeys.includes(message.modelKey)) throw new AppError("BAD_REQUEST", "模型不可用", 400);
        const fingerprint = createHash("sha256").update(JSON.stringify(message)).digest("hex");
        const prior = await hostState.request(message.requestId);
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new AppError("CONFLICT", "该请求 ID 已用于不同消息", 409);
          return runs.get(OWNER, prior.runId);
        }
        const active = (await state!.records.find("runs", { owner_user_id: OWNER, conversation_id: message.conversationId, status: "running" }))[0];
        if (active) throw new AppError("CONFLICT", "请先完成或停止当前查询", 409);
        if (inFlight.size >= 4) throw new AppError("CONFLICT", "查询并发已满，请稍后重试", 429);
        await runs.ensureConversation(OWNER, message.conversationId, message.input);
        const run = await runs.startConversation(OWNER, message.input, {
          conversationId: message.conversationId, modelKey: message.modelKey, allowDangerousTools: true,
        }, { persist: async record => {
          await hostState.admit({ requestId: message.requestId, fingerprint, runId: record.id, ownerUserId: OWNER, runtimeId,
            conversationId: message.conversationId });
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
        await hostState.observe({ id: call.id, category: call.scenarioId, createdAt: call.startedAt, payload: JSON.parse(payload) }, create);
      },
      async list(limit = 50) { return await hostState.observations(limit) as DataAgentMcpCall[]; },
      async get(id) { return await hostState.observation(id) as DataAgentMcpCall | undefined; },
    };

    return {
      runs, start, mcpCalls,
      history: history ? new RuntimeHistoryView(state, history.reader, runs, archiveStore) : undefined,
      historyStatus: async () => ({ source: history ? "tidb" : "sqlite", archive: maintenance?.status(), ...(await state!.historyOutbox?.status() ?? {}) }),
      runtimeStateStatus: () => ({ backend: options.stateConfig?.backend ?? "sqlite", history: history ? "tidb" : "sqlite" }),
      get defaultModelKey() { return options.defaultModelKey; },
      get skill() { return { id: skill!.id, name: skill!.name, contentHash: skill!.contentHash }; },
      setModelKeys(keys: readonly string[]) { modelKeys = keys; runs.setModelKeys(keys); },
      onHostLeaseLost(_handler: (error: Error) => void) { return () => {}; },
      /** Serialize host configuration with Run admission, including waiting HIL. */
      configure<T>(action: () => Promise<T>, refreshPackage = false): Promise<T> {
        const operation = queue.then(async () => {
          if (closing) throw new AppError("CONFLICT", "应用正在关闭", 409);
          const active = (await state!.records.find("runs", { owner_user_id: OWNER, status: "running" }))[0];
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
          const rows = await state!.records.find("runs", { owner_user_id: OWNER });
          for (const row of rows) {
            if (await runs.currentHumanLoop(OWNER, row.id)) await runs.whenRunIdle(row.id);
            else if (row.status === "running" && runs.isRunExecuting(row.id)) await runs.cancel(OWNER, row.id);
          }
          await Promise.all([...new Set([...inFlight, ...rows.map(r => r.id)])].map(id => runs.whenRunIdle(id)));
          await runs.closeRunEvents();
          await maintenance?.close(); await history?.close();
          if (options.stateConfig) await state!.close();
          await database!.close();
        })();
      },
    };
  } catch (error) {
    // Cleanup must not replace the initialization failure with a closed-pool error.
    try { await maintenance?.close(); await history?.close(); if (options.stateConfig) await state?.close(); await database?.close(); } catch { /* Preserve initialization error. */ }
    try { await options.connection.close(); } catch { /* Preserve the original initialization error. */ }
    throw error;
  }
}
export type DataAgent = Awaited<ReturnType<typeof createDataAgent>>;
