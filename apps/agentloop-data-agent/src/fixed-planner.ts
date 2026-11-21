import { DEFAULT_MAX_PLANNING_TURNS, MAX_SUPPORTED_PLANNING_TURNS, type PlanProposal, type Planner, type PrivateSkill, type RuntimeEventSink, type TaskSpec } from "@zhujun/agentloop";

export interface FixedDataAnalysisPlannerOptions {
  /** Deployment-owned planning budget recorded on the Run even though this Planner is deterministic. */
  maxPlanningTurns?: number;
}

/** The product owns the workflow; the model owns all domain decisions within it. */
export function fixedDataAnalysisPlanner(skill: PrivateSkill, options: FixedDataAnalysisPlannerOptions = {}): Planner {
  if (skill.name !== "data-analysis" || !skill.agentLoop?.executionProfiles?.includes("local_script")) {
    throw new Error("The data Agent requires the executable data-analysis Skill");
  }
  const maxPlanningTurns = planningTurnLimit(options.maxPlanningTurns);
  return {
    async plan(task: TaskSpec, _signal?: AbortSignal, emit?: RuntimeEventSink) {
      await emit?.({
        type: "planning.started",
        data: {
          availableSkillCount: task.availableSkills.length,
          availableToolCount: task.availableToolNames.length,
          maxPlanningTurns,
          deterministic: true,
        },
      });
      await emit?.({
        type: "planning.turn.started",
        data: {
          turn: 1,
          loadedSkillCount: 0,
          pendingSkillCount: 0,
          hasRuntimeDirective: false,
          toolCount: task.availableToolNames.length,
          messageCount: 1,
          deterministic: true,
        },
      });
      const intent = task.canonicalState.intent;
      const goal = responseOnlyGoal(task);
      if (task.responseOnly === true) {
        const hasTools = task.availableToolNames.length > 0;
        const proposal: PlanProposal = {
          schema: "agentloop.outcomePlan/v2",
          shape: "single_leaf",
          goal: goal.trim().slice(0, 20_000) || "回答最新一轮用户消息",
          selectedSkillIds: [],
          selectedSkillRoles: [],
          steps: [{
            id: "response",
            kind: "leaf",
            role: "deliver",
            objective: hasTools
              ? "回答最新一轮用户消息。只使用当前 Run 已授权的工具（如确有必要），保留输入身份和口径；Result 引用或截断摘要不等于完整内容。对话模式不会额外授予执行权限。"
              : "直接依据已提供的上下文回答最新一轮用户消息。",
            dependencies: [],
            skillIds: [],
            requiredCapabilities: hasTools
              ? ["conversation_delivery", "authorized_tool_use"]
              : ["conversation_delivery"],
            ...(intent.requiredToolSourceIds.length > 0 ? {
              sourceConstraint: { requiredToolSourceIds: intent.requiredToolSourceIds },
            } : {}),
            targetIds: Object.keys(task.canonicalState.targets),
            successCriteria: [{
              id: "answered",
              description: hasTools
                ? "回答覆盖最新一轮用户请求，并使用必要的 Run 工具证据，保留重要不确定性。"
                : "返回非空的直接回答。",
              source: "planner",
              verification: hasTools ? "model_judged" : "deterministic",
            }],
          }],
        };
        await emitDeterministicPlanningCompletion(emit);
        return proposal;
      }
      const proposal: PlanProposal = {
        schema: "agentloop.outcomePlan/v2",
        shape: "single_leaf",
        goal,
        selectedSkillIds: [skill.id],
        selectedSkillRoles: [{ skillId: skill.id, role: "primary_builder", reason: "应用固定的问数工作流，无需模型选择主 Skill。" }],
        steps: [{
          id: "data-analysis",
          kind: "leaf",
          role: "deliver",
          objective: `${goal}\n遵循 data-analysis 的固定工具状态机：load_skill → retrieve-knowledge → get-query-context → 读取 plan_seed/semantic_bindings/semantic_gap_refs → get-metrics → 对会改变答案的歧义 request_human_loop → 从同一 plan_seed 生成 query_plan → 一次参数化、有限结果 SQL。恢复或修复时先复用本 Run 已成功的 query_context/plan_seed 和 HIL decision；HIL 解决语义缺口后必须在 query_plan 同时保留 resolved_gap_refs:[gap_id] 与 decision_refs:[{request_id,selected_option_id}]，让已回答缺口不再按 unresolved 阻断；目录版本未变化时不得重新 retrieve-knowledge 或重建前置上下文。读取 source/object/attribute/measure/time/term/relation 分层语义对象，在当前步骤内完成实体、指标、期间和粒度规划。实体可以先用模型假设驱动 candidate-lookup 等有限只读探查；用户直接给出物理编码时可直接在 SQL 中参数化使用，不要求名称解析或 entity_bindings；名称唯一命中时可保留 inferred 绑定，不触发 HIL；多个候选只有在会改变答案时才请求 HIL，结果口径相同或用户已提供编码时继续执行并记录选择证据或低风险警告；没有候选或来源无法确定时停止并报告语义缺口。不得把模糊候选直接当 selected_codes。query_plan 必须直接复制同一个 plan_seed，只增补本题所需绑定；禁止手写或删减 semantic_bindings，禁止加入 resolution_notes、domain_plan、user_decisions 等未知顶层字段。query_context.json 可直接作为 --query-plan 文件，执行器会提取其中的 plan_seed；执行请求文件只能放在 --request-json，不能同时再传 --query-plan。原样保留 semantic_model_version、semantic_bindings、semantic_gap_refs、catalog_revision、source_signatures，并只在确认没有 blocking semantic gap 或已用 HIL 决策解析该 gap 后生成 SQL。正式指标和具体期间补入同一个 query_plan；多时间格式必须明确 variant_id。查询结果需要后处理时只能调用声明的 compute-result，不能自行写或执行脚本；禁止用 computer_search_text、computer_write_file、python3 -c 或第二套连接处理数据；query_plan_* 同一错误只自动修复一次；计划包装或 schema 错误重复时报告技术阻塞，不请求用户选择内部 JSON 结构；HIL 只用于会改变答案的业务口径歧义，且不得改变用户要求的聚合粒度或改成原始明细。由当前模型通过 Skill 执行器提交带 query_plan 的受控 TiDB 查询，核对完整结果后回答；领域计划随实际 SQL 一起提交，不另建模型工作流。`,
          dependencies: [],
          skillIds: [skill.id],
          requiredCapabilities: ["skill_instruction_load", "skill_local_script_execution", `skill_source_provider.database.${skill.id}`, "conversation_delivery"],
          targetIds: Object.values(task.canonicalState.targets).filter(t => t.status !== "accepted").map(t => t.targetId),
          evidenceContract: { requiredKinds: ["source_summary"], caveatPolicy: "strict_fail_on_missing_source" },
          successCriteria: [
            { id: "business-answer", description: "按用户要求直接回答；每个事实均有真实目录、查询结果或已绑定 Result 依据。没有数据、NULL、策略拒绝和故障如实区分。", source: "task", blocking: true },
            { id: "skill-contract", description: "遵循固定 Skill 的实体、指标、时间与 SQL 校验流程；只对会改变答案的歧义请求用户确认，保留模型假设和有限探查证据。", source: "planner", blocking: true },
            { id: "semantic-plan-contract", description: "SQL 执行必须消费同一 get-query-context.plan_seed 的语义版本、来源签名、semantic_bindings 和 semantic_gap_refs；存在 blocking gap 或缺少 query_plan 时不得执行。", source: "planner", blocking: true },
          ],
        }],
      };
      await emitDeterministicPlanningCompletion(emit);
      return proposal;
    },
  };
}

async function emitDeterministicPlanningCompletion(emit: RuntimeEventSink | undefined): Promise<void> {
  await emit?.({
    type: "planning.turn.completed",
    data: {
      turn: 1,
      finishReason: "deterministic",
      toolCallCount: 0,
      loadSkillCallCount: 0,
      submitPlanCallCount: 0,
      submitOutcomePlanCallCount: 0,
      loadedSkillCount: 0,
      contentLength: 0,
      deterministic: true,
    },
  });
}

function planningTurnLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_PLANNING_TURNS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SUPPORTED_PLANNING_TURNS) {
    throw new TypeError(`maxPlanningTurns must be a positive safe integer no greater than ${MAX_SUPPORTED_PLANNING_TURNS}`);
  }
  return value;
}

function responseOnlyGoal(task: TaskSpec): string {
  const intent = task.canonicalState.intent;
  const effectiveGoal = intent.turnResolution?.effectiveGoal ?? intent.userInput;
  return [...new Set([
    effectiveGoal,
    ...(intent.turnResolution?.userConstraints ?? []),
    intent.userInput,
  ].map(value => value.trim()).filter(value => value.length > 0))].join("\n");
}
