import type { Planner, PrivateSkill, TaskSpec } from "@zhujun/agentloop";

/** The product owns the workflow; the model owns all domain decisions within it. */
export function fixedDataAnalysisPlanner(skill: PrivateSkill): Planner {
  if (skill.name !== "data-analysis" || !skill.agentLoop?.executionProfiles?.includes("local_script")) {
    throw new Error("The data Agent requires the executable data-analysis Skill");
  }
  return {
    async plan(task: TaskSpec) {
      const intent = task.canonicalState.intent;
      const goal = responseOnlyGoal(task);
      if (task.responseOnly === true) {
        const hasTools = task.availableToolNames.length > 0;
        return {
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
      }
      return {
        schema: "agentloop.outcomePlan/v2",
        shape: "single_leaf",
        goal,
        selectedSkillIds: [skill.id],
        selectedSkillRoles: [{ skillId: skill.id, role: "primary_builder", reason: "应用固定的问数工作流，无需模型选择主 Skill。" }],
        steps: [{
          id: "data-analysis",
          kind: "leaf",
          role: "deliver",
          objective: `${goal}\n遵循 data-analysis：先读当前目录，在当前步骤内完成实体、指标、期间和粒度的领域规划；存在业务歧义时请求结构化 HIL；由当前模型生成 SQL，通过 Skill 执行器受控查询 TiDB，核对完整结果后回答。领域计划随实际 SQL 一起提交，不另建模型工作流。`,
          dependencies: [],
          skillIds: [skill.id],
          requiredCapabilities: ["skill_instruction_load", "skill_local_script_execution", `skill_source_provider.database.${skill.id}`, "conversation_delivery"],
          targetIds: Object.values(task.canonicalState.targets).filter(t => t.status !== "accepted").map(t => t.targetId),
          evidenceContract: { requiredKinds: ["source_summary"], caveatPolicy: "strict_fail_on_missing_source" },
          successCriteria: [
            { id: "business-answer", description: "按用户要求直接回答；每个事实均有真实目录、查询结果或已绑定 Result 依据。没有数据、NULL、策略拒绝和故障如实区分。", source: "task", blocking: true },
            { id: "skill-contract", description: "遵循固定 Skill 的实体、指标、时间与 SQL 校验流程；歧义已经用户确认，不猜编码、不放宽必要条件。", source: "planner", blocking: true },
          ],
        }],
      };
    },
  };
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
