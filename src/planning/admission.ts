import { randomUUID } from "node:crypto";
import { AppError } from "../shared/errors.ts";
import type { PrivateSkill } from "../skills/skill-service.ts";
import type { ExecutionPlan, PlanProposal, PlanStep, SuccessCriterion } from "./contracts.ts";

const FILE_PRODUCER_TOOL_NAMES = new Set([
  "computer_write_file",
  "computer_run_command",
]);

export function admitPlan(input: {
  runId: string;
  proposal: PlanProposal;
  availableSkills: readonly PrivateSkill[];
  availableToolNames: ReadonlySet<string>;
  now?: number;
}): ExecutionPlan {
  const { proposal } = input;
  if (proposal.steps.length === 0 || proposal.steps.length > 100) {
    reject("Plan must contain between 1 and 100 steps");
  }
  const availableSkills = new Map(input.availableSkills.map((skill) => [skill.id, skill]));
  assertUnique(proposal.selectedSkillIds, "selected skill IDs");
  for (const skillId of proposal.selectedSkillIds) {
    if (!availableSkills.has(skillId)) reject(`Plan selected unavailable Skill ${skillId}`);
  }

  const stepIds = proposal.steps.map((step) => step.id);
  assertUnique(stepIds, "step IDs");
  const stepIdSet = new Set(stepIds);
  const selectedSet = new Set(proposal.selectedSkillIds);
  const boundSkillIds = new Set<string>();
  const canProduceFiles = hasFileProducer(input.availableToolNames);

  const steps: PlanStep[] = proposal.steps.map((step, position) => {
    assertUnique(step.dependencies, `dependencies for step ${step.id}`);
    assertUnique(step.skillIds, `Skill bindings for step ${step.id}`);
    assertUnique(step.requiredToolNames, `tools for step ${step.id}`);
    if (step.dependencies.includes(step.id)) reject(`Step ${step.id} cannot depend on itself`);
    for (const dependency of step.dependencies) {
      if (!stepIdSet.has(dependency)) reject(`Step ${step.id} has unknown dependency ${dependency}`);
    }
    if (step.skillIds.length > 0 && isPureSkillActivationStep(step)) {
      reject(
        `Step ${step.id} is only a Skill activation step; bind the Skill to a concrete user-deliverable step instead`,
      );
    }
    const fileProducingStep = requiresFileProduction(step);
    if (!canProduceFiles && fileProducingStep) {
      reject(
        `Step ${step.id} requires file or artifact production, but no file-producing Tool is available in this Run; enable write/command tools or submit a text-only Plan without file-output success criteria`,
      );
    }
    if (fileProducingStep && !hasFileProducer(new Set(step.requiredToolNames))) {
      reject(`Step ${step.id} requires file or artifact production, but it does not require a file-producing Tool`);
    }
    const mergedTools = new Set(step.requiredToolNames);
    if (step.skillIds.length > 0) mergedTools.add("load_skill");
    const criteria: SuccessCriterion[] = [...step.successCriteria];
    for (const skillId of step.skillIds) {
      if (!selectedSet.has(skillId)) reject(`Step ${step.id} binds unselected Skill ${skillId}`);
      const skill = availableSkills.get(skillId);
      if (skill === undefined) reject(`Step ${step.id} binds unavailable Skill ${skillId}`);
      boundSkillIds.add(skillId);
    }
    for (const toolName of mergedTools) {
      if (!input.availableToolNames.has(toolName)) {
        reject(`Step ${step.id} requires unavailable Tool ${toolName}`);
      }
    }
    if (criteria.length === 0) reject(`Step ${step.id} has no success criteria`);
    assertUnique(criteria.map((criterion) => criterion.id), `criteria for step ${step.id}`);
    assertStepIsBounded(step);
    return {
      ...step,
      position,
      requiredToolNames: [...mergedTools],
      successCriteria: criteria,
      status: "pending",
    };
  });

  for (const skillId of selectedSet) {
    if (!boundSkillIds.has(skillId)) reject(`Selected Skill ${skillId} is not bound to any Plan step`);
  }
  assertAcyclic(steps);
  const now = input.now ?? Date.now();
  return {
    id: randomUUID(),
    runId: input.runId,
    version: 1,
    goal: proposal.goal,
    selectedSkillIds: [...proposal.selectedSkillIds],
    status: "admitted",
    steps,
    createdAt: now,
    updatedAt: now,
  };
}

function assertAcyclic(steps: readonly PlanStep[]): void {
  const dependencies = new Map(steps.map((step) => [step.id, step.dependencies]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): void => {
    if (visited.has(stepId)) return;
    if (visiting.has(stepId)) reject(`Plan dependency graph contains a cycle at ${stepId}`);
    visiting.add(stepId);
    for (const dependency of dependencies.get(stepId) ?? []) visit(dependency);
    visiting.delete(stepId);
    visited.add(stepId);
  };
  for (const step of steps) visit(step.id);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) reject(`${label} must not contain duplicates`);
}

function isPureSkillActivationStep(step: PlanProposal["steps"][number]): boolean {
  const nonActivationTools = step.requiredToolNames.filter((name) => name !== "load_skill");
  if (nonActivationTools.length > 0) return false;
  const id = normalizePlanText(step.id);
  const objective = normalizePlanText(step.objective);
  const criteria = normalizePlanText(step.successCriteria.map((criterion) => criterion.description).join(" "));
  if (/^(load|activate|fetch|retrieve|read)[-_ ]*(skill|skills)?$/.test(id)) return true;
  if (/^(load|activate|fetch|retrieve|read)[-_ ]+.+[-_ ]+skill$/.test(id)) return true;
  if (/^(load|activate|fetch|retrieve|read)\b.{0,120}\b(skill|skills|instruction|instructions|workflow|workflows)\b/.test(objective)) {
    return !containsCompoundDeliverable(objective);
  }
  if (/^(加载|激活|获取|读取).{0,120}(技能|skill|说明|指令|工作流)/.test(objective)) {
    return !containsCompoundDeliverable(objective);
  }
  return objective.length > 0 && objective === criteria && (
    /^skill activation$/.test(objective)
    || /^load skill$/.test(objective)
    || /^加载技能$/.test(objective)
  );
}

function containsCompoundDeliverable(value: string): boolean {
  return /\b(and|then)\b.+\b(apply|follow|use|provide|validate|create|produce|design|build|generate|write|verify|deliver|implement|analyze|summarize)\b/.test(value)
    || /(并|并且|然后).*(应用|遵循|使用|提供|创建|生成|设计|输出|实现|完成|分析|总结|验证|交付)/.test(value);
}

function normalizePlanText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function hasFileProducer(availableToolNames: ReadonlySet<string>): boolean {
  for (const name of availableToolNames) {
    if (FILE_PRODUCER_TOOL_NAMES.has(name)) return true;
    if (/(^|_)(write|create|generate|render|export|save)(_|$)/.test(name)) return true;
  }
  return false;
}

function requiresFileProduction(step: PlanProposal["steps"][number]): boolean {
  const text = normalizePlanText([
    step.id,
    step.objective,
    ...step.successCriteria.map((criterion) => criterion.description),
  ].join(" "));
  const mentionsFileArtifact = /(?:\.(?:png|pdf|md|markdown|html|svg|jpe?g|webp|gif|docx|pptx|xlsx|csv)\b|\b(?:png|pdf|markdown|html|svg|jpe?g|webp|gif|docx|pptx|xlsx|csv)\b|文件|档案|\bfile\b)/i.test(text);
  const hasProductionVerb = /\b(create|produce|generate|write|save|export|render|materialize|build|deliver|output)\b|创建|生成|写入|保存|导出|渲染|产出|输出|交付|制作/.test(text);
  return mentionsFileArtifact && hasProductionVerb;
}

function assertStepIsBounded(step: PlanProposal["steps"][number]): void {
  const text = normalizePlanText([
    step.id,
    step.objective,
    ...step.successCriteria.map((criterion) => `${criterion.id} ${criterion.description}`),
  ].join(" "));
  const tools = new Set(step.requiredToolNames);
  const hasInspectionTool = [...tools].some((name) => /(?:^|_)(list|read|search|inspect|fetch)(?:_|$)/.test(name));
  const hasProducerTool = hasFileProducer(tools);
  const hasDiscoveryWork = /\b(read|inspect|explore|discover|extract|analy[sz]e|reconstruct|summari[sz]e|confirm|identify)\b|读取|检查|探索|发现|提取|分析|重构|总结|确认|识别/.test(text);
  const hasProductionWork = /\b(write|author|create|generate|build|implement|materialize|produce|save)\b|编写|撰写|创建|生成|实现|沉淀|产出|保存|写入/.test(text);
  const hasVerificationWork = /\b(verify|validate|test|run|compare|check)\b|验证|校验|测试|运行|对比|检查/.test(text);
  const hasDataAnalysisWork = /\b(?:data|spreadsheet|sheet|workbook|table|dataset|schema|field|row|record|range|count|metric|analysis)\b|数据|表格|工作簿|工作表|字段|行|记录|范围|数量|指标|分析/.test(text);
  const hasSourceProfilingWork = /\b(?:source|sheet|table|schema|field|range|count|identify|profile|scope)\b|来源|源|工作表|表格|字段|范围|数量|识别|定位|解析/.test(text);
  const hasDurableEvidenceWork = /\b(?:structured evidence|evidence artifact|json|markdown|artifact|hash|reusable evidence)\b|结构化证据|证据文件|证据产物|可复用证据|哈希/.test(text);
  const hasCommandRunner = tools.has("computer_run_command") || [...tools].some((name) => /(?:^|_)run(?:_|$)/.test(name));
  const hasWriteTool = tools.has("computer_write_file") || [...tools].some((name) => /(?:^|_)(write|save|export|create)(?:_|$)/.test(name));
  const manyCriteria = step.successCriteria.length >= 4;
  const broadToolSurface = hasInspectionTool && hasProducerTool && tools.size >= 3;

  if (broadToolSurface && hasDiscoveryWork && hasProductionWork && (hasVerificationWork || manyCriteria)) {
    reject(
      `Step ${step.id} is too broad: split discovery/extraction, production, and verification into smaller dependency-linked steps`,
    );
  }
  if (
    hasDataAnalysisWork
    && hasSourceProfilingWork
    && hasDurableEvidenceWork
    && hasInspectionTool
    && hasCommandRunner
    && hasWriteTool
    && step.successCriteria.length >= 3
  ) {
    reject(
      `Step ${step.id} is too broad: split data source profiling, extraction artifact generation, and downstream reporting or verification into smaller dependency-linked steps`,
    );
  }
}

function reject(message: string): never {
  throw new AppError("PLAN_NOT_ADMITTED", message, 422);
}
