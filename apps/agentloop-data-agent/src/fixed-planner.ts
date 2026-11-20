import type { Planner, PrivateSkill, TaskSpec } from "@zhujun/agentloop";

/** The product owns the workflow; the model owns all domain decisions within it. */
export function fixedDataAnalysisPlanner(skill: PrivateSkill): Planner {
  if (skill.name !== "data-analysis" || !skill.agentLoop?.executionProfiles?.includes("local_script")) {
    throw new Error("The data Agent requires the executable data-analysis Skill");
  }
  return {
    async plan(task: TaskSpec) {
      const intent = task.canonicalState.intent;
      const goal = intent.userInput;
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
          evidenceContract: { requiredKinds: task.responseOnly ? [] : ["source_summary"], caveatPolicy: "strict_fail_on_missing_source" },
          successCriteria: [
            { id: "business-answer", description: "按用户要求直接回答；每个事实均有真实目录、查询结果或已绑定 Result 依据。没有数据、NULL、策略拒绝和故障如实区分。", source: "task", blocking: true },
            { id: "skill-contract", description: "遵循固定 Skill 的实体、指标、时间与 SQL 校验流程；歧义已经用户确认，不猜编码、不放宽必要条件。", source: "planner", blocking: true },
          ],
        }],
      };
    },
  };
}
