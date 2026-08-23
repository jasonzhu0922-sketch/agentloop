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
import { DependencyScheduler } from "../src/planning/scheduler.ts";
import { estimateTextTokens } from "../src/runtime/context-assembler.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { RunService, selectPlanningSkills } from "../src/runtime/run-service.ts";
import { RuntimeActionRepository } from "../src/runtime/runtime-action-repository.ts";
import { TerminalCommitter } from "../src/runtime/terminal-committer.ts";
import type { RuntimeTool } from "../src/runtime/tool-registry.ts";
import { AppError } from "../src/shared/errors.ts";
import { SkillService, type PrivateSkill } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { RunOutcomeRepository } from "../src/storage/repositories/outcome-repository.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

type LegacyPlanStepFixture = Omit<PlanProposal["steps"][number], "successCriteria"> & {
  readonly successCriteria?: readonly { readonly id: string; readonly description: string; readonly source?: "task" | "planner" }[];
};

function submitOutcomePlanToolCall(
  id: string,
  input: {
    readonly goal: string;
    readonly selectedSkillIds?: readonly string[];
    readonly selectedSkillRoles?: readonly { readonly skillId: string; readonly role: "primary_builder" | "source_provider" | "support" | "qa"; readonly reason: string }[];
    readonly shape?: "single_leaf" | "fact_then_produce" | "multi_deliverable" | "pipeline" | "recovery_patch";
    readonly steps: readonly LegacyPlanStepFixture[];
  },
): ModelResponse["toolCalls"][number] {
  const selectedSkillRoles = input.selectedSkillRoles
    ?? (input.selectedSkillIds ?? []).map((skillId) => ({
      skillId,
      role: "primary_builder" as const,
      reason: "Focused test fixture selection",
    }));
  return {
    id,
    name: "submit_outcome_plan",
    arguments: {
      schema: "agentloop.outcomePlan/v2",
      goal: input.goal,
      shape: input.shape ?? (input.steps.length === 1 ? "single_leaf" : "pipeline"),
      selectedSkillRoles,
      leaves: input.steps.map((step) => ({
        id: step.id,
        objective: step.objective,
        dependsOn: step.dependencies,
        role: outcomeLeafRoleForFixture(step),
        skillIds: step.skillIds,
        requiredToolNames: step.requiredToolNames,
        evidenceContract: evidenceContractForFixture(step),
      })),
    },
  };
}

function outcomeLeafRoleForFixture(step: LegacyPlanStepFixture): "fact_acquisition" | "produce" | "deliver" | "repair" {
  if (step.role !== undefined) return step.role;
  const text = `${step.id} ${step.objective}`.toLowerCase();
  if (step.requiredToolNames.some((name) => name === "websearch" || name === "webfetch")) return "fact_acquisition";
  if (/repair|fix|修复/.test(text)) return "repair";
  if (step.requiredToolNames.some((name) => /write|run|export|create/i.test(name))) return "produce";
  return "deliver";
}

function evidenceContractForFixture(step: LegacyPlanStepFixture): {
  readonly requiredKinds: readonly string[];
  readonly caveatPolicy: "none" | "mark_unverified_facts" | "strict_fail_on_missing_source";
} {
  if (step.evidenceContract !== undefined) return step.evidenceContract;
  if (step.requiredToolNames.some((name) => name === "websearch" || name === "webfetch")) {
    return { requiredKinds: ["source_summary", "source_urls", "explicit_caveats"], caveatPolicy: "mark_unverified_facts" };
  }
  if (step.requiredToolNames.some((name) => /write|run|read_file|find_files/i.test(name))) {
    return { requiredKinds: ["artifact_path", "artifact_non_empty", "delivery_receipt"], caveatPolicy: "none" };
  }
  return { requiredKinds: ["delivery_receipt"], caveatPolicy: "none" };
}

test("ModelPlanner fails closed when the model returns prose instead of submit_outcome_plan", async () => {
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
        planningTurn: 1,
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
      name: "submit_outcome_plan",
      arguments: {
        schema: "agentloop.outcomePlan/v2",
        goal: "inspect then build",
        shape: "single_leaf",
        selectedSkillRoles: [],
        leaves: [{
          id: "build",
          objective: "build output",
          dependsOn: [],
          role: "produce",
          skillIds: [],
          requiredToolNames: ["computer_read_file", "computer_write_file", "computer_write_file"],
          evidenceContract: {
            requiredKinds: ["artifact_path", "artifact_non_empty", "delivery_receipt"],
            caveatPolicy: "none",
          },
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
        toolCalls: [submitOutcomePlanToolCall("plan", {
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
        })],
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

test("ModelPlanner keeps stable planning system prompt compact", async () => {
  let observedSystemPrompt = "";
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      observedSystemPrompt = request.systemPrompt;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("plan", {
            goal: "answer",
            selectedSkillIds: [],
            steps: [{
              id: "answer",
              objective: "Answer the user.",
              dependencies: [],
              skillIds: [],
              requiredToolNames: [],
              successCriteria: [{ id: "answered", description: "The user receives an answer." }],
            }],
        })],
      };
    },
  });

  await planner.plan({
    runId: "run-compact-planner-prompt",
    input: "answer briefly",
    availableSkills: [],
    availableToolNames: [],
  });

  assert.ok(estimateTextTokens(observedSystemPrompt) <= 700, `Planner systemPrompt is too large: ${estimateTextTokens(observedSystemPrompt)} estimated tokens`);
  assert.match(observedSystemPrompt, /dynamic_prompt_profile/);
  assert.match(observedSystemPrompt, /browser-presentable, presentation-style, or document-like artifacts/);
  assert.doesNotMatch(observedSystemPrompt, /html-ppt|DCMM/i);
  assert.doesNotMatch(observedSystemPrompt, /data-to-report|workspace inspection|inspect_\*|repeated raw stdout|Skill-mandated QA/);
});

test("ModelPlanner exposes operation profiles for source-level step shaping", async () => {
  let sawProfiles = false;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      sawProfiles = /operationProfiles/.test(request.runtimeContext?.content ?? "")
        && /data_analysis/.test(request.runtimeContext?.content ?? "")
        && /dynamic_prompt_context/.test(request.runtimeContext?.content ?? "")
        && /agentloop\.taskProfile\/v2/.test(request.runtimeContext?.content ?? "")
        && /"intent":"execute"/.test(request.runtimeContext?.content ?? "")
        && /structured extraction artifact/.test(request.runtimeContext?.content ?? "")
        && !/data-to-report/.test(request.systemPrompt)
        && !/repeated raw stdout dumps/.test(request.systemPrompt);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("plan", {
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
        })],
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
        toolCalls: [submitOutcomePlanToolCall("plan", {
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
        })],
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
        && context.includes("Continue from prior Run prior-run Plan step build.")
        && !/continue from unfinished Plan steps/i.test(request.systemPrompt);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("plan", {
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
        })],
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

test("ModelPlanner treats empty conversation workspace as context instead of Plan work", async () => {
  let calls = 0;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      const context = request.runtimeContext?.content ?? "";
      assert.match(context, /planning\.workspaceFacts\/v1/);
      assert.match(context, /Do not create a workspace inspection Plan step/);
      assert.doesNotMatch(request.systemPrompt, /Runtime\/context intake facts are planning inputs/);
      assert.doesNotMatch(request.systemPrompt, /workspace inspection step/);
      if (calls === 1) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [submitOutcomePlanToolCall("workspace-outcome-plan", {
              goal: "build a landing page",
              selectedSkillIds: [],
              steps: [
                {
                  id: "create_page",
                  objective: "Create the requested landing page as a standalone index.html in the empty conversation workspace.",
                  dependencies: [],
                  skillIds: [],
                  requiredToolNames: ["computer_write_file"],
                  successCriteria: [{ id: "page-created", description: "A standalone index.html file is written in the workspace." }],
                },
              ],
          })],
        };
      }
      throw new Error("Planner should not ask for a repair turn for empty workspace context");
    },
  });

  const plan = await planner.plan({
    runId: "run-empty-workspace-plan",
    input: "做一个活动宣传网页",
    availableSkills: [],
    availableToolNames: ["computer_list_directory", "computer_find_files", "computer_write_file"],
    workspaceFacts: {
      schema: "planning.workspaceFacts/v1",
      kind: "conversation_workspace",
      rootLabel: "conversation workspace",
      state: "empty",
      entryCount: 0,
      sampleEntries: [],
      visibleDirectoryCount: 0,
      guidance: "The workspace is empty and has no visible external directories. Do not create a workspace inspection Plan step unless the user asks to inspect an existing project.",
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(plan.steps.map((step) => step.id), ["create_page"]);
});

test("ModelPlanner accepts artifact delivery receipts in an empty conversation workspace", async () => {
  let calls = 0;
  const skill = skillFixture({ id: "web", name: "web-artifacts-builder" });
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async () => {
      calls += 1;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("artifact-delivery-plan", {
            goal: "制作 HTML-PPT 培训材料",
            selectedSkillIds: [skill.id],
            steps: [{
              id: "build_html_ppt",
              objective: "基于调研结果制作并交付 DCMM 4级评级中文培训 HTML-PPT。",
              dependencies: [],
              skillIds: [skill.id],
              requiredToolNames: ["load_skill", "computer_write_file", "computer_run_command", "computer_read_file"],
              successCriteria: [
                { id: "sc-1", description: "交付非空的 HTML-PPT 文件或可运行的 HTML 演示项目，位于对话工作区内，并提供明确路径。" },
                { id: "sc-2", description: "通过本地构建或读取检查获得非空交付回执，能够确认输出格式、工作区路径及基本可用性。" },
              ],
            }],
        })],
      };
    },
  });

  const plan = await planner.plan({
    runId: "run-empty-workspace-artifact-delivery",
    input: "帮我做一个 DCMM 4 评级的培训材料，html-ppt 格式的",
    availableSkills: [skill],
    availableToolNames: ["load_skill", "computer_write_file", "computer_run_command", "computer_read_file"],
    workspaceFacts: {
      schema: "planning.workspaceFacts/v1",
      kind: "conversation_workspace",
      rootLabel: "conversation workspace",
      state: "empty",
      entryCount: 0,
      sampleEntries: [],
      visibleDirectoryCount: 0,
      guidance: "The workspace is empty and has no visible external directories. Do not create a workspace inspection Plan step unless the user asks to inspect an existing project.",
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(plan.steps.map((step) => step.id), ["build_html_ppt"]);
});

test("ModelPlanner keeps ordinary planning light without adding explicit QA tails", async () => {
  let calls = 0;
  let sawOutcomePlanGuidance = false;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      const context = request.runtimeContext?.content ?? "";
      sawOutcomePlanGuidance = /stepGranularity/.test(context)
        && /ordinary artifact or answer task/.test(context)
        && /one outcome leaf with concrete delivery boundary/.test(context)
        && /reusable pipeline or targeted recovery is required/.test(context)
        && /smallest Outcome Plan/.test(request.systemPrompt)
        && /Use one leaf for ordinary answer or artifact tasks/.test(request.systemPrompt)
        && /two leaves only when source facts must be acquired before production/.test(request.systemPrompt)
        && !/choose the smallest dependency-linked operation units/.test(request.systemPrompt);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("small-plan", {
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
                objective: "Write analyze_scenario.py from the analysis contract and record the expected execution command as delivery evidence.",
                dependencies: ["extract-analysis-contract"],
                skillIds: [],
                requiredToolNames: ["computer_read_file", "computer_write_file"],
                successCriteria: [{ id: "script-written", description: "The reusable script is written with its execution contract recorded." }],
              },
            ],
        })],
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
  assert.equal(sawOutcomePlanGuidance, true);
  assert.deepEqual(plan.steps.map((item) => item.id), [
    "extract-analysis-contract",
    "author-script",
  ]);
});

test("ModelPlanner rejects default QA and repair tails for ordinary artifact tasks", async () => {
  let calls = 0;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      assert.match(request.systemPrompt, /repair\/verification tail leaves/);
      assert.doesNotMatch(request.systemPrompt, /inspect_\*/);
      assert.doesNotMatch(request.systemPrompt, /Skill-mandated QA belongs inside/);
      assert.deepEqual(request.tools.map((tool) => tool.name), ["submit_outcome_plan"]);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("light-poster-plan", {
              goal: "create a concert poster",
              selectedSkillIds: [],
              steps: [
                {
                  id: "create_poster",
                  objective: "Create and export the requested poster as PNG.",
                  dependencies: [],
                  skillIds: [],
                  requiredToolNames: ["computer_write_file"],
                  successCriteria: [{ id: "poster-created", description: "poster.png is written." }],
                },
              ],
        })],
      };
    },
  });

  const plan = await planner.plan({
    runId: "run-heavy-qa-tail",
    input: "生成一张演唱会海报",
    availableSkills: [],
    availableToolNames: ["computer_read_file", "computer_write_file"],
  });
  assert.equal(calls, 1);
  assert.deepEqual(plan.steps.map((step) => step.id), ["create_poster"]);
});

test("ModelPlanner accepts delivery leaves with core file receipt evidence", async () => {
  const skill = skillFixture({ id: "discovered:theme-factory", name: "theme-factory" });
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async () => ({
      content: "",
      finishReason: "tool_calls",
      toolCalls: [submitOutcomePlanToolCall("dcmm-plan", {
        goal: "制作一套面向 DCMM 4 级评级培训的中文 HTML-PPT 材料。",
        selectedSkillIds: [skill.id],
        shape: "fact_then_produce",
        steps: [
          {
            id: "step-1",
            kind: "leaf",
            objective: "检索并整理制作 DCMM 4 级评级培训材料所需的权威事实，包括等级定位、能力域与过程要求、量化管理特征、评估依据和评级准备要点。",
            dependencies: [],
            refinementState: "not_refinable",
            requiredFacts: [
              {
                id: "fact-1",
                description: "DCMM 4 级的标准定位、能力域及过程要求",
                evidenceKinds: ["权威标准或官方机构网页", "标准版本或发布日期", "来源URL"],
              },
            ],
            skillIds: [],
            requiredToolNames: ["websearch", "webfetch"],
            successCriteria: [{
              id: "sc-1",
              description: "形成可直接用于课件的中文事实摘要，引用可访问来源，并标注不可确认事实边界。",
            }],
          },
          {
            id: "step-2",
            kind: "leaf",
            objective: "基于已核实事实制作并交付一套主题统一、适合授课的 DCMM 4 级评级中文 HTML-PPT。",
            dependencies: ["step-1"],
            refinementState: "not_refinable",
            skillIds: [skill.id],
            requiredToolNames: ["load_skill", "computer_write_file", "computer_run_command"],
            successCriteria: [
              {
                id: "sc-2",
                description: "在工作区交付可直接用浏览器打开、逐页切换或导航演示的 HTML-PPT 文件，包含封面、目录、章节内容、总结与参考来源。",
              },
              {
                id: "sc-3",
                description: "文件写入回执提供最终 HTML-PPT 的工作区路径和非空状态，证明交付物已生成。",
              },
            ],
          },
        ],
      })],
    }),
  });

  const plan = await planner.plan({
    runId: "run-dcmm-html-ppt-plan",
    input: "帮我做一个 DCMM 4 评级的培训材料，html-ppt 格式的",
    availableSkills: [skill],
    availableToolNames: ["websearch", "webfetch", "load_skill", "computer_write_file", "computer_run_command"],
  });

  assert.deepEqual(plan.steps.map((step) => step.id), ["step-1", "step-2"]);
});

test("ModelPlanner accepts first-round factual artifact plans with conditional source metadata", async () => {
  let calls = 0;
  const skill = skillFixture({ id: "discovered:web-artifacts-builder", name: "web-artifacts-builder" });
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async () => {
      calls += 1;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("dcmm-conditional-source-plan", {
            goal: "制作一套面向 DCMM 4级评级培训的中文 HTML-PPT。",
            selectedSkillIds: [skill.id],
            shape: "fact_then_produce",
            steps: [
              {
                id: "dcmm-research",
                kind: "leaf",
                objective: "检索并提炼 DCMM 4级评级培训所需的核心事实、来源依据与适用边界，作为课件内容基础。",
                dependencies: [],
                refinementState: "not_refinable",
                requiredFacts: [{
                  id: "dcmm-level4-facts",
                  description: "DCMM 4级定位、核心要求、量化管理机制及评估准备相关事实。",
                  evidenceKinds: ["公开网页来源", "来源URL", "发布日期（来源提供且与判断相关时）", "相关性判断"],
                  satisfiedBy: ["dcmm-research-evidence"],
                }],
                skillIds: [],
                requiredToolNames: ["websearch", "webfetch"],
                successCriteria: [{
                  id: "dcmm-research-evidence",
                  description: "形成与 DCMM 4级培训直接相关的事实摘要，记录所采用来源的 URL、来源提供且与判断相关时的发布日期，以及来源与课件主题的相关性；公开资料无法确认的事项明确标注为待核实，不作为确定评级要求。",
                }],
              },
              {
                id: "build-dcmm-html-ppt",
                kind: "leaf",
                objective: "基于已提炼的资料制作并交付中文 DCMM 4级评级 HTML-PPT。",
                dependencies: ["dcmm-research"],
                refinementState: "not_refinable",
                requiredFacts: [],
                skillIds: [skill.id],
                requiredToolNames: ["load_skill", "computer_write_file", "computer_run_command", "computer_read_file"],
                successCriteria: [
                  {
                    id: "html-ppt-delivered",
                    description: "交付可在浏览器中打开的 HTML-PPT 文件，具有清晰的逐页幻灯片结构和可用的基本翻页/演示交互。",
                  },
                  {
                    id: "training-content-covered",
                    description: "课件覆盖培训目标、DCMM 概览与等级体系、4级定义和特征、相关能力域及关键要求、评估关注点、建设路径、常见问题与总结，内容适合中文培训讲授。",
                  },
                  {
                    id: "local-receipt-confirmed",
                    description: "关键事实与研究结论一致，末尾列出采用的来源 URL、可获得的发布日期或访问日期及必要 caveat；同一交付步骤内完成本地运行或读取确认，确保入口文件和核心内容完整。",
                  },
                ],
              },
            ],
        })],
      };
    },
  });

  const plan = await planner.plan({
    runId: "run-dcmm-first-round-conditional-sources",
    input: "帮我做一个 DCMM 4 评级的培训材料，html-ppt 格式的",
    availableSkills: [skill],
    availableToolNames: ["websearch", "webfetch", "load_skill", "computer_write_file", "computer_run_command", "computer_read_file"],
  });

  assert.equal(calls, 1);
  assert.deepEqual(plan.steps.map((step) => step.id), ["dcmm-research", "build-dcmm-html-ppt"]);
});

test("ModelPlanner drops unrequested optional enhancement success criteria without a repair turn", async () => {
  let calls = 0;
  const skill = skillFixture({ id: "discovered:theme-factory", name: "theme-factory" });
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async () => {
      calls += 1;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("overconstrained-dcmm-plan", {
            goal: "制作 DCMM 4 级 HTML-PPT 培训材料。",
            selectedSkillIds: [skill.id],
            shape: "fact_then_produce",
            steps: [
              {
                id: "step-1",
                kind: "leaf",
                objective: "检索并整理 DCMM 4 级评级培训材料所需的来源事实。",
                dependencies: [],
                refinementState: "not_refinable",
                skillIds: [],
                requiredToolNames: ["websearch", "webfetch"],
                successCriteria: [
                  {
                    id: "sc-1",
                    description: "形成覆盖定义、等级特征和评级准备要点的事实摘要。",
                  },
                  {
                    id: "sc-2",
                    description: "列出实际获取并采用的来源URL、发布机构及发布日期，并说明版本差异。",
                  },
                ],
              },
              {
                id: "step-2",
                kind: "leaf",
                objective: "基于已核实事实设计并生成中文 DCMM 4级 HTML-PPT。",
                dependencies: ["step-1"],
                refinementState: "not_refinable",
                skillIds: [skill.id],
                requiredToolNames: ["load_skill", "computer_write_file"],
                successCriteria: [
                  {
                    id: "sc-3",
                    description: "交付一个可直接在浏览器打开和演示的 HTML-PPT 文件。",
                  },
                  {
                    id: "sc-4",
                    description: "具备清晰的逐页导航、键盘翻页、页码或进度提示，并适配常见演示屏幕。",
                  },
                  {
                    id: "sc-5",
                    description: "课件形成完整培训叙事，至少涵盖案例或练习、常见误区、实施路线图。",
                  },
                  {
                    id: "sc-6",
                    description: "视觉主题专业统一，中文排版清晰，图表、流程、矩阵或时间路线等可视化内容支持培训理解，且无明显内容溢出或不可读元素。",
                  },
                ],
              },
            ],
        })],
      };
    },
  });

  const plan = await planner.plan({
    runId: "run-dcmm-optional-enhancements",
    input: "帮我做一个 DCMM 4 评级的培训材料，html-ppt 格式的",
    availableSkills: [skill],
    availableToolNames: ["websearch", "webfetch", "load_skill", "computer_write_file"],
  });

  assert.equal(calls, 1);
  assert.deepEqual(plan.steps.map((step) => step.id), ["step-1", "step-2"]);
  assert.deepEqual(plan.steps.map((step) => step.successCriteria.map((criterion) => criterion.id)), [
    ["source_summary", "source_urls", "explicit_caveats"],
    ["artifact_path", "artifact_non_empty", "delivery_receipt"],
  ]);
});

test("ModelPlanner allows source inspection and keeps local report receipt inside production", async () => {
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async () => ({
      content: "",
      finishReason: "tool_calls",
      toolCalls: [submitOutcomePlanToolCall("source-grounded-report-plan", {
          goal: "write a source-grounded report",
          selectedSkillIds: [],
          shape: "fact_then_produce",
          steps: [
            {
              id: "inspect_sources",
              objective: "Inspect the provided source files and identify reusable report facts.",
              dependencies: [],
              skillIds: [],
              requiredToolNames: ["computer_read_file"],
              successCriteria: [{ id: "sources-profiled", description: "Source facts and gaps are recorded." }],
            },
            {
              id: "write_report",
              objective: "Write the requested report from the inspected source facts and confirm the report file can be read locally.",
              dependencies: ["inspect_sources"],
              skillIds: [],
              requiredToolNames: ["computer_write_file", "computer_read_file"],
              successCriteria: [{ id: "report-written", description: "The report file is written and local readback confirms it references the inspected source facts." }],
            },
          ],
      })],
    }),
  });

  const plan = await planner.plan({
    runId: "run-source-inspection-not-tail",
    input: "基于这些资料写一份报告",
    availableSkills: [],
    availableToolNames: ["computer_read_file", "computer_write_file"],
  });

  assert.deepEqual(plan.steps.map((step) => step.id), [
    "inspect_sources",
    "write_report",
  ]);
});

test("Plan admission accepts leaf-local artifact production and readback evidence", () => {
  const proposal: PlanProposal = {
    goal: "create reusable data analysis script",
    schema: "agentloop.outcomePlan/v2",
    shape: "single_leaf",
    selectedSkillRoles: [],
    selectedSkillIds: [],
    steps: [{
      id: "reconstruct-author-and-verify",
      objective: "Read prior artifacts, reconstruct the spreadsheet analysis flow, confirm python/openpyxl, write analyze_scenario.py, and verify regenerated JSON and Markdown outputs.",
      dependencies: [],
      role: "produce",
      skillIds: [],
      requiredToolNames: [
        "computer_list_directory",
        "computer_read_file",
        "computer_search_text",
        "computer_write_file",
        "computer_run_command",
      ],
      evidenceContract: {
        requiredKinds: ["artifact_path", "artifact_non_empty", "format_matches_request", "delivery_receipt"],
        caveatPolicy: "none",
      },
      successCriteria: [
        { id: "artifact_path", description: "The generated script path is recorded." },
        { id: "artifact_non_empty", description: "The generated script is non-empty." },
        { id: "format_matches_request", description: "The generated script format matches the request." },
        { id: "delivery_receipt", description: "The delivery receipt identifies the final result." },
      ],
    }],
  };

  const plan = admitPlan({
    runId: "run-leaf-local-artifact",
    proposal,
    availableSkills: [],
    availableToolNames: new Set([
      "computer_list_directory",
      "computer_read_file",
      "computer_search_text",
      "computer_write_file",
      "computer_run_command",
    ]),
  });

  assert.deepEqual(plan.steps.map((step) => step.id), ["reconstruct-author-and-verify"]);
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

test("Plan admission accepts Chinese leaf-local production with readback evidence", () => {
  const proposal: PlanProposal = {
    goal: "读取资料并生成报告",
    schema: "agentloop.outcomePlan/v2",
    shape: "single_leaf",
    selectedSkillRoles: [],
    selectedSkillIds: [],
    steps: [{
      id: "read_create_and_compare",
      objective: "读取源文件，提取结构化内容，创建报告，并对比源数据验证输出。",
      dependencies: [],
      role: "produce",
      skillIds: [],
      requiredToolNames: ["computer_read_file", "computer_write_file", "computer_run_command"],
      evidenceContract: {
        requiredKinds: ["artifact_path", "artifact_non_empty", "format_matches_request", "delivery_receipt"],
        caveatPolicy: "none",
      },
      successCriteria: [
        { id: "artifact_path", description: "报告文件路径已记录。" },
        { id: "artifact_non_empty", description: "报告文件非空。" },
        { id: "format_matches_request", description: "报告格式符合请求。" },
        { id: "delivery_receipt", description: "交付回执标识最终结果。" },
      ],
    }],
  };

  const plan = admitPlan({
    runId: "run-chinese-leaf-local-step",
    proposal,
    availableSkills: [],
    availableToolNames: new Set(["computer_read_file", "computer_write_file", "computer_run_command"]),
  });

  assert.deepEqual(plan.steps.map((step) => step.id), ["read_create_and_compare"]);
});

test("Plan admission accepts structured data evidence as one fact-acquisition leaf", () => {
  const proposal: PlanProposal = {
    goal: "分析工作区中的 1.xlsx 并生成中文场景分析报告",
    schema: "agentloop.outcomePlan/v2",
    shape: "fact_then_produce",
    selectedSkillRoles: [],
    selectedSkillIds: [],
    steps: [{
      id: "extract_structured_evidence",
      objective: "定位并解析 1.xlsx，识别工作表、字段、有效数据范围、记录数量、关键分组与指标，形成供报告写作使用的结构化分析证据；本步骤不撰写最终报告。",
      dependencies: [],
      role: "fact_acquisition",
      skillIds: [],
      requiredToolNames: ["computer_list_directory", "computer_run_command", "computer_write_file"],
      evidenceContract: {
        requiredKinds: ["source_summary", "explicit_caveats", "delivery_receipt"],
        caveatPolicy: "mark_unverified_facts",
      },
      successCriteria: [
        { id: "source_summary", description: "结构化证据摘要可用于后续报告写作。" },
        { id: "explicit_caveats", description: "无法确认的数据边界被明确标注。" },
        { id: "delivery_receipt", description: "证据产物回执已记录。" },
      ],
    }],
  };

  const plan = admitPlan({
    runId: "run-data-evidence-leaf",
    proposal,
    availableSkills: [],
    availableToolNames: new Set(["computer_list_directory", "computer_run_command", "computer_write_file"]),
  });

  assert.deepEqual(plan.steps.map((step) => step.id), ["extract_structured_evidence"]);
});

test("ModelPlanner fails closed when a model submits legacy submit_plan", async () => {
  let calls = 0;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      assert.match(request.systemPrompt, /smallest Outcome Plan/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "legacy-plan",
          name: "submit_plan",
          arguments: {
            goal: "create reusable data analysis script",
            selectedSkillIds: [],
            steps: [{
              id: "reconstruct-author-and-verify",
              objective: "Read prior artifacts, reconstruct the spreadsheet analysis flow, confirm python/openpyxl, write analyze_scenario.py, and verify regenerated JSON and Markdown outputs.",
              dependencies: [],
              skillIds: [],
              requiredToolNames: ["computer_read_file", "computer_write_file", "computer_run_command"],
              successCriteria: [{ id: "verified", description: "The script is run and outputs are compared with prior artifacts." }],
            }],
          },
        }],
      };
    },
  });

  await assert.rejects(
    () => planner.plan({
      runId: "run-legacy-submit-plan",
      input: "总结此前分析过程，生成可复用 analyze_scenario.py 并验证",
      availableSkills: [],
      availableToolNames: ["computer_read_file", "computer_write_file", "computer_run_command"],
    }),
    (error: unknown) => hasCode(error, "PLANNING_ERROR")
      && String((error as Error).message).includes("submit_outcome_plan"),
  );
  assert.equal(calls, 1);
});

test("ModelPlanner admits repair leaves only for recovery-shaped OutcomePlans", async () => {
  let calls = 0;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      assert.match(request.systemPrompt, /repair\/verification tail leaves/);
      assert.doesNotMatch(request.systemPrompt, /inspect_\*/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("recovery-repair-plan", {
          goal: "produce and verify final deck",
          shape: "recovery_patch",
          steps: [{
            id: "repair-final-deck",
            objective: "Read the quality report, apply targeted source fixes, rebuild the final PPTX, and record delivery evidence.",
            dependencies: [],
            role: "repair",
            skillIds: [],
            requiredToolNames: ["computer_read_file", "computer_write_file", "computer_run_command"],
            evidenceContract: {
              requiredKinds: ["artifact_path", "artifact_non_empty", "delivery_receipt"],
              caveatPolicy: "none",
            },
          }],
        })],
      };
    },
  });

  const plan = await planner.plan({
    runId: "run-recovery-finalization-boundaries",
    input: "修正 PPT 质量问题，重新生成并终检",
    conversationWorkingSet: {
      schema: "conversation.workset/v1",
      runCount: 1,
      requiredCapabilities: { skillIds: [], toolNames: ["computer_read_file", "computer_write_file", "computer_run_command"] },
      reusableArtifacts: [],
      failedBoundaries: [{ stepId: "finalize_deck", category: "validation", message: "quality report failed", reusableEvidenceRefs: [] }],
      resumeSuggestion: "Continue from prior Run by repairing finalize_deck.",
    },
    availableSkills: [],
    availableToolNames: [
      "computer_read_file",
      "computer_write_file",
      "computer_run_command",
    ],
  });

  assert.equal(calls, 1);
  assert.equal(plan.shape, "recovery_patch");
  assert.deepEqual(plan.steps.map((step) => step.id), ["repair-final-deck"]);
  assert.equal(plan.steps[0].role, "repair");
});

test("ModelPlanner rejects non-recovery repair leaves without a patch turn", async () => {
  let calls = 0;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("invalid-repair-leaf", {
          goal: "analyze spreadsheet and write report",
          shape: "single_leaf",
          steps: [{
            id: "repair_data",
            objective: "Repair the spreadsheet analysis without a failed boundary.",
            dependencies: [],
            role: "repair",
            skillIds: [],
            requiredToolNames: ["computer_read_file", "computer_write_file"],
            evidenceContract: {
              requiredKinds: ["artifact_path", "delivery_receipt"],
              caveatPolicy: "none",
            },
          }],
        })],
      };
    },
  });

  await assert.rejects(
    () => planner.plan({
      runId: "run-invalid-initial-repair",
      input: "分析 xlsx 并生成报告",
      availableSkills: [],
      availableToolNames: ["computer_read_file", "computer_write_file"],
    }),
    (error: unknown) => hasCode(error, "PLANNING_ERROR")
      && String((error as Error).message).includes("repair leaves"),
  );
  assert.equal(calls, 1);
});

test("ModelPlanner accepts a broad artifact leaf instead of requesting patch repair", async () => {
  let calls = 0;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async () => {
      calls += 1;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("broad-artifact-leaf", {
          goal: "analyze spreadsheet and write report",
          shape: "single_leaf",
          steps: [{
            id: "extract_data",
            objective: "Read the workbook, profile sheets, write an extraction script, run it, verify the JSON evidence, and prepare report-ready summary statistics.",
            dependencies: [],
            role: "produce",
            skillIds: [],
            requiredToolNames: ["computer_list_directory", "computer_read_file", "computer_write_file", "computer_run_command"],
            evidenceContract: {
              requiredKinds: ["artifact_path", "artifact_non_empty", "delivery_receipt"],
              caveatPolicy: "none",
            },
          }],
        })],
      };
    },
  });

  const plan = await planner.plan({
    runId: "run-broad-artifact-leaf",
    input: "分析 xlsx 并生成报告",
    availableSkills: [],
    availableToolNames: [
      "computer_list_directory",
      "computer_read_file",
      "computer_write_file",
      "computer_run_command",
    ],
  });

  assert.equal(calls, 1);
  assert.deepEqual(plan.steps.map((item) => item.id), ["extract_data"]);
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
  const canvas = skillFixture({ id: "canvas", name: "canvas-design", description: "Create beautiful poster and visual art in .png and .pdf documents using design philosophy.", agentLoop: agentLoopMetadata(["primary_builder"], ["image"]) });
  const algorithmic = skillFixture({ id: "algo", name: "algorithmic-art", description: "Creating algorithmic art using p5.js with seeded randomness and interactive parameter exploration.", agentLoop: agentLoopMetadata(["primary_builder"], ["image"]) });
  const unrelated = skillFixture({ id: "note", name: "note-writer", description: "Write short notes and messages.", agentLoop: agentLoopMetadata(["primary_builder"], ["none"]) });
  const frontend = skillFixture({ id: "frontend", name: "frontend-design", description: "Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one.", agentLoop: agentLoopMetadata(["primary_builder"], ["html", "code"]) });

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
    agentLoop: agentLoopMetadata(["source_provider"], ["none"], ["api"]),
  });
  const exploreData = skillFixture({
    id: "explore-data",
    name: "explore-data",
    description: "Profile and explore a dataset to understand its shape, quality, and patterns.",
    agentLoop: agentLoopMetadata(["source_provider"], ["none"], ["data"]),
  });
  const dashboard = skillFixture({
    id: "build-dashboard",
    name: "build-dashboard",
    description: "Build an interactive HTML dashboard with charts, filters, and tables.",
    agentLoop: agentLoopMetadata(["primary_builder"], ["html"]),
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
  const frontend = skillFixture({ id: "frontend", name: "frontend-design", description: "Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one.", agentLoop: agentLoopMetadata(["primary_builder"], ["html", "code"]) });
  const pptx = skillFixture({ id: "pptx", name: "pptx", description: "Create presentation slides.", agentLoop: agentLoopMetadata(["primary_builder"], ["presentation"]) });
  const algorithmic = skillFixture({ id: "algo", name: "algorithmic-art", description: "Create existing Skill validation art examples.", agentLoop: agentLoopMetadata(["primary_builder"], ["image"]) });

  const selected = selectPlanningSkills(
    [pptx, algorithmic, frontend],
    "Validate this existing Skill without creating a new Skill.",
    [frontend.id],
  );

  assert.deepEqual(selected.map((skill) => skill.name), ["frontend-design"]);
});

test("selectPlanningSkills prefers artifact builders over styling support for HTML-PPT requests", () => {
  const webArtifacts = skillFixture({
    id: "web",
    name: "web-artifacts-builder",
    description: "Suite of tools for creating elaborate, multi-component HTML artifacts using modern frontend web technologies. Bundle to a single HTML file.",
    agentLoop: agentLoopMetadata(["primary_builder"], ["html"]),
  });
  const presentation = skillFixture({
    id: "presentation",
    name: "presentation-skill",
    description: "Build, edit, redesign, render, and verify polished editable PowerPoint `.pptx` decks. Aliases: presentation generator, slide-deck generator, deck builder.",
    agentLoop: agentLoopMetadata(["primary_builder"], ["presentation"]),
  });
  const theme = skillFixture({
    id: "theme",
    name: "theme-factory",
    description: "Toolkit for styling artifacts with a theme. These artifacts can be slides, docs, reportings, HTML landing pages, etc. There are 10 pre-set themes with colors/fonts that you can apply to any artifact that has been creating, or can generate a new theme on-the-fly.",
    agentLoop: agentLoopMetadata(["support"], ["html", "presentation"]),
  });

  const selected = selectPlanningSkills(
    [theme, presentation, webArtifacts],
    "帮我做一个 DCMM 4 评级的培训材料，html-ppt 格式的",
    [],
  );

  assert.equal(selected[0]?.name, "web-artifacts-builder");
  assert.equal(selected.some((skill) => skill.name === "theme-factory"), false);
});

test("selectPlanningSkills excludes undeclared and support-only Skills from ordinary first-round planning", () => {
  const undeclared = skillFixture({
    id: "legacy",
    name: "legacy-helper",
    description: "Create HTML artifacts, but without structured AgentLoop role metadata.",
    agentLoop: undefined,
  });
  const webArtifacts = skillFixture({
    id: "web",
    name: "web-artifacts-builder",
    description: "Create single HTML artifacts.",
    agentLoop: agentLoopMetadata(["primary_builder"], ["html"]),
  });
  const theme = skillFixture({
    id: "theme",
    name: "theme-factory",
    description: "Apply styling and visual themes to existing artifacts.",
    agentLoop: agentLoopMetadata(["support"], ["html"]),
  });

  const selected = selectPlanningSkills(
    [undeclared, theme, webArtifacts],
    "做一个 DCMM 4 评级培训材料，html-ppt 格式",
    [],
  );

  assert.deepEqual(selected.map((skill) => skill.name), ["web-artifacts-builder"]);
});

test("ModelPlanner fails closed on invalid OutcomePlan structure without a repair turn", async () => {
  let calls = 0;
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "invalid-plan",
          name: "submit_outcome_plan",
          arguments: {
            schema: "agentloop.outcomePlan/v2",
            goal: "build",
            shape: "single_leaf",
            selectedSkillRoles: [],
            leaves: [{
              id: "build",
              objective: { invalid: true },
              dependsOn: [],
              role: "deliver",
              skillIds: [],
              requiredToolNames: [],
              evidenceContract: {
                requiredKinds: ["delivery_receipt"],
                caveatPolicy: "none",
              },
            }],
          },
        }],
      };
    },
  };
  await assert.rejects(
    () => new ModelPlanner(model).plan({
      runId: "run-1",
      input: "build",
      availableSkills: [],
      availableToolNames: [],
    }),
    (error: unknown) => hasCode(error, "PLANNING_ERROR")
      && String((error as Error).message).includes("objective must be a string"),
  );
  assert.equal(calls, 1);
});

test("ModelPlanner selects Skills from the catalog and submits a Plan without loading Skill bodies", async () => {
  const skill = skillFixture({ instructions: "EXACT-PLANNING-INSTRUCTIONS" });
  let calls = 0;
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      assert.deepEqual(request.tools.map((tool) => tool.name), ["submit_outcome_plan"]);
      assert.match(request.runtimeContext?.content ?? "", /<available_skills>/);
      assert.match(request.runtimeContext?.content ?? "", /computer_write_file/);
      assert.match(request.runtimeContext?.content ?? "", /Create or overwrite a UTF-8 file/);
      assert.match(request.systemPrompt, /Skill catalog entries/);
      assert.doesNotMatch(request.systemPrompt, /EXACT-PLANNING-INSTRUCTIONS/);
      assert.doesNotMatch(request.messages.map((message) => message.content).join("\n"), /EXACT-PLANNING-INSTRUCTIONS/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall(`plan-${calls}`, {
            goal: "materialize and verify",
            selectedSkillIds: [skill.id],
            shape: "single_leaf",
            steps: [{
              id: "materialize-and-verify",
              objective: "materialize and verify",
              dependencies: [],
              role: "produce",
              skillIds: [skill.id],
              requiredToolNames: ["computer_write_file"],
              successCriteria: [{ id: "verified", description: "artifact exists and is valid" }],
            }],
        })],
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
      assert.match(request.systemPrompt, /smallest Outcome Plan/);
      assert.match(request.systemPrompt, /polish-only/);
      assert.doesNotMatch(request.systemPrompt, /optional polish, critique, or follow-up work/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("plan", {
            goal: "Create a steel company homepage",
            shape: "single_leaf",
            steps: [{
              id: "build-and-verify-homepage",
              objective: "Create and verify the requested homepage",
              dependencies: [],
              role: "produce",
              skillIds: [],
              requiredToolNames: [],
              successCriteria: [{ id: "homepage-ready", description: "The requested homepage is present and verified" }],
            }],
        })],
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

test("ModelPlanner rejects pure Skill activation leaves without a patch turn", async () => {
  const skill = skillFixture({ id: "canvas-design", name: "canvas-design" });
  let calls = 0;
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      assert.match(request.systemPrompt, /Skill-loading-only/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("bad-plan", {
          goal: "Design a poster",
          selectedSkillIds: [skill.id],
          shape: "single_leaf",
          steps: [{
            id: "load-skill",
            objective: "Load the canvas-design Skill",
            dependencies: [],
            role: "deliver",
            skillIds: [skill.id],
            requiredToolNames: [],
            successCriteria: [{ id: "skill-loaded", description: "The Skill is loaded" }],
          }],
        })],
      };
    },
  };

  await assert.rejects(
    () => new ModelPlanner(model).plan({
      runId: "run-1",
      input: "Design a poster",
      availableSkills: [skill],
      availableToolNames: ["load_skill"],
    }),
    (error: unknown) => hasCode(error, "PLANNING_ERROR")
      && String((error as Error).message).includes("only a Skill activation step"),
  );

  assert.equal(calls, 1);
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

test("Admission accepts lightweight milestones but only schedules executable leaves", () => {
  const plan = admitPlan({
    runId: "run-milestone",
    proposal: {
      goal: "research then build",
      selectedSkillIds: [],
      steps: [
        {
          ...step("research-phase"),
          kind: "milestone",
          objective: "Collect enough durable evidence to decide the concrete implementation plan.",
          requiredFacts: [],
          requiredToolNames: [],
          successCriteria: [{ id: "phase-defined", description: "The research phase boundary is explicit.", source: "planner" }],
        },
        {
          ...step("collect-evidence"),
          dependencies: ["research-phase"],
          objective: "Collect durable evidence for the next implementation step.",
          requiredToolNames: ["computer_read_file"],
        },
      ],
    },
    availableSkills: [],
    availableToolNames: new Set(["computer_read_file"]),
  });

  assert.equal(plan.steps[0].kind, "milestone");
  assert.equal(plan.steps[0].refinementState, "ready_to_refine");
  assert.equal(plan.steps[1].kind, "leaf");
  assert.equal(new DependencyScheduler().nextReady(plan)?.id, "collect-evidence");
});

test("Scheduler inherits milestone dependencies for child leaves without executing milestones", () => {
  const plan = admitPlan({
    runId: "run-milestone-parent-dependencies",
    proposal: {
      goal: "research before implementation",
      selectedSkillIds: [],
      steps: [
        {
          ...step("collect-evidence"),
          objective: "Collect evidence required before implementation.",
          requiredToolNames: ["computer_read_file"],
        },
        {
          ...step("implementation-phase"),
          kind: "milestone",
          dependencies: ["collect-evidence"],
          objective: "Implementation phase starts only after evidence collection.",
          requiredToolNames: [],
        },
        {
          ...step("implement"),
          parentId: "implementation-phase",
          objective: "Implement from collected evidence.",
          requiredToolNames: ["computer_read_file"],
        },
      ],
    },
    availableSkills: [],
    availableToolNames: new Set(["computer_read_file"]),
  });

  const scheduler = new DependencyScheduler();
  assert.equal(scheduler.nextReady(plan)?.id, "collect-evidence");

  const withEvidenceComplete = {
    ...plan,
    steps: plan.steps.map((candidate) =>
      candidate.id === "collect-evidence" ? { ...candidate, status: "completed" as const } : candidate
    ),
  };
  assert.equal(scheduler.nextReady(withEvidenceComplete)?.id, "implement");
});

test("Admission keeps milestones non-executable and requires at least one leaf", () => {
  assert.throws(
    () => admitPlan({
      runId: "run-milestone-tool",
      proposal: {
        goal: "invalid milestone",
        selectedSkillIds: [],
        steps: [{
          ...step("phase"),
          kind: "milestone",
          requiredToolNames: ["computer_read_file"],
        }],
      },
      availableSkills: [],
      availableToolNames: new Set(["computer_read_file"]),
    }),
    (error: unknown) => hasCode(error, "PLAN_NOT_ADMITTED")
      && String((error as Error).message).includes("cannot require execution Tools"),
  );

  assert.throws(
    () => admitPlan({
      runId: "run-only-milestone",
      proposal: {
        goal: "invalid skeleton",
        selectedSkillIds: [],
        steps: [{ ...step("phase"), kind: "milestone", requiredToolNames: [] }],
      },
      availableSkills: [],
      availableToolNames: new Set(),
    }),
    (error: unknown) => hasCode(error, "PLAN_NOT_ADMITTED")
      && String((error as Error).message).includes("at least one executable leaf"),
  );

  assert.throws(
    () => admitPlan({
      runId: "run-leaf-parent",
      proposal: {
        goal: "invalid parent",
        selectedSkillIds: [],
        steps: [{ ...step("parent") }, { ...step("child"), parentId: "parent" }],
      },
      availableSkills: [],
      availableToolNames: new Set(),
    }),
    (error: unknown) => hasCode(error, "PLAN_NOT_ADMITTED")
      && String((error as Error).message).includes("must be a milestone"),
  );
});

test("TerminalCommitter ignores milestone nodes and requires assessments only for leaves", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const owner = await auth.register("milestone-terminal@example.com", "milestone terminal secure password");
    const runId = "run-milestone-terminal";
    database.prepare(`
      INSERT INTO runs(
        id, owner_user_id, parent_run_id, depth, allow_dangerous_tools,
        status, input, created_at
      ) VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "research then build", Date.now());
    const plans = new PlanRepository(database);
    let plan = plans.create(admitPlan({
      runId,
      proposal: {
        goal: "research then build",
        selectedSkillIds: [],
        steps: [
          { ...step("phase"), kind: "milestone", requiredToolNames: [] },
          { ...step("build"), dependencies: ["phase"] },
        ],
      },
      availableSkills: [],
      availableToolNames: new Set(),
    }));
    plan = plans.startStep(plan.id, "build");
    plan = plans.completeStep(plan.id, "build", "leaf output", {
      candidateOutput: "leaf output",
      toolCalls: [],
      modelSteps: 1,
    });
    plans.saveAssessment({
      id: "assessment-build-1",
      planId: plan.id,
      stepId: "build",
      attempt: 1,
      approved: true,
      criteria: [{ criterionId: "build-done", satisfied: true, rationale: "Leaf is complete.", evidenceRefs: ["candidateOutput"] }],
      skills: [],
      evidenceDigest: "leaf-evidence",
      feedback: "",
      createdAt: Date.now(),
    });

    new TerminalCommitter(plans, new RunOutcomeRepository(database)).commitCompleted(runId, plan.id, "leaf output");
    const outcome = database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
      .get(runId) as { status: string; reason_code: string };
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reason_code, "plan_assessed_and_completed");
  } finally {
    database.close();
  }
});

test("PlanRepository preserves OutcomePlan evidence contracts and assessment failed boundaries", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const owner = await auth.register("evidence-contract@example.com", "evidence contract secure password");
    const runId = "evidence-contract-run";
    database.prepare(`
      INSERT INTO runs(
        id, owner_user_id, parent_run_id, depth, allow_dangerous_tools,
        status, input, created_at
      ) VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "build an html artifact", Date.now());

    const plans = new PlanRepository(database);
    const evidenceContract = {
      requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_openable"] as const,
      caveatPolicy: "none" as const,
    };
    const plan = plans.create(admitPlan({
      runId,
      proposal: {
        schema: "agentloop.outcomePlan/v2",
        shape: "single_leaf",
        goal: "build an html artifact",
        selectedSkillIds: [],
        selectedSkillRoles: [],
        steps: [{
          ...step("produce-html"),
          role: "produce",
          requiredToolNames: ["computer_write_file"],
          evidenceContract,
          successCriteria: evidenceContract.requiredKinds.map((kind) => ({
            id: kind,
            description: `${kind} evidence is present`,
            source: "planner" as const,
          })),
        }],
      },
      availableSkills: [],
      availableToolNames: new Set(["computer_write_file"]),
    }));

    assert.deepEqual(plans.get(plan.id).steps[0].evidenceContract, evidenceContract);

    const failedBoundary = {
      stepId: "produce-html",
      missingEvidenceKinds: ["artifact_openable"],
      violatedSkillRequirements: [],
      reusableEvidenceRefs: ["write-file"],
      suggestedRepairShape: "repair_leaf" as const,
    };
    plans.saveAssessment({
      id: "assessment-produce-html-1",
      planId: plan.id,
      stepId: "produce-html",
      attempt: 1,
      assessmentProfile: "source_grounded",
      assessmentMethod: "model",
      approved: false,
      criteria: [
        { criterionId: "artifact_path", satisfied: true, rationale: "Path exists", evidenceRefs: ["write-file"] },
        { criterionId: "artifact_non_empty", satisfied: true, rationale: "Content exists", evidenceRefs: ["write-file"] },
        { criterionId: "artifact_openable", satisfied: false, rationale: "No openability evidence", evidenceRefs: [] },
      ],
      skills: [],
      evidenceDigest: "digest",
      feedback: "Openability evidence is missing.",
      failedBoundary,
      createdAt: Date.now(),
    });

    assert.deepEqual(plans.assessments(plan.id)[0].failedBoundary, failedBoundary);
  } finally {
    database.close();
  }
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

test("ModelStepAssessor carries evidence contracts into assessment and accepts rejected failed boundaries", async () => {
  let observedContext = "";
  const assessor = new ModelStepAssessor({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      observedContext = request.runtimeContext?.content ?? "";
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "assessment",
          name: "submit_assessment",
          arguments: {
            criteria: [
              { criterionId: "artifact_path", satisfied: true, rationale: "Path was recorded", evidenceRefs: ["write-file"] },
              { criterionId: "artifact_openable", satisfied: false, rationale: "No browser/readback evidence was recorded", evidenceRefs: [] },
            ],
            skills: [],
            feedback: "Record artifact openability evidence before delivery.",
            failedBoundary: {
              stepId: "produce-html",
              missingEvidenceKinds: ["artifact_openable"],
              violatedSkillRequirements: [],
              reusableEvidenceRefs: ["write-file"],
              suggestedRepairShape: "repair_leaf",
            },
          },
        }],
      };
    },
  });
  const assessment = await assessor.assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("produce-html"),
      position: 0,
      status: "running",
      evidenceContract: {
        requiredKinds: ["artifact_path", "artifact_openable"],
        caveatPolicy: "none",
      },
      successCriteria: [
        { id: "artifact_path", description: "Artifact path evidence is present", source: "planner" },
        { id: "artifact_openable", description: "Artifact openability evidence is present", source: "planner" },
      ],
    },
    skills: [],
    evidence: {
      candidateOutput: "Generated /tmp/out.html",
      toolCalls: [{ toolCallId: "write-file", toolName: "computer_write_file", isError: false, result: "created out.html" }],
      modelSteps: 1,
    },
    attempt: 1,
  });

  assert.match(observedContext, /"evidenceContract"/);
  assert.equal(assessment.approved, false);
  assert.deepEqual(assessment.failedBoundary, {
    stepId: "produce-html",
    missingEvidenceKinds: ["artifact_openable"],
    violatedSkillRequirements: [],
    reusableEvidenceRefs: ["write-file"],
    suggestedRepairShape: "repair_leaf",
  });
});

test("RuleBasedStepAssessor derives failed boundaries from rejected evidence contracts", async () => {
  const assessment = await new RuleBasedStepAssessor().assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("produce-html"),
      position: 0,
      status: "running",
      evidenceContract: {
        requiredKinds: ["artifact_path", "artifact_non_empty"],
        caveatPolicy: "none",
      },
      successCriteria: [
        { id: "artifact_path", description: "Artifact path evidence is present", source: "planner" },
        { id: "artifact_non_empty", description: "Artifact non-empty evidence is present", source: "planner" },
      ],
    },
    skills: [],
    evidence: { candidateOutput: "", toolCalls: [], modelSteps: 1 },
    attempt: 1,
  });

  assert.equal(assessment.approved, false);
  assert.deepEqual(assessment.failedBoundary, {
    stepId: "produce-html",
    missingEvidenceKinds: ["artifact_path", "artifact_non_empty"],
    violatedSkillRequirements: [],
    reusableEvidenceRefs: [],
    suggestedRepairShape: "repair_leaf",
  });
});

test("RunService emits assessment failed boundaries for rejected candidates", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("failed-boundary-event@example.com", "failed boundary event secure password");
    const failedBoundary = {
      stepId: "test-step",
      missingEvidenceKinds: ["delivery_receipt"],
      violatedSkillRequirements: [],
      reusableEvidenceRefs: ["candidateOutput"],
      suggestedRepairShape: "repair_leaf" as const,
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => new StaticModel({ content: "partial result", toolCalls: [], finishReason: "stop" }),
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => ({
        assess: async (input) => ({
          id: `reject-${input.attempt}`,
          planId: input.planId,
          stepId: input.step.id,
          attempt: input.attempt,
          assessmentProfile: input.assessmentProfile,
          assessmentMethod: "model",
          approved: false,
          criteria: input.step.successCriteria.map((criterion) => ({
            criterionId: criterion.id,
            satisfied: false,
            rationale: "Delivery receipt evidence is missing.",
            evidenceRefs: ["candidateOutput"],
          })),
          skills: [],
          evidenceDigest: "digest",
          feedback: "Delivery receipt evidence is missing.",
          failedBoundary,
          createdAt: Date.now(),
        }),
      }),
      maxSteps: 2,
    });

    const run = await runs.execute(owner.user.id, "produce a delivery receipt");
    const recovery = await waitForRecoveryState(runs, owner.user.id, run.id, "waiting_recovery");
    assert.equal(runs.get(owner.user.id, run.id).status, "running");
    assert.equal(recovery.action?.stepId, "test-step");
    assert.deepEqual(recovery.action?.metadata.failedBoundary, failedBoundary);
    const events = runs.events(owner.user.id, run.id);
    const assessed = events.find((event) => event.type === "skill.compliance.assessed");
    assert.deepEqual((assessed?.data as { failedBoundary?: unknown } | undefined)?.failedBoundary, failedBoundary);
    const boundary = events.find((event) => event.type === "assessment.failed_boundary");
    assert.deepEqual((boundary?.data as { failedBoundary?: unknown } | undefined)?.failedBoundary, failedBoundary);
    assert.equal(events.some((event) => event.type === "run.recovery_required"), true);
  } finally {
    database.close();
  }
});

test("failedBoundary recovery creates and executes only a targeted repair leaf", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("failed-boundary-repair@example.com", "failed boundary repair secure password");
    const failedBoundary = {
      stepId: "test-step",
      missingEvidenceKinds: ["delivery_receipt"],
      violatedSkillRequirements: [],
      reusableEvidenceRefs: ["candidateOutput"],
      suggestedRepairShape: "repair_leaf" as const,
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => new StaticModel({ content: "delivery receipt is now present", toolCalls: [], finishReason: "stop" }),
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => ({
        assess: async (input) => {
          const approved = input.step.role === "repair";
          return {
            id: `assessment-${input.step.id}-${input.attempt}`,
            planId: input.planId,
            stepId: input.step.id,
            attempt: input.attempt,
            assessmentProfile: input.assessmentProfile,
            assessmentMethod: "model",
            approved,
            criteria: input.step.successCriteria.map((criterion) => ({
              criterionId: criterion.id,
              satisfied: approved,
              rationale: approved
                ? "The repair leaf produced the missing delivery receipt evidence."
                : "The original leaf is missing delivery receipt evidence.",
              evidenceRefs: ["candidateOutput"],
            })),
            skills: [],
            evidenceDigest: `digest-${input.step.id}`,
            feedback: approved ? "" : "Delivery receipt evidence is missing.",
            ...(approved ? {} : { failedBoundary }),
            createdAt: Date.now(),
          };
        },
      }),
      planRevisionAssessorFactory: () => ({
        assess: async () => ({
          approved: true,
          feedback: "",
          evidenceRefs: ["assessment.failed_boundary"],
        }),
      }),
      maxSteps: 2,
    });

    const run = await runs.execute(owner.user.id, "produce a delivery receipt");
    await waitForRecoveryState(runs, owner.user.id, run.id, "waiting_recovery");

    const recovery = await runs.advanceRecovery(owner.user.id, run.id);

    assert.equal(recovery.state, undefined);
    assert.equal(runs.get(owner.user.id, run.id).status, "completed");
    const detail = runs.plan(owner.user.id, run.id);
    const original = detail.plan.steps.find((step) => step.id === "test-step");
    const repair = detail.plan.steps.find((step) => step.id === "test-step.repair.2");
    assert.notEqual(original?.retiredAt, undefined);
    assert.equal(repair?.role, "repair");
    assert.equal(repair?.status, "completed");
    assert.deepEqual(repair?.evidenceContract, { requiredKinds: ["delivery_receipt"], caveatPolicy: "none" });
    assert.equal(detail.assessments.some((assessment) => assessment.stepId === "test-step" && !assessment.approved), true);
    assert.equal(detail.assessments.some((assessment) => assessment.stepId === "test-step.repair.2" && assessment.approved), true);
    const events = runs.events(owner.user.id, run.id);
    assert.equal(events.filter((event) => event.type === "recovery.repair_leaf_created").length, 1);
    assert.equal(recovery.decisions[0]?.planRevision?.shape, "recovery_patch");
    const outcome = database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
      .get(run.id) as { status: string; reason_code: string };
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reason_code, "plan_assessed_and_completed");
  } finally {
    database.close();
  }
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

test("ModelStepAssessor keeps stable assessment system prompt compact", async () => {
  let observedSystemPrompt = "";
  let observedContext = "";
  const assessor = new ModelStepAssessor({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      observedSystemPrompt = request.systemPrompt;
      observedContext = request.runtimeContext?.content ?? "";
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

  await assessor.assess({
    runId: "run-compact-assessor-prompt",
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

  assert.ok(
    estimateTextTokens(observedSystemPrompt) <= 260,
    `Assessment systemPrompt is too large: ${estimateTextTokens(observedSystemPrompt)} estimated tokens`,
  );
  assert.match(observedSystemPrompt, /dynamic_prompt_profile/);
  assert.doesNotMatch(observedSystemPrompt, /Skill-mandated validation|planning-before-coding|computer_run_command/);
  assert.match(observedContext, /dynamic_prompt_context/);
  assert.match(observedContext, /agentloop\.taskProfile\/v2/);
  assert.match(observedContext, /"evidenceProfile":"source_grounded"/);
  assert.doesNotMatch(observedContext, /assessmentPolicy|Skill-mandated validation|planning-before-coding/);
});

test("ModelStepAssessor exposes Skill caveat policy only for Skill-bound assessments", async () => {
  const skill = skillFixture({
    id: "visual-skill",
    name: "visual-skill",
    instructions: "Render visual output when local rendering is available.",
  });
  let observedSystemPrompt = "";
  let observedContext = "";
  const assessor = new ModelStepAssessor({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      observedSystemPrompt = request.systemPrompt;
      observedContext = request.runtimeContext?.content ?? "";
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
            skills: [{
              skillId: skill.id,
              status: "skipped_unavailable",
              followed: false,
              rationale: "Renderer was probed and unavailable.",
              evidenceRefs: ["renderer-probe"],
            }],
            feedback: "Renderer unavailable; visual validation was not claimed complete.",
          },
        }],
      };
    },
  });

  await assessor.assess({
    runId: "run-skill-assessment-policy",
    planId: "plan",
    step: {
      ...step("assess"),
      position: 0,
      status: "running",
      successCriteria: [{ id: "done", description: "Work is complete", source: "planner" }],
    },
    skills: [skill],
    evidence: {
      candidateOutput: "complete; renderer unavailable",
      toolCalls: [{ toolCallId: "renderer-probe", toolName: "computer_run_command", isError: false, result: "renderer missing" }],
      modelSteps: 1,
    },
    attempt: 1,
  });

  assert.doesNotMatch(observedSystemPrompt, /Skill-mandated validation|planning-before-coding|review-before-build/);
  assert.match(observedContext, /assessmentPolicy/);
  assert.match(observedContext, /Skill-mandated validation/);
  assert.match(observedContext, /planning-before-coding/);
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
      instructions: instructionsWithAgentLoopMetadata("MANDATORY-PRIVATE-INSTRUCTION"),
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
      instructions: instructionsWithAgentLoopMetadata(
        "Build the deck from source-grounded outline files.",
        ["primary_builder"],
        ["presentation"],
      ),
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
          && /dynamic_prompt_profile/.test(request.systemPrompt)
          && /dynamic_prompt_context/.test(context)
          && /agentloop\.taskProfile\/v2/.test(context)
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
      instructions: instructionsWithAgentLoopMetadata("Apply the rule."),
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
      instructions: instructionsWithAgentLoopMetadata("Plan before building."),
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

test("external source gaps can complete with an evidence-boundary caveat", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("evidence-boundary@example.com", "evidence boundary secure password");
    const websearch: RuntimeTool<unknown> = {
      name: "websearch",
      description: "Search public sources",
      inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string" } } },
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => value,
      execute: async () => [{ title: "Official metadata", url: "https://example.test/metadata", snippet: "Metadata is public" }],
    };
    const webfetch: RuntimeTool<unknown> = {
      name: "webfetch",
      description: "Fetch public source text",
      inputSchema: { type: "object", additionalProperties: false, properties: { url: { type: "string" } } },
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => value as { url: string },
      execute: async (_context, value) => {
        const url = (value as { url: string }).url;
        if (url.includes("blocked")) {
          throw new AppError("BAD_REQUEST", "HTTP 403 while fetching https://example.test/blocked", 422);
        }
        return { url, title: "Official metadata", content: "Verified metadata is available." };
      },
    };
    const planner: Planner = {
      plan: async () => ({
        goal: "research source facts with a clear boundary",
        selectedSkillIds: [],
        steps: [{
          id: "research-sources",
          objective: "Research external source facts for a training artifact and preserve any evidence boundary.",
          dependencies: [],
          skillIds: [],
          requiredToolNames: ["websearch", "webfetch"],
          successCriteria: [{
            id: "source-facts",
            description: "A source-grounded fact baseline is returned with URLs and any unavailable authoritative facts clearly identified.",
          }],
        }],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => new EvidenceBoundaryResearchModel(),
      plannerFactory: () => planner,
      assessorFactory: () => evidenceBoundaryAssessor(),
      tools: [websearch, webfetch],
      maxSteps: 6,
    });

    const run = await runs.execute(owner.user.id, "Prepare a training brief from public sources");

    assert.equal(run.status, "completed");
    assert.match(run.output ?? "", /Evidence boundary note/);
    assert.match(run.output ?? "", /403/);
    const detail = runs.plan(owner.user.id, run.id);
    assert.equal(detail.plan.status, "completed");
    assert.equal(detail.assessments.length, 1);
    assert.equal(detail.assessments.at(-1)?.approved, false);
    assert.equal(detail.plan.steps[0].evidence?.completionCaveat?.reason, "evidence_boundary");
    assert.equal(runs.events(owner.user.id, run.id).filter((event) => event.type === "candidate.evidence_boundary_accepted").length, 1);
    const outcome = database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
      .get(run.id) as { status: string; reason_code: string };
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reason_code, "completed_with_evidence_boundary");
  } finally {
    database.close();
  }
});

test("missing source facts do not block the core artifact deliverable", async () => {
  const database = new AppDatabase(":memory:");
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-source-boundary-delivery-"));
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("source-boundary-delivery@example.com", "source boundary secure password");
    const websearch: RuntimeTool<unknown> = {
      name: "websearch",
      description: "Search public source metadata",
      inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string" } } },
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => value,
      execute: async () => [{ title: "Standard metadata", url: "https://example.test/standard", snippet: "Metadata only" }],
    };
    const webfetch: RuntimeTool<unknown> = {
      name: "webfetch",
      description: "Fetch public source metadata",
      inputSchema: { type: "object", additionalProperties: false, properties: { url: { type: "string" } } },
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => value,
      execute: async (_context, value) => ({
        url: (value as { url: string }).url,
        title: "Standard metadata",
        content: "The page exposes public standard metadata but does not expose the full text.",
      }),
    };
    const planner: Planner = {
      plan: async () => ({
        goal: "create a source-bounded training report",
        selectedSkillIds: [],
        steps: [
          {
            id: "research-sources",
            objective: "Collect source facts for a training report while preserving missing source boundaries.",
            dependencies: [],
            skillIds: [],
            requiredToolNames: ["websearch", "webfetch"],
            successCriteria: [{
              id: "source-outline",
              description: "A bounded source outline is returned, with missing full-text facts clearly identified.",
            }],
          },
          {
            id: "write-report",
            objective: "Generate the requested HTML training report from the bounded source outline.",
            dependencies: ["research-sources"],
            skillIds: [],
            requiredToolNames: ["computer_write_file"],
            successCriteria: [{
              id: "report-written",
              description: "An HTML report file is written and states the evidence boundary.",
            }],
          },
        ],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => new MissingSourceFactsReportModel(),
      plannerFactory: () => planner,
      assessorFactory: () => missingSourceFactsAssessor(),
      tools: [websearch, webfetch],
      workspaceRoot: workspace,
      maxSteps: 8,
    });

    const run = await runs.execute(owner.user.id, "Generate the DCMM training report", { allowDangerousTools: true });

    assert.equal(run.status, "completed");
    assert.match(run.output ?? "", /dcmm-training.html/);
    const artifacts = await runs.processArtifacts(owner.user.id, run.id);
    const report = artifacts.find((artifact) => artifact.path.endsWith("dcmm-training.html"));
    assert.notEqual(report, undefined);
    const readReport = await runs.readProcessArtifact(owner.user.id, run.id, report.id);
    assert.equal(readReport.content.toString("utf8").includes("Evidence boundary"), true);
    const detail = runs.plan(owner.user.id, run.id);
    assert.equal(detail.plan.status, "completed");
    assert.equal(detail.plan.steps[0].evidence?.completionCaveat?.reason, "evidence_boundary");
    assert.equal(detail.plan.steps[1].status, "completed");
    const outcome = database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
      .get(run.id) as { status: string; reason_code: string };
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reason_code, "completed_with_evidence_boundary");
  } finally {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("strict source requirements remain blocking instead of evidence-boundary delivery", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("strict-source@example.com", "strict source secure password");
    const websearch: RuntimeTool<unknown> = {
      name: "websearch",
      description: "Search public source metadata",
      inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string" } } },
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => value,
      execute: async () => [{ title: "Standard metadata", url: "https://example.test/standard", snippet: "Metadata only" }],
    };
    const webfetch: RuntimeTool<unknown> = {
      name: "webfetch",
      description: "Fetch public source metadata",
      inputSchema: { type: "object", additionalProperties: false, properties: { url: { type: "string" } } },
      executionMode: "parallel",
      replaySafe: true,
      parse: (value) => value,
      execute: async (_context, value) => ({
        url: (value as { url: string }).url,
        title: "Standard metadata",
        content: "The page exposes public standard metadata but does not expose the full text.",
      }),
    };
    const planner: Planner = {
      plan: async () => ({
        goal: "strict source research",
        selectedSkillIds: [],
        steps: [{
          id: "research-sources",
          objective: "必须严格依据官方标准全文逐条核验，生成来源事实基线。",
          dependencies: [],
          skillIds: [],
          requiredToolNames: ["websearch", "webfetch"],
          successCriteria: [{
            id: "strict-source-facts",
            description: "必须按照官方标准全文逐条给出精确条款；缺少全文时不能交付。",
          }],
        }],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => new MissingSourceFactsReportModel(),
      plannerFactory: () => planner,
      assessorFactory: () => missingSourceFactsAssessor(),
      tools: [websearch, webfetch],
      maxSteps: 6,
    });

    await assert.rejects(
      () => runs.execute(owner.user.id, "必须严格按照官方标准全文逐条核验"),
      (error) => hasCode(error, "STEP_NOT_COMPLETED"),
    );
  } finally {
    database.close();
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
      instructions: [
        "---",
        "agentloop:",
        "  roles:",
        "    - primary_builder",
        "  artifactKinds:",
        "    - none",
        "  sourceKinds: []",
        "  qaKinds: []",
        "---",
        "Include canonical evidence.",
      ].join("\n"),
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
    assert.ok(lines.some((line) => line.includes("event=planning.turn.completed") && line.includes("submitOutcomePlanCalls=1")));
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
    const events = runs.events(owner.user.id, run.id);
    assert.equal(events.filter((event) => event.type === "loop.convergence_requested").length, 1);
    const lifecycle = events
      .filter((event) =>
        typeof event.data.toolCallId === "string"
        && event.data.toolCallId === "proof-1"
        && [
          "tool.effect_pending",
          "tool.dispatched",
          "tool.result_committed",
          "tool.completed",
        ].includes(event.type)
      )
      .map((event) => event.type);
    assert.deepEqual(lifecycle, [
      "tool.effect_pending",
      "tool.dispatched",
      "tool.result_committed",
      "tool.completed",
    ]);
    const terminalIndex = events.findIndex((event) => event.type === "terminal.delivery_committed");
    const completedIndex = events.findIndex((event) => event.type === "run.completed");
    assert.notEqual(terminalIndex, -1);
    assert.notEqual(completedIndex, -1);
    assert.equal(terminalIndex < completedIndex, true);
    assert.equal(events[terminalIndex].data.reasonCode, "plan_assessed_and_completed");
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

class EvidenceBoundaryResearchModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  executionCalls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.phase === "assessment") {
      throw new Error("evidence-boundary test uses a focused assessor");
    }
    this.executionCalls += 1;
    if (this.executionCalls === 1) {
      assert.equal(request.tools.some((tool) => tool.name === "websearch"), true);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "search", name: "websearch", arguments: { query: "official source metadata" } }],
      };
    }
    if (this.executionCalls === 2) {
      assert.equal(request.tools.some((tool) => tool.name === "webfetch"), true);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          { id: "fetch-ok", name: "webfetch", arguments: { url: "https://example.test/metadata" } },
          { id: "fetch-blocked", name: "webfetch", arguments: { url: "https://example.test/blocked" } },
        ],
      };
    }
    return {
      content: "Verified facts are limited to public metadata from https://example.test/metadata. The full text remains unverified because https://example.test/blocked returned HTTP 403, so missing source facts are not claimed as verified.",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class MissingSourceFactsReportModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  executionCalls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.phase === "assessment") {
      throw new Error("missing-source-facts test uses a focused assessor");
    }
    this.executionCalls += 1;
    const toolNames = request.tools.map((tool) => tool.name);
    if (this.executionCalls === 1) {
      assert.equal(toolNames.includes("websearch"), true);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "search-metadata", name: "websearch", arguments: { query: "standard metadata" } }],
      };
    }
    if (this.executionCalls === 2) {
      assert.equal(toolNames.includes("webfetch"), true);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "fetch-metadata", name: "webfetch", arguments: { url: "https://example.test/standard" } }],
      };
    }
    if (this.executionCalls === 3) {
      return {
        content: "Verified facts are limited to public metadata. The full text remains unverified, so missing source facts and exact clauses are not claimed as verified; downstream report content must label those sections as training interpretation.",
        finishReason: "stop",
        toolCalls: [],
      };
    }
    if (this.executionCalls >= 4 && !toolNames.includes("computer_write_file")) {
      return {
        content: "Verified facts are limited to public metadata. The full text remains unverified, so missing source facts and exact clauses are not claimed as verified; downstream report content must label those sections as training interpretation.",
        finishReason: "stop",
        toolCalls: [],
      };
    }
    if (this.executionCalls === 4) {
      assert.equal(toolNames.includes("computer_write_file"), true);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "write-report",
          name: "computer_write_file",
          arguments: {
            path: "dcmm-training.html",
            content: "<!doctype html><html><body><h1>DCMM Training Report</h1><p>Evidence boundary: full text remains unverified; exact clauses are not claimed as verified.</p></body></html>",
          },
        }],
      };
    }
    return {
      content: "dcmm-training.html was generated from the bounded source outline and states the evidence boundary.",
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
      assert.deepEqual(request.tools.map((tool) => tool.name), ["submit_outcome_plan"]);
      assert.match(request.runtimeContext?.content ?? "", /evidence-chain/);
      assert.doesNotMatch(request.runtimeContext?.content ?? "", /Include canonical evidence/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "plan",
          name: "submit_outcome_plan",
          arguments: {
            schema: "agentloop.outcomePlan/v2",
            goal: "produce answer",
            shape: "single_leaf",
            selectedSkillRoles: [{
              skillId: this.skillId,
              role: "primary_builder",
              reason: "The answer must follow the selected evidence Skill.",
            }],
            leaves: [{
              id: "answer",
              objective: "produce the evidence-backed answer",
              dependsOn: [],
              role: "deliver",
              skillIds: [this.skillId],
              requiredToolNames: [],
              evidenceContract: {
                requiredKinds: ["delivery_receipt"],
                caveatPolicy: "none",
              },
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
            { criterionId: "delivery_receipt", satisfied: true, rationale: "Answer exists", evidenceRefs: ["candidateOutput"] },
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
    version: 1, contentHash: "hash",
    agentLoop: {
      roles: ["primary_builder"],
      artifactKinds: ["none"],
      sourceKinds: [],
      qaKinds: [],
    },
    updatedAt: 1, ...overrides,
  };
}

function agentLoopMetadata(
  roles: NonNullable<PrivateSkill["agentLoop"]>["roles"],
  artifactKinds: NonNullable<PrivateSkill["agentLoop"]>["artifactKinds"],
  sourceKinds: readonly string[] = [],
  qaKinds: readonly string[] = [],
): NonNullable<PrivateSkill["agentLoop"]> {
  return { roles, artifactKinds, sourceKinds, qaKinds };
}

function instructionsWithAgentLoopMetadata(
  body: string,
  roles: NonNullable<PrivateSkill["agentLoop"]>["roles"] = ["primary_builder"],
  artifactKinds: NonNullable<PrivateSkill["agentLoop"]>["artifactKinds"] = ["none"],
  sourceKinds: readonly string[] = [],
  qaKinds: readonly string[] = [],
): string {
  const lines = [
    "---",
    "agentloop:",
    "  roles:",
    ...roles.map((role) => `    - ${role}`),
    "  artifactKinds:",
    ...artifactKinds.map((kind) => `    - ${kind}`),
    ...(sourceKinds.length === 0
      ? ["  sourceKinds: []"]
      : ["  sourceKinds:", ...sourceKinds.map((kind) => `    - ${kind}`)]),
    ...(qaKinds.length === 0
      ? ["  qaKinds: []"]
      : ["  qaKinds:", ...qaKinds.map((kind) => `    - ${kind}`)]),
    "---",
    body,
  ];
  return lines.join("\n");
}

async function waitForRecoveryState(
  runs: RunService,
  ownerUserId: string,
  runId: string,
  state: "waiting_recovery" | "waiting_user" | "ready_to_resume",
): Promise<ReturnType<RunService["recoveryForRun"]>> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const recovery = runs.recoveryForRun(ownerUserId, runId);
    if (recovery.state?.state === state) return recovery;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return runs.recoveryForRun(ownerUserId, runId);
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

function evidenceBoundaryAssessor(): import("../src/planning/contracts.ts").StepAssessor {
  return {
    assess: async (input) => ({
      id: `assessment-${input.step.id}-${input.attempt}`,
      planId: input.planId,
      stepId: input.step.id,
      attempt: input.attempt,
      assessmentProfile: input.assessmentProfile,
      assessmentMethod: "model",
      approved: false,
      criteria: input.step.successCriteria.map((criterion) => ({
        criterionId: criterion.id,
        satisfied: false,
        rationale: "The candidate preserves verified public metadata, but the full text is unavailable with HTTP 403 and source facts remain unverified.",
        evidenceRefs: ["candidateOutput", "fetch-ok", "fetch-blocked"],
      })),
      skills: [],
      evidenceDigest: "evidence-boundary-digest",
      feedback: "Proceed only as a limited evidence-boundary delivery: cite verified metadata, state that the source returned 403, and do not claim missing source facts as verified.",
      createdAt: Date.now(),
    }),
  };
}

function missingSourceFactsAssessor(): import("../src/planning/contracts.ts").StepAssessor {
  return {
    assess: async (input) => {
      const approved = input.step.id === "write-report";
      return {
        id: `assessment-${input.step.id}-${input.attempt}`,
        planId: input.planId,
        stepId: input.step.id,
        attempt: input.attempt,
        assessmentProfile: input.assessmentProfile,
        assessmentMethod: "model",
        approved,
        criteria: input.step.successCriteria.map((criterion) => ({
          criterionId: criterion.id,
          satisfied: approved,
          rationale: approved
            ? "The requested report artifact was generated and preserves the evidence boundary."
            : "候选输出保留了已验证的公开元数据，但关键事实仍未验证，标准全文未提供，精确条款无法可靠核实。",
          evidenceRefs: approved ? ["candidateOutput", "write-report"] : ["candidateOutput", "fetch-metadata"],
        })),
        skills: [],
        evidenceDigest: `missing-source-facts-${input.step.id}`,
        feedback: approved
          ? ""
          : "Proceed with an evidence-boundary delivery: use verified metadata, state that standard details cannot be publicly confirmed, and do not claim unverified key facts or exact clauses as verified.",
        createdAt: Date.now(),
      };
    },
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
