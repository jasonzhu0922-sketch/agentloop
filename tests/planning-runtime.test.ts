import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthService } from "../src/auth/auth-service.ts";
import { admitPlan } from "../src/planning/admission.ts";
import type { ConversationWorkingSet, PlanProposal, Planner, TaskSpec } from "../src/planning/contracts.ts";
import { ModelStepAssessor, RuleBasedStepAssessor } from "../src/planning/assessor.ts";
import { ModelPlanner } from "../src/planning/planner.ts";
import { PlanRepository } from "../src/planning/plan-repository.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { RunService, selectPlanningSkills } from "../src/runtime/run-service.ts";
import { RuntimeActionRepository } from "../src/runtime/runtime-action-repository.ts";
import type { RuntimeTool } from "../src/runtime/tool-registry.ts";
import { SkillService, type PrivateSkill } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

test("ModelPlanner fails closed when the model returns prose instead of submit_plan", async () => {
  const planner = new ModelPlanner(new StaticModel({ content: "Here is a markdown plan", toolCalls: [], finishReason: "stop" }));
  await assert.rejects(
    () => planner.plan({
      runId: "run-1",
      input: "do work",
      availableSkills: [],
      availableToolNames: [],
    }),
    (error: unknown) => {
      assert.equal(hasCode(error, "PLANNING_ERROR"), true);
      assert.deepEqual((error as { details?: unknown }).details, {
        planningTurn: 3,
        finishReason: "stop",
        toolCallCount: 0,
        toolCallNames: [],
        responseContentLength: 23,
        responseContentPreview: "Here is a markdown plan",
      });
      return true;
    },
  );
});

test("ModelPlanner canonicalizes duplicate names in the set-valued Tool capability field", async () => {
  const planner = new ModelPlanner(new StaticModel({
    content: "",
    finishReason: "tool_calls",
    toolCalls: [{
      id: "plan",
      name: "submit_plan",
      arguments: {
        goal: "inspect then build",
        selectedSkillIds: [],
        steps: [{
          id: "build",
          objective: "build output",
          dependencies: [],
          skillIds: [],
          requiredToolNames: ["computer_read_file", "computer_write_file", "computer_write_file"],
          successCriteria: [{ id: "built", description: "output exists" }],
        }],
      },
    }],
  }));
  const plan = await planner.plan({
    runId: "run-1",
    input: "build",
    availableSkills: [],
    availableToolNames: ["computer_read_file", "computer_write_file"],
  });
  assert.deepEqual(plan.steps[0].requiredToolNames, ["computer_read_file", "computer_write_file"]);
});

test("Plan admission rejects file artifact delivery when the Run has no producer Tool", () => {
  const skill = skillFixture({ id: "canvas", name: "canvas-design" });
  const proposal: PlanProposal = {
    goal: "Design a concert poster",
    selectedSkillIds: [skill.id],
    steps: [{
      id: "create-poster",
      objective: "Create a concert poster and output PNG or PDF files.",
      dependencies: [],
      skillIds: [skill.id],
      requiredToolNames: ["computer_list_directory"],
      successCriteria: [{ id: "poster-file", description: "A PNG or PDF poster file is generated." }],
    }],
  };
  assert.throws(
    () => admitPlan({
      runId: "run-1",
      proposal,
      availableSkills: [skill],
      availableToolNames: new Set(["load_skill", "computer_list_directory"]),
    }),
    (error: unknown) => hasCode(error, "PLAN_NOT_ADMITTED")
      && String((error as Error).message).includes("no file-producing Tool is available"),
  );

  const admitted = admitPlan({
    runId: "run-1",
    proposal,
    availableSkills: [skill],
    availableToolNames: new Set(["load_skill", "computer_list_directory", "computer_write_file"]),
  });
  assert.deepEqual(admitted.steps[0].requiredToolNames, ["computer_list_directory", "load_skill"]);
});

test("ModelPlanner caps the planning model output budget", async () => {
  let observedMaxOutputTokens: number | undefined;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      observedMaxOutputTokens = request.maxOutputTokens;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "plan",
          name: "submit_plan",
          arguments: {
            goal: "build",
            selectedSkillIds: [],
            steps: [{
              id: "build",
              objective: "build output",
              dependencies: [],
              skillIds: [],
              requiredToolNames: [],
              successCriteria: [{ id: "built", description: "output exists" }],
            }],
          },
        }],
      };
    },
  });
  await planner.plan({
    runId: "run-1",
    input: "build",
    availableSkills: [],
    availableToolNames: [],
  });
  assert.equal(observedMaxOutputTokens, 8_192);
});

test("ModelPlanner exposes operation profiles for source-level step shaping", async () => {
  let sawProfiles = false;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      sawProfiles = /operationProfiles/.test(request.runtimeContext?.content ?? "")
        && /data_analysis/.test(request.runtimeContext?.content ?? "")
        && /structured extraction artifact/.test(request.runtimeContext?.content ?? "")
        && /data-to-report/.test(request.systemPrompt)
        && /repeated raw stdout dumps/.test(request.systemPrompt);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "plan",
          name: "submit_plan",
          arguments: {
            goal: "analyze spreadsheet",
            selectedSkillIds: [],
            steps: [{
              id: "analyze",
              objective: "Analyze the xlsx file and report findings.",
              dependencies: [],
              skillIds: [],
              requiredToolNames: ["computer_run_command"],
              successCriteria: [{ id: "facts", description: "Structured analysis evidence exists" }],
            }],
          },
        }],
      };
    },
  });
  await planner.plan({
    runId: "operation-profile-plan",
    input: "分析 1.xlsx 并生成报告",
    availableSkills: [],
    availableToolNames: ["computer_run_command"],
  });
  assert.equal(sawProfiles, true);
});

test("ModelPlanner keeps executable Skill tasks out of direct-answer-only planning profiles", async () => {
  const skill = skillFixture({ id: "frontend-design", name: "frontend-design" });
  let sawExecutableSkillProfiles = false;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      const context = request.runtimeContext?.content ?? "";
      sawExecutableSkillProfiles = /operationProfiles/.test(context)
        && /content_generation/.test(context)
        && /artifact_build/.test(context)
        && !/direct_answer/.test(context);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "plan",
          name: "submit_plan",
          arguments: {
            goal: "build a homepage",
            selectedSkillIds: [skill.id],
            steps: [{
              id: "build-homepage",
              objective: "Build the requested homepage deliverable with the bound frontend Skill.",
              dependencies: [],
              skillIds: [skill.id],
              requiredToolNames: ["test_skill_delivery"],
              successCriteria: [{ id: "homepage-delivered", description: "The homepage delivery is generated." }],
            }],
          },
        }],
      };
    },
  });

  await planner.plan({
    runId: "run-skill-profile-plan",
    input: "做一个品牌首页",
    availableSkills: [skill],
    availableToolNames: ["load_skill", "test_skill_delivery"],
  });

  assert.equal(sawExecutableSkillProfiles, true);
});

test("ModelPlanner exposes conversation workset facts for follow-up planning", async () => {
  let sawWorkingSet = false;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      const context = request.runtimeContext?.content ?? "";
      sawWorkingSet = context.includes("conversation.workset/v1")
        && context.includes("artifacts/outline.json")
        && context.includes("MODEL_ERROR")
        && /continue from unfinished Plan steps/i.test(request.systemPrompt);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "plan",
          name: "submit_plan",
          arguments: {
            goal: "continue prior artifact work",
            selectedSkillIds: [],
            steps: [{
              id: "continue",
              objective: "Continue from the prior durable outline.",
              dependencies: [],
              skillIds: [],
              requiredToolNames: ["computer_write_file"],
              successCriteria: [{ id: "continued", description: "Continuation artifact is written." }],
            }],
          },
        }],
      };
    },
  });

  await planner.plan({
    runId: "run-followup-plan",
    input: "基于上面的成果继续推进",
    availableSkills: [],
    availableToolNames: ["computer_write_file"],
    conversationWorkingSet: {
      schema: "conversation.workset/v1",
      conversationId: "conversation-1",
      runCount: 3,
      activeGoal: {
        runId: "prior-run",
        planId: "prior-plan",
        goal: "Create deck",
        status: "failed",
        unfinished: true,
        reasonCode: "MODEL_ERROR",
      },
      planCursors: [{
        runId: "prior-run",
        planId: "prior-plan",
        goal: "Create deck",
        status: "failed",
        selectedSkillIds: [],
        steps: [{
          id: "build",
          position: 1,
          status: "failed",
          objective: "Build the deck from the outline.",
          dependencies: [],
          skillIds: [],
          recommendedToolNames: ["computer_write_file"],
          error: "Model provider returned HTTP 502",
        }],
      }],
      reusableArtifacts: [{
        runId: "prior-run",
        path: "artifacts/outline.json",
        name: "outline.json",
        bytes: 128,
        mimeType: "application/json",
        sourceTool: "computer_write_file",
        sourceToolCallId: "write-outline",
        sourcePlanStepId: "build",
        reusable: true,
      }],
      failedBoundaries: [{
        runId: "prior-run",
        planId: "prior-plan",
        stepId: "build",
        code: "MODEL_ERROR",
        message: "Model provider returned HTTP 502",
        reasonCode: "MODEL_ERROR",
        category: "provider",
      }],
      requiredCapabilities: {
        skillIds: [],
        toolNames: ["computer_write_file"],
      },
      resumeSuggestion: "Continue from prior Run prior-run Plan step build.",
    },
  });

  assert.equal(sawWorkingSet, true);
});

test("ModelPlanner proactively guides reusable-artifact work into small steps", async () => {
  let calls = 0;
  let sawSmallStepGuidance = false;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      sawSmallStepGuidance = /stepGranularity/.test(request.runtimeContext?.content ?? "")
        && /extract_contract_or_spec/.test(request.runtimeContext?.content ?? "")
        && /author_reusable_artifact/.test(request.runtimeContext?.content ?? "")
        && /verify_reusable_artifact/.test(request.runtimeContext?.content ?? "")
        && /Before calling submit_plan, choose the smallest dependency-linked operation units/.test(request.systemPrompt)
        && /convert prior work, analysis evidence, or source material into a reusable script/.test(request.systemPrompt);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "small-plan",
          name: "submit_plan",
          arguments: {
            goal: "create reusable data analysis script",
            selectedSkillIds: [],
            steps: [
              {
                id: "extract-analysis-contract",
                objective: "Read prior artifacts and write a reusable analysis contract.",
                dependencies: [],
                skillIds: [],
                requiredToolNames: ["computer_read_file", "computer_write_file"],
                successCriteria: [{ id: "contract-written", description: "The reusable analysis contract is written." }],
              },
              {
                id: "author-script",
                objective: "Write analyze_scenario.py from the analysis contract.",
                dependencies: ["extract-analysis-contract"],
                skillIds: [],
                requiredToolNames: ["computer_read_file", "computer_write_file"],
                successCriteria: [{ id: "script-written", description: "The reusable script is written." }],
              },
              {
                id: "verify-script",
                objective: "Run the reusable script and compare key outputs with the prior artifacts.",
                dependencies: ["author-script"],
                skillIds: [],
                requiredToolNames: ["computer_run_command", "computer_read_file"],
                successCriteria: [{ id: "script-verified", description: "Verification evidence is recorded." }],
              },
            ],
          },
        }],
      };
    },
  });

  const plan = await planner.plan({
    runId: "run-small-steps-first",
    input: "总结此前分析过程，生成可复用 analyze_scenario.py 并验证",
    availableSkills: [],
    availableToolNames: [
      "computer_read_file",
      "computer_write_file",
      "computer_run_command",
    ],
  });

  assert.equal(calls, 1);
  assert.equal(sawSmallStepGuidance, true);
  assert.deepEqual(plan.steps.map((item) => item.id), [
    "extract-analysis-contract",
    "author-script",
    "verify-script",
  ]);
});

test("Plan admission rejects oversized exploratory production steps", () => {
  const proposal: PlanProposal = {
    goal: "create reusable data analysis script",
    selectedSkillIds: [],
    steps: [{
      id: "reconstruct-author-and-verify",
      objective: "Read prior artifacts, reconstruct the spreadsheet analysis flow, confirm python/openpyxl, write analyze_scenario.py, and verify regenerated JSON and Markdown outputs.",
      dependencies: [],
      skillIds: [],
      requiredToolNames: [
        "computer_list_directory",
        "computer_read_file",
        "computer_search_text",
        "computer_write_file",
        "computer_run_command",
      ],
      successCriteria: [
        { id: "sources-read", description: "Prior artifacts are read and summarized." },
        { id: "script-created", description: "analyze_scenario.py is written." },
        { id: "io-parameterized", description: "Input and output paths are parameterized." },
        { id: "verified", description: "The script is run and outputs are compared with prior artifacts." },
      ],
    }],
  };

  assert.throws(
    () => admitPlan({
      runId: "run-oversized-step",
      proposal,
      availableSkills: [],
      availableToolNames: new Set([
        "computer_list_directory",
        "computer_read_file",
        "computer_search_text",
        "computer_write_file",
        "computer_run_command",
      ]),
    }),
    (error: unknown) => hasCode(error, "PLAN_NOT_ADMITTED")
      && String((error as Error).message).includes("split discovery/extraction, production, and verification"),
  );
});

test("Plan admission preserves visual contrast language as artifact authoring work", () => {
  const skill = skillFixture({ id: "presentation-skill", name: "presentation-skill" });
  const proposal: PlanProposal = {
    goal: "Create an editable suspense game introduction PowerPoint from a source design document.",
    selectedSkillIds: [skill.id],
    steps: [
      {
        id: "step_1_extract_source_outline",
        objective: "定位并阅读设计稿.md，提炼游戏定位、叙事主线、世界观、核心玩法、角色与场景、差异化卖点及悬疑惊悚视觉线索，形成供后续制作用的结构化内容提纲。",
        dependencies: [],
        skillIds: [],
        requiredToolNames: ["visible_find_files", "visible_read_file", "computer_write_file"],
        successCriteria: [
          { id: "sc_1_source", description: "确认设计稿的准确文件路径，并读取与游戏介绍相关的正文内容。" },
          { id: "sc_1_outline", description: "在工作区生成非空的结构化提纲文件，明确建议页序、逐页核心信息、设计稿依据和氛围表达线索，且不虚构关键设定。" },
        ],
      },
      {
        id: "step_2_author_deck_workspace",
        objective: "依据结构化提纲和 presentation-skill 的制作规范，创建可复现的演示文稿工作区与逐页可编辑源文件，落实统一的暗色、高对比、压迫感构图和克制留白。",
        dependencies: ["step_1_extract_source_outline"],
        skillIds: [skill.id],
        requiredToolNames: ["load_skill", "computer_read_file", "computer_write_file", "computer_run_command"],
        successCriteria: [
          { id: "sc_2_workspace", description: "工作区包含非空、可复现的演示文稿源文件与必要配置，并由写入或命令回执确认创建。" },
          { id: "sc_2_content", description: "逐页源内容覆盖游戏定位、背景故事、玩法机制、关键角色或场景和核心卖点，且与提纲中的设计稿依据一致。" },
          { id: "sc_2_visual_system", description: "源文件明确并统一应用悬疑惊悚视觉系统，包括色彩、字体层级、版式节奏和关键视觉元素规则。" },
        ],
      },
      {
        id: "step_3_generate_editable_pptx",
        objective: "从已完成的演示文稿源文件生成可编辑的游戏介绍 .pptx，不在此步骤进行视觉验收或内容重构。",
        dependencies: ["step_2_author_deck_workspace"],
        skillIds: [skill.id],
        requiredToolNames: ["load_skill", "computer_run_command", "computer_find_files"],
        successCriteria: [
          { id: "sc_3_artifact", description: "工作区内生成目标 .pptx，工具回执确认文件存在且大小非零。" },
          { id: "sc_3_parse", description: "生成流程正常结束，且输出可被演示文稿工具链解析并报告有效页数。" },
          { id: "sc_3_editable", description: "交付物为可编辑的 PowerPoint 文件，而非仅由整页位图组成的静态预览。" },
        ],
      },
      {
        id: "step_4_render_and_inspect",
        objective: "按 presentation-skill 的验证流程渲染已生成的 PPT，并对页面完整性、可读性、溢出、越界、遮挡、异常空白及整体悬疑惊悚风格一致性进行检查，形成明确的质量检查结果。",
        dependencies: ["step_3_generate_editable_pptx"],
        skillIds: [skill.id],
        requiredToolNames: ["load_skill", "computer_run_command", "computer_find_files", "computer_read_file"],
        successCriteria: [
          { id: "sc_4_render", description: "生成整套幻灯片的渲染预览或等效验证输出，渲染页数与 PPT 页数一致。" },
          { id: "sc_4_report", description: "形成可观察的检查结果，逐项标明是否存在文字溢出、元素越界、严重遮挡、异常空白、不可读内容或风格断裂，并定位任何问题页。" },
          { id: "sc_4_content_check", description: "检查结果确认各页主要信息与结构化提纲对应，未发现关键内容缺页或明显错置。" },
        ],
      },
      {
        id: "step_5_finalize_delivery",
        objective: "依据质量检查结果对源文件实施必要的定点修正，重新生成并复验最终版本；若检查无问题，则保留现有版本并完成最终交付确认。",
        dependencies: ["step_4_render_and_inspect"],
        skillIds: [skill.id],
        requiredToolNames: ["load_skill", "computer_read_file", "computer_write_file", "computer_run_command", "computer_find_files"],
        successCriteria: [
          { id: "sc_5_quality", description: "最终复验未发现文字溢出、元素越界、严重遮挡、异常空白或明显不可读页面，且悬疑惊悚视觉表达在全套页面中保持一致。" },
          { id: "sc_5_integrity", description: "最终 PPT 可正常解析和渲染，页数与最终预览一致。" },
          { id: "sc_5_delivery", description: "确认最终可编辑 .pptx 的工作区路径、存在性和非零大小，并保留最终渲染或等效验证证据。" },
        ],
      },
    ],
  };

  const plan = admitPlan({
    runId: "run-visual-contrast-plan",
    proposal,
    availableSkills: [skill],
    availableToolNames: new Set([
      "load_skill",
      "visible_find_files",
      "visible_read_file",
      "computer_find_files",
      "computer_read_file",
      "computer_write_file",
      "computer_run_command",
    ]),
  });

  assert.deepEqual(plan.steps.map((item) => item.id), [
    "step_1_extract_source_outline",
    "step_2_author_deck_workspace",
    "step_3_generate_editable_pptx",
    "step_4_render_and_inspect",
    "step_5_finalize_delivery",
  ]);
});

test("Plan admission still rejects Chinese steps that mix extraction, production, and comparison verification", () => {
  const proposal: PlanProposal = {
    goal: "读取资料并生成报告",
    selectedSkillIds: [],
    steps: [{
      id: "read_create_and_compare",
      objective: "读取源文件，提取结构化内容，创建报告，并对比源数据验证输出。",
      dependencies: [],
      skillIds: [],
      requiredToolNames: ["computer_read_file", "computer_write_file", "computer_run_command"],
      successCriteria: [
        { id: "source-read", description: "源文件内容已读取并提取为结构化内容。" },
        { id: "report-created", description: "报告文件已创建。" },
        { id: "output-verified", description: "报告输出与源数据完成对比验证。" },
      ],
    }],
  };

  assert.throws(
    () => admitPlan({
      runId: "run-chinese-oversized-step",
      proposal,
      availableSkills: [],
      availableToolNames: new Set(["computer_read_file", "computer_write_file", "computer_run_command"]),
    }),
    (error: unknown) => hasCode(error, "PLAN_NOT_ADMITTED")
      && String((error as Error).message).includes("split discovery/extraction, production, and verification"),
  );
});

test("Plan admission rejects oversized data evidence extraction steps", () => {
  const proposal: PlanProposal = {
    goal: "分析工作区中的 1.xlsx 并生成中文场景分析报告",
    selectedSkillIds: [],
    steps: [{
      id: "extract_structured_evidence",
      objective: "定位并解析 1.xlsx，识别工作表、字段、有效数据范围、记录数量、关键分组与指标，形成供报告写作使用的结构化分析证据；本步骤不撰写最终报告。",
      dependencies: [],
      skillIds: [],
      requiredToolNames: ["computer_list_directory", "computer_run_command", "computer_write_file"],
      successCriteria: [
        { id: "source_identified", description: "确认实际读取的 1.xlsx 路径，并记录文件所含工作表及各表有效数据范围。" },
        { id: "schema_and_counts_captured", description: "结构化证据包含各工作表字段摘要、有效记录数、缺失或异常概况以及用于场景划分的关键维度。" },
        { id: "evidence_written", description: "生成独立的结构化证据文件，包含关键统计、场景分组结果与可追溯的源表/字段引用，且不以完整原始行数据转储代替分析。" },
      ],
    }],
  };

  assert.throws(
    () => admitPlan({
      runId: "run-oversized-data-evidence-step",
      proposal,
      availableSkills: [],
      availableToolNames: new Set(["computer_list_directory", "computer_run_command", "computer_write_file"]),
    }),
    (error: unknown) => hasCode(error, "PLAN_NOT_ADMITTED")
      && String((error as Error).message).includes("split data source profiling, extraction artifact generation"),
  );
});

test("ModelPlanner repairs oversized steps with a structured patch turn", async () => {
  let calls = 0;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      assert.match(request.systemPrompt, /Keep each step as one bounded operation unit/);
      if (calls === 1) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{
            id: "oversized-plan",
            name: "submit_plan",
            arguments: {
              goal: "create reusable data analysis script",
              selectedSkillIds: [],
              steps: [{
                id: "reconstruct-author-and-verify",
                objective: "Read prior artifacts, reconstruct the spreadsheet analysis flow, confirm python/openpyxl, write analyze_scenario.py, and verify regenerated JSON and Markdown outputs.",
                dependencies: [],
                skillIds: [],
                requiredToolNames: [
                  "computer_list_directory",
                  "computer_read_file",
                  "computer_search_text",
                  "computer_write_file",
                  "computer_run_command",
                ],
                successCriteria: [
                  { id: "sources-read", description: "Prior artifacts are read and summarized." },
                  { id: "script-created", description: "analyze_scenario.py is written." },
                  { id: "io-parameterized", description: "Input and output paths are parameterized." },
                  { id: "verified", description: "The script is run and outputs are compared with prior artifacts." },
                ],
              }],
            },
          }],
        };
      }
      assert.deepEqual(request.tools.map((tool) => tool.name), ["submit_plan_patch"]);
      assert.match(request.runtimeContext?.content ?? "", /is too broad/i);
      assert.match(request.runtimeContext?.content ?? "", /smaller dependency-linked steps/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "split-plan",
          name: "submit_plan_patch",
          arguments: {
            replacements: [{
              targetStepId: "reconstruct-author-and-verify",
              downstreamDependencyStepId: "verify-script",
              replacementSteps: [
                {
                  id: "extract-analysis-contract",
                  objective: "Read prior artifacts and write a concise analysis contract describing source scope, fields, counts, and expected outputs.",
                  dependencies: [],
                  skillIds: [],
                  requiredToolNames: ["computer_read_file", "computer_write_file"],
                  successCriteria: [{ id: "contract-written", description: "A structured analysis contract file is written." }],
                },
                {
                  id: "author-script",
                  objective: "Write analyze_scenario.py from the analysis contract.",
                  dependencies: ["extract-analysis-contract"],
                  skillIds: [],
                  requiredToolNames: ["computer_read_file", "computer_write_file"],
                  successCriteria: [{ id: "script-written", description: "analyze_scenario.py exists and implements the contract." }],
                },
                {
                  id: "verify-script",
                  objective: "Run analyze_scenario.py and compare its key outputs with the prior artifacts.",
                  dependencies: ["author-script"],
                  skillIds: [],
                  requiredToolNames: ["computer_run_command", "computer_read_file"],
                  successCriteria: [{ id: "script-verified", description: "The script exits successfully and verification evidence is recorded." }],
                },
              ],
            }],
          },
        }],
      };
    },
  });

  const plan = await planner.plan({
    runId: "run-repair-oversized-step",
    input: "总结此前分析过程，生成可复用 analyze_scenario.py 并验证",
    availableSkills: [],
    availableToolNames: [
      "computer_list_directory",
      "computer_read_file",
      "computer_search_text",
      "computer_write_file",
      "computer_run_command",
    ],
  });

  assert.equal(calls, 2);
  assert.deepEqual(plan.steps.map((item) => item.id), [
    "extract-analysis-contract",
    "author-script",
    "verify-script",
  ]);
});

test("ModelPlanner repair resubmit keeps artifact repair conditional across the whole Plan", async () => {
  let calls = 0;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls === 1) {
        assert.match(request.systemPrompt, /Required quality checks for an artifact-generating/);
        assert.match(request.systemPrompt, /do not fold post-generation rendering, parsing, comparison, quality review, or defect repair/);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{
            id: "initial-broad-finalization",
            name: "submit_plan",
            arguments: {
              goal: "produce and verify final deck",
              selectedSkillIds: [],
              steps: [{
                id: "finalize_deck",
                objective: "Read the quality report, write source fixes, build the final PPTX, and verify the rendered deck.",
                dependencies: [],
                skillIds: [],
                requiredToolNames: ["computer_read_file", "computer_write_file", "computer_run_command"],
                successCriteria: [
                  { id: "report-read", description: "Quality report is read." },
                  { id: "source-fixed", description: "Source fixes are written." },
                  { id: "deck-built", description: "Final PPTX is generated." },
                  { id: "deck-verified", description: "Final PPTX is rendered and verified." },
                ],
              }],
            },
          }],
        };
      }
      if (calls === 2) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ["submit_plan_patch"]);
        assert.match(request.runtimeContext?.content ?? "", /Keep artifact repair conditional/);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{
            id: "patch-still-broad-finalization",
            name: "submit_plan_patch",
            arguments: {
              replacements: [{
                targetStepId: "finalize_deck",
                downstreamDependencyStepId: "rebuild_and_verify_final_deck",
                replacementSteps: [{
                  id: "rebuild_and_verify_final_deck",
                  objective: "Read the quality report, write source fixes, build the final PPTX, and verify the final PPTX page count.",
                  dependencies: [],
                  skillIds: [],
                  requiredToolNames: ["computer_read_file", "computer_write_file", "computer_run_command"],
                  successCriteria: [
                    { id: "source-fixed", description: "Source fixes are written." },
                    { id: "deck-built", description: "Final PPTX is generated." },
                    { id: "deck-verified", description: "Final PPTX page count is verified." },
                  ],
                }],
              }],
            },
          }],
        };
      }
      assert.deepEqual(request.tools.map((tool) => tool.name), ["submit_plan"]);
      const context = request.runtimeContext?.content ?? "";
      assert.match(context, /Audit every step in the resubmitted Plan/);
      assert.match(context, /Preserve previously valid split steps and downstream dependencies/);
      assert.match(context, /Do not introduce a new step that combines source or inspection evidence/);
      assert.match(context, /Keep artifact repair conditional/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "split-finalization",
          name: "submit_plan",
          arguments: {
            goal: "produce and verify final deck",
            selectedSkillIds: [],
            steps: [
              {
                id: "apply_quality_fixes",
                objective: "Read the quality report and update the deck source with the required fixes.",
                dependencies: [],
                skillIds: [],
                requiredToolNames: ["computer_read_file", "computer_write_file"],
                successCriteria: [{ id: "source-fixed", description: "Source fixes are written from the quality report." }],
              },
              {
                id: "rebuild_final_deck",
                objective: "Run the deck build command to generate the final PPTX from the fixed source.",
                dependencies: ["apply_quality_fixes"],
                skillIds: [],
                requiredToolNames: ["computer_run_command"],
                successCriteria: [{ id: "deck-built", description: "Final PPTX is generated by the build command." }],
              },
              {
                id: "verify_final_deck",
                objective: "Render and parse the final PPTX, then record the final validation evidence.",
                dependencies: ["rebuild_final_deck"],
                skillIds: [],
                requiredToolNames: ["computer_run_command", "computer_read_file"],
                successCriteria: [{ id: "deck-verified", description: "Final PPTX render and parse evidence confirms the expected deck." }],
              },
            ],
          },
        }],
      };
    },
  });

  const plan = await planner.plan({
    runId: "run-repair-finalization-boundaries",
    input: "修正 PPT 质量问题，重新生成并终检",
    availableSkills: [],
    availableToolNames: [
      "computer_read_file",
      "computer_write_file",
      "computer_run_command",
    ],
  });

  assert.equal(calls, 3);
  assert.deepEqual(plan.steps.map((step) => step.id), [
    "apply_quality_fixes",
    "rebuild_final_deck",
    "verify_final_deck",
  ]);
});

test("ModelPlanner keeps repairing oversized submitted Plans with the rejected Plan context", async () => {
  let calls = 0;
  const oversizedPlan = {
    goal: "analyze spreadsheet and write report",
    selectedSkillIds: [],
    steps: [{
      id: "extract_data",
      objective: "Read the workbook, profile sheets, write an extraction script, run it, verify the JSON evidence, and prepare report-ready summary statistics.",
      dependencies: [],
      skillIds: [],
      requiredToolNames: [
        "computer_list_directory",
        "computer_read_file",
        "computer_write_file",
        "computer_run_command",
      ],
      successCriteria: [
        { id: "profiled", description: "Workbook sheets, fields, ranges, and counts are profiled." },
        { id: "script-written", description: "The extraction script is written." },
        { id: "json-produced", description: "The extraction script produces JSON evidence." },
        { id: "json-verified", description: "The JSON evidence is verified against source counts." },
      ],
    }],
  };
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls === 1 || calls === 2) {
        if (calls === 2) {
          assert.match(request.runtimeContext?.content ?? "", /rejectedPlan/);
          assert.match(request.runtimeContext?.content ?? "", /extract_data/);
          assert.match(request.runtimeContext?.content ?? "", /smaller dependency-linked steps/);
        }
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: `oversized-${calls}`, name: "submit_plan", arguments: oversizedPlan }],
        };
      }
      assert.match(request.runtimeContext?.content ?? "", /rejectedPlan/);
      assert.match(request.runtimeContext?.content ?? "", /extract_data/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "split-plan",
          name: "submit_plan",
          arguments: {
            goal: "analyze spreadsheet and write report",
            selectedSkillIds: [],
            steps: [
              {
                id: "profile_source",
                objective: "Profile workbook sheets, fields, ranges, and counts.",
                dependencies: [],
                skillIds: [],
                requiredToolNames: ["computer_list_directory", "computer_run_command"],
                successCriteria: [{ id: "source-profiled", description: "Source workbook structure is profiled." }],
              },
              {
                id: "author_extractor",
                objective: "Write the extraction script from the source profile.",
                dependencies: ["profile_source"],
                skillIds: [],
                requiredToolNames: ["computer_write_file"],
                successCriteria: [{ id: "script-written", description: "Extraction script is written." }],
              },
              {
                id: "run_extractor",
                objective: "Run the extraction script and verify the JSON evidence against the source profile.",
                dependencies: ["author_extractor"],
                skillIds: [],
                requiredToolNames: ["computer_run_command", "computer_read_file"],
                successCriteria: [{ id: "json-verified", description: "JSON evidence is produced and verified." }],
              },
            ],
          },
        }],
      };
    },
  });

  const plan = await planner.plan({
    runId: "run-repair-repeated-oversized-step",
    input: "分析 xlsx 并生成报告",
    availableSkills: [],
    availableToolNames: [
      "computer_list_directory",
      "computer_read_file",
      "computer_write_file",
      "computer_run_command",
    ],
  });

  assert.equal(calls, 3);
  assert.deepEqual(plan.steps.map((item) => item.id), [
    "profile_source",
    "author_extractor",
    "run_extractor",
  ]);
});

test("RunService exposes downstream Plan steps as execution boundary context", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("step-boundary@example.com", "step boundary secure password");
    const planner: Planner = {
      plan: async () => ({
        goal: "analyze data and write a report",
        selectedSkillIds: [],
        steps: [
          {
            id: "extract-data",
            objective: "Extract structured evidence from the spreadsheet.",
            dependencies: [],
            skillIds: [],
            requiredToolNames: [],
            successCriteria: [{ id: "structured-evidence", description: "A structured extraction artifact exists." }],
          },
          {
            id: "write-report",
            objective: "Write the final Markdown report from the extraction artifact.",
            dependencies: ["extract-data"],
            skillIds: [],
            requiredToolNames: ["computer_write_file"],
            successCriteria: [{ id: "report-file", description: "The final Markdown report is produced." }],
          },
        ],
      }),
    };
    const model = new StepBoundaryContextModel();
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
      assessorFactory: () => approvingSkillAssessor(),
    });

    const run = await runs.execute(owner.user.id, "分析 1.xlsx 并生成 Markdown 报告", { allowDangerousTools: true });

    assert.equal(run.status, "completed");
    assert.match(model.firstSystemPrompt, /Do not perform work reserved for a pending downstream Plan step/);
    assert.match(model.firstRuntimeContext, /"currentPlanStep":\{"id":"extract-data"/);
    assert.match(model.firstRuntimeContext, /"downstreamPlanSteps":\[\{"id":"write-report"/);
    assert.match(model.firstRuntimeContext, /The final Markdown report is produced/);
  } finally {
    database.close();
  }
});

test("ModelPlanner creates response-only conversational Plans without a planning model call", async () => {
  let calls = 0;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async () => {
      calls += 1;
      throw new Error("response-only planning must be deterministic");
    },
  });
  const plan = await planner.plan({
    runId: "reply-only",
    input: "Which Skill did you use?",
    availableSkills: [skillFixture({ id: "pptx", name: "pptx" })],
    availableToolNames: ["computer_write_file"],
    responseOnly: true,
  });
  assert.equal(calls, 0);
  assert.deepEqual(plan.selectedSkillIds, []);
  assert.deepEqual(plan.steps.map((step) => ({
    id: step.id,
    skillIds: step.skillIds,
    requiredToolNames: step.requiredToolNames,
  })), [{
    id: "response",
    skillIds: [],
    requiredToolNames: [],
  }]);
});

test("selectPlanningSkills prefers the matching Skill summary and allows no-skill", () => {
  const canvas = skillFixture({ id: "canvas", name: "canvas-design", description: "Create beautiful poster and visual art in .png and .pdf documents using design philosophy." });
  const algorithmic = skillFixture({ id: "algo", name: "algorithmic-art", description: "Creating algorithmic art using p5.js with seeded randomness and interactive parameter exploration." });
  const unrelated = skillFixture({ id: "note", name: "note-writer", description: "Write short notes and messages." });
  const frontend = skillFixture({ id: "frontend", name: "frontend-design", description: "Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one." });

  const selected = selectPlanningSkills(
    [algorithmic, unrelated, canvas, frontend],
    "Use frontend-design only for this live validation",
    [],
  );
  assert.deepEqual(selected.map((skill) => skill.name), ["frontend-design"]);

  const none = selectPlanningSkills(
    [algorithmic, unrelated],
    "继续",
    [],
  );
  assert.deepEqual(none, []);
});

test("selectPlanningSkills recalls Chinese API catalog tasks from aliases and subphrases", () => {
  const apiQuery = skillFixture({
    id: "api-query",
    name: "api-query",
    description: "查询集团（宝武数据中台）API 目录信息。Use when 用户要了解某个 API/接口/服务是干什么的、有哪些入参、哪些出参、涉及哪些数据表，或要检索现有 API。触发词：查API、查接口、API入参出参、这个接口是干啥的、接口涉及哪些表、API目录检索。数据源为数智域通用 SQL API。",
  });
  const exploreData = skillFixture({
    id: "explore-data",
    name: "explore-data",
    description: "Profile and explore a dataset to understand its shape, quality, and patterns.",
  });
  const dashboard = skillFixture({
    id: "build-dashboard",
    name: "build-dashboard",
    description: "Build an interactive HTML dashboard with charts, filters, and tables.",
  });

  const naturalLanguageSelected = selectPlanningSkills(
    [exploreData, dashboard, apiQuery],
    "了解合同备案相关的 API 信息",
    [],
  );
  assert.deepEqual(naturalLanguageSelected.map((skill) => skill.name), ["api-query"]);

  const aliasSelected = selectPlanningSkills(
    [exploreData, dashboard, apiQuery],
    "查接口涉及哪些表",
    [],
  );
  assert.deepEqual(aliasSelected.map((skill) => skill.name), ["api-query"]);
});

test("selectPlanningSkills keeps explicitly bound Skills ahead of generic task wording", () => {
  const frontend = skillFixture({ id: "frontend", name: "frontend-design", description: "Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one." });
  const pptx = skillFixture({ id: "pptx", name: "pptx", description: "Create presentation slides." });
  const algorithmic = skillFixture({ id: "algo", name: "algorithmic-art", description: "Create existing Skill validation art examples." });

  const selected = selectPlanningSkills(
    [pptx, algorithmic, frontend],
    "Validate this existing Skill without creating a new Skill.",
    [frontend.id],
  );

  assert.deepEqual(selected.map((skill) => skill.name), ["frontend-design"]);
});

test("ModelPlanner repairs an invalid structured Plan without weakening the schema", async () => {
  let calls = 0;
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{
            id: "invalid-plan",
            name: "submit_plan",
            arguments: {
              goal: "build",
              selectedSkillIds: [],
              steps: [{
                id: "build",
                objective: { invalid: true },
                dependencies: [],
                skillIds: [],
                requiredToolNames: [],
                successCriteria: [{ id: "built", description: "output exists" }],
              }],
            },
          }],
        };
      }
      assert.match(request.runtimeContext?.content ?? "", /objective must be a string/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "repaired-plan",
          name: "submit_plan",
          arguments: {
            goal: "build",
            selectedSkillIds: [],
            steps: [{
              id: "build",
              objective: "build output",
              dependencies: [],
              skillIds: [],
              requiredToolNames: [],
              successCriteria: [{ id: "built", description: "output exists" }],
            }],
          },
        }],
      };
    },
  };
  const plan = await new ModelPlanner(model).plan({
    runId: "run-1",
    input: "build",
    availableSkills: [],
    availableToolNames: [],
  });
  assert.equal(calls, 2);
  assert.equal(plan.steps[0].objective, "build output");
});

test("ModelPlanner selects Skills from the catalog and submits a Plan without loading Skill bodies", async () => {
  const skill = skillFixture({ instructions: "EXACT-PLANNING-INSTRUCTIONS" });
  let calls = 0;
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      assert.deepEqual(request.tools.map((tool) => tool.name), ["submit_plan"]);
      assert.match(request.runtimeContext?.content ?? "", /<available_skills>/);
      assert.match(request.runtimeContext?.content ?? "", /computer_write_file/);
      assert.match(request.runtimeContext?.content ?? "", /Create or overwrite a UTF-8 file/);
      assert.match(request.systemPrompt, /Use only the Skill catalog summaries/);
      assert.doesNotMatch(request.systemPrompt, /EXACT-PLANNING-INSTRUCTIONS/);
      assert.doesNotMatch(request.messages.map((message) => message.content).join("\n"), /EXACT-PLANNING-INSTRUCTIONS/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: `plan-${calls}`,
          name: "submit_plan",
          arguments: {
            goal: "materialize and verify",
            selectedSkillIds: [skill.id],
            steps: [{
              id: "materialize-and-verify",
              objective: "materialize and verify",
              dependencies: [],
              skillIds: [skill.id],
              requiredToolNames: ["computer_write_file"],
              successCriteria: [{ id: "verified", description: "artifact exists and is valid" }],
            }],
          },
        }],
      };
    },
  };
  const plan = await new ModelPlanner(model).plan({
    runId: "run-1",
    input: "materialize and verify",
    availableSkills: [skill],
    availableToolNames: ["load_skill", "computer_write_file"],
    availableTools: [
      { name: "load_skill", description: "Load the exact Skill body." },
      { name: "computer_write_file", description: "Create or overwrite a UTF-8 file under the workspace root.", dangerous: true },
    ],
  });
  assert.equal(calls, 1);
  assert.equal(plan.steps.length, 1);
  assert.deepEqual(plan.steps[0].skillIds, [skill.id]);
});

test("ModelPlanner keeps optional refinement out of the terminal Plan scope", async () => {
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      assert.match(request.systemPrompt, /Keep the Plan scoped to the user's requested deliverable/);
      assert.match(request.systemPrompt, /Do not add optional polish, critique, or follow-up work/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "plan",
          name: "submit_plan",
          arguments: {
            goal: "Create a steel company homepage",
            selectedSkillIds: [],
            steps: [{
              id: "build-and-verify-homepage",
              objective: "Create and verify the requested homepage",
              dependencies: [],
              skillIds: [],
              requiredToolNames: [],
              successCriteria: [{ id: "homepage-ready", description: "The requested homepage is present and verified" }],
            }],
          },
        }],
      };
    },
  };
  const plan = await new ModelPlanner(model).plan({
    runId: "run-1",
    input: "Create a steel company homepage",
    availableSkills: [],
    availableToolNames: [],
  });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].id, "build-and-verify-homepage");
});

test("ModelPlanner repairs pure Skill activation steps into user-deliverable steps", async () => {
  const skill = skillFixture({ id: "canvas-design", name: "canvas-design" });
  let calls = 0;
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      assert.match(request.systemPrompt, /Do not create a Plan step whose objective is only to load/);
      if (calls === 1) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{
            id: "bad-plan",
            name: "submit_plan",
            arguments: {
              goal: "Design a poster",
              selectedSkillIds: [skill.id],
              steps: [{
                id: "load-skill",
                objective: "Load the canvas-design Skill",
                dependencies: [],
                skillIds: [skill.id],
                requiredToolNames: [],
                successCriteria: [{ id: "skill-loaded", description: "The Skill is loaded" }],
              }],
            },
          }],
        };
      }
      assert.deepEqual(request.tools.map((tool) => tool.name), ["submit_plan_patch"]);
      assert.match(request.runtimeContext?.content ?? "", /only a Skill activation step/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "repaired-plan",
          name: "submit_plan_patch",
          arguments: {
            replacements: [{
              targetStepId: "load-skill",
              downstreamDependencyStepId: "design-poster",
              replacementSteps: [{
                id: "design-poster",
                objective: "Design the requested poster using the bound Skill",
                dependencies: [],
                skillIds: [skill.id],
                requiredToolNames: [],
                successCriteria: [{ id: "poster-ready", description: "The poster design is produced" }],
              }],
            }],
          },
        }],
      };
    },
  };

  const plan = await new ModelPlanner(model).plan({
    runId: "run-1",
    input: "Design a poster",
    availableSkills: [skill],
    availableToolNames: ["load_skill"],
  });

  assert.equal(calls, 2);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].id, "design-poster");
});

test("legacy interrupted Runs enter recovery review instead of being terminally failed on restart", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("interrupted@example.com", "interrupted secure password");
    const runId = "interrupted-run";
    database.prepare(`
      INSERT INTO runs(
        id, owner_user_id, parent_run_id, depth, allow_dangerous_tools,
        status, input, created_at
      ) VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "create an artifact", Date.now());
    const plans = new PlanRepository(database);
    const plan = plans.create(admitPlan({
      runId,
      proposal: {
        goal: "create an artifact",
        selectedSkillIds: [],
        steps: [step("create-artifact")],
      },
      availableSkills: [],
      availableToolNames: new Set(),
    }));
    plans.startStep(plan.id, "create-artifact");
    const runs = new RunService({ database, skills, modelFactory: () => new StaticModel({ content: "", toolCalls: [], finishReason: "stop" }) });

    assert.equal(runs.reconcileInterruptedRuns(), 1);
    assert.equal(runs.get(owner.user.id, runId).status, "running");
    assert.equal(plans.get(plan.id).status, "running");
    assert.equal(plans.get(plan.id).steps[0].status, "running");
    const actions = runs.actionsForRun(owner.user.id, runId);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].kind, "recovery_review");
    assert.equal(actions[0].state, "recovery_required");
    assert.equal(actions[0].metadata.reason, "legacy_state_incomplete");
    assert.equal(runs.events(owner.user.id, runId).at(-1)?.type, "action.recovery_required");
    assert.equal(runs.reconcileInterruptedRuns(), 0);
  } finally {
    database.close();
  }
});

test("Admission rejects cycles, unknown dependencies, unbound Skills, and missing Skill activation", () => {
  const skill = skillFixture();
  const base: PlanProposal = {
    goal: "goal",
    selectedSkillIds: [],
    steps: [step("a")],
  };
  assert.throws(
    () => admitPlan({
      runId: "run", proposal: { ...base, steps: [{ ...step("a"), dependencies: ["missing"] }] },
      availableSkills: [], availableToolNames: new Set(),
    }),
    (error: unknown) => hasCode(error, "PLAN_NOT_ADMITTED"),
  );
  assert.throws(
    () => admitPlan({
      runId: "run",
      proposal: { ...base, steps: [{ ...step("a"), dependencies: ["b"] }, { ...step("b"), dependencies: ["a"] }] },
      availableSkills: [], availableToolNames: new Set(),
    }),
    (error: unknown) => hasCode(error, "PLAN_NOT_ADMITTED"),
  );
  assert.throws(
    () => admitPlan({
      runId: "run", proposal: { ...base, selectedSkillIds: [skill.id] },
      availableSkills: [skill], availableToolNames: new Set(["load_skill"]),
    }),
    (error: unknown) => hasCode(error, "PLAN_NOT_ADMITTED"),
  );
  assert.throws(
    () => admitPlan({
      runId: "run",
      proposal: { ...base, selectedSkillIds: [skill.id], steps: [{ ...step("a"), skillIds: [skill.id] }] },
      availableSkills: [skill], availableToolNames: new Set(),
    }),
    (error: unknown) => hasCode(error, "PLAN_NOT_ADMITTED"),
  );
});

test("Admission adds only the generic Skill activation Tool to a Skill-bound Step", async () => {
  const skill = skillFixture();
  const plan = admitPlan({
    runId: "run",
    proposal: {
      goal: "verify artifact",
      selectedSkillIds: [skill.id],
      steps: [{ ...step("qa"), skillIds: [skill.id], requiredToolNames: ["computer_read_file"] }],
    },
    availableSkills: [skill],
    availableToolNames: new Set(["computer_read_file", "load_skill"]),
  });
  assert.deepEqual(plan.steps[0].requiredToolNames, ["computer_read_file", "load_skill"]);
  assert.deepEqual(plan.steps[0].successCriteria, [{
    id: "qa-done",
    description: "qa is done",
    source: "planner",
  }]);

  const assessor = new ModelStepAssessor(new StaticModel({
    content: "",
    finishReason: "tool_calls",
    toolCalls: [{
      id: "assessment",
      name: "submit_assessment",
      arguments: {
        criteria: [
          { criterionId: "qa-done", satisfied: true, rationale: "QA passed", evidenceRefs: ["read"] },
        ],
        skills: [{
          skillId: skill.id,
          followed: true,
          rationale: "The QA-only step followed the bound Skill without rewriting the artifact",
          evidenceRefs: ["read"],
        }],
        feedback: "",
      },
    }],
  }));
  const assessment = await assessor.assess({
    runId: "run",
    planId: plan.id,
    step: plan.steps[0],
    skills: [skill],
    evidence: {
      candidateOutput: "Artifact QA passed",
      toolCalls: [{ toolCallId: "read", toolName: "computer_read_file", isError: false, result: "valid" }],
      modelSteps: 1,
    },
    attempt: 1,
  });
  assert.equal(assessment.approved, true);
  assert.equal(assessment.skills[0].followed, true);
});

test("ModelStepAssessor allows unavailable optional validation to be skipped with a caveat", async () => {
  const skill = skillFixture({
    id: "doc-skill",
    name: "doc-skill",
    instructions: "Create the artifact. Render it for visual QA when the renderer is available.",
  });
  const assessor = new ModelStepAssessor(new StaticModel({
    content: "",
    finishReason: "tool_calls",
    toolCalls: [{
      id: "assessment",
      name: "submit_assessment",
      arguments: {
        criteria: [
          { criterionId: "artifact-ready", satisfied: true, rationale: "Artifact exists and content checks passed", evidenceRefs: ["write", "extract"] },
        ],
        skills: [{
          skillId: skill.id,
          status: "skipped_unavailable",
          followed: false,
          rationale: "Renderer binary was probed and unavailable; visual QA was skipped instead of being claimed complete.",
          evidenceRefs: ["renderer-probe"],
        }],
        feedback: "Skipped visual QA because the renderer is unavailable; install a renderer to run the full check.",
      },
    }],
  }));
  const assessment = await assessor.assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("artifact"),
      position: 0,
      status: "running",
      successCriteria: [{ id: "artifact-ready", description: "Artifact exists and content checks passed", source: "planner" }],
    },
    skills: [skill],
    evidence: {
      candidateOutput: "Artifact generated; visual QA skipped because renderer is unavailable.",
      toolCalls: [
        { toolCallId: "write", toolName: "computer_write_file", isError: false, result: "created artifact.docx" },
        { toolCallId: "extract", toolName: "computer_run_command", isError: false, result: "content ok" },
        { toolCallId: "renderer-probe", toolName: "computer_run_command", isError: false, result: "soffice not found" },
      ],
      modelSteps: 3,
    },
    attempt: 1,
  });

  assert.equal(assessment.approved, true);
  assert.deepEqual(assessment.skills[0], {
    skillId: skill.id,
    status: "skipped_unavailable",
    followed: false,
    rationale: "Renderer binary was probed and unavailable; visual QA was skipped instead of being claimed complete.",
    evidenceRefs: ["renderer-probe"],
  });
  assert.match(assessment.feedback, /Skipped visual QA/);
});

test("ModelStepAssessor treats process-only Skill gaps as non-blocking caveats", async () => {
  const skill = skillFixture({
    id: "frontend-design",
    name: "frontend-design",
    instructions: "Plan and review the design before coding.",
  });
  const assessor = new ModelStepAssessor(new StaticModel({
    content: "",
    finishReason: "tool_calls",
    toolCalls: [{
      id: "assessment",
      name: "submit_assessment",
      arguments: {
        criteria: [
          { criterionId: "page-ready", satisfied: true, rationale: "The page is built and content checks passed", evidenceRefs: ["build"] },
        ],
        skills: [{
          skillId: skill.id,
          status: "process_caveat",
          followed: false,
          rationale: "The only remaining issue is missing pre-code design-plan timing evidence.",
          evidenceRefs: ["candidateOutput"],
        }],
        feedback: "Process caveat: design planning evidence was captured after coding, but the deliverable criteria are satisfied.",
      },
    }],
  }));
  const assessment = await assessor.assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("page"),
      position: 0,
      status: "running",
      successCriteria: [{ id: "page-ready", description: "The page is built and content checks passed", source: "planner" }],
    },
    skills: [skill],
    evidence: {
      candidateOutput: "Page built and checked.",
      toolCalls: [{ toolCallId: "build", toolName: "computer_run_command", isError: false, result: "build ok" }],
      modelSteps: 2,
    },
    attempt: 1,
  });

  assert.equal(assessment.approved, true);
  assert.equal(assessment.skills[0].status, "process_caveat");
  assert.match(assessment.feedback, /Process caveat/);
});

test("ModelStepAssessor still rejects unavailable validation when a required criterion is unsatisfied", async () => {
  const skill = skillFixture({ id: "qa-skill", name: "qa-skill" });
  const assessor = new ModelStepAssessor(new StaticModel({
    content: "",
    finishReason: "tool_calls",
    toolCalls: [{
      id: "assessment",
      name: "submit_assessment",
      arguments: {
        criteria: [
          { criterionId: "visual-qa", satisfied: false, rationale: "Visual QA could not run because the renderer is missing", evidenceRefs: ["renderer-probe"] },
        ],
        skills: [{
          skillId: skill.id,
          status: "skipped_unavailable",
          followed: false,
          rationale: "Renderer binary was unavailable.",
          evidenceRefs: ["renderer-probe"],
        }],
        feedback: "Install the renderer and rerun visual QA.",
      },
    }],
  }));
  const assessment = await assessor.assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("qa"),
      position: 0,
      status: "running",
      successCriteria: [{ id: "visual-qa", description: "Visual QA has been completed", source: "task" }],
    },
    skills: [skill],
    evidence: {
      candidateOutput: "Artifact generated, but visual QA was not run.",
      toolCalls: [{ toolCallId: "renderer-probe", toolName: "computer_run_command", isError: false, result: "renderer not found" }],
      modelSteps: 1,
    },
    attempt: 1,
  });

  assert.equal(assessment.approved, false);
  assert.equal(assessment.skills[0].status, "skipped_unavailable");
  assert.match(assessment.feedback, /Install the renderer/);
});

test("Admission rejects pure Skill activation steps", () => {
  const skill = skillFixture({ id: "canvas-design", name: "canvas-design" });
  assert.throws(
    () => admitPlan({
      runId: "run",
      proposal: {
        goal: "Design a poster",
        selectedSkillIds: [skill.id],
        steps: [{
          ...step("load-skill"),
          objective: "Load the canvas-design Skill",
          skillIds: [skill.id],
          successCriteria: [{ id: "loaded", description: "The Skill is loaded", source: "planner" }],
        }],
      },
      availableSkills: [skill],
      availableToolNames: new Set(["load_skill"]),
    }),
    (error: unknown) => {
      assert.equal(hasCode(error, "PLAN_NOT_ADMITTED"), true);
      assert.match((error as Error).message, /only a Skill activation step/);
      return true;
    },
  );
});

test("Admission allows Skill-bound steps that load and apply the workflow", () => {
  const skill = skillFixture({ id: "directory-demo", name: "directory-demo" });
  const plan = admitPlan({
    runId: "run",
    proposal: {
      goal: "Apply the discovered Skill",
      selectedSkillIds: [skill.id],
      steps: [{
        ...step("apply-directory-skill"),
        objective: "Load and follow the discovered workflow",
        skillIds: [skill.id],
        successCriteria: [{
          id: "loaded-and-followed",
          description: "The exact discovered Skill body is loaded before completion",
          source: "planner",
        }],
      }],
    },
    availableSkills: [skill],
    availableToolNames: new Set(["load_skill"]),
  });
  assert.equal(plan.steps[0].id, "apply-directory-skill");
  assert.deepEqual(plan.steps[0].requiredToolNames, ["load_skill"]);
});

test("ModelStepAssessor records invalid assessment response shape for diagnostics", async () => {
  const assessor = new ModelStepAssessor(new StaticModel({
    content: "not structured",
    finishReason: "stop",
    toolCalls: [],
  }));
  const events: Array<{ type: string; data: Readonly<Record<string, unknown>> }> = [];

  await assert.rejects(
    () => assessor.assess({
      runId: "run",
      planId: "plan",
      step: {
        ...step("qa"),
        position: 0,
        status: "running",
        successCriteria: [{ id: "qa-done", description: "qa is done", source: "planner" }],
      },
      skills: [],
      evidence: { candidateOutput: "done", toolCalls: [], modelSteps: 1 },
      attempt: 1,
    }, undefined, (event) => events.push(event)),
    (error: unknown) => {
      assert.equal(hasCode(error, "ASSESSMENT_ERROR"), true);
      assert.equal((error as { details?: Record<string, unknown> }).details?.finishReason, "stop");
      assert.equal((error as { details?: Record<string, unknown> }).details?.toolCallCount, 0);
      return true;
    },
  );
  assert.equal(events.filter((event) => event.type === "assessment.turn.completed").length, 3);
  assert.equal(events.at(-1)?.data.contentLength, "not structured".length);
});

test("ModelStepAssessor caps the assessment model output budget", async () => {
  let observedMaxOutputTokens: number | undefined;
  const assessor = new ModelStepAssessor({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      observedMaxOutputTokens = request.maxOutputTokens;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "assessment",
          name: "submit_assessment",
          arguments: {
            criteria: [{
              criterionId: "done",
              satisfied: true,
              rationale: "Canonical evidence proves completion",
              evidenceRefs: ["candidateOutput"],
            }],
            skills: [],
            feedback: "",
          },
        }],
      };
    },
  });
  const assessment = await assessor.assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("assess"),
      position: 0,
      status: "running",
      successCriteria: [{ id: "done", description: "Work is complete", source: "planner" }],
    },
    skills: [],
    evidence: { candidateOutput: "complete", toolCalls: [], modelSteps: 1 },
    attempt: 1,
  });
  assert.equal(assessment.approved, true);
  assert.equal(observedMaxOutputTokens, 8_192);
});

test("ModelStepAssessor repairs invalid structured arguments without approving by default", async () => {
  let calls = 0;
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "bad", name: "submit_assessment", arguments: "not-an-object" }],
        };
      }
      assert.match(request.runtimeContext?.content ?? "", /must be a JSON object/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "repaired",
          name: "submit_assessment",
          arguments: {
            criteria: [{
              criterionId: "done",
              satisfied: true,
              rationale: "Canonical evidence proves completion",
              evidenceRefs: ["candidateOutput"],
            }],
            skills: [],
            feedback: "",
          },
        }],
      };
    },
  };
  const assessment = await new ModelStepAssessor(model).assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("assess"),
      position: 0,
      status: "running",
      successCriteria: [{ id: "done", description: "Work is complete", source: "planner" }],
    },
    skills: [],
    evidence: { candidateOutput: "complete", toolCalls: [], modelSteps: 1 },
    attempt: 1,
  });
  assert.equal(calls, 2);
  assert.equal(assessment.approved, true);
});

test("Plan-bound Skill instructions are loaded on demand and compliance is persisted", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("planning@example.com", "planning secure password");
    const skill = skills.create(owner.user.id, {
      name: "strict-private",
      description: "Private procedure",
      instructions: "MANDATORY-PRIVATE-INSTRUCTION",
    });
    const model = new InspectSkillModel();
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingSkillAssessor(),
    });
    const run = await runs.execute(owner.user.id, "apply private procedure");
    assert.equal(run.status, "completed");
    assert.equal(model.sawInstruction, true);
    const detail = runs.plan(owner.user.id, run.id);
    assert.deepEqual(detail.plan.steps[0].skillIds, [skill.id]);
    assert.equal(detail.assessments.at(-1)?.skills[0].followed, true);
    const events = runs.events(owner.user.id, run.id);
    assert.equal(events.filter((event) => event.type === "skill.activation.available").length, 1);
    assert.equal(events.filter((event) => event.type === "skill.activated").length, 1);
  } finally {
    database.close();
  }
});

test("unused Plan-bound Skills do not block completion when output criteria are met", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("selected-skills@example.com", "selected skills secure password");
    const pptx = skills.create(owner.user.id, {
      name: "pptx",
      description: "Build PowerPoint decks",
      instructions: "PPTX-WORKFLOW-MUST-BE-FOLLOWED-WHEN-USED",
    });
    const presentation = skills.create(owner.user.id, {
      name: "presentation-skill",
      description: "Design presentation structure",
      instructions: "PRESENTATION-WORKFLOW-MUST-BE-FOLLOWED-WHEN-USED",
    });
    const theme = skills.create(owner.user.id, {
      name: "theme-factory",
      description: "Build visual themes",
      instructions: "THEME-WORKFLOW-MUST-BE-FOLLOWED-WHEN-USED",
    });
    const model = new SelectiveSkillUseModel();
    const planner: Planner = {
      plan: async () => ({
        goal: "produce the requested output",
        selectedSkillIds: [pptx.id, presentation.id, theme.id],
        steps: [{
          id: "build-deck",
          objective: "Produce the requested output",
          dependencies: [],
          skillIds: [pptx.id, presentation.id, theme.id],
          requiredToolNames: ["computer_list_directory"],
          successCriteria: [{ id: "output-ready", description: "The requested output is ready" }],
        }],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
      assessorFactory: () => selectiveSkillAssessor(pptx.id),
    });

    const run = await runs.execute(owner.user.id, "produce output using pptx presentation-skill theme-factory", { allowDangerousTools: true });

    assert.equal(run.status, "completed");
    const detail = runs.plan(owner.user.id, run.id);
    assert.deepEqual(detail.plan.steps[0].skillIds, [pptx.id, presentation.id, theme.id]);
    assert.equal(detail.assessments.length, 1);
    assert.equal(detail.assessments[0].approved, true);
    assert.deepEqual(detail.assessments[0].skills.map((skill) => skill.skillId), [pptx.id]);
    assert.equal(model.sawPptxInstruction, true);
  } finally {
    database.close();
  }
});

test("Plan step Tool lists are recommendations while execution can use any Run-authorized Tool", async () => {
  const database = new AppDatabase(":memory:");
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-tool-recommendation-"));
  try {
    await fs.writeFile(join(workspace, "evidence.txt"), "verified evidence\n");
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("tools@example.com", "tools secure password");
    const model = new ExtraToolBeyondRecommendationModel();
    const planner: Planner = {
      plan: async () => ({
        goal: "read evidence",
        selectedSkillIds: [],
        steps: [{
          ...step("read-evidence"),
          objective: "Read evidence using whatever authorized inspection Tool is needed.",
          requiredToolNames: ["computer_list_directory"],
          successCriteria: [{ id: "evidence-read", description: "Evidence file is read." }],
        }],
      }),
    };
    const runs = new RunService({
      database, skills, modelFactory: () => model, plannerFactory: () => planner,
      assessorFactory: () => new RuleBasedStepAssessor(),
      workspaceRoot: workspace,
    });
    const run = await runs.execute(owner.user.id, "read evidence");
    assert.equal(run.status, "completed");
    assert.equal(model.readToolWasVisible, true);
    assert.equal(model.recommendedListToolWasPresentInContext, true);
    const started = runs.events(owner.user.id, run.id).find((event) => event.type === "plan.step.started");
    const startedData = started?.data as { toolNames?: string[]; recommendedToolNames?: string[] } | undefined;
    assert.equal(Boolean(startedData?.toolNames?.includes("computer_read_file")), true);
    assert.deepEqual(startedData?.recommendedToolNames, ["computer_list_directory"]);
  } finally {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("RunService builds a cross-turn conversation workset from prior persisted facts", async () => {
  const database = new AppDatabase(":memory:");
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-conversation-workset-"));
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("workset@example.com", "workset secure password");
    const skill = skills.create(owner.user.id, {
      name: "deck-builder",
      description: "Create and verify editable pptx presentation files from outlines.",
      instructions: "Build the deck from source-grounded outline files.",
    });
    const conversationId = "conversation-workset";
    const priorRunId = "prior-failed-run";
    const priorPlanId = "prior-plan";
    const olderRunId = "older-completed-run";
    const now = Date.now();
    const conversationRoot = join(workspace, "conversations", conversationId);
    await fs.mkdir(join(conversationRoot, "artifacts"), { recursive: true });
    await fs.writeFile(join(conversationRoot, "artifacts", "outline.json"), "{\"slides\":[]}\n");
    await fs.writeFile(join(conversationRoot, "artifacts", "content.md"), "# content\n");

    database.prepare(`
      INSERT INTO conversations(id, owner_user_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(conversationId, owner.user.id, "Deck conversation", now - 20_000, now - 1_000);
    database.prepare(`
      INSERT INTO runs(
        id, owner_user_id, conversation_id, parent_run_id, depth, allow_dangerous_tools,
        model_key, status, input, output, error_code, created_at, finished_at
      ) VALUES (?, ?, ?, NULL, 0, 1, NULL, 'completed', ?, ?, NULL, ?, ?)
    `).run(olderRunId, owner.user.id, conversationId, "first completed turn", "done", now - 19_000, now - 18_000);
    database.prepare(`
      INSERT INTO runs(
        id, owner_user_id, conversation_id, parent_run_id, depth, allow_dangerous_tools,
        model_key, status, input, output, error_code, created_at, finished_at
      ) VALUES (?, ?, ?, NULL, 0, 1, NULL, 'failed', ?, NULL, 'MODEL_ERROR', ?, ?)
    `).run(priorRunId, owner.user.id, conversationId, "生成一份游戏推介 PPT", now - 10_000, now - 1_000);
    database.prepare(`
      INSERT INTO plans(id, run_id, version, goal, selected_skill_ids_json, status, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, 'failed', ?, ?)
    `).run(priorPlanId, priorRunId, "Create a suspense game pitch deck", JSON.stringify([skill.id]), now - 9_000, now - 1_000);
    const insertStep = database.prepare(`
      INSERT INTO plan_steps(
        plan_id, step_id, position, objective, dependencies_json, skill_ids_json,
        required_tool_names_json, success_criteria_json, status, output, evidence_json, error,
        started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `);
    insertStep.run(
      priorPlanId,
      "extract",
      0,
      "Extract source-grounded deck outline.",
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify(["computer_write_file"]),
      JSON.stringify([{ id: "outline", description: "Outline is written.", source: "planner" }]),
      "completed",
      "Created reusable source outline at artifacts/content.md.",
      null,
      now - 8_000,
      now - 7_000,
    );
    insertStep.run(
      priorPlanId,
      "build",
      1,
      "Generate the editable PPTX from artifacts/outline.json.",
      JSON.stringify(["extract"]),
      JSON.stringify([skill.id]),
      JSON.stringify(["load_skill", "computer_read_file", "computer_write_file", "computer_run_command"]),
      JSON.stringify([{ id: "pptx", description: "Editable pptx is generated.", source: "planner" }]),
      "failed",
      null,
      "Model provider returned HTTP 502",
      now - 6_000,
      now - 1_000,
    );
    insertStep.run(
      priorPlanId,
      "verify",
      2,
      "Render and verify the final PPTX.",
      JSON.stringify(["build"]),
      JSON.stringify([skill.id]),
      JSON.stringify(["load_skill", "computer_run_command", "computer_find_files"]),
      JSON.stringify([{ id: "verified", description: "Deck rendering is verified.", source: "planner" }]),
      "pending",
      null,
      null,
      null,
      null,
    );
    database.prepare(`
      INSERT INTO run_outcomes(run_id, plan_id, status, output, reason_code, committed_at)
      VALUES (?, ?, 'failed', NULL, 'MODEL_ERROR', ?)
    `).run(priorRunId, priorPlanId, now - 1_000);
    database.prepare(`
      INSERT INTO runtime_actions(
        id, run_id, plan_id, step_id, kind, state, attempt, max_attempts, replay_policy,
        deadline_at, lease_until, fence, revision, metadata_json, result_ref, error_code,
        created_at, updated_at, closed_at
      ) VALUES (?, ?, ?, ?, 'tool_call', 'succeeded', 1, 1, 'unsafe', NULL, NULL, 1, 1, ?, NULL, NULL, ?, ?, ?)
    `).run(
      "write-outline-action",
      priorRunId,
      priorPlanId,
      "build",
      JSON.stringify({ toolCallId: "write-outline", toolName: "computer_write_file" }),
      now - 5_000,
      now - 5_000,
      now - 5_000,
    );
    const insertEvent = database.prepare(`
      INSERT INTO run_events(run_id, seq, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertEvent.run(
      priorRunId,
      1,
      "tool.completed",
      JSON.stringify({
        step: 9,
        toolCallId: "write-outline",
        toolName: "computer_write_file",
        result: JSON.stringify({ path: "artifacts/outline.json", bytes: 12 }),
      }),
      now - 5_000,
    );
    insertEvent.run(
      priorRunId,
      2,
      "plan.step.failed",
      JSON.stringify({
        stepId: "build",
        error: "Model provider returned HTTP 502",
      }),
      now - 1_500,
    );
    insertEvent.run(
      priorRunId,
      3,
      "run.failed",
      JSON.stringify({
        runId: priorRunId,
        planId: priorPlanId,
        code: "MODEL_ERROR",
        message: "Model provider returned HTTP 502",
      }),
      now - 1_000,
    );

    let capturedTask: TaskSpec | undefined;
    const planner: Planner = {
      plan: async (task) => {
        capturedTask = task;
        return {
          goal: "continue deck",
          selectedSkillIds: task.availableSkills.map((item) => item.id),
          steps: [{
            id: "continue-build",
            objective: "Continue from the prior outline and write the final deck.",
            dependencies: [],
            skillIds: task.availableSkills.map((item) => item.id),
            requiredToolNames: ["computer_write_file"],
            successCriteria: [{ id: "continued", description: "Continuation completed.", source: "planner" }],
          }],
        };
      },
    };
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => new StaticModel({ content: "continued", finishReason: "stop", toolCalls: [] }),
      plannerFactory: () => planner,
      assessorFactory: () => approvingTestAssessor(),
    });

    const run = await runs.execute(owner.user.id, "基于上面的成果继续推进", {
      conversationId,
      allowDangerousTools: true,
    });

    assert.equal(run.status, "completed");
    assert.equal(capturedTask?.availableSkills.map((item) => item.id).includes(skill.id), true);
    const workset = capturedTask?.conversationWorkingSet as ConversationWorkingSet | undefined;
    assert.equal(workset?.schema, "conversation.workset/v1");
    assert.equal(workset?.runCount, 2);
    assert.equal(workset?.activeGoal?.runId, priorRunId);
    assert.equal(workset?.activeGoal?.reasonCode, "MODEL_ERROR");
    assert.deepEqual(workset?.requiredCapabilities.skillIds, [skill.id]);
    assert.equal(workset?.requiredCapabilities.toolNames.includes("computer_write_file"), true);
    assert.equal(workset?.reusableArtifacts.some((artifact) =>
      artifact.path === "artifacts/outline.json"
      && artifact.sourceToolCallId === "write-outline"
      && artifact.sourcePlanStepId === "build"
      && artifact.reusable
    ), true);
    assert.equal(workset?.failedBoundaries[0]?.category, "provider");
    assert.equal(workset?.failedBoundaries[0]?.stepId, "build");
    assert.match(workset?.resumeSuggestion ?? "", /Continue from prior Run/);
    assert.match(workset?.resumeSuggestion ?? "", /artifacts\/outline\.json/);
  } finally {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("execution context injects data-analysis operation profile before the first model action", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("operation-profile@example.com", "operation profile secure password");
    let sawDataAnalysisProfile = false;
    const model: ModelAdapter = {
      limits: TEST_MODEL_LIMITS,
      complete: async (request) => {
        const context = request.runtimeContext?.content ?? "";
        sawDataAnalysisProfile = /"id":"data_analysis"/.test(context)
          && /structured extraction artifact/.test(context)
          && /Do not repeatedly print overlapping raw rows to stdout/.test(context)
          && !/dataAcquisitionDiscipline/.test(context);
        return { content: "analysis evidence is ready", finishReason: "stop", toolCalls: [] };
      },
    };
    const planner: Planner = {
      plan: async () => ({
        goal: "analyze spreadsheet",
        selectedSkillIds: [],
        steps: [{
          id: "analyze-xlsx",
          objective: "Analyze 1.xlsx and return scenario analysis conclusions from the workbook data.",
          dependencies: [],
          skillIds: [],
          requiredToolNames: [],
          successCriteria: [{ id: "analysis-ready", description: "Workbook schema, record counts, and analysis conclusions are available." }],
        }],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
      assessorFactory: () => approvingSkillAssessor(),
    });

    const run = await runs.execute(owner.user.id, "分析 1.xlsx 并生成场景分析报告");

    assert.equal(run.status, "completed");
    assert.equal(sawDataAnalysisProfile, true);
  } finally {
    database.close();
  }
});

test("default assessment policy uses a persisted lookup-lite profile for ordinary information lookup", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("lookup-lite@example.com", "lookup lite secure password");
    const model = new LookupLiteResearchModel();
    const websearch: RuntimeTool<unknown> = {
      name: "websearch",
      description: "Focused test search tool",
      inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string" } } },
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => value,
      execute: async () => [{ title: "Example release", url: "https://example.test/release", snippet: "Released today" }],
    };
    const planner: Planner = {
      plan: async () => ({
        goal: "look up release information",
        selectedSkillIds: [],
        steps: [{
          id: "lookup-release",
          objective: "Look up release information and answer the user.",
          dependencies: [],
          skillIds: [],
          requiredToolNames: ["websearch"],
          successCriteria: [{ id: "answer-returned", description: "The answer is returned." }],
        }],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
      tools: [websearch],
    });

    const run = await runs.execute(owner.user.id, "查一下 Example 的发布信息");

    assert.equal(run.status, "completed");
    assert.equal(model.assessmentCalls, 0);
    const detail = runs.plan(owner.user.id, run.id);
    assert.equal(detail.assessments.length, 1);
    assert.equal(detail.assessments[0].approved, true);
    assert.equal(detail.assessments[0].assessmentProfile, "lookup_lite");
    assert.equal(detail.assessments[0].assessmentMethod, "rule");
    assert.ok(runs.actionsForRun(owner.user.id, run.id).some((action) => action.kind === "assessment" && action.state === "succeeded"));
    const event = runs.events(owner.user.id, run.id).find((item) => item.type === "skill.compliance.assessed");
    assert.equal((event?.data as { assessmentProfile?: string } | undefined)?.assessmentProfile, "lookup_lite");
    const outcome = database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
      .get(run.id) as { status: string; reason_code: string };
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reason_code, "plan_assessed_and_completed");
  } finally {
    database.close();
  }
});

test("web lookup evidence queues convergence before the step budget is exhausted", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("web-research-converge@example.com", "web research converge secure password");
    let executions = 0;
    const websearch: RuntimeTool<unknown> = {
      name: "websearch",
      description: "Focused test search tool",
      inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string" } } },
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => value,
      execute: async () => {
        executions += 1;
        return [{ title: `Example source ${executions}`, url: `https://example.test/${executions}`, snippet: "Relevant evidence" }];
      },
    };
    const model = new BoundedWebResearchModel();
    const planner: Planner = {
      plan: async () => ({
        goal: "look up event information",
        selectedSkillIds: [],
        steps: [{
          id: "lookup-event",
          objective: "Look up event time and venue.",
          dependencies: [],
          skillIds: [],
          requiredToolNames: ["websearch"],
          successCriteria: [
            { id: "event-facts", description: "Event time and venue are returned." },
            { id: "result-link", description: "A result link is included." },
          ],
        }],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
      tools: [websearch],
      maxSteps: 8,
    });

    const run = await runs.execute(owner.user.id, "查一下活动信息");

    assert.equal(run.status, "completed");
    assert.equal(run.output, "Event evidence is ready from websearch results https://example.test/1 and https://example.test/2.");
    assert.equal(executions, 2);
    assert.equal(model.executionCalls, 2);
    const events = runs.events(owner.user.id, run.id);
    assert.equal(events.filter((event) => event.type === "loop.convergence_queued").length, 1);
    const requested = events.find((event) => event.type === "loop.convergence_requested");
    assert.equal(requested?.data.reason, "lookup_evidence_ready:websearch_results");
    assert.equal(events.some((event) => event.type === "loop.limit_exceeded"), false);
    const detail = runs.plan(owner.user.id, run.id);
    assert.equal(detail.assessments.length, 1);
    assert.equal(detail.assessments[0].assessmentProfile, "lookup_lite");
    assert.equal(detail.assessments[0].approved, true);
    const outcome = database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
      .get(run.id) as { status: string; reason_code: string };
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reason_code, "plan_assessed_and_completed");
  } finally {
    database.close();
  }
});

test("rule-based assessment cannot claim Skill compliance but repair limit can complete with caveat", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("criteria@example.com", "criteria secure password");
    const skill = skills.create(owner.user.id, {
      name: "semantic-check",
      description: "Requires semantic review",
      instructions: "Apply the rule.",
    });
    const runs = new RunService({
      database, skills, modelFactory: () => new LoadThenClaimModel(), maxSteps: 3,
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => new RuleBasedStepAssessor(),
    });
    const run = await runs.execute(owner.user.id, "semantic task");
    const runId = run.id;
    const detail = runs.plan(owner.user.id, runId);
    assert.equal(detail.assessments.at(-1)?.approved, false);
    assert.equal(runs.get(owner.user.id, runId).status, "completed");
    assert.equal(runs.events(owner.user.id, runId).filter((event) => event.type === "loop.candidate_repair_grace_granted").length, 1);
    assert.equal(runs.events(owner.user.id, runId).filter((event) => event.type === "candidate.completion_caveated").length, 1);
    assert.equal(runs.events(owner.user.id, runId).some((event) => event.type === "skill.compliance.assessment_reused"), true);
    assert.equal(runs.events(owner.user.id, runId).some((event) => event.type === "candidate.assessment_reused"), true);
    const outcome = database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
      .get(run.id) as { status: string; reason_code: string };
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reason_code, "completed_with_repair_limit_caveat");
  } finally {
    database.close();
  }
});

test("process-only Skill gaps complete with process caveat outcome", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("process-caveat@example.com", "process caveat secure password");
    skills.create(owner.user.id, {
      name: "semantic-check",
      description: "Requires process evidence",
      instructions: "Plan before building.",
    });
    const runs = new RunService({
      database, skills, modelFactory: () => new LoadThenClaimModel(), maxSteps: 3,
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => processCaveatAssessor(),
    });

    const run = await runs.execute(owner.user.id, "semantic task");

    assert.equal(run.status, "completed");
    const detail = runs.plan(owner.user.id, run.id);
    assert.equal(detail.assessments.at(-1)?.approved, true);
    const assessment = database.prepare(`
      SELECT skills_json FROM skill_compliance_assessments WHERE plan_id = ? ORDER BY attempt DESC LIMIT 1
    `).get(detail.plan.id) as { skills_json: string };
    assert.equal(JSON.parse(assessment.skills_json)[0].status, "process_caveat");
    const outcome = database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
      .get(run.id) as { status: string; reason_code: string };
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reason_code, "completed_with_process_caveat");
  } finally {
    database.close();
  }
});

test("required validation that remains locally unavailable completes with deferred-validation caveat", async () => {
  const database = new AppDatabase(":memory:");
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-deferred-validation-"));
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("deferred-validation@example.com", "deferred validation secure password");
    const skill = skills.create(owner.user.id, {
      name: "presentation-skill",
      description: "Build and render editable pptx artifacts",
      instructions: "Create the deck and run visual validation when available.",
    });
    const model = new DeferredValidationRunModel();
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => deferredValidationAssessor(skill.id),
      workspaceRoot: workspace,
      maxSteps: 3,
    });

    const run = await runs.execute(
      owner.user.id,
      "使用 presentation-skill 生成 deck.pptx 并完成本地渲染校验",
      { allowDangerousTools: true },
    );

    assert.equal(run.status, "completed");
    assert.match(run.output ?? "", /Deferred validation note/i);
    const detail = runs.plan(owner.user.id, run.id);
    assert.equal(detail.plan.status, "completed");
    assert.equal(detail.assessments.at(-1)?.approved, false);
    assert.equal(detail.assessments.at(-1)?.skills[0].status, "skipped_unavailable");
    assert.equal(runs.events(owner.user.id, run.id).filter((event) => event.type === "candidate.validation_deferred").length, 1);
    const outcome = database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
      .get(run.id) as { status: string; reason_code: string };
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reason_code, "completed_with_deferred_validation");
  } finally {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("Structured planning, execution, assessment, and terminal commit form one complete chain", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("full-chain@example.com", "full chain secure password");
    const skill = skills.create(owner.user.id, {
      name: "evidence-chain",
      description: "Require evidence in the answer",
      instructions: "Include canonical evidence.",
    });
    const model = new FullChainModel(skill.id);
    const lines: string[] = [];
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      runEventLogSink: (line) => lines.push(line),
    });
    const run = await runs.execute(owner.user.id, "produce answer");
    assert.equal(run.status, "completed");
    assert.equal(run.output, "answer with canonical evidence");
    assert.ok(lines.some((line) => line.includes("event=planning.skills.selected") && line.includes("selected=\"evidence-chain\"")));
    assert.ok(lines.some((line) => line.includes("event=planning.started") && line.includes("availableSkills=1")));
    assert.ok(lines.some((line) => line.includes("event=planning.turn.completed") && line.includes("submitPlanCalls=1")));
    assert.ok(lines.some((line) => line.includes("event=run.completed")));
    const detail = runs.plan(owner.user.id, run.id);
    assert.equal(detail.plan.status, "completed");
    assert.equal(detail.assessments.length, 1);
    assert.equal(detail.assessments[0].approved, true);
    const actions = runs.actionsForRun(owner.user.id, run.id);
    assert.ok(actions.every((action) => action.state === "succeeded"));
    assert.ok(actions.some((action) => action.kind === "planning"));
    assert.ok(actions.some((action) => action.kind === "model_turn"));
    assert.ok(actions.some((action) => action.kind === "assessment"));
    const outcome = database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
      .get(run.id) as { status: string; reason_code: string };
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reason_code, "plan_assessed_and_completed");
  } finally {
    database.close();
  }
});

test("budgeted convergence still requires assessment before TerminalCommitter completes the Run", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("convergence@example.com", "convergence secure password");
    let executions = 0;
    const proofTool: RuntimeTool<unknown> = {
      name: "collect_proof",
      description: "Collect the proof required by the current step",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => value,
      execute: async () => {
        executions += 1;
        return { artifact: "ready", validation: "passed" };
      },
    };
    const model = new TerminalConvergenceModel();
    const planner: Planner = {
      plan: async () => ({
        goal: "produce a verified artifact",
        selectedSkillIds: [],
        steps: [{
          id: "collect-proof",
          objective: "Collect proof for the verified artifact.",
          dependencies: [],
          skillIds: [],
          requiredToolNames: ["collect_proof"],
          successCriteria: [{ id: "artifact-ready", description: "A verified artifact is produced." }],
        }],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      maxSteps: 2,
      plannerFactory: () => planner,
      assessorFactory: () => new RuleBasedStepAssessor(),
      tools: [proofTool],
    });

    const run = await runs.execute(owner.user.id, "produce a verified artifact");

    assert.equal(run.status, "completed");
    assert.equal(run.output, "verified artifact ready; evidence: collect_proof");
    assert.equal(executions, 1);
    const detail = runs.plan(owner.user.id, run.id);
    assert.equal(detail.plan.status, "completed");
    assert.equal(detail.assessments.length, 1);
    assert.equal(detail.assessments[0].approved, true);
    const proofAction = runs.actionsForRun(owner.user.id, run.id)
      .find((action) => action.kind === "tool_call");
    assert.equal(proofAction?.state, "succeeded");
    assert.equal(proofAction?.replayPolicy, "safe");
    assert.equal(runs.events(owner.user.id, run.id).filter((event) => event.type === "loop.convergence_requested").length, 1);
    const outcome = database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
      .get(run.id) as { status: string; reason_code: string };
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reason_code, "plan_assessed_and_completed");
  } finally {
    database.close();
  }
});

test("file artifact evidence queues assessment instead of spending all file-output grace steps", async () => {
  const database = new AppDatabase(":memory:");
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-file-converge-"));
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("file-converge@example.com", "file converge secure password");
    const planner: Planner = {
      plan: async () => ({
        goal: "produce poster files",
        selectedSkillIds: [],
        steps: [{
          id: "design-poster",
          objective: "Create a poster and output PNG and PDF files.",
          dependencies: [],
          skillIds: [],
          requiredToolNames: ["computer_write_file"],
          successCriteria: [
            { id: "png-output", description: "A poster PNG file is generated.", source: "planner" },
            { id: "pdf-output", description: "A poster PDF file is generated.", source: "planner" },
          ],
        }],
      }),
    };
    const model = new FileArtifactConvergenceModel();
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => model,
      plannerFactory: () => planner,
      assessorFactory: () => approvingSkillAssessor(),
    });

    const run = await runs.execute(owner.user.id, "make a poster", { allowDangerousTools: true });

    assert.equal(run.status, "completed");
    assert.equal(run.output, "poster.png and poster.pdf are ready");
    assert.equal(model.calls, 2);
    const events = runs.events(owner.user.id, run.id);
    assert.equal(events.filter((event) => event.type === "loop.convergence_queued").length, 1);
    const requested = events.find((event) => event.type === "loop.convergence_requested");
    assert.match(String(requested?.data.reason), /required_file_artifacts_observed/);
    assert.equal(events.filter((event) => event.type === "tool.completed").length, 2);
    assert.equal(events.some((event) => event.type === "loop.limit_exceeded"), false);
    const detail = runs.plan(owner.user.id, run.id);
    assert.equal(detail.assessments.length, 1);
    const outcome = database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
      .get(run.id) as { status: string; reason_code: string };
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reason_code, "plan_assessed_and_completed");
  } finally {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("file artifact convergence ignores command stdout that only mentions output paths", async () => {
  const database = new AppDatabase(":memory:");
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-file-stdout-mention-"));
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("file-stdout-mention@example.com", "file stdout mention secure password");
    const planner: Planner = {
      plan: async () => ({
        goal: "produce poster files",
        selectedSkillIds: [],
        steps: [{
          id: "design-poster",
          objective: "Create a poster and output PNG and PDF files.",
          dependencies: [],
          skillIds: [],
          requiredToolNames: ["computer_run_command", "computer_write_file"],
          successCriteria: [
            { id: "png-output", description: "A poster PNG file is generated.", source: "planner" },
            { id: "pdf-output", description: "A poster PDF file is generated.", source: "planner" },
          ],
        }],
      }),
    };
    const model = new StdoutMentionThenWriteModel();
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => model,
      plannerFactory: () => planner,
      assessorFactory: () => approvingSkillAssessor(),
    });

    const run = await runs.execute(owner.user.id, "make a poster", { allowDangerousTools: true });

    assert.equal(run.status, "completed");
    assert.equal(run.output, "poster.png and poster.pdf are ready");
    assert.equal(model.calls, 3);
    const events = runs.events(owner.user.id, run.id);
    assert.equal(events.filter((event) => event.type === "loop.convergence_queued").length, 1);
    assert.equal(events.filter((event) => event.type === "tool.completed").length, 3);
    assert.equal(events.some((event) => event.type === "loop.limit_exceeded"), false);
  } finally {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("file artifact evidence accepts command fileChanges instead of stdout path mentions", async () => {
  const database = new AppDatabase(":memory:");
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-file-command-changes-"));
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("file-command-changes@example.com", "file command changes secure password");
    const planner: Planner = {
      plan: async () => ({
        goal: "produce poster files",
        selectedSkillIds: [],
        steps: [{
          id: "design-poster",
          objective: "Create a poster and output PNG and PDF files.",
          dependencies: [],
          skillIds: [],
          requiredToolNames: ["computer_run_command"],
          successCriteria: [
            { id: "png-output", description: "A poster PNG file is generated.", source: "planner" },
            { id: "pdf-output", description: "A poster PDF file is generated.", source: "planner" },
          ],
        }],
      }),
    };
    const model = new CommandFileChangesConvergenceModel();
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => model,
      plannerFactory: () => planner,
      assessorFactory: () => approvingSkillAssessor(),
    });

    const run = await runs.execute(owner.user.id, "make a poster", { allowDangerousTools: true });

    assert.equal(run.status, "completed");
    assert.equal(run.output, "poster.png and poster.pdf are ready");
    assert.equal(model.calls, 2);
    const events = runs.events(owner.user.id, run.id);
    assert.equal(events.filter((event) => event.type === "loop.convergence_queued").length, 1);
    assert.equal(events.filter((event) => event.type === "tool.completed").length, 1);
    assert.equal(events.some((event) => event.type === "loop.limit_exceeded"), false);
  } finally {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("file artifact convergence does not shortcut verification-only artifact steps", async () => {
  const database = new AppDatabase(":memory:");
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-file-verify-only-"));
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("file-verify-only@example.com", "file verify only secure password");
    const planner: Planner = {
      plan: async () => ({
        goal: "verify deck artifact",
        selectedSkillIds: [],
        steps: [{
          id: "verify-deck",
          objective: "Verify existing deck.pptx with QA checks.",
          dependencies: [],
          skillIds: [],
          requiredToolNames: ["computer_run_command"],
          successCriteria: [
            { id: "deck-verified", description: "Final deck.pptx is inspected and verified.", source: "planner" },
          ],
        }],
      }),
    };
    const model = new VerificationOnlyArtifactModel();
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => model,
      plannerFactory: () => planner,
      assessorFactory: () => approvingSkillAssessor(),
    });

    const run = await runs.execute(owner.user.id, "verify deck", { allowDangerousTools: true });

    assert.equal(run.status, "completed");
    assert.equal(run.output, "deck.pptx was inspected and verified by QA command");
    assert.equal(model.calls, 2);
    const events = runs.events(owner.user.id, run.id);
    assert.equal(events.filter((event) => event.type === "loop.convergence_queued").length, 0);
    assert.equal(events.filter((event) => event.type === "tool.completed").length, 1);
  } finally {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("an approved recovery revision can retire an unfinished safe tail step and complete only through TerminalCommitter", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("recovery-revision@example.com", "recovery revision secure password");
    const runId = "recovery-revision-run";
    database.prepare(`
      INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "produce the requested artifact", Date.now());
    const plans = new PlanRepository(database);
    const plan = plans.create(admitPlan({
      runId,
      proposal: {
        goal: "produce the requested artifact",
        selectedSkillIds: [],
        steps: [step("build"), { ...step("critique-polish"), dependencies: ["build"] }],
      },
      availableSkills: [],
      availableToolNames: new Set(),
    }));
    plans.startStep(plan.id, "build");
    plans.saveAssessment({
      id: "build-assessment", planId: plan.id, stepId: "build", attempt: 1, approved: true,
      criteria: [{ criterionId: "build-done", satisfied: true, rationale: "canonical evidence", evidenceRefs: ["candidateOutput"] }],
      skills: [], evidenceDigest: "build-evidence", feedback: "", createdAt: Date.now(),
    });
    plans.completeStep(plan.id, "build", "verified artifact", { candidateOutput: "verified artifact", toolCalls: [], modelSteps: 1 });
    const actions = new RuntimeActionRepository(database);
    const action = actions.dispatch({
      runId, planId: plan.id, stepId: "critique-polish", kind: "model_turn", replayPolicy: "safe", deadlineMs: 1_000,
    });
    database.prepare("UPDATE runtime_actions SET deadline_at = 0, lease_until = 0 WHERE id = ?").run(action.id);
    assert.equal(actions.reconcileRunningRuns(), 1);
    const runs = new RunService({
      database, skills, modelFactory: () => new StaticModel({ content: "", toolCalls: [], finishReason: "stop" }),
      recoveryPlannerFactory: () => ({
        decide: async () => ({
          actionId: action.id, expectedActionRevision: 2, decision: "revise_plan", rationale: "The requested artifact is already assessed; optional polish has no effect.", evidenceRefs: ["build-assessment"],
          planRevision: { goal: "produce the requested artifact", selectedSkillIds: [], steps: [step("build")] },
        }),
      }),
      planRevisionAssessorFactory: () => ({
        assess: async () => ({ approved: true, feedback: "", evidenceRefs: ["build-assessment"] }),
      }),
    });

    const recovery = await runs.advanceRecovery(owner.user.id, runId);
    assert.equal(recovery.state, undefined);
    assert.equal(recovery.decisions[0]?.state, "admitted");
    assert.equal(recovery.planRevisionAssessments[0]?.approved, true);
    assert.equal(runs.get(owner.user.id, runId).status, "completed");
    assert.equal(runs.get(owner.user.id, runId).output, "verified artifact");
    const revised = runs.plan(owner.user.id, runId).plan;
    assert.equal(revised.status, "completed");
    assert.ok(revised.steps.find((item) => item.id === "critique-polish")?.retiredAt !== undefined);
    const outcome = database.prepare("SELECT reason_code FROM run_outcomes WHERE run_id = ?").get(runId) as { reason_code: string };
    assert.equal(outcome.reason_code, "plan_assessed_and_completed");
  } finally {
    database.close();
  }
});

test("recovery never resumes an unsafe Action and preserves the Run for a new decision", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("recovery-unsafe@example.com", "recovery unsafe secure password");
    const runId = "unsafe-recovery-run";
    database.prepare(`
      INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "perform external effect", Date.now());
    const actions = new RuntimeActionRepository(database);
    const action = actions.dispatch({ runId, kind: "tool_call", replayPolicy: "unsafe", deadlineMs: 1_000 });
    database.prepare("UPDATE runtime_actions SET deadline_at = 0, lease_until = 0 WHERE id = ?").run(action.id);
    actions.reconcileRunningRuns();
    const runs = new RunService({
      database, skills, modelFactory: () => new StaticModel({ content: "", toolCalls: [], finishReason: "stop" }),
      recoveryPlannerFactory: () => ({
        decide: async () => ({ actionId: action.id, expectedActionRevision: 2, decision: "resume_step", rationale: "retry", evidenceRefs: [] }),
      }),
    });

    await assert.rejects(() => runs.advanceRecovery(owner.user.id, runId), (error: unknown) => hasCode(error, "TOOL_POLICY_DENIED"));
    assert.equal(runs.get(owner.user.id, runId).status, "running");
    const recovery = runs.recoveryForRun(owner.user.id, runId);
    assert.equal(recovery.state?.state, "waiting_recovery");
    assert.equal(recovery.decisions[0]?.state, "rejected");
  } finally {
    database.close();
  }
});

test("recovery records a user question instead of inferring an unsafe external fact", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("recovery-question@example.com", "recovery question secure password");
    const runId = "question-recovery-run";
    database.prepare(`
      INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "confirm whether email was sent", Date.now());
    const actions = new RuntimeActionRepository(database);
    const action = actions.dispatch({ runId, kind: "tool_call", replayPolicy: "unsafe", deadlineMs: 1_000 });
    database.prepare("UPDATE runtime_actions SET deadline_at = 0, lease_until = 0 WHERE id = ?").run(action.id);
    actions.reconcileRunningRuns();
    const runs = new RunService({
      database, skills, modelFactory: () => new StaticModel({ content: "", toolCalls: [], finishReason: "stop" }),
      recoveryPlannerFactory: () => ({
        decide: async () => ({
          actionId: action.id, expectedActionRevision: 2, decision: "ask_user", rationale: "The external effect is unknown.", evidenceRefs: [],
          question: "Please confirm whether the email was delivered.",
        }),
      }),
    });

    const recovery = await runs.advanceRecovery(owner.user.id, runId);
    assert.equal(recovery.state?.state, "waiting_user");
    assert.equal(recovery.state?.question, "Please confirm whether the email was delivered.");
    assert.equal(recovery.decisions[0]?.state, "admitted");
    assert.equal(runs.get(owner.user.id, runId).status, "running");
  } finally {
    database.close();
  }
});

test("safe recovery rebuilds only complete exchanges, resumes the interrupted step, and continues dependent Plan work", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("recovery-resume@example.com", "recovery resume secure password");
    const runId = "recovery-resume-run";
    database.prepare(`
      INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "recover the interrupted work", Date.now());
    const plans = new PlanRepository(database);
    const plan = plans.create(admitPlan({
      runId,
      proposal: {
        goal: "recover the interrupted work",
        selectedSkillIds: [],
        steps: [step("build"), { ...step("verify"), dependencies: ["build"] }],
      },
      availableSkills: [],
      availableToolNames: new Set(),
    }));
    plans.startStep(plan.id, "build");
    const actions = new RuntimeActionRepository(database);
    const action = actions.dispatch({
      runId, planId: plan.id, stepId: "build", kind: "model_turn", replayPolicy: "safe", deadlineMs: 1_000,
    });
    database.prepare(`
      INSERT INTO run_events(run_id, seq, type, payload_json, created_at) VALUES
        (?, 20, 'plan.step.started', ?, ?),
        (?, 21, 'assistant.committed', ?, ?),
        (?, 22, 'tool.effect_pending', ?, ?)
    `).run(
      runId, JSON.stringify({ planId: plan.id, stepId: "build" }), Date.now(),
      runId, JSON.stringify({ step: 1, content: "", toolCalls: [{ id: "unfinished-tool", name: "external_write", arguments: {} }] }), Date.now(),
      runId, JSON.stringify({ step: 1, toolCallId: "unfinished-tool", toolName: "external_write", replaySafe: true }), Date.now(),
    );
    database.prepare("UPDATE runtime_actions SET deadline_at = 0, lease_until = 0 WHERE id = ?").run(action.id);
    actions.reconcileRunningRuns();
    let modelCalls = 0;
    const model: ModelAdapter = {
      limits: TEST_MODEL_LIMITS,
      complete: async (request) => {
        modelCalls += 1;
        if (modelCalls === 1) {
          assert.deepEqual(request.messages, [{ role: "user", content: "recover the interrupted work" }]);
          assert.match(request.runtimeContext?.content ?? "", /unfinished-tool/);
          return { content: "rebuilt artifact", toolCalls: [], finishReason: "stop" };
        }
        assert.match(request.runtimeContext?.content ?? "", /"id":"verify"/);
        return { content: "verified rebuilt artifact", toolCalls: [], finishReason: "stop" };
      },
    };
    const runs = new RunService({
      database, skills, modelFactory: () => model,
      recoveryPlannerFactory: () => ({
        decide: async () => ({ actionId: action.id, expectedActionRevision: 2, decision: "resume_step", rationale: "Safe model turn can restart from persisted facts.", evidenceRefs: [] }),
      }),
      assessorFactory: () => approvingSkillAssessor(),
    });

    await runs.advanceRecovery(owner.user.id, runId);
    const resumed = await runs.resumeRecovery(owner.user.id, runId);
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.output, "verified rebuilt artifact");
    assert.equal(modelCalls, 2);
    const detail = runs.plan(owner.user.id, runId);
    assert.ok(detail.plan.steps.every((item) => item.status === "completed"));
    assert.equal(detail.assessments.length, 2);
    assert.ok(detail.assessments.every((assessment) => assessment.approved));
    assert.equal(runs.recoveryForRun(owner.user.id, runId).state, undefined);
  } finally {
    database.close();
  }
});

test("a persisted user recovery response reopens Planner decision-making for the same Action", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("recovery-answer@example.com", "recovery answer secure password");
    const runId = "recovery-answer-run";
    database.prepare(`
      INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "confirm external effect", Date.now());
    const actions = new RuntimeActionRepository(database);
    const action = actions.dispatch({ runId, kind: "tool_call", replayPolicy: "unsafe", deadlineMs: 1_000 });
    database.prepare("UPDATE runtime_actions SET deadline_at = 0, lease_until = 0 WHERE id = ?").run(action.id);
    actions.reconcileRunningRuns();
    let decisions = 0;
    const runs = new RunService({
      database, skills, modelFactory: () => new StaticModel({ content: "", toolCalls: [], finishReason: "stop" }),
      recoveryPlannerFactory: () => ({
        decide: async (input) => {
          decisions += 1;
          if (decisions === 1) {
            assert.deepEqual(input.userResponses, []);
            return {
              actionId: action.id, expectedActionRevision: 2, decision: "ask_user", rationale: "External effect is unknown.", evidenceRefs: [],
              question: "Was the external effect applied?",
            };
          }
          assert.equal(input.userResponses[0]?.response, "No, it was not applied.");
          return { actionId: action.id, expectedActionRevision: 2, decision: "fail", rationale: "User confirmed no external effect.", evidenceRefs: [] };
        },
      }),
    });

    await runs.advanceRecovery(owner.user.id, runId);
    const answered = runs.respondRecovery(owner.user.id, runId, "No, it was not applied.");
    assert.equal(answered.state?.state, "waiting_recovery");
    assert.equal(answered.userResponses[0]?.response, "No, it was not applied.");
    await runs.advanceRecovery(owner.user.id, runId);
    assert.equal(decisions, 2);
    assert.equal(runs.get(owner.user.id, runId).status, "failed");
    assert.equal(runs.recoveryForRun(owner.user.id, runId).decisions.filter((item) => item.state === "admitted").length, 2);
  } finally {
    database.close();
  }
});

class StaticModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private readonly response: ModelResponse;
  constructor(response: ModelResponse) { this.response = response; }
  async complete(): Promise<ModelResponse> { return this.response; }
}

class InspectSkillModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  sawInstruction = false;
  private calls = 0;
  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.match(request.runtimeContext?.content ?? "", /strict-private/);
      assert.doesNotMatch(request.runtimeContext?.content ?? "", /MANDATORY-PRIVATE-INSTRUCTION/);
      assert.ok(request.tools.some((tool) => tool.name === "load_skill"));
      assert.equal(request.tools.some((tool) => tool.name === "computer_write_file"), false);
      assert.equal(request.toolChoice, "auto");
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "load", name: "load_skill", arguments: { name: "strict-private" } }],
      };
    }
    const loaded = request.messages.find((message) => message.role === "tool" && message.name === "load_skill");
    this.sawInstruction = loaded?.content.includes("MANDATORY-PRIVATE-INSTRUCTION") ?? false;
    return { content: "instruction applied", toolCalls: [], finishReason: "stop" };
  }
}

class SelectiveSkillUseModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  sawPptxInstruction = false;
  private calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    const toolNames = request.tools.map((tool) => tool.name);
    if (this.calls === 1) {
      assert.equal(toolNames.includes("computer_list_directory"), true);
      assert.equal(toolNames.includes("load_skill"), true);
      assert.match(request.runtimeContext?.content ?? "", /presentation-skill/);
      assert.match(request.runtimeContext?.content ?? "", /theme-factory/);
      assert.doesNotMatch(request.runtimeContext?.content ?? "", /PRESENTATION-WORKFLOW-MUST-BE-FOLLOWED-WHEN-USED/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "load-pptx", name: "load_skill", arguments: { name: "pptx" } }],
      };
    }
    const loaded = request.messages.find((message) => message.role === "tool" && message.name === "load_skill");
    const transcript = request.messages.map((message) => message.content).join("\n");
    this.sawPptxInstruction = loaded?.content.includes("PPTX-WORKFLOW-MUST-BE-FOLLOWED-WHEN-USED") ?? false;
    assert.doesNotMatch(transcript, /PRESENTATION-WORKFLOW-MUST-BE-FOLLOWED-WHEN-USED/);
    assert.doesNotMatch(transcript, /THEME-WORKFLOW-MUST-BE-FOLLOWED-WHEN-USED/);
    return { content: "requested output is ready using pptx evidence", toolCalls: [], finishReason: "stop" };
  }
}

class LoadThenClaimModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private loaded = false;
  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (!this.loaded) {
      this.loaded = true;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "load", name: "load_skill", arguments: { name: "semantic-check" } }],
      };
    }
    return { content: "claim", toolCalls: [], finishReason: "stop" };
  }
}

class DeferredValidationRunModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.equal(request.tools.some((tool) => tool.name === "load_skill"), true);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "load-presentation", name: "load_skill", arguments: { name: "presentation-skill" } }],
      };
    }
    if (this.calls === 2) {
      assert.equal(request.tools.some((tool) => tool.name === "computer_write_file"), true);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "write-deck", name: "computer_write_file", arguments: { path: "deck.pptx", content: "pptx" } }],
      };
    }
    return {
      content: "deck.pptx 已生成，但本地渲染校验器不可用，未完成逐页视觉校验。",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class ExtraToolBeyondRecommendationModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;
  readToolWasVisible = false;
  recommendedListToolWasPresentInContext = false;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    const toolNames = request.tools.map((tool) => tool.name);
    this.readToolWasVisible = this.readToolWasVisible || toolNames.includes("computer_read_file");
    this.recommendedListToolWasPresentInContext = this.recommendedListToolWasPresentInContext
      || (request.runtimeContext?.content ?? "").includes("\"recommendedToolNames\":[\"computer_list_directory\"]");
    if (this.calls === 1) {
      assert.equal(toolNames.includes("computer_read_file"), true);
      return {
        content: "",
        toolCalls: [{
          id: "read-extra-tool",
          name: "computer_read_file",
          arguments: { path: "evidence.txt" },
        }],
        finishReason: "tool_calls",
      };
    }
    return { content: "Evidence file was read with computer_read_file.", toolCalls: [], finishReason: "stop" };
  }
}

class LookupLiteResearchModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  assessmentCalls = 0;
  private executionCalls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.phase === "assessment") {
      this.assessmentCalls += 1;
      throw new Error("lookup-lite test should not invoke the model assessor");
    }
    this.executionCalls += 1;
    if (this.executionCalls === 1) {
      assert.equal(request.tools.some((tool) => tool.name === "websearch"), true);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "lookup", name: "websearch", arguments: { query: "Example release information" } }],
      };
    }
    return {
      content: "Example release information is available from the websearch result at https://example.test/release.",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class BoundedWebResearchModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  executionCalls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.phase === "assessment") {
      throw new Error("bounded web research should use lookup-lite rule assessment");
    }
    this.executionCalls += 1;
    if (this.executionCalls === 1) {
      assert.equal(request.tools.some((tool) => tool.name === "websearch"), true);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          { id: "search-1", name: "websearch", arguments: { query: "event time venue" } },
          { id: "search-2", name: "websearch", arguments: { query: "event source URL" } },
        ],
      };
    }
    assert.deepEqual(request.tools, []);
    assert.match(request.runtimeContext?.content ?? "", /runtime_convergence/);
    return {
      content: "Event evidence is ready from websearch results https://example.test/1 and https://example.test/2.",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class StepBoundaryContextModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  firstSystemPrompt = "";
  firstRuntimeContext = "";
  private calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      this.firstSystemPrompt = request.systemPrompt;
      this.firstRuntimeContext = request.runtimeContext?.content ?? "";
      return { content: "structured extraction evidence is ready", toolCalls: [], finishReason: "stop" };
    }
    return { content: "final Markdown report is ready from extraction evidence", toolCalls: [], finishReason: "stop" };
  }
}

class FullChainModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;
  private readonly skillId: string;
  constructor(skillId: string) { this.skillId = skillId; }
  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.deepEqual(request.tools.map((tool) => tool.name), ["submit_plan"]);
      assert.match(request.runtimeContext?.content ?? "", /evidence-chain/);
      assert.doesNotMatch(request.runtimeContext?.content ?? "", /Include canonical evidence/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "plan",
          name: "submit_plan",
          arguments: {
            goal: "produce answer",
            selectedSkillIds: [this.skillId],
            steps: [{
              id: "answer",
              objective: "produce the evidence-backed answer",
              dependencies: [],
              skillIds: [this.skillId],
              requiredToolNames: [],
              successCriteria: [{ id: "answer-ready", description: "An answer is produced" }],
            }],
          },
        }],
      };
    }
    if (this.calls === 2) {
      assert.doesNotMatch(request.runtimeContext?.content ?? "", /Include canonical evidence/);
      assert.equal(request.tools.some((tool) => tool.name === "load_skill"), true);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "execution-load", name: "load_skill", arguments: { name: "evidence-chain" } }],
      };
    }
    if (this.calls === 3) {
      const loaded = request.messages.find((message) => message.role === "tool" && message.name === "load_skill");
      assert.match(loaded?.content ?? "", /Include canonical evidence/);
      return { content: "answer with canonical evidence", toolCalls: [], finishReason: "stop" };
    }
    assert.deepEqual(request.tools.map((tool) => tool.name), ["submit_assessment"]);
    return {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{
        id: "assessment",
        name: "submit_assessment",
        arguments: {
          criteria: [
            { criterionId: "answer-ready", satisfied: true, rationale: "Answer exists", evidenceRefs: ["candidateOutput"] },
          ],
          skills: [{
            skillId: this.skillId,
            followed: true,
            rationale: "The exact bound Skill was applied",
            evidenceRefs: ["candidateOutput"],
          }],
          feedback: "",
        },
      }],
    };
  }
}

class TerminalConvergenceModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.equal(request.tools.some((tool) => tool.name === "collect_proof"), true);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "proof-1", name: "collect_proof", arguments: {} }],
      };
    }
    assert.deepEqual(request.tools, []);
    assert.match(request.runtimeContext?.content ?? "", /runtime_convergence/);
    return {
      content: "verified artifact ready; evidence: collect_proof",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class FileArtifactConvergenceModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.equal(request.tools.some((tool) => tool.name === "computer_write_file"), true);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "write-png",
            name: "computer_write_file",
            arguments: { path: "poster.png", content: "png-bytes" },
          },
          {
            id: "write-pdf",
            name: "computer_write_file",
            arguments: { path: "poster.pdf", content: "pdf-bytes" },
          },
        ],
      };
    }
    assert.deepEqual(request.tools, []);
    assert.match(request.runtimeContext?.content ?? "", /runtime_convergence/);
    return {
      content: "poster.png and poster.pdf are ready",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class StdoutMentionThenWriteModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.equal(request.tools.some((tool) => tool.name === "computer_run_command"), true);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "print-source",
          name: "computer_run_command",
          arguments: {
            command: "node",
            args: ["-e", "console.log('OUT_PNG = \"poster.png\"\\nOUT_PDF = \"poster.pdf\"')"],
          },
        }],
      };
    }
    if (this.calls === 2) {
      assert.equal(request.tools.some((tool) => tool.name === "computer_write_file"), true);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "write-png",
            name: "computer_write_file",
            arguments: { path: "poster.png", content: "png-bytes" },
          },
          {
            id: "write-pdf",
            name: "computer_write_file",
            arguments: { path: "poster.pdf", content: "pdf-bytes" },
          },
        ],
      };
    }
    assert.deepEqual(request.tools, []);
    assert.match(request.runtimeContext?.content ?? "", /runtime_convergence/);
    return {
      content: "poster.png and poster.pdf are ready",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class CommandFileChangesConvergenceModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.equal(request.tools.some((tool) => tool.name === "computer_run_command"), true);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "create-files",
          name: "computer_run_command",
          arguments: {
            command: "node",
            args: [
              "-e",
              [
                "const fs = require('node:fs');",
                "fs.writeFileSync('poster.png', 'png-bytes');",
                "fs.writeFileSync('poster.pdf', 'pdf-bytes');",
              ].join(" "),
            ],
          },
        }],
      };
    }
    assert.deepEqual(request.tools, []);
    assert.match(request.runtimeContext?.content ?? "", /runtime_convergence/);
    return {
      content: "poster.png and poster.pdf are ready",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class VerificationOnlyArtifactModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.equal(request.tools.some((tool) => tool.name === "computer_run_command"), true);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "verify-deck",
          name: "computer_run_command",
          arguments: {
            command: "node",
            args: ["-e", "require('fs').writeFileSync('deck.pptx', 'verified')"],
          },
        }],
      };
    }
    assert.equal(request.tools.some((tool) => tool.name === "computer_run_command"), true);
    assert.doesNotMatch(request.runtimeContext?.content ?? "", /runtime_convergence/);
    return {
      content: "deck.pptx was inspected and verified by QA command",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

function step(id: string): PlanProposal["steps"][number] {
  return {
    id,
    objective: id,
    dependencies: [],
    skillIds: [],
    requiredToolNames: [],
    successCriteria: [{ id: `${id}-done`, description: `${id} is done`, source: "planner" }],
  };
}

function skillFixture(overrides: Partial<PrivateSkill> = {}): PrivateSkill {
  return {
    id: "skill-1", ownerUserId: "user-1", name: "skill", description: "skill",
    instructions: "instructions", sourceKind: "inline",
    version: 1, contentHash: "hash", updatedAt: 1, ...overrides,
  };
}

function approvingSkillAssessor(): import("../src/planning/contracts.ts").StepAssessor {
  return {
    assess: async (input) => ({
      id: `assessment-${input.step.id}-${input.attempt}`,
      planId: input.planId,
      stepId: input.step.id,
      attempt: input.attempt,
      approved: true,
      criteria: input.step.successCriteria.map((criterion) => ({
        criterionId: criterion.id,
        satisfied: true,
        rationale: "Verified by the focused test assessor",
        evidenceRefs: ["candidateOutput"],
      })),
      skills: input.skills.map((skill) => ({
        skillId: skill.id,
        followed: true,
        rationale: "The exact Skill body was loaded before completion",
        evidenceRefs: ["load_skill"],
      })),
      evidenceDigest: "test-evidence",
      feedback: "",
      createdAt: Date.now(),
    }),
  };
}

function processCaveatAssessor(): import("../src/planning/contracts.ts").StepAssessor {
  return {
    assess: async (input) => ({
      id: `assessment-${input.step.id}-${input.attempt}`,
      planId: input.planId,
      stepId: input.step.id,
      attempt: input.attempt,
      approved: true,
      criteria: input.step.successCriteria.map((criterion) => ({
        criterionId: criterion.id,
        satisfied: true,
        rationale: "The deliverable satisfies the admitted success criterion.",
        evidenceRefs: ["candidateOutput"],
      })),
      skills: input.skills.map((skill) => ({
        skillId: skill.id,
        status: "process_caveat",
        followed: false,
        rationale: "The remaining gap is process timing evidence that cannot be repaired after the deliverable exists.",
        evidenceRefs: ["candidateOutput"],
      })),
      evidenceDigest: "process-caveat-evidence",
      feedback: "Process caveat recorded without blocking delivery.",
      createdAt: Date.now(),
    }),
  };
}

function deferredValidationAssessor(skillId: string): import("../src/planning/contracts.ts").StepAssessor {
  return {
    assess: async (input) => ({
      id: `assessment-${input.step.id}-${input.attempt}`,
      planId: input.planId,
      stepId: input.step.id,
      attempt: input.attempt,
      approved: false,
      criteria: input.step.successCriteria.map((criterion) => ({
        criterionId: criterion.id,
        satisfied: false,
        rationale: "The artifact exists, but the local renderer is unavailable so required visual validation did not run.",
        evidenceRefs: ["candidateOutput", "write-deck"],
      })),
      skills: [{
        skillId,
        status: "skipped_unavailable",
        followed: false,
        rationale: "The local validation dependency was probed and remains unavailable; validation is deferred with a user-facing caveat.",
        evidenceRefs: ["candidateOutput"],
      }],
      evidenceDigest: "deferred-validation-evidence",
      feedback: "Renderer remains unavailable; leave visual validation to the user and report the exact caveat.",
      createdAt: Date.now(),
    }),
  };
}

function selectiveSkillAssessor(expectedSkillId: string): import("../src/planning/contracts.ts").StepAssessor {
  return {
    assess: async (input) => {
      assert.deepEqual(input.skills.map((skill) => skill.id), [expectedSkillId]);
      return {
        id: `assessment-${input.step.id}-${input.attempt}`,
        planId: input.planId,
        stepId: input.step.id,
        attempt: input.attempt,
        approved: true,
        criteria: input.step.successCriteria.map((criterion) => ({
          criterionId: criterion.id,
          satisfied: true,
          rationale: "The user-facing output criterion is satisfied",
          evidenceRefs: ["candidateOutput"],
        })),
        skills: input.skills.map((skill) => ({
          skillId: skill.id,
          followed: true,
          rationale: "Only the actually loaded Skill is assessed for compliance",
          evidenceRefs: ["load_skill"],
        })),
        evidenceDigest: "test-evidence",
        feedback: "",
        createdAt: Date.now(),
      };
    },
  };
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error
    && (error as { code: unknown }).code === code;
}
