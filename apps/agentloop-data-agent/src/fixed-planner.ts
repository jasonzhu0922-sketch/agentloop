import { DEFAULT_MAX_PLANNING_TURNS, MAX_SUPPORTED_PLANNING_TURNS, type Planner, type PlanProposal, type PrivateSkill, type RuntimeEventSink, type TaskSpec } from "@zhujun/agentloop";
import { fileExportForTarget } from "./file-export.ts";

export interface FixedDataAnalysisPlannerOptions {
  /** Deployment-owned planning budget recorded on the Run even though this Planner is deterministic. */
  maxPlanningTurns?: number;
}

/** The product owns the workflow; the model owns all domain decisions within it. */
export function fixedDataAnalysisPlanner(
  skill: PrivateSkill,
  fileSkills: readonly PrivateSkill[] = [],
  options: FixedDataAnalysisPlannerOptions = {},
): Planner {
  if (skill.name !== "data-analysis" || !skill.agentLoop?.executionProfiles?.includes("local_script")) {
    throw new Error("The data Agent requires the executable data-analysis Skill");
  }
  const maxPlanningTurns = planningTurnLimit(options.maxPlanningTurns);
  const fileSkillByName = new Map(fileSkills.map(item => [item.name, item]));
  return {
    async plan(task: TaskSpec, _signal?: AbortSignal, emit?: RuntimeEventSink) {
      await emit?.({ type: "planning.started", data: {
        availableSkillCount: task.availableSkills.length, availableToolCount: task.availableToolNames.length,
        maxPlanningTurns, deterministic: true,
      } });
      await emit?.({ type: "planning.turn.started", data: {
        turn: 1, loadedSkillCount: 0, pendingSkillCount: 0, hasRuntimeDirective: false,
        toolCount: task.availableToolNames.length, messageCount: 1, deterministic: true,
      } });
      const intent = task.canonicalState.intent;
      const goal = intent.userInput;
      const openTargets = Object.values(task.canonicalState.targets).filter(target => target.status !== "accepted");
      const fileExport = openTargets.map(fileExportForTarget).find(Boolean);
      const fileSkill = fileExport?.skillName ? fileSkillByName.get(fileExport.skillName) : undefined;
      if (fileExport?.skillName && !fileSkill) throw new Error(`The data Agent requires the ${fileExport.skillName} file Skill`);
      const selectedSkills = fileSkill ? [skill, fileSkill] : [skill];
      const artifactDelivery = fileExport !== undefined;
      const proposal: PlanProposal = {
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
          objective: `${goal}\n遵循 data-analysis：先读当前目录，在当前步骤内完成实体、指标、期间和粒度的领域规划；知识未命中、多个候选、未知格式或一次 SQL 失败时，先用目录和有界只读探查自行查证，只有仍存在会改变答案且必须由用户决定的业务歧义才请求结构化 HIL。优先用 get-query-context 返回的 context_id 生成紧凑 query_plan，由当前模型生成 SQL，通过 Skill 执行器受控查询 TiDB，核对完整结果；相同失败组合不得重复提交。${artifactDelivery ? `再按照 ${fileSkill?.name ?? "文件"} Skill 的格式规则，把真实查询结果写入 data-agent.file-export/v1 JSON 规格，并且只调用 data-analysis 清单中的 scripts/file_export.py 固定生成器生成 ${fileExport!.format} 文件；不得编写临时可执行脚本、重新查询或编造数据。绑定目标并完成文件验收。` : "核对后直接回答。"}领域计划随实际 SQL 一起提交，不另建模型工作流。`,
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
            { id: "skill-contract", description: "遵循固定 Skill 的实体、指标、时间与 SQL 校验流程；只对会改变答案且必须由用户决定的业务歧义请求确认，不猜编码、不放宽必要条件。", source: "planner", blocking: true },
            { id: "semantic-plan-contract", description: "SQL 必须消费同一 get-query-context 的 context_id、语义版本、来源签名和适用于当前 SQL 的绑定；结构错误确定性修复一次，相同失败组合不得重复提交。", source: "planner", blocking: true },
          ],
        }],
      };
      await emit?.({ type: "planning.turn.completed", data: {
        turn: 1, finishReason: "deterministic", toolCallCount: 0, loadSkillCallCount: 0,
        submitPlanCallCount: 0, submitOutcomePlanCallCount: 0, loadedSkillCount: 0,
        contentLength: 0, deterministic: true,
      } });
      return proposal;
    },
  };
}

function planningTurnLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_PLANNING_TURNS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SUPPORTED_PLANNING_TURNS) {
    throw new TypeError(`maxPlanningTurns must be a positive safe integer no greater than ${MAX_SUPPORTED_PLANNING_TURNS}`);
  }
  return value;
}
