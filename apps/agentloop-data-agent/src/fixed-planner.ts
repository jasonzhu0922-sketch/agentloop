import type { Planner, PrivateSkill, TaskSpec } from "@zhujun/agentloop";
import { fileExportForTarget } from "./file-export.ts";

/** The product owns the workflow; the model owns all domain decisions within it. */
export function fixedDataAnalysisPlanner(skill: PrivateSkill, fileSkills: readonly PrivateSkill[] = []): Planner {
  if (skill.name !== "data-analysis" || !skill.agentLoop?.executionProfiles?.includes("local_script")) {
    throw new Error("The data Agent requires the executable data-analysis Skill");
  }
  const fileSkillByName = new Map(fileSkills.map(item => [item.name, item]));
  return {
    async plan(task: TaskSpec) {
      const intent = task.canonicalState.intent;
      const goal = intent.userInput;
      const openTargets = Object.values(task.canonicalState.targets).filter(target => target.status !== "accepted");
      const fileExport = openTargets.map(fileExportForTarget).find(Boolean);
      const fileSkill = fileExport?.skillName ? fileSkillByName.get(fileExport.skillName) : undefined;
      if (fileExport?.skillName && !fileSkill) throw new Error(`The data Agent requires the ${fileExport.skillName} file Skill`);
      const selectedSkills = fileSkill ? [skill, fileSkill] : [skill];
      const artifactDelivery = fileExport !== undefined;
      return {
        schema: "agentloop.outcomePlan/v2",
        shape: "single_leaf",
        goal,
        selectedSkillIds: selectedSkills.map(item => item.id),
        selectedSkillRoles: artifactDelivery
          ? [
              { skillId: skill.id, role: "source_provider", reason: "data-analysis 负责真实业务数据查询与结果核对。" },
              ...(fileSkill ? [{ skillId: fileSkill.id, role: "primary_builder" as const, reason: `${fileSkill.name} 负责生成用户要求的文件。` }] : []),
            ]
          : [{ skillId: skill.id, role: "primary_builder", reason: "应用固定的问数工作流，无需模型选择主 Skill。" }],
        steps: [{
          id: "data-analysis",
          kind: "leaf",
          role: "deliver",
          objective: `${goal}\n遵循 data-analysis：先读当前目录，在当前步骤内完成实体、指标、期间和粒度的领域规划；存在业务歧义时请求结构化 HIL；由当前模型生成 SQL，通过 Skill 执行器受控查询 TiDB，核对完整结果。${artifactDelivery ? `再按照 ${fileSkill?.name ?? "文件"} Skill 的格式规则，把真实查询结果写入 data-agent.file-export/v1 JSON 规格，并且只调用 data-analysis 清单中的 scripts/file_export.py 固定生成器生成 ${fileExport!.format} 文件；不得编写临时可执行脚本、重新查询或编造数据。绑定目标并完成文件验收。` : "核对后直接回答。"}领域计划随实际 SQL 一起提交，不另建模型工作流。`,
          dependencies: [],
          skillIds: selectedSkills.map(item => item.id),
          requiredCapabilities: [
            "skill_instruction_load", "skill_local_script_execution", `skill_source_provider.database.${skill.id}`,
            ...(artifactDelivery ? ["workspace_artifact_write", "artifact_acceptance"] : ["conversation_delivery"]),
          ],
          targetIds: openTargets.map(target => target.targetId),
          // This application always answers from the governed business-data Skill.
          // A conversational delivery target is still evidence-backed; an empty
          // contract is invalid and previously caused PLAN_NOT_ADMITTED failures.
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
