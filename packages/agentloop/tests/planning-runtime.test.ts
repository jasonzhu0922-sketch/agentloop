import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { admitPlan } from "../src/planning/admission.ts";
import type { ConversationWorkingSet, PlanProposal, Planner, TaskSpec } from "../src/planning/contracts.ts";
import { ModelStepAssessor, ProfiledRuleStepAssessor, RuleBasedStepAssessor } from "../src/planning/assessor.ts";
import { ModelPlanner } from "../src/planning/planner.ts";
import { PlanRepository } from "../src/planning/plan-repository.ts";
import { DependencyScheduler } from "../src/planning/scheduler.ts";
import {
  planningCapabilitiesFromTools,
  requiredToolSourceIdsFromInput,
} from "../src/planning/step-execution-binding.ts";
import { estimateTextTokens } from "../src/runtime/context-assembler.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { buildTaskProfile, formatDynamicPromptContext } from "../src/runtime/dynamic-prompt.ts";
import { RunService, selectPlanningSkills } from "../src/runtime/run-service.ts";
import { createStepExecutionStrategyProfile } from "../src/runtime/step-execution-strategy.ts";
import { classifyTaskIntent } from "../src/runtime/task-intent.ts";
import { RuntimeActionRepository } from "../src/runtime/runtime-action-repository.ts";
import { TerminalCommitter } from "../src/runtime/terminal-committer.ts";
import type { RuntimeTool } from "../src/tools/tool-registry.ts";
import { AppError } from "../src/shared/errors.ts";
import { inspectSkillPackage, removeSkillPackage } from "../src/skills/skill-package.ts";
import { SkillService, type PrivateSkill } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { SourceRepository } from "../src/storage/repositories/source-repository.ts";
import { RunOutcomeRepository } from "../src/storage/repositories/outcome-repository.ts";
import { RunRepository } from "../src/storage/repositories/run-repository.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS, testOwner } from "./runtime-test-helpers.ts";

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
        requiredCapabilities: step.requiredCapabilities,
        ...(step.sourceConstraint === undefined ? {} : { sourceConstraint: step.sourceConstraint }),
        evidenceContract: evidenceContractForFixture(step),
      })),
    },
  };
}

function outcomeLeafRoleForFixture(step: LegacyPlanStepFixture): "fact_acquisition" | "produce" | "deliver" | "repair" {
  if (step.role !== undefined) return step.role;
  const text = `${step.id} ${step.objective}`.toLowerCase();
  if (step.requiredCapabilities.some((name) =>
    name === "web_research"
    || name === "external_api_call"
    || name === "uploaded_source_read"
    || name === "uploaded_table_extraction"
    || name === "visible_directory_read"
    || name === "visible_table_extraction"
    || name === "workspace_file_read"
    || name === "workspace_structured_artifact_read"
  )) return "fact_acquisition";
  if (/repair|fix|修复/.test(text)) return "repair";
  if (step.requiredCapabilities.some((name) => name === "workspace_artifact_write" || name === "artifact_acceptance")) return "produce";
  return "deliver";
}

function evidenceContractForFixture(step: LegacyPlanStepFixture): {
  readonly requiredKinds: readonly string[];
  readonly caveatPolicy: "none" | "mark_unverified_facts" | "strict_fail_on_missing_source";
} {
  if (step.evidenceContract !== undefined) return step.evidenceContract;
  if (step.requiredCapabilities.some((name) =>
    name === "web_research"
    || name === "external_api_call"
    || name === "uploaded_source_read"
    || name === "uploaded_table_extraction"
    || name === "visible_directory_read"
    || name === "visible_table_extraction"
    || name === "workspace_file_read"
    || name === "workspace_structured_artifact_read"
  )) {
    return { requiredKinds: ["source_summary", "source_urls", "explicit_caveats"], caveatPolicy: "mark_unverified_facts" };
  }
  if (step.requiredCapabilities.some((name) => name === "workspace_artifact_write" || name === "artifact_acceptance")) {
    return { requiredKinds: ["artifact_path", "artifact_non_empty", "delivery_receipt"], caveatPolicy: "none" };
  }
  return { requiredKinds: ["delivery_receipt"], caveatPolicy: "none" };
}

function executionBindingJson(input: {
  readonly requiredCapabilities: readonly string[];
  readonly resolvedToolNames?: readonly string[];
  readonly sourceKinds?: readonly string[];
  readonly evidenceKinds?: readonly string[];
  readonly sideEffect?: string;
}): string {
  return JSON.stringify({
    schema: "agentloop.stepExecutionBinding/v1",
    requiredCapabilities: input.requiredCapabilities,
    resolvedToolNames: input.resolvedToolNames ?? [],
    sourceKinds: input.sourceKinds ?? [],
    sideEffect: input.sideEffect ?? "none",
    evidenceKinds: input.evidenceKinds ?? [],
  });
}

test("ModelPlanner fails closed after one bounded prose contract retry", async () => {
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
        planningTurn: 2,
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

test("ModelPlanner retries once when the planning model returns ordinary text", async () => {
  let calls = 0;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      assert.deepEqual(request.tools.map((tool) => tool.name), ["submit_outcome_plan"]);
      if (calls === 1) {
        return {
          content: "已经按你的要求改成绘图人物风格了。",
          finishReason: "stop",
          toolCalls: [],
        };
      }
      assert.match(request.runtimeContext?.content ?? "", /ordinary assistant text/i);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("plain-response-plan", {
          goal: "Create the requested image artifact.",
          shape: "single_leaf",
          steps: [{
            id: "create_image",
            objective: "Create and deliver the requested image artifact.",
            dependencies: [],
            role: "produce",
            skillIds: [],
            requiredCapabilities: ["workspace_artifact_write"],
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
    runId: "run-plain-planning-response",
    input: "这些形象要用绘图的方式，不要单纯用文字",
    availableSkills: [],
    availableToolNames: ["computer_write_file"],
  });

  assert.equal(calls, 2);
  assert.deepEqual(plan.steps.map((step) => step.id), ["create_image"]);
});

test("ModelPlanner retries once when the planning model returns an empty response", async () => {
  let calls = 0;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      assert.deepEqual(request.tools.map((tool) => tool.name), ["submit_outcome_plan"]);
      if (calls === 1) {
        return { content: "", finishReason: "stop", toolCalls: [] };
      }
      assert.match(request.runtimeContext?.content ?? "", /previous planning response was empty/i);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("empty-response-plan", {
          goal: "Generate a festive National Day poster.",
          shape: "single_leaf",
          steps: [{
            id: "build_poster",
            objective: "Create the requested poster.",
            dependencies: [],
            role: "produce",
            skillIds: [],
            requiredCapabilities: ["workspace_artifact_write"],
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
    runId: "run-empty-planning-response",
    input: "帮我生成一张国庆庆祝海报",
    availableSkills: [],
    availableToolNames: ["computer_write_file"],
  });

  assert.equal(calls, 2);
  assert.deepEqual(plan.steps.map((step) => step.id), ["build_poster"]);
});

test("ModelPlanner corrects a capability mistakenly submitted as a Skill", async () => {
  let calls = 0;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls === 1) {
        assert.match(request.runtimeContext?.content ?? "", /\"availableSkillIds\":\[\]/);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [submitOutcomePlanToolCall("capability-as-skill", {
            goal: "Summarize the uploaded source.",
            selectedSkillRoles: [{
              skillId: "uploaded_source_read",
              role: "source_provider",
              reason: "Read the uploaded source.",
            }],
            steps: [{
              id: "read_upload",
              objective: "Read the uploaded source and summarize it.",
              dependencies: [],
              role: "fact_acquisition",
              skillIds: ["uploaded_source_read"],
              requiredCapabilities: ["uploaded_source_read"],
              evidenceContract: {
                requiredKinds: ["source_summary", "explicit_caveats"],
                caveatPolicy: "mark_unverified_facts",
              },
            }],
          })],
        };
      }
      assert.match(request.runtimeContext?.content ?? "", /Do not place capability IDs, Tool names, ToolSource IDs, or evidence kinds/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("capability-corrected", {
          goal: "Summarize the uploaded source.",
          selectedSkillRoles: [],
          steps: [{
            id: "read_upload",
            objective: "Read the uploaded source and summarize it.",
            dependencies: [],
            role: "fact_acquisition",
            skillIds: [],
            requiredCapabilities: ["uploaded_source_read"],
            evidenceContract: {
              requiredKinds: ["source_summary", "explicit_caveats"],
              caveatPolicy: "mark_unverified_facts",
            },
          }],
        })],
      };
    },
  });

  const plan = await planner.plan({
    runId: "run-capability-not-skill",
    input: "Summarize the uploaded source.",
    availableSkills: [],
    availableToolNames: ["read_source"],
  });

  assert.equal(calls, 2);
  assert.deepEqual(plan.selectedSkillIds, []);
  assert.deepEqual(plan.steps[0].skillIds, []);
  assert.deepEqual(plan.steps[0].requiredCapabilities, ["uploaded_source_read"]);
});

test("Task intent treats Chinese summary files as workspace document artifacts", () => {
  const intent = classifyTaskIntent({
    objective: "你倒是生成一个总结文件啊",
    requiredCapabilities: ["workspace_artifact_write"],
  });

  assert.equal(intent.artifactKind, "document");
  assert.equal(intent.deliverySurface, "workspace_artifact");
  assert.equal(intent.wantsArtifact, true);
});

test("Task intent keeps a referenced uploaded HTML source conversational when file writers are available", () => {
  const intent = classifyTaskIntent({
    objective: "阅读这个 html",
    toolNames: ["read_source", "computer_write_file", "verify_artifact_acceptance"],
  });

  assert.equal(intent.artifactKind, "none");
  assert.equal(intent.deliverySurface, "conversation");
  assert.equal(intent.wantsArtifact, false);
});

test("ModelPlanner admits an uploaded HTML reading plan without inventing a workspace artifact", async () => {
  const sourceId = "src_uploaded_html";
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      const context = request.runtimeContext?.content ?? "";
      assert.match(context, /"deliverySurface":"conversation"/);
      assert.doesNotMatch(context, /"artifactKind":"html"/);
      assert.doesNotMatch(context, /"id":"artifact_build"/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("read-uploaded-html", {
          goal: "阅读并概述用户上传的 HTML 文件内容。",
          steps: [{
            id: "read_html",
            objective: "读取上传的 HTML 文件，并向用户概述其内容与未确认之处。",
            dependencies: [],
            role: "fact_acquisition",
            skillIds: [],
            requiredCapabilities: ["uploaded_source_read"],
            sourceConstraint: { requiredUploadedSourceIds: [sourceId] },
            evidenceContract: {
              requiredKinds: ["source_summary", "explicit_caveats"],
              caveatPolicy: "mark_unverified_facts",
            },
          }],
        })],
      };
    },
  });

  const plan = await planner.plan({
    runId: "run-read-uploaded-html",
    input: "阅读这个 html",
    availableSkills: [],
    availableToolNames: ["read_source", "computer_write_file", "verify_artifact_acceptance"],
    sources: [{
      id: sourceId,
      originalName: "chapter.html",
      mimeType: "text/html",
      extension: ".html",
      byteSize: 512,
      sha256: "a".repeat(64),
      status: "ready",
      summary: "Uploaded HTML chapter.",
      chunkCount: 1,
      truncated: false,
    }],
  });

  assert.deepEqual(plan.steps[0]?.requiredCapabilities, ["uploaded_source_read"]);
});

test("Task intent treats Chinese market price queries as fresh lookup", () => {
  const intent = classifyTaskIntent({
    objective: "帮我查查上海市螺纹钢的市场价格，型号任选。",
  });

  assert.equal(intent.sourceNeed, "lookup_lite");
  assert.deepEqual(intent.signals.source, ["fresh"]);
  assert.equal(intent.researchPolicy?.depth, "opportunistic");
  assert.equal(intent.researchPolicy?.maxSearches, 1);
  assert.equal(intent.researchPolicy?.maxFetches, 2);
  assert.equal(intent.researchPolicy?.freshnessNeed, "current");
});

test("Task intent keeps research policy conditional and graded", () => {
  const plainArtifact = classifyTaskIntent({
    objective: "生成一份项目周报案例，html 格式",
    requiredCapabilities: ["web_research", "workspace_artifact_write"],
  });
  const opportunistic = classifyTaskIntent({
    objective: "互联网能找到材料你就用，没有就靠你自己的知识，生成 pptx",
  });
  const strict = classifyTaskIntent({
    objective: "仅基于可核验官方公开资料和标准全文，逐条核验后生成培训材料",
  });

  assert.equal(plainArtifact.sourceNeed, "none");
  assert.equal(plainArtifact.researchPolicy, undefined);
  assert.equal(opportunistic.sourceNeed, "source_grounded");
  assert.equal(opportunistic.researchPolicy?.depth, "opportunistic");
  assert.equal(opportunistic.researchPolicy?.maxSearches, 1);
  assert.equal(opportunistic.researchPolicy?.maxFetches, 3);
  assert.equal(strict.sourceNeed, "strict_user_source");
  assert.equal(strict.researchPolicy?.depth, "strict");
  assert.equal(strict.researchPolicy?.authorityNeed, "official_required");
});

test("Dynamic prompt context includes a runtime clock for fresh lookups", () => {
  const intent = classifyTaskIntent({
    objective: "帮我查查上海市螺纹钢的市场价格，型号任选。",
  });
  const context = formatDynamicPromptContext(buildTaskProfile({
    phase: "planning",
    intent: "execute",
    sourceNeed: "lookup_lite",
    researchPolicy: intent.researchPolicy,
    skillBound: false,
  }));

  assert.match(context, /"schema":"agentloop\.taskProfile\/v2"/);
  assert.match(context, /"sourceNeed":"lookup_lite"/);
  assert.match(context, /"runtimeClock":/);
  assert.match(context, /"currentDateUtc":"\d{4}-\d{2}-\d{2}"/);
  assert.match(context, /freshnessInstruction/);
  assert.match(context, /agentloop\.researchPolicy\/v1/);
});

test("Dynamic prompt context omits research policy when source evidence is not needed", () => {
  const context = formatDynamicPromptContext(buildTaskProfile({
    phase: "planning",
    intent: "execute",
    sourceNeed: "none",
    skillBound: false,
  }));

  assert.doesNotMatch(context, /researchPolicy/);
  assert.doesNotMatch(context, /agentloop\.researchPolicy\/v1/);
});

test("ModelPlanner retries once when the planning model attempts execution tools", async () => {
  let calls = 0;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      assert.deepEqual(request.tools.map((tool) => tool.name), ["submit_outcome_plan"]);
      if (calls === 1) {
        return {
          content: "我来检查 Excel 文件。",
          finishReason: "tool_calls",
          toolCalls: [{
            id: "wrong-tool",
            name: "computer_read_file",
            arguments: { path: "workbook.xlsx" },
          }],
        };
      }
      assert.match(request.runtimeContext?.content ?? "", /Attempted tools: computer_read_file/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("repair-xlsx-plan", {
          goal: "Repair the unreadable spreadsheet artifact.",
          shape: "single_leaf",
          steps: [{
            id: "repair_xlsx",
            objective: "Locate the prior XLSX artifact, verify text readability, regenerate the spreadsheet if needed, and record artifact acceptance evidence.",
            dependencies: [],
            role: "produce",
            skillIds: [],
            requiredCapabilities: ["workspace_file_read", "workspace_artifact_write", "artifact_acceptance"],
            evidenceContract: {
              requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance", "artifact_openable", "format_matches_request"],
              caveatPolicy: "none",
            },
          }],
        })],
      };
    },
  });

  const plan = await planner.plan({
    runId: "run-planner-tool-contract-retry",
    input: "这个 excel 文件里面中文全是乱码",
    availableSkills: [],
    availableToolNames: ["computer_read_file", "computer_write_file", "verify_artifact_acceptance"],
  });

  assert.equal(calls, 2);
  assert.deepEqual(plan.steps.map((step) => step.id), ["repair_xlsx"]);
});

test("ModelPlanner retries once when submit_outcome_plan arguments are not a JSON object", async () => {
  let calls = 0;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      assert.deepEqual(request.tools.map((tool) => tool.name), ["submit_outcome_plan"]);
      if (calls === 1) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{
            id: "malformed-plan",
            name: "submit_outcome_plan",
            arguments: "{\"schema\":\"agentloop.outcomePlan/v2\",\"goal\":\"查询目录中\"合同备案\"相关接口\"}",
          }],
        };
      }
      assert.match(request.runtimeContext?.content ?? "", /arguments were not a JSON object/);
      assert.match(request.runtimeContext?.content ?? "", /Observed argument type: string/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("valid-plan", {
          goal: "Query API parameters",
          shape: "single_leaf",
          selectedSkillRoles: [{
            skillId: "discovered:api-query",
            role: "source_provider",
            reason: "The selected Skill provides API catalog source data.",
          }],
          steps: [{
            id: "query_api_params",
            objective: "Load the API catalog Skill and query parameter information.",
            dependencies: [],
            role: "produce",
            skillIds: ["discovered:api-query"],
            requiredCapabilities: ["workspace_artifact_write"],
            evidenceContract: {
              requiredKinds: ["source_summary", "explicit_caveats", "delivery_receipt"],
              caveatPolicy: "mark_unverified_facts",
            },
          }],
        })],
      };
    },
  });
  const skill = skillFixture({
    id: "discovered:api-query",
    name: "api-query",
    agentLoop: agentLoopMetadata(["source_provider"], ["none"], ["api"]),
  });

  const plan = await planner.plan({
    runId: "run-planner-arguments-contract-retry",
    input: "查询宝武集团数据中台中合同备案 API 的参数信息",
    availableSkills: [skill],
    selectedSkillRoles: [{
      skillId: skill.id,
      role: "source_provider",
      reason: "Skill metadata declares source_provider for requested source-grounded work.",
    }],
    availableToolNames: ["load_skill", "computer_run_command"],
  });

  assert.equal(calls, 2);
  assert.deepEqual(plan.selectedSkillIds, ["discovered:api-query"]);
  assert.deepEqual(plan.steps.map((step) => step.id), ["query_api_params"]);
});

test("ModelPlanner retries once when Admission rejects an initial support Skill role", async () => {
  let calls = 0;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [submitOutcomePlanToolCall("invalid-support-role", {
            goal: "Build an HTML report from the uploaded spreadsheet.",
            shape: "single_leaf",
            selectedSkillRoles: [
              {
                skillId: "discovered:build-dashboard",
                role: "primary_builder",
                reason: "Dashboard builder owns the executable artifact.",
              },
              {
                skillId: "discovered:web-artifacts-builder",
                role: "support",
                reason: "Use as optional HTML conventions.",
              },
            ],
            steps: [{
              id: "produce_report",
              objective: "Read the uploaded spreadsheet and produce an accepted HTML report.",
              dependencies: [],
              role: "produce",
              skillIds: ["discovered:build-dashboard"],
              requiredCapabilities: ["uploaded_source_read", "workspace_artifact_write", "artifact_acceptance"],
              evidenceContract: {
                requiredKinds: ["source_summary", "artifact_path", "artifact_non_empty", "artifact_acceptance"],
                caveatPolicy: "mark_unverified_facts",
              },
            }],
          })],
        };
      }
      assert.match(request.runtimeContext?.content ?? "", /rejected by Runtime Admission/);
      assert.match(request.runtimeContext?.content ?? "", /support and qa roles are recovery-only/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("valid-initial-plan", {
          goal: "Build an HTML report from the uploaded spreadsheet.",
          shape: "single_leaf",
          selectedSkillRoles: [{
            skillId: "discovered:build-dashboard",
            role: "primary_builder",
            reason: "Dashboard builder owns the executable artifact.",
          }],
          steps: [{
            id: "produce_report",
            objective: "Read the uploaded spreadsheet and produce an accepted HTML report.",
            dependencies: [],
            role: "produce",
            skillIds: ["discovered:build-dashboard"],
            requiredCapabilities: ["uploaded_source_read", "workspace_artifact_write", "artifact_acceptance"],
            evidenceContract: {
              requiredKinds: ["source_summary", "artifact_path", "artifact_non_empty", "artifact_acceptance"],
              caveatPolicy: "mark_unverified_facts",
            },
          }],
        })],
      };
    },
  });
  const dashboard = skillFixture({
    id: "discovered:build-dashboard",
    name: "build-dashboard",
    agentLoop: agentLoopMetadata(["primary_builder"], ["html"]),
  });
  const htmlBuilder = skillFixture({
    id: "discovered:web-artifacts-builder",
    name: "web-artifacts-builder",
    agentLoop: agentLoopMetadata(["primary_builder"], ["html"]),
  });

  const plan = await planner.plan({
    runId: "run-planner-admission-contract-retry",
    input: "把这个 excel 的场景清单生成一份 html 格式的报告",
    availableSkills: [dashboard, htmlBuilder],
    availableToolNames: ["read_source", "load_skill", "computer_write_file", "verify_artifact_acceptance"],
  });

  assert.equal(calls, 2);
  assert.deepEqual(plan.selectedSkillIds, ["discovered:build-dashboard"]);
  assert.deepEqual(plan.steps[0].skillIds, ["discovered:build-dashboard"]);
});

test("ModelPlanner treats bound uploaded sources as source-grounded artifact input", async () => {
  let calls = 0;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      const runtimeContext = request.runtimeContext?.content ?? "";
      assert.match(runtimeContext, /"sourceNeed":"source_grounded"/);
      assert.match(runtimeContext, /"planShape":"fact_then_produce"/);
      assert.match(runtimeContext, /Choose the smallest dependency shape/);
      assert.match(runtimeContext, /"finalDeliverySurface":"workspace_artifact"/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("uploaded-source-fact-then-produce", {
          goal: "Build an HTML report from the uploaded spreadsheet.",
          shape: "fact_then_produce",
          selectedSkillRoles: [{
            skillId: "discovered:build-dashboard",
            role: "primary_builder",
            reason: "Dashboard builder owns the executable artifact.",
          }],
          steps: [{
            id: "profile_uploaded_spreadsheet",
            objective: "Read the uploaded spreadsheet and record bounded source summary evidence.",
            dependencies: [],
            role: "fact_acquisition",
            skillIds: [],
            requiredCapabilities: ["uploaded_source_read"],
            evidenceContract: {
              requiredKinds: ["source_summary", "explicit_caveats"],
              caveatPolicy: "mark_unverified_facts",
            },
          }, {
            id: "produce_html_report",
            objective: "Build the final HTML report from the source summary and record artifact acceptance.",
            dependencies: ["profile_uploaded_spreadsheet"],
            role: "produce",
            skillIds: ["discovered:build-dashboard"],
            requiredCapabilities: ["skill_instruction_load", "workspace_artifact_write", "artifact_acceptance"],
            evidenceContract: {
              requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_openable", "format_matches_request", "artifact_acceptance", "explicit_caveats"],
              caveatPolicy: "mark_unverified_facts",
            },
          }],
        })],
      };
    },
  });
  const dashboard = skillFixture({
    id: "discovered:build-dashboard",
    name: "build-dashboard",
    agentLoop: agentLoopMetadata(["primary_builder"], ["html"]),
  });

  const plan = await planner.plan({
    runId: "run-planner-uploaded-source-fact-then-produce",
    input: "把这个 excel 的场景清单生成一份 html 格式的报告",
    availableSkills: [dashboard],
    availableToolNames: ["read_source", "load_skill", "computer_write_file", "verify_artifact_acceptance"],
    sources: [{
      id: "src_uploaded",
      originalName: "场景清单.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: ".xlsx",
      byteSize: 250_732,
      sha256: "a".repeat(64),
      status: "ready",
      summary: "场景清单.xlsx is a XLSX source with 264 lines.",
      chunkCount: 4,
      truncated: false,
    }],
  });

  assert.equal(calls, 1);
  assert.deepEqual(plan.steps.map((step) => step.id), ["profile_uploaded_spreadsheet", "produce_html_report"]);
  assert.deepEqual(plan.steps[1].dependencies, ["profile_uploaded_spreadsheet"]);
});

test("ModelPlanner prefers fact-then-produce for visible spreadsheet data analysis replies", async () => {
  let calls = 0;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      const runtimeContext = request.runtimeContext?.content ?? "";
      assert.match(runtimeContext, /"planShape":"fact_then_produce"/);
      assert.match(runtimeContext, /"id":"data_analysis"/);
      assert.match(runtimeContext, /visible_directory_read/);
      assert.doesNotMatch(runtimeContext, /visible_extract_tables/);
      assert.match(runtimeContext, /structured extraction artifact/);
      assert.match(runtimeContext, /"evidenceContractPolicy"/);
      assert.match(runtimeContext, /"finalDeliverySurface":"conversation"/);
      assert.match(runtimeContext, /"forbiddenKinds":\["artifact_path","artifact_non_empty","artifact_acceptance","artifact_openable","format_matches_request"\]/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("visible-spreadsheet-analysis", {
          goal: "Analyze the visible spreadsheet data with structured evidence before replying.",
          shape: "fact_then_produce",
          steps: [{
            id: "profile_visible_spreadsheets",
            objective: "Profile visible spreadsheet files and extract bounded structured table evidence with schema, counts, ranges, and caveats.",
            dependencies: [],
            role: "fact_acquisition",
            skillIds: [],
            requiredCapabilities: ["visible_directory_read"],
            evidenceContract: {
              requiredKinds: ["source_summary", "schema_summary", "record_counts", "structured_extraction_artifact", "explicit_caveats"],
              caveatPolicy: "mark_unverified_facts",
            },
          }, {
            id: "deliver_analysis_reply",
            objective: "Answer the user's analysis request using the structured extraction evidence and caveats.",
            dependencies: ["profile_visible_spreadsheets"],
            role: "deliver",
            skillIds: [],
            requiredCapabilities: [],
            evidenceContract: {
              requiredKinds: ["artifact_path", "artifact_non_empty", "format_matches_request", "delivery_receipt", "explicit_caveats"],
              caveatPolicy: "mark_unverified_facts",
            },
          }],
        })],
      };
    },
  });

  const plan = await planner.plan({
    runId: "run-planner-visible-spreadsheet-analysis-fact-then-produce",
    input: "帮我分析一下这里面的绩效评价情况，直接在对话里回答就行",
    availableSkills: [],
    availableToolNames: ["visible_index_directory", "visible_extract_tables", "visible_find_files", "visible_read_files"],
    responseOnly: true,
    visibleDirectories: [{
      id: "visible_dir_1",
      name: "绩效表",
      path: "/tmp/perf",
    }],
  });

  assert.equal(calls, 1);
  assert.deepEqual(plan.steps.map((step) => step.id), ["profile_visible_spreadsheets", "deliver_analysis_reply"]);
  assert.deepEqual(plan.steps[0].requiredCapabilities, ["visible_directory_read"]);
  assert.deepEqual(plan.steps[1].dependencies, ["profile_visible_spreadsheets"]);
  assert.deepEqual(plan.steps[1].evidenceContract?.requiredKinds, ["explicit_caveats"]);
  assert.deepEqual(plan.steps[1].successCriteria.map((criterion) => criterion.id), ["explicit_caveats"]);
});

test("ModelPlanner requires derived aggregation evidence for a structured dependency count question", async () => {
  const planner = new ModelPlanner(new StaticModel({
    content: "",
    finishReason: "tool_calls",
    toolCalls: [submitOutcomePlanToolCall("structured-count", {
      goal: "Count records by owner from the uploaded table.",
      shape: "fact_then_produce",
      steps: [{
        id: "extract_table",
        objective: "Extract the uploaded workbook into durable structured table evidence.",
        dependencies: [],
        role: "fact_acquisition",
        skillIds: [],
        requiredCapabilities: ["uploaded_source_read"],
        evidenceContract: {
          requiredKinds: ["source_summary", "schema_summary", "record_counts", "structured_extraction_artifact", "explicit_caveats"],
          caveatPolicy: "mark_unverified_facts",
        },
      }, {
        id: "answer_count",
        objective: "统计每位责任人的任务数量、并列最多和最少情况。",
        dependencies: ["extract_table"],
        role: "deliver",
        skillIds: [],
        requiredCapabilities: [],
        evidenceContract: {
          requiredKinds: ["explicit_caveats"],
          caveatPolicy: "mark_unverified_facts",
        },
      }],
    })],
  }));

  const plan = await planner.plan({
    runId: "run-structured-aggregation-contract",
    input: "统计这个表里每位责任人的任务数量，谁最多、谁最少？",
    availableSkills: [],
    availableToolNames: [
      "read_source",
      "extract_source_tables",
      "computer_read_json",
      "computer_summarize_table_artifact",
      "computer_aggregate_table_artifact",
    ],
    sources: [{
      id: "src_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      originalName: "tasks.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: ".xlsx",
      byteSize: 1024,
      sha256: "a".repeat(64),
      status: "ready",
      summary: "task records",
      chunkCount: 1,
      truncated: false,
    }],
  });

  const answer = plan.steps.find((step) => step.id === "answer_count");
  assert.ok(answer);
  assert.ok(answer.requiredCapabilities.includes("workspace_file_read"));
  assert.deepEqual(answer.evidenceContract?.requiredKinds, ["explicit_caveats", "derived_aggregation"]);
  assert.deepEqual(answer.successCriteria.map((criterion) => criterion.id), ["explicit_caveats", "derived_aggregation"]);
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
          requiredCapabilities: ["workspace_file_read", "workspace_artifact_write"],
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
  assert.deepEqual(plan.steps[0].requiredCapabilities, ["workspace_file_read", "workspace_artifact_write"]);
});

test("ModelPlanner normalizes a missing fixed OutcomePlan schema discriminator", async () => {
  const planner = new ModelPlanner(new StaticModel({
    content: "",
    finishReason: "tool_calls",
    toolCalls: [{
      id: "plan",
      name: "submit_outcome_plan",
      arguments: {
        goal: "write source-grounded report",
        shape: "single_leaf",
        selectedSkillRoles: [],
        leaves: [{
          id: "produce_report",
          objective: "Read source files and write the report.",
          dependsOn: [],
          role: "produce",
          skillIds: [],
          requiredCapabilities: ["visible_directory_read", "workspace_artifact_write"],
          evidenceContract: {
            requiredKinds: ["source_summary", "artifact_path", "artifact_non_empty", "explicit_caveats"],
            caveatPolicy: "mark_unverified_facts",
          },
        }],
      },
    }],
  }));

  const plan = await planner.plan({
    runId: "run-missing-schema",
    input: "总结差旅报支方面的知识，形成一份差旅报支常识性说明报告",
    availableSkills: [],
    availableToolNames: ["visible_index_directory", "visible_search_text", "visible_read_files", "computer_write_file"],
  });

  assert.equal(plan.schema, "agentloop.outcomePlan/v2");
  assert.equal(plan.steps[0].id, "produce_report");
});

test("ModelPlanner still rejects an incorrect OutcomePlan schema discriminator", async () => {
  const planner = new ModelPlanner(new StaticModel({
    content: "",
    finishReason: "tool_calls",
    toolCalls: [{
      id: "plan",
      name: "submit_outcome_plan",
      arguments: {
        schema: "agentloop.outcomePlan/v1",
        goal: "write report",
        shape: "single_leaf",
        selectedSkillRoles: [],
        leaves: [{
          id: "produce_report",
          objective: "Read source files and write the report.",
          dependsOn: [],
          role: "produce",
          skillIds: [],
          requiredCapabilities: ["workspace_artifact_write"],
          evidenceContract: {
            requiredKinds: ["artifact_path", "artifact_non_empty"],
            caveatPolicy: "none",
          },
        }],
      },
    }],
  }));

  await assert.rejects(
    () => planner.plan({
      runId: "run-wrong-schema",
      input: "write report",
      availableSkills: [],
      availableToolNames: ["computer_write_file"],
    }),
    (error: unknown) => hasCode(error, "PLANNING_ERROR")
      && String((error as Error).message).includes("schema must be agentloop.outcomePlan/v2"),
  );
});

test("ModelPlanner accepts aggregate artifact_acceptance evidence contracts", async () => {
  const planner = new ModelPlanner(new StaticModel({
    content: "",
    finishReason: "tool_calls",
    toolCalls: [submitOutcomePlanToolCall("plan", {
      goal: "build and verify an html-ppt artifact",
      steps: [{
        id: "build-html-ppt",
        objective: "Create the requested HTML-PPT and record unified artifact acceptance evidence.",
        dependencies: [],
        role: "produce",
        skillIds: [],
        requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"],
        evidenceContract: {
          requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance"],
          caveatPolicy: "none",
        },
      }],
    })],
  }));

  const plan = await planner.plan({
    runId: "run-artifact-acceptance",
    input: "生成 html-ppt 并验收",
    availableSkills: [],
    availableToolNames: ["computer_write_file", "verify_artifact_acceptance"],
  });

  assert.deepEqual(plan.steps[0].requiredCapabilities, ["workspace_artifact_write", "artifact_acceptance"]);
  assert.deepEqual(plan.steps[0].evidenceContract, {
    requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance"],
    caveatPolicy: "none",
  });
  assert.deepEqual(
    plan.steps[0].successCriteria.map((criterion) => criterion.id),
    ["artifact_path", "artifact_non_empty", "artifact_acceptance"],
  );
});

test("ModelPlanner accepts ordinary delivery leaves without an evidence contract", async () => {
  const planner = new ModelPlanner(new StaticModel({
    content: "",
    finishReason: "tool_calls",
    toolCalls: [{
      id: "ordinary-delivery",
      name: "submit_outcome_plan",
      arguments: {
        schema: "agentloop.outcomePlan/v2",
        goal: "Explain the design trade-off",
        shape: "single_leaf",
        selectedSkillRoles: [],
        leaves: [{
          id: "answer",
          objective: "Explain the design trade-off directly to the user.",
          dependsOn: [],
          role: "deliver",
          skillIds: [],
          requiredCapabilities: [],
        }],
      },
    }],
  }));

  const plan = await planner.plan({
    runId: "run-ordinary-delivery",
    input: "Explain the design trade-off",
    availableSkills: [],
    availableToolNames: [],
  });

  assert.equal(plan.steps[0]?.evidenceContract, undefined);
  assert.deepEqual(plan.steps[0]?.successCriteria.map((criterion) => criterion.id), ["delivered"]);
});

test("ToolSource capability categories and explicit source constraints stay host-declared", async () => {
  const source = {
    id: "amap-maps",
    aliases: ["高德", "amap"],
    transport: "mcp",
    capabilities: [{
      id: "spatial_planning.route",
      category: "spatial_planning",
      label: "Route planning",
    }],
  } as const;
  const availableTools = [{
    name: "mcp_amap_maps_direction",
    description: "Plan a driving route.",
    source,
  }, {
    name: "websearch",
    description: "Search the web.",
  }];
  const requiredToolSourceIds = requiredToolSourceIdsFromInput("请调用高德 MCP 查询路线", availableTools);
  assert.deepEqual(requiredToolSourceIds, ["amap-maps"]);

  let planningContext = "";
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      planningContext = request.runtimeContext?.content ?? "";
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("source-bound-route", {
          goal: "Plan the requested route with the named map source.",
          steps: [{
            id: "plan-route",
            objective: "Use the named map source to plan the requested route.",
            dependencies: [],
            role: "fact_acquisition",
            skillIds: [],
            requiredCapabilities: ["spatial_planning.route"],
            sourceConstraint: { requiredToolSourceIds },
            evidenceContract: {
              requiredKinds: ["source_summary", "explicit_caveats"],
              caveatPolicy: "mark_unverified_facts",
            },
          }],
        })],
      };
    },
  });

  const proposal = await planner.plan({
    runId: "source-bound-route",
    input: "请调用高德 MCP 查询路线",
    availableSkills: [],
    availableToolNames: availableTools.map((tool) => tool.name),
    availableTools,
    availableCapabilities: planningCapabilitiesFromTools(availableTools),
    requiredToolSourceIds,
  });
  assert.match(planningContext, /"category":"spatial_planning"/);
  assert.match(planningContext, /"requiredToolSourceIds":\["amap-maps"\]/);

  const admitted = admitPlan({
    runId: "source-bound-route",
    proposal,
    availableSkills: [],
    availableToolNames: new Set(availableTools.map((tool) => tool.name)),
    availableTools,
    requiredToolSourceIds,
  });
  assert.deepEqual(admitted.steps[0]?.executionBinding.resolvedToolNames, ["mcp_amap_maps_direction"]);
  assert.deepEqual(admitted.steps[0]?.executionBinding.requiredToolSourceIds, ["amap-maps"]);

  assert.throws(
    () => admitPlan({
      runId: "source-bound-route-missing-constraint",
      proposal: {
        ...proposal,
        steps: proposal.steps.map((step) => ({ ...step, sourceConstraint: undefined })),
      },
      availableSkills: [],
      availableToolNames: new Set(availableTools.map((tool) => tool.name)),
      availableTools,
      requiredToolSourceIds,
    }),
    (error: unknown) => error instanceof AppError && /does not bind user-required ToolSource/.test(error.message),
  );
});

test("uploaded source IDs bind read_source without entering the ToolSource namespace", () => {
  const sourceId = "src_525eab4b68f44652a4601ca72ccbf69e";
  const proposal: PlanProposal = {
    goal: "Summarize the selected uploaded source.",
    selectedSkillIds: [],
    steps: [{
      id: "extract-source-points",
      objective: "Read the selected upload and extract its key points.",
      dependencies: [],
      skillIds: [],
      role: "fact_acquisition",
      requiredCapabilities: ["uploaded_source_read"],
      sourceConstraint: { requiredUploadedSourceIds: [sourceId] },
      evidenceContract: {
        requiredKinds: ["source_summary", "explicit_caveats"],
        caveatPolicy: "mark_unverified_facts",
      },
      successCriteria: [
        { id: "source_summary", description: "Source evidence is available.", source: "planner" },
        { id: "explicit_caveats", description: "Caveats are explicit when needed.", source: "planner" },
      ],
    }],
  };
  const admitted = admitPlan({
    runId: "uploaded-source-binding",
    proposal,
    availableSkills: [],
    availableToolNames: new Set(["read_source"]),
    availableTools: [{ name: "read_source", description: "Read authorized uploaded source chunks." }],
    availableUploadedSourceIds: [sourceId],
  });

  assert.deepEqual(admitted.steps[0]?.executionBinding.resolvedToolNames, ["read_source"]);
  assert.deepEqual(admitted.steps[0]?.executionBinding.requiredUploadedSourceIds, [sourceId]);
  assert.equal(admitted.steps[0]?.executionBinding.requiredToolSourceIds, undefined);
  assert.throws(
    () => admitPlan({
      runId: "uploaded-source-binding-unknown",
      proposal,
      availableSkills: [],
      availableToolNames: new Set(["read_source"]),
      availableTools: [{ name: "read_source", description: "Read authorized uploaded source chunks." }],
      availableUploadedSourceIds: [],
    }),
    (error: unknown) => error instanceof AppError && /requires unavailable uploaded source/.test(error.message),
  );
});

test("uploaded table extraction is a distinct capability from uploaded source reading", () => {
  const sourceId = "src_63636363636363636363636363636363";
  const proposal: PlanProposal = {
    goal: "Analyze the selected uploaded spreadsheet.",
    selectedSkillIds: [],
    steps: [{
      id: "extract-uploaded-table",
      objective: "Read the selected spreadsheet as structured source evidence.",
      dependencies: [],
      skillIds: [],
      role: "fact_acquisition",
      requiredCapabilities: ["uploaded_source_read", "uploaded_table_extraction"],
      sourceConstraint: { requiredUploadedSourceIds: [sourceId] },
      evidenceContract: {
        requiredKinds: ["source_summary", "schema_summary", "record_counts", "structured_extraction_artifact"],
        caveatPolicy: "mark_unverified_facts",
      },
      successCriteria: [{ id: "structured_evidence", description: "Structured source evidence is available.", source: "planner" }],
    }],
  };

  const admitted = admitPlan({
    runId: "uploaded-structured-source-binding",
    proposal,
    availableSkills: [],
    availableToolNames: new Set(["read_source", "extract_source_tables"]),
    availableTools: [
      { name: "read_source", description: "Read authorized uploaded source chunks." },
      { name: "extract_source_tables", description: "Extract authorized uploaded spreadsheet tables." },
    ],
    availableUploadedSourceIds: [sourceId],
  });

  assert.deepEqual(admitted.steps[0]?.executionBinding.resolvedToolNames, ["read_source", "extract_source_tables"]);
  assert.deepEqual(admitted.steps[0]?.executionBinding.requiredUploadedSourceIds, [sourceId]);
});

test("source capability catalog and admission never promise tabular extraction for a non-tabular upload", () => {
  const sourceId = "src_73737373737373737373737373737373";
  const source = {
    id: sourceId,
    originalName: "project-materials.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: ".docx",
    byteSize: 1024,
    sha256: "b".repeat(64),
    status: "ready" as const,
    chunkCount: 1,
    truncated: false,
  };
  const tools = [
    { name: "read_source", description: "Read authorized uploaded source chunks." },
    { name: "extract_source_tables", description: "Extract authorized uploaded spreadsheet tables." },
  ];
  const capabilities = planningCapabilitiesFromTools(tools, [source]);
  assert.equal(capabilities.some((capability) => capability.id === "uploaded_table_extraction"), false);

  assert.throws(
    () => admitPlan({
      runId: "non-tabular-structured-contract",
      proposal: {
        goal: "Extract document facts.",
        selectedSkillIds: [],
        steps: [{
          id: "extract-document-facts",
          objective: "Read the uploaded document and make its facts reusable.",
          dependencies: [],
          skillIds: [],
          role: "fact_acquisition",
          requiredCapabilities: ["uploaded_source_read"],
          sourceConstraint: { requiredUploadedSourceIds: [sourceId] },
          evidenceContract: {
            requiredKinds: ["source_summary", "structured_extraction_artifact", "explicit_caveats"],
            caveatPolicy: "mark_unverified_facts",
          },
          successCriteria: [{ id: "facts", description: "Document facts are available.", source: "planner" }],
        }],
      },
      availableSkills: [],
      availableToolNames: new Set(tools.map((tool) => tool.name)),
      availableTools: tools,
      availableCapabilities: capabilities,
      availableUploadedSourceIds: [sourceId],
    }),
    (error: unknown) => error instanceof AppError
      && /bound capabilities cannot produce: structured_extraction_artifact/.test(error.message),
  );
});

test("visible directory IDs bind visible tools without entering the ToolSource namespace", () => {
  const directoryId = "visible_dir_1";
  const proposal: PlanProposal = {
    goal: "Summarize the selected visible directory.",
    selectedSkillIds: [],
    steps: [{
      id: "index-visible-directory",
      objective: "Index the selected visible directory and summarize its contents.",
      dependencies: [],
      skillIds: [],
      role: "fact_acquisition",
      requiredCapabilities: ["visible_directory_read"],
      sourceConstraint: { requiredVisibleDirectoryIds: [directoryId] },
      evidenceContract: {
        requiredKinds: ["source_summary", "explicit_caveats"],
        caveatPolicy: "mark_unverified_facts",
      },
      successCriteria: [
        { id: "source_summary", description: "Directory evidence is available.", source: "planner" },
        { id: "explicit_caveats", description: "Directory caveats are explicit when needed.", source: "planner" },
      ],
    }],
  };
  const input = {
    availableSkills: [],
    availableToolNames: new Set(["visible_read_file"]),
    availableTools: [{ name: "visible_read_file", description: "Read an authorized visible directory file." }],
    availableVisibleDirectoryIds: [directoryId],
  };

  const admitted = admitPlan({ runId: "visible-directory-binding", proposal, ...input });
  assert.deepEqual(admitted.steps[0]?.executionBinding.resolvedToolNames, ["visible_read_file"]);
  assert.deepEqual(admitted.steps[0]?.executionBinding.requiredVisibleDirectoryIds, [directoryId]);
  assert.equal(admitted.steps[0]?.executionBinding.requiredToolSourceIds, undefined);
  assert.throws(
    () => admitPlan({ runId: "visible-directory-binding-unknown", proposal, ...input, availableVisibleDirectoryIds: [] }),
    (error: unknown) => error instanceof AppError && /requires unavailable visible directory/.test(error.message),
  );
});

test("visible directory Plan bindings narrow step context and persist the Run snapshot", async () => {
  const database = new AppDatabase(":memory:");
  const first = await fs.mkdtemp(join(tmpdir(), "agentloop-visible-bound-first-"));
  const second = await fs.mkdtemp(join(tmpdir(), "agentloop-visible-bound-second-"));
  try {
    const skills = new SkillService(database);
    const owner = testOwner();
    let executionContext = "";
    const planner: Planner = {
      plan: async (task) => ({
        goal: "Summarize only the first visible directory.",
        selectedSkillIds: [],
        steps: [{
          id: "summarize-first-directory",
          objective: "Summarize only the first authorized directory.",
          dependencies: [],
          skillIds: [],
          role: "deliver",
          requiredCapabilities: ["visible_directory_read"],
          sourceConstraint: { requiredVisibleDirectoryIds: [task.visibleDirectories![0]!.id] },
          evidenceContract: { requiredKinds: ["delivery_receipt"], caveatPolicy: "none" },
          successCriteria: [{ id: "delivery_receipt", description: "The directory summary is delivered.", source: "planner" }],
        }],
      }),
    };
    const model: ModelAdapter = {
      limits: TEST_MODEL_LIMITS,
      complete: async (request) => {
        if (request.phase === "execution") executionContext = request.runtimeContext?.content ?? "";
        return { content: "The first directory summary was delivered.", finishReason: "stop", toolCalls: [] };
      },
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
      assessorFactory: () => approvingTestAssessor(),
    });

    const run = await runs.execute(owner.user.id, "只总结第一个目录", { visibleDirectories: [first, second] });

    assert.equal(run.status, "completed");
    assert.match(executionContext, /visible_dir_1/);
    assert.doesNotMatch(executionContext, /visible_dir_2/);
    const persisted = await new RunRepository(database).visibleDirectoriesForRun(run.id);
    assert.deepEqual(persisted.map((directory) => directory.path), [await fs.realpath(first), await fs.realpath(second)]);
    const started = (await runs.events(owner.user.id, run.id)).find((event) => event.type === "plan.step.started");
    assert.deepEqual((started?.data.executionBinding as { requiredVisibleDirectoryIds?: string[] } | undefined)?.requiredVisibleDirectoryIds, ["visible_dir_1"]);
  } finally {
    await fs.rm(first, { recursive: true, force: true });
    await fs.rm(second, { recursive: true, force: true });
    await database.close();
  }
});

test("ModelPlanner keeps Skill-owned QA evidence out of generic evidence contracts", async () => {
  let calls = 0;
  let planningContext = "";
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      planningContext = request.runtimeContext?.content ?? "";
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall(`plan-${calls}`, {
          goal: "analyze spreadsheet and deliver markdown",
          steps: [{
            id: "analyze-and-report",
            objective: "Read the visible XLSX data, compare it, and deliver a Markdown analysis report.",
            dependencies: [],
            role: "produce",
            skillIds: [],
            requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"],
            evidenceContract: {
              requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance", "format_matches_request", "basic_navigation"],
              caveatPolicy: "none",
            },
          }],
        })],
      };
    },
  });

  const plan = await planner.plan({
    runId: "run-skill-owned-qa-evidence",
    input: "分析目录下面的 xlsx 数据，形成 markdown 报告",
    availableSkills: [],
    availableToolNames: ["computer_run_command", "computer_write_file", "verify_artifact_acceptance"],
  });

  assert.equal(calls, 1);
  assert.doesNotMatch(planningContext, /"basic_navigation"/);
  assert.deepEqual(plan.steps[0].evidenceContract, {
    requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance", "format_matches_request"],
    caveatPolicy: "none",
  });
});

test("Plan admission adds artifact acceptance Tool when the evidence contract requires it", () => {
  const proposal: PlanProposal = {
    goal: "build and verify an artifact",
    selectedSkillIds: [],
    steps: [{
      id: "build-artifact",
      objective: "Create a PDF artifact and record acceptance evidence.",
      dependencies: [],
      skillIds: [],
      requiredCapabilities: ["workspace_artifact_write"],
      evidenceContract: {
        requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance"],
        caveatPolicy: "none",
      },
      successCriteria: [{ id: "artifact_acceptance", description: "Acceptance receipt is recorded.", source: "planner" }],
    }],
  };

  const admitted = admitPlan({
    runId: "run-artifact-acceptance-admission",
    proposal,
    availableSkills: [],
    availableToolNames: new Set(["computer_write_file", "verify_artifact_acceptance"]),
  });

  assert.deepEqual(admitted.steps[0].requiredCapabilities, ["workspace_artifact_write", "artifact_acceptance"]);
  assert.deepEqual(admitted.steps[0].executionBinding.resolvedToolNames, ["computer_write_file", "verify_artifact_acceptance"]);
});

test("Plan admission normalizes Skill-owned QA evidence out of Runtime evidence contracts", () => {
  const proposal: PlanProposal = {
    goal: "build and verify an artifact",
    selectedSkillIds: [],
    steps: [{
      id: "build-artifact",
      objective: "Create an HTML artifact and record acceptance evidence.",
      dependencies: [],
      skillIds: [],
      requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"],
      evidenceContract: {
        requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance", "basic_navigation"],
        caveatPolicy: "none",
      },
      successCriteria: [{ id: "artifact_acceptance", description: "Acceptance receipt is recorded.", source: "planner" }],
    }],
  };

  const admitted = admitPlan({
    runId: "run-qa-evidence-admission",
    proposal,
    availableSkills: [],
    availableToolNames: new Set(["computer_write_file", "verify_artifact_acceptance"]),
  });

  assert.deepEqual(admitted.steps[0].evidenceContract?.requiredKinds, [
    "artifact_path",
    "artifact_non_empty",
    "artifact_acceptance",
  ]);
});

test("Plan admission retains source-only evidence without making delivery audit a completion gate", () => {
  const proposal: PlanProposal = {
    goal: "summarize uploaded source",
    selectedSkillIds: [],
    steps: [{
      id: "summarize-source",
      objective: "Read the uploaded source and produce a user-facing summary.",
      dependencies: [],
      role: "produce",
      skillIds: [],
      requiredCapabilities: ["uploaded_source_read"],
      evidenceContract: {
        requiredKinds: ["source_summary", "explicit_caveats"],
        caveatPolicy: "mark_unverified_facts",
      },
      successCriteria: [
        { id: "source_summary", description: "Source evidence is available.", source: "planner" },
        { id: "explicit_caveats", description: "Caveats are recorded.", source: "planner" },
      ],
    }],
  };

  const admitted = admitPlan({
    runId: "run-source-only-produce-admission",
    proposal,
    availableSkills: [],
    availableToolNames: new Set(["read_source"]),
  });

  assert.deepEqual(admitted.steps[0].evidenceContract?.requiredKinds, [
    "source_summary",
    "explicit_caveats",
  ]);
  assert.equal(admitted.steps[0].successCriteria.some((criterion) => criterion.id === "delivery_receipt"), false);
});

test("Plan admission leaves acquisition source evidence contracts source-only", () => {
  const proposal: PlanProposal = {
    goal: "collect uploaded source facts",
    selectedSkillIds: [],
    steps: [{
      id: "read-source",
      objective: "Read the uploaded source as evidence for a later step.",
      dependencies: [],
      role: "fact_acquisition",
      skillIds: [],
      requiredCapabilities: ["uploaded_source_read"],
      evidenceContract: {
        requiredKinds: ["source_summary", "explicit_caveats"],
        caveatPolicy: "mark_unverified_facts",
      },
      successCriteria: [
        { id: "source_summary", description: "Source evidence is available.", source: "planner" },
        { id: "explicit_caveats", description: "Caveats are recorded.", source: "planner" },
      ],
    }],
  };

  const admitted = admitPlan({
    runId: "run-source-acquisition-admission",
    proposal,
    availableSkills: [],
    availableToolNames: new Set(["read_source"]),
  });

  assert.deepEqual(admitted.steps[0].evidenceContract?.requiredKinds, [
    "source_summary",
    "explicit_caveats",
  ]);
  assert.equal(admitted.steps[0].successCriteria.some((criterion) => criterion.id === "delivery_receipt"), false);
});

test("Plan admission normalizes conversation-only data analysis final leaves away from artifact gates", () => {
  const proposal: PlanProposal = {
    goal: "analyze structured table data and reply",
    selectedSkillIds: [],
    steps: [{
      id: "profile-visible-tables",
      objective: "Extract structured table evidence from visible spreadsheet files.",
      dependencies: [],
      role: "fact_acquisition",
      skillIds: [],
      requiredCapabilities: ["visible_directory_read"],
      evidenceContract: {
        requiredKinds: ["source_summary", "schema_summary", "record_counts", "structured_extraction_artifact", "explicit_caveats"],
        caveatPolicy: "mark_unverified_facts",
      },
      successCriteria: [
        { id: "source_summary", description: "Source evidence is available.", source: "planner" },
        { id: "schema_summary", description: "Schema evidence is available.", source: "planner" },
        { id: "record_counts", description: "Record counts are available.", source: "planner" },
        { id: "structured_extraction_artifact", description: "A structured extraction artifact is available.", source: "planner" },
        { id: "explicit_caveats", description: "Caveats are explicit.", source: "planner" },
      ],
    }, {
      id: "deliver-analysis-reply",
      objective: "Use the structured evidence to answer the user's analysis request in the conversation.",
      dependencies: ["profile-visible-tables"],
      role: "produce",
      skillIds: [],
    requiredCapabilities: ["workspace_artifact_write"],
      evidenceContract: {
        requiredKinds: ["artifact_path", "artifact_non_empty", "format_matches_request", "delivery_receipt", "explicit_caveats"],
        caveatPolicy: "mark_unverified_facts",
      },
      successCriteria: [
        { id: "artifact_path", description: "A delivered artifact path is recorded.", source: "planner" },
        { id: "artifact_non_empty", description: "The delivered artifact is non-empty.", source: "planner" },
        { id: "format_matches_request", description: "The artifact format matches the request.", source: "planner" },
        { id: "delivery_receipt", description: "The final answer is delivered.", source: "planner" },
        { id: "explicit_caveats", description: "Caveats are explicit.", source: "planner" },
      ],
    }],
  };

  const admitted = admitPlan({
    runId: "run-conversation-data-analysis-admission",
    proposal,
    availableSkills: [],
    availableToolNames: new Set(["visible_index_directory", "visible_extract_tables", "computer_read_file"]),
    taskIntent: { deliverySurface: "conversation", artifactKind: "none" },
  });

  assert.deepEqual(admitted.steps[0].evidenceContract?.requiredKinds, [
    "source_summary",
    "schema_summary",
    "record_counts",
    "structured_extraction_artifact",
    "explicit_caveats",
  ]);
  assert.equal(admitted.steps[1].evidenceContract, undefined);
  assert.deepEqual(admitted.steps[1].successCriteria.map((criterion) => criterion.id), [
    "delivery_receipt",
  ]);
});

test("Plan admission reuses completed source evidence for a conversation terminal leaf", () => {
  const proposal: PlanProposal = {
    goal: "assess an uploaded project document in the conversation",
    selectedSkillIds: [],
    steps: [{
      id: "acquire-project-facts",
      objective: "Read the uploaded source and record bounded project facts and missing data.",
      dependencies: [],
      role: "fact_acquisition",
      skillIds: [],
      requiredCapabilities: ["uploaded_source_read"],
      evidenceContract: {
        requiredKinds: ["source_summary", "explicit_caveats"],
        caveatPolicy: "mark_unverified_facts",
      },
      successCriteria: [
        { id: "source_summary", description: "Source facts are available.", source: "planner" },
        { id: "explicit_caveats", description: "Source gaps are explicit.", source: "planner" },
      ],
    }, {
      id: "deliver-assessment",
      objective: "Use the acquired facts to provide a user-facing assessment.",
      dependencies: ["acquire-project-facts"],
      role: "produce",
      skillIds: [],
      requiredCapabilities: [],
      evidenceContract: {
        requiredKinds: ["source_summary", "explicit_caveats"],
        caveatPolicy: "mark_unverified_facts",
      },
      successCriteria: [
        { id: "source_summary", description: "Source facts are available.", source: "planner" },
        { id: "explicit_caveats", description: "Source gaps are explicit.", source: "planner" },
      ],
    }],
  };

  const admitted = admitPlan({
    runId: "run-reuse-source-evidence",
    proposal,
    availableSkills: [],
    availableToolNames: new Set(["read_source"]),
    taskIntent: { deliverySurface: "conversation", artifactKind: "none" },
  });

  assert.deepEqual(admitted.steps[0]?.evidenceContract?.requiredKinds, ["source_summary", "explicit_caveats"]);
  assert.equal(admitted.steps[1]?.evidenceContract, undefined);
  assert.deepEqual(admitted.steps[1]?.successCriteria.map((criterion) => criterion.id), ["conversation_delivery"]);
  assert.deepEqual(admitted.steps[1]?.executionBinding.evidenceKinds, []);
});

test("Plan admission preserves artifact gates for workspace artifact delivery", () => {
  const proposal: PlanProposal = {
    goal: "write a source-grounded report file",
    selectedSkillIds: [],
    steps: [{
      id: "write-report",
      objective: "Create a Markdown report file from the extracted data.",
      dependencies: [],
      role: "produce",
      skillIds: [],
      requiredCapabilities: ["workspace_artifact_write"],
      evidenceContract: {
        requiredKinds: ["artifact_path", "artifact_non_empty", "format_matches_request", "delivery_receipt"],
        caveatPolicy: "none",
      },
      successCriteria: [
        { id: "artifact_path", description: "A delivered artifact path is recorded.", source: "planner" },
        { id: "artifact_non_empty", description: "The delivered artifact is non-empty.", source: "planner" },
        { id: "format_matches_request", description: "The artifact format matches the request.", source: "planner" },
        { id: "delivery_receipt", description: "The final artifact is delivered.", source: "planner" },
      ],
    }],
  };

  const admitted = admitPlan({
    runId: "run-workspace-artifact-admission",
    proposal,
    availableSkills: [],
    availableToolNames: new Set(["computer_write_file"]),
    taskIntent: { deliverySurface: "workspace_artifact", artifactKind: "document" },
  });

  assert.deepEqual(admitted.steps[0].evidenceContract?.requiredKinds, [
    "artifact_path",
    "artifact_non_empty",
    "format_matches_request",
  ]);
});

test("ModelPlanner accepts paginated HTML materialization as a file-producing artifact plan", async () => {
  const planner = new ModelPlanner(new StaticModel({
    content: "",
    finishReason: "tool_calls",
    toolCalls: [submitOutcomePlanToolCall("plan", {
      goal: "build and verify an HTML-PPT from a structured paginated HTML spec",
      steps: [{
        id: "materialize-paginated-html",
        objective: "Materialize the requested HTML-PPT from a structured paginated HTML specification and record unified artifact acceptance evidence.",
        dependencies: [],
        role: "produce",
        skillIds: [],
        requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"],
        evidenceContract: {
          requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance"],
          caveatPolicy: "none",
        },
      }],
    })],
  }));

  const plan = await planner.plan({
    runId: "run-paginated-html-materializer-plan",
    input: "帮我做一个培训材料，html-ppt 格式",
    availableSkills: [],
    availableToolNames: ["materialize_paginated_html", "verify_artifact_acceptance"],
  });

  assert.deepEqual(plan.steps[0].requiredCapabilities, ["workspace_artifact_write", "artifact_acceptance"]);
  assert.deepEqual(plan.steps[0].evidenceContract, {
    requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance"],
    caveatPolicy: "none",
  });
});

test("ModelPlanner does not make materialized page specs the generic HTML artifact default", async () => {
  let planningContext = "";
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      planningContext = request.runtimeContext?.content ?? "";
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("ordinary-html-plan", {
          goal: "build a standalone event landing page",
          steps: [{
            id: "build-page",
            objective: "Create the requested standalone HTML page with observable file evidence.",
            dependencies: [],
            role: "produce",
            skillIds: [],
            requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"],
            evidenceContract: {
              requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance"],
              caveatPolicy: "none",
            },
          }],
        })],
      };
    },
  });

  const plan = await planner.plan({
    runId: "run-ordinary-html-page",
    input: "做一个活动宣传网页",
    availableSkills: [],
    availableToolNames: ["computer_write_file", "materialize_paginated_html", "verify_artifact_acceptance"],
  });

  assert.deepEqual(plan.steps[0].requiredCapabilities, ["workspace_artifact_write", "artifact_acceptance"]);
  assert.match(planningContext, /Do not force a structured page-spec producer for generic HTML artifacts/);
  assert.doesNotMatch(planningContext, /For paginated HTML, HTML-PPT, or presentation-style HTML artifacts, prefer a compact structured page specification/);
});

test("checked-in HTML Skills describe page materialization as a capability instead of naming Tools", async () => {
  const skillRoot = resolve(import.meta.dirname, "..", "..", "agentloop-skills", "skills");
  const frontend = await fs.readFile(resolve(skillRoot, "frontend-design", "SKILL.md"), "utf8");
  const webArtifacts = await fs.readFile(resolve(skillRoot, "web-artifacts-builder", "SKILL.md"), "utf8");

  assert.match(frontend, /Use a structured page-materialization capability only when the user or current Plan step explicitly asks for paginated HTML/);
  assert.match(webArtifacts, /Use a structured page-materialization capability only for explicit paginated HTML/);
  assert.doesNotMatch(frontend, /materialize_paginated_html|verify_artifact_acceptance/);
  assert.doesNotMatch(webArtifacts, /materialize_paginated_html|verify_artifact_acceptance|default low-latency path/);
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
      requiredCapabilities: ["workspace_artifact_write"],
      successCriteria: [{ id: "poster-file", description: "A PNG or PDF poster file is generated.", source: "planner" }],
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
  assert.deepEqual(admitted.steps[0].requiredCapabilities, ["workspace_artifact_write", "skill_instruction_load"]);
  assert.deepEqual(admitted.steps[0].executionBinding.resolvedToolNames, ["computer_write_file", "load_skill"]);
});

test("Plan admission keeps tool-backed direct answers text-only when plan wording mentions file output", () => {
  const proposal: PlanProposal = {
    goal: "answer using the available tool",
    selectedSkillIds: [],
    steps: [{
      id: "leaf_direct_answer_tools_used",
      objective: "Use the available lookup Tool and include its file output details in the direct answer.",
      dependencies: [],
      role: "deliver",
      skillIds: [],
      requiredCapabilities: [],
      evidenceContract: {
        requiredKinds: ["artifact_path"],
        caveatPolicy: "none",
      },
      successCriteria: [{
        id: "artifact_path",
        description: "The tool-backed answer includes its file output details.",
        source: "planner",
      }],
    }],
  };

  const admitted = admitPlan({
    runId: "run-direct-answer-tools-used",
    proposal,
    availableSkills: [],
    availableToolNames: new Set(["websearch"]),
    taskIntent: { deliverySurface: "conversation", artifactKind: "none" },
  });

  assert.equal(admitted.steps[0].id, "leaf_direct_answer_tools_used");
  assert.equal(admitted.steps[0].evidenceContract, undefined);
  assert.deepEqual(admitted.steps[0].successCriteria.map((criterion) => criterion.id), ["conversation_delivery"]);
});

test("Plan admission ignores negated file creation in a conversation delivery objective", () => {
  const admitted = admitPlan({
    runId: "run-conversation-no-file-creation",
    proposal: {
      goal: "仅回复用户要求的最小文本",
      selectedSkillIds: [],
      steps: [{
        id: "answer",
        objective: "直接返回非空文本，不调用外部工具或创建文件。",
        dependencies: [],
        role: "deliver",
        skillIds: [],
        requiredCapabilities: [],
        successCriteria: [{
          id: "answered",
          description: "A non-empty answer is returned in the conversation.",
          source: "planner",
        }],
      }],
    },
    availableSkills: [],
    availableToolNames: new Set(["websearch"]),
    taskIntent: { deliverySurface: "conversation", artifactKind: "none" },
  });

  assert.equal(admitted.steps[0].id, "answer");
  assert.deepEqual(admitted.steps[0].requiredCapabilities, ["conversation_delivery"]);
});

test("Plan admission does not infer a file contract from unstructured plan wording", () => {
  const admitted = admitPlan({
    runId: "run-unstructured-file-wording",
    proposal: {
      goal: "answer the question",
      selectedSkillIds: [],
      steps: [{
        id: "leaf_direct_answer_tools_used",
        objective: "Create a direct answer that explains the available tool's file output.",
        dependencies: [],
        role: "deliver",
        skillIds: [],
        requiredCapabilities: [],
        successCriteria: [{
          id: "answered",
          description: "A tool-backed direct answer is returned in the conversation.",
          source: "planner",
        }],
      }],
    },
    availableSkills: [],
    availableToolNames: new Set(["websearch"]),
  });

  assert.equal(admitted.steps[0].id, "leaf_direct_answer_tools_used");
});

test("ModelPlanner admits tool-backed direct answers with incidental file wording in one turn", async () => {
  let planningCalls = 0;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async () => {
      planningCalls += 1;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("direct-answer-tools", {
          goal: "answer using the available lookup tool",
          steps: [{
            id: "leaf_direct_answer_tools_used",
            objective: "Use the available lookup Tool and include its file output details in the direct answer.",
            dependencies: [],
            role: "deliver",
            skillIds: [],
            requiredCapabilities: [],
            evidenceContract: { requiredKinds: ["artifact_path"], caveatPolicy: "none" },
            successCriteria: [{ id: "artifact_path", description: "The tool output details are included in the answer." }],
          }],
        })],
      };
    },
  });

  const plan = await planner.plan({
    runId: "run-direct-answer-tools-planner",
    input: "Use the lookup tool to answer my question directly.",
    availableSkills: [],
    availableToolNames: ["websearch"],
  });

  assert.equal(planningCalls, 1);
  assert.equal(plan.steps[0].evidenceContract, undefined);
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
              requiredCapabilities: [],
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
              requiredCapabilities: [],
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
  assert.match(observedSystemPrompt, /Skill-owned QA/);
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
              requiredCapabilities: ["workspace_artifact_write"],
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

test("ModelPlanner does not infer web research merely because web tools are available", async () => {
  let observedContext = "";
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      observedContext = request.runtimeContext?.content ?? "";
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("plan", {
            goal: "save the prior answer as Markdown",
            selectedSkillIds: [],
            steps: [{
              id: "write-markdown",
              objective: "Generate the requested Markdown file and record its path.",
              dependencies: [],
              skillIds: [],
              requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"],
              successCriteria: [{ id: "artifact_path", description: "The Markdown file path is recorded." }],
            }],
        })],
      };
    },
  });

  await planner.plan({
    runId: "operation-profile-available-web-tools",
    input: "生成一个 markdown 文件吧",
    availableSkills: [],
    availableToolNames: ["websearch", "webfetch", "computer_write_file", "verify_artifact_acceptance"],
  });

  assert.match(observedContext, /artifact_build/);
  assert.doesNotMatch(observedContext, /"operationProfiles":\[\{"id":"web_research"/);
  assert.doesNotMatch(observedContext, /researchPlanningPolicy/);
  assert.doesNotMatch(observedContext, /agentloop\.researchPolicy\/v1/);
});

test("ModelPlanner injects research policy only for source-grounded planning", async () => {
  let observedContext = "";
  let observedSystemPrompt = "";
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      observedContext = request.runtimeContext?.content ?? "";
      observedSystemPrompt = request.systemPrompt;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("research-then-build", {
            goal: "create a DCMM training deck from bounded public source evidence",
            selectedSkillIds: [],
            steps: [{
              id: "research",
              objective: "Collect bounded public source evidence and caveats for DCMM level 4 training.",
              dependencies: [],
              skillIds: [],
              requiredCapabilities: ["web_research"],
              evidenceContract: {
                requiredKinds: ["source_summary", "source_urls", "explicit_caveats"],
                caveatPolicy: "mark_unverified_facts",
              },
            }, {
              id: "build-deck",
              objective: "Build the requested PPTX training deck from the bounded research evidence.",
              dependencies: ["research"],
              skillIds: [],
              requiredCapabilities: ["workspace_artifact_write"],
              evidenceContract: {
                requiredKinds: ["artifact_path", "artifact_non_empty", "format_matches_request"],
                caveatPolicy: "mark_unverified_facts",
              },
            }],
        })],
      };
    },
  });

  await planner.plan({
    runId: "operation-profile-research-policy",
    input: "请检索互联网公开资料，制作 DCMM 四级培训 PPTX，无法核验的内容标注边界。",
    availableSkills: [],
    availableToolNames: ["websearch", "webfetch", "computer_write_file"],
  });

  assert.match(observedContext, /web_research/);
  assert.match(observedContext, /researchPlanningPolicy/);
  assert.match(observedContext, /agentloop\.researchPolicy\/v1/);
  assert.match(observedContext, /"depth":"bounded"/);
  assert.match(observedContext, /"maxSearches":2/);
  assert.match(observedSystemPrompt, /"research":\{"depth":"bounded"/);
});

test("ModelPlanner classifies designed pages as observable artifact delivery intent", async () => {
  let observedContext = "";
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      observedContext = request.runtimeContext?.content ?? "";
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("plan", {
            goal: "build a world cup login homepage artifact",
            selectedSkillIds: [],
            steps: [{
              id: "build-worldcup-login-homepage",
              objective: "Create the requested login homepage as a standalone HTML artifact in the workspace.",
              dependencies: [],
              skillIds: [],
              requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"],
              evidenceContract: {
                requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance"],
                caveatPolicy: "none",
              },
              successCriteria: [{ id: "artifact_path", description: "The generated homepage HTML path is recorded." }],
            }],
        })],
      };
    },
  });

  await planner.plan({
    runId: "operation-profile-designed-page-artifact",
    input: "设计一个足球世界杯的登录首页。",
    availableSkills: [],
    availableToolNames: ["computer_write_file", "verify_artifact_acceptance"],
  });

  assert.match(observedContext, /artifact_build/);
  assert.match(observedContext, /"artifactKind":"html"/);
  assert.match(observedContext, /"deliverySurface":"workspace_artifact"/);
  assert.doesNotMatch(observedContext, /direct_answer/);
});

test("ModelPlanner rejects text-only plans for requested observable artifacts", async () => {
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async () => ({
      content: "",
      finishReason: "tool_calls",
      toolCalls: [submitOutcomePlanToolCall("plan", {
          goal: "answer with page code only",
          selectedSkillIds: [],
          steps: [{
            id: "answer-page-design",
            objective: "Reply with a homepage design and copyable code without creating a file.",
            dependencies: [],
            skillIds: [],
            requiredCapabilities: [],
            evidenceContract: { requiredKinds: ["delivery_receipt"], caveatPolicy: "none" },
            successCriteria: [{ id: "delivery_receipt", description: "The answer exists." }],
          }],
      })],
    }),
  });

  await assert.rejects(
    () => planner.plan({
      runId: "operation-profile-designed-page-text-only-rejected",
      input: "设计一个足球世界杯的登录首页。",
      availableSkills: [],
      availableToolNames: ["computer_write_file", "verify_artifact_acceptance"],
    }),
    (error: unknown) => hasCode(error, "PLANNING_ERROR"),
  );
  await assert.rejects(
    () => planner.plan({
      runId: "operation-profile-designed-page-text-only-without-producer-rejected",
      input: "设计一个足球世界杯的登录首页。",
      availableSkills: [],
      availableToolNames: [],
    }),
    (error: unknown) => hasCode(error, "PLANNING_ERROR"),
  );
});

test("ModelPlanner keeps executable Skill tasks out of direct-answer-only planning profiles", async () => {
  const skill = skillFixture({ id: "frontend-design", name: "frontend-design" });
  let sawExecutableSkillProfiles = false;
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      const context = request.runtimeContext?.content ?? "";
      sawExecutableSkillProfiles = /operationProfiles/.test(context)
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
              requiredCapabilities: ["custom_tool_call"],
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
              requiredCapabilities: ["workspace_artifact_write"],
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
          requiredCapabilities: ["workspace_artifact_write"],
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
      recommendedCapabilities: {
        skillIds: [],
        toolNames: ["computer_write_file"],
      },
      resumeSuggestion: "Continue from prior Run prior-run Plan step build.",
    },
  });

  assert.equal(sawWorkingSet, true);
});

test("ModelPlanner prefers reusable Markdown artifacts over completed delivery text for PDF follow-ups", async () => {
  let observedContext = "";
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      observedContext = request.runtimeContext?.content ?? "";
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("markdown-to-pdf", {
            goal: "export existing Markdown report to PDF",
            steps: [{
              id: "export-pdf",
              objective: "Convert deliverables/report.md to a PDF artifact and verify the PDF acceptance receipt.",
              dependencies: [],
              skillIds: [],
              requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"],
              evidenceContract: {
                requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance", "format_matches_request"],
                caveatPolicy: "none",
              },
            }],
        })],
      };
    },
  });

  await planner.plan({
    runId: "run-followup-markdown-to-pdf",
    input: "把上一轮 markdown 导出 pdf",
    availableSkills: [],
    availableToolNames: ["read_source", "computer_run_command", "verify_artifact_acceptance"],
    sources: [{
      id: "src_sheet",
      originalName: "source.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: ".xlsx",
      byteSize: 4096,
      sha256: "source-hash",
      status: "ready",
      chunkCount: 1,
      truncated: false,
      summary: "Original spreadsheet source that must not become the conversion source.",
    }],
    conversationWorkingSet: {
      schema: "conversation.workset/v1",
      conversationId: "conversation-markdown-pdf",
      runCount: 2,
      planCursors: [{
        runId: "prior-run",
        planId: "prior-plan",
        goal: "Write report",
        status: "completed",
        selectedSkillIds: [],
        steps: [{
          id: "write-report",
          position: 0,
          status: "completed",
          objective: "Write the Markdown report artifact.",
          dependencies: [],
          skillIds: [],
          requiredCapabilities: ["workspace_artifact_write"],
          output: "Completed report summary text. This is only a fallback, not the preferred PDF source.",
        }],
      }],
      reusableArtifacts: [{
        runId: "prior-run",
        path: "deliverables/report.md",
        name: "report.md",
        bytes: 2048,
        mimeType: "text/markdown",
        sourceTool: "computer_write_file",
        sourceToolCallId: "write-report-md",
        sourcePlanStepId: "write-report",
        reusable: true,
      }],
      failedBoundaries: [],
      recommendedCapabilities: {
        skillIds: [],
        toolNames: [],
      },
    },
  });

  assert.match(observedContext, /agentloop\.artifactFollowup\/v1/);
  assert.match(observedContext, /"intent":"convert_artifact"/);
  assert.match(observedContext, /deliverables\/report\.md/);
  assert.match(observedContext, /preferred_artifact_conversion_source/);
  assert.match(observedContext, /completed delivery text only when no reusable artifact/i);
  assert.match(observedContext, /"artifactKind":"document"/);
  assert.match(observedContext, /"deliverySurface":"workspace_artifact"/);
  assert.match(observedContext, /artifact_build/);
  assert.doesNotMatch(observedContext, /"id":"data_analysis"/);
  assert.doesNotMatch(observedContext, /"id":"web_research"/);
});

test("ModelPlanner exposes completed delivery text for follow-up file creation without reusable artifacts", async () => {
  let observedContext = "";
  const planner = new ModelPlanner({
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      observedContext = request.runtimeContext?.content ?? "";
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [submitOutcomePlanToolCall("delivery-text-to-file", {
            goal: "write the prior summary as a Markdown file",
            steps: [{
              id: "write-summary-file",
              objective: "Create a Markdown summary file from the latest completed delivery text and verify the artifact receipt.",
              dependencies: [],
              skillIds: [],
              requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"],
              evidenceContract: {
                requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance", "format_matches_request"],
                caveatPolicy: "mark_unverified_facts",
              },
            }],
        })],
      };
    },
  });

  await planner.plan({
    runId: "run-followup-delivery-text-to-file",
    input: "你倒是生成一个总结文件啊",
    availableSkills: [],
    availableToolNames: ["computer_write_file", "verify_artifact_acceptance"],
    conversationWorkingSet: {
      schema: "conversation.workset/v1",
      conversationId: "conversation-summary-file",
      runCount: 2,
      planCursors: [{
        runId: "prior-run",
        planId: "prior-plan",
        goal: "Summarize source documents",
        status: "completed",
        selectedSkillIds: [],
        steps: [{
          id: "summarize",
          position: 0,
          status: "completed",
          objective: "Summarize the selected source documents.",
          dependencies: [],
          skillIds: [],
          requiredCapabilities: ["visible_directory_read"],
          output: "上轮总结文本：五层架构、外部 Coding Agent 接入、分阶段落地。",
        }],
      }],
      reusableArtifacts: [],
      failedBoundaries: [],
      recommendedCapabilities: {
        skillIds: [],
        toolNames: [],
      },
    },
  });

  assert.match(observedContext, /agentloop\.artifactFollowup\/v1/);
  assert.match(observedContext, /"intent":"create_file_from_delivery_text"/);
  assert.match(observedContext, /上轮总结文本/);
  assert.match(observedContext, /latest completed delivery text/i);
  assert.match(observedContext, /"artifactKind":"document"/);
  assert.match(observedContext, /"deliverySurface":"workspace_artifact"/);
  assert.match(observedContext, /artifact_build/);
  assert.doesNotMatch(observedContext, /"id":"web_research"/);
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
                  requiredCapabilities: ["workspace_artifact_write"],
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
              requiredCapabilities: ["skill_instruction_load", "workspace_artifact_write", "workspace_file_read"],
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
                requiredCapabilities: ["workspace_file_read", "workspace_artifact_write"],
                successCriteria: [{ id: "contract-written", description: "The reusable analysis contract is written." }],
              },
              {
                id: "author-script",
                objective: "Write analyze_scenario.py from the analysis contract and record the expected execution command as delivery evidence.",
                dependencies: ["extract-analysis-contract"],
                skillIds: [],
                requiredCapabilities: ["workspace_file_read", "workspace_artifact_write"],
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
                  requiredCapabilities: ["workspace_artifact_write"],
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
            requiredCapabilities: ["web_research"],
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
            requiredCapabilities: ["skill_instruction_load", "workspace_artifact_write"],
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
                requiredCapabilities: ["web_research"],
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
                requiredCapabilities: ["skill_instruction_load", "workspace_artifact_write", "workspace_file_read"],
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
                requiredCapabilities: ["web_research"],
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
                requiredCapabilities: ["skill_instruction_load", "workspace_artifact_write"],
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
              requiredCapabilities: ["workspace_file_read"],
              successCriteria: [{ id: "sources-profiled", description: "Source facts and gaps are recorded." }],
            },
            {
              id: "write_report",
              objective: "Write the requested report from the inspected source facts and confirm the report file can be read locally.",
              dependencies: ["inspect_sources"],
              skillIds: [],
              requiredCapabilities: ["workspace_artifact_write", "workspace_file_read"],
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
      requiredCapabilities: ["workspace_file_read", "workspace_artifact_write"],
      evidenceContract: {
        requiredKinds: ["artifact_path", "artifact_non_empty", "format_matches_request", "delivery_receipt"],
        caveatPolicy: "none",
      },
      successCriteria: [
        { id: "artifact_path", description: "The generated script path is recorded.", source: "planner" },
        { id: "artifact_non_empty", description: "The generated script is non-empty.", source: "planner" },
        { id: "format_matches_request", description: "The generated script format matches the request.", source: "planner" },
        { id: "delivery_receipt", description: "The delivery receipt identifies the final result.", source: "planner" },
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
        requiredCapabilities: ["visible_directory_read", "workspace_artifact_write"],
        successCriteria: [
          { id: "sc_1_source", description: "确认设计稿的准确文件路径，并读取与游戏介绍相关的正文内容。", source: "planner" },
          { id: "sc_1_outline", description: "在工作区生成非空的结构化提纲文件，明确建议页序、逐页核心信息、设计稿依据和氛围表达线索，且不虚构关键设定。", source: "planner" },
        ],
      },
      {
        id: "step_2_author_deck_workspace",
        objective: "依据结构化提纲和 presentation-skill 的制作规范，创建可复现的演示文稿工作区与逐页可编辑源文件，落实统一的暗色、高对比、压迫感构图和克制留白。",
        dependencies: ["step_1_extract_source_outline"],
        skillIds: [skill.id],
        requiredCapabilities: ["skill_instruction_load", "workspace_file_read", "workspace_artifact_write"],
        successCriteria: [
          { id: "sc_2_workspace", description: "工作区包含非空、可复现的演示文稿源文件与必要配置，并由写入或命令回执确认创建。", source: "planner" },
          { id: "sc_2_content", description: "逐页源内容覆盖游戏定位、背景故事、玩法机制、关键角色或场景和核心卖点，且与提纲中的设计稿依据一致。", source: "planner" },
          { id: "sc_2_visual_system", description: "源文件明确并统一应用悬疑惊悚视觉系统，包括色彩、字体层级、版式节奏和关键视觉元素规则。", source: "planner" },
        ],
      },
      {
        id: "step_3_generate_editable_pptx",
        objective: "从已完成的演示文稿源文件生成可编辑的游戏介绍 .pptx，不在此步骤进行视觉验收或内容重构。",
        dependencies: ["step_2_author_deck_workspace"],
        skillIds: [skill.id],
        requiredCapabilities: ["skill_instruction_load", "workspace_artifact_write", "workspace_file_read"],
        successCriteria: [
          { id: "sc_3_artifact", description: "工作区内生成目标 .pptx，工具回执确认文件存在且大小非零。", source: "planner" },
          { id: "sc_3_parse", description: "生成流程正常结束，且输出可被演示文稿工具链解析并报告有效页数。", source: "planner" },
          { id: "sc_3_editable", description: "交付物为可编辑的 PowerPoint 文件，而非仅由整页位图组成的静态预览。", source: "planner" },
        ],
      },
      {
        id: "step_4_render_and_inspect",
        objective: "按 presentation-skill 的验证流程渲染已生成的 PPT，并对页面完整性、可读性、溢出、越界、遮挡、异常空白及整体悬疑惊悚风格一致性进行检查，形成明确的质量检查结果。",
        dependencies: ["step_3_generate_editable_pptx"],
        skillIds: [skill.id],
        requiredCapabilities: ["skill_instruction_load", "workspace_artifact_write", "workspace_file_read"],
        successCriteria: [
          { id: "sc_4_render", description: "生成整套幻灯片的渲染预览或等效验证输出，渲染页数与 PPT 页数一致。", source: "planner" },
          { id: "sc_4_report", description: "形成可观察的检查结果，逐项标明是否存在文字溢出、元素越界、严重遮挡、异常空白、不可读内容或风格断裂，并定位任何问题页。", source: "planner" },
          { id: "sc_4_content_check", description: "检查结果确认各页主要信息与结构化提纲对应，未发现关键内容缺页或明显错置。", source: "planner" },
        ],
      },
      {
        id: "step_5_finalize_delivery",
        objective: "依据质量检查结果对源文件实施必要的定点修正，重新生成并复验最终版本；若检查无问题，则保留现有版本并完成最终交付确认。",
        dependencies: ["step_4_render_and_inspect"],
        skillIds: [skill.id],
        requiredCapabilities: ["skill_instruction_load", "workspace_file_read", "workspace_artifact_write"],
        successCriteria: [
          { id: "sc_5_quality", description: "最终复验未发现文字溢出、元素越界、严重遮挡、异常空白或明显不可读页面，且悬疑惊悚视觉表达在全套页面中保持一致。", source: "planner" },
          { id: "sc_5_integrity", description: "最终 PPT 可正常解析和渲染，页数与最终预览一致。", source: "planner" },
          { id: "sc_5_delivery", description: "确认最终可编辑 .pptx 的工作区路径、存在性和非零大小，并保留最终渲染或等效验证证据。", source: "planner" },
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
      requiredCapabilities: ["workspace_file_read", "workspace_artifact_write"],
      evidenceContract: {
        requiredKinds: ["artifact_path", "artifact_non_empty", "format_matches_request", "delivery_receipt"],
        caveatPolicy: "none",
      },
      successCriteria: [
        { id: "artifact_path", description: "报告文件路径已记录。", source: "planner" },
        { id: "artifact_non_empty", description: "报告文件非空。", source: "planner" },
        { id: "format_matches_request", description: "报告格式符合请求。", source: "planner" },
        { id: "delivery_receipt", description: "交付回执标识最终结果。", source: "planner" },
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
      requiredCapabilities: ["workspace_file_read", "workspace_artifact_write"],
      evidenceContract: {
        requiredKinds: ["source_summary", "explicit_caveats", "delivery_receipt"],
        caveatPolicy: "mark_unverified_facts",
      },
      successCriteria: [
        { id: "source_summary", description: "结构化证据摘要可用于后续报告写作。", source: "planner" },
        { id: "explicit_caveats", description: "无法确认的数据边界被明确标注。", source: "planner" },
        { id: "delivery_receipt", description: "证据产物回执已记录。", source: "planner" },
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
              requiredCapabilities: ["workspace_file_read", "workspace_artifact_write"],
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
            requiredCapabilities: ["workspace_file_read", "workspace_artifact_write"],
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
      conversationId: "conversation-recovery-finalization",
      runCount: 1,
      planCursors: [],
      recommendedCapabilities: { skillIds: [], toolNames: ["computer_read_file", "computer_write_file", "computer_run_command"] },
      reusableArtifacts: [],
      failedBoundaries: [{ runId: "prior-run", stepId: "finalize_deck", category: "assessment", message: "quality report failed" }],
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

test("ModelPlanner rejects non-recovery repair leaves after one admission correction turn", async () => {
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
            requiredCapabilities: ["workspace_file_read", "workspace_artifact_write"],
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
  assert.equal(calls, 2);
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
            requiredCapabilities: ["workspace_file_read", "workspace_artifact_write"],
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

    const skills = new SkillService(database);
    const owner = testOwner();
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
            requiredCapabilities: [],
            successCriteria: [{ id: "structured-evidence", description: "A structured extraction artifact exists.", source: "planner" }],
          },
          {
            id: "write-report",
            objective: "Write the final Markdown report from the extraction artifact.",
            dependencies: ["extract-data"],
            skillIds: [],
            requiredCapabilities: ["workspace_artifact_write"],
            successCriteria: [{ id: "report-file", description: "The final Markdown report is produced.", source: "planner" }],
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
      tools: [webSearchFixtureTool(["https://source.test/one"]), webFetchFixtureTool()],
      assessorFactory: () => approvingSkillAssessor(),
    });

    const run = await runs.execute(owner.user.id, "分析 1.xlsx 并生成 Markdown 报告", { allowDangerousTools: true });

    assert.equal(run.status, "completed");
    assert.match(model.firstSystemPrompt, /Do not perform work reserved for a pending downstream Plan step/);
    assert.match(model.firstSystemPrompt, /Use loopStepFrame for model-step continuity/);
    assert.match(model.firstRuntimeContext, /"currentPlanStep":\{"id":"extract-data"/);
    assert.match(model.firstRuntimeContext, /"planStepHandoffFrame":\{"schema":"agentloop\.stepHandoffFrame\/v1","mode":"current_to_next"/);
    assert.match(model.firstRuntimeContext, /"downstreamPlanSteps":\[\{"id":"write-report"/);
    assert.match(model.firstRuntimeContext, /The final Markdown report is produced/);
  } finally {
    database.close();
  }
});

test("RunService injects research policy only into the current source step", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const planner: Planner = {
      plan: async () => ({
        goal: "research and write",
        selectedSkillIds: [],
        steps: [
          {
            id: "research",
            role: "fact_acquisition",
            objective: "Collect bounded public source evidence and caveats.",
            dependencies: [],
            skillIds: [],
            requiredCapabilities: ["web_research"],
            evidenceContract: {
              requiredKinds: ["source_summary", "source_urls", "explicit_caveats"],
              caveatPolicy: "mark_unverified_facts",
            },
            successCriteria: [{ id: "source_summary", description: "A bounded source summary exists.", source: "planner" }],
          },
          {
            id: "write",
            role: "produce",
            objective: "Write the final Markdown summary from the completed research evidence.",
            dependencies: ["research"],
            skillIds: [],
            requiredCapabilities: ["workspace_artifact_write"],
            evidenceContract: {
              requiredKinds: ["artifact_path", "artifact_non_empty", "format_matches_request"],
              caveatPolicy: "mark_unverified_facts",
            },
            successCriteria: [{ id: "artifact_path", description: "The final Markdown file path is recorded.", source: "planner" }],
          },
        ],
      }),
    };
    const model = new ResearchPolicyExecutionContextModel();
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
      tools: [webSearchFixtureTool(["https://source.test/one"]), webFetchFixtureTool()],
      assessorFactory: () => approvingSkillAssessor(),
    });

    const run = await runs.execute(owner.user.id, "基于互联网公开资料生成总结文件", { allowDangerousTools: true });

    assert.equal(run.status, "completed");
    assert.match(model.contexts[0] ?? "", /agentloop\.researchPolicy\/v1/);
    assert.match(model.contexts[0] ?? "", /"maxFetches":5/);
    assert.match(model.systemPrompts[0] ?? "", /"research":\{"depth":"bounded"/);
    assert.doesNotMatch(model.contexts[0] ?? "", /agentloop\.skillArtifactWorkflowDiscipline\/v1/);
    assert.doesNotMatch(model.contexts[1] ?? "", /agentloop\.researchPolicy\/v1/);
    assert.doesNotMatch(model.contexts[1] ?? "", /agentloop\.skillArtifactWorkflowDiscipline\/v1/);
    assert.doesNotMatch(model.systemPrompts[1] ?? "", /"research":/);
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
    requiredCapabilities: step.requiredCapabilities,
  })), [{
    id: "response",
    skillIds: [],
    requiredCapabilities: ["conversation_delivery"],
  }]);
  assert.equal(plan.steps[0]?.evidenceContract, undefined);
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
    agentLoop: agentLoopMetadata(["source_provider"], ["none"], ["dataset"]),
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

test("selectPlanningSkills recalls an API source-provider Skill for Chinese parameter lookup", () => {
  const apiQuery = skillFixture({
    id: "api-query",
    name: "api-query",
    description: "查询 API 目录信息，包括用途、入参、出参和关联数据表。",
    agentLoop: agentLoopMetadata(["source_provider"], ["none"], ["api"], ["local_script"]),
  });
  const exploreData = skillFixture({
    id: "explore-data",
    name: "explore-data",
    description: "Profile and explore a dataset to understand its shape, quality, and patterns.",
    agentLoop: agentLoopMetadata(["source_provider"], ["none"], ["dataset"]),
  });

  const selected = selectPlanningSkills(
    [exploreData, apiQuery],
    "查询宝武集团数据中台中合同备案 API 的参数信息",
    [],
  );

  assert.deepEqual(selected.map((skill) => skill.name), ["api-query"]);
});

test("selectPlanningSkills recalls a Chinese source-provider Skill for an enterprise query", () => {
  const enterpriseInfo = skillFixture({
    id: "enterprise-info",
    name: "enterprise-info",
    description: "查询中国大陆企业工商注册信息、企业详情、统一社会信用代码、法人、注册资本和经营范围。",
    agentLoop: agentLoopMetadata(["source_provider"], ["none"], ["api"]),
  });

  const selected = selectPlanningSkills(
    [enterpriseInfo],
    "查询宝武共享服务有限公司的工商信息和法定代表人",
    [],
  );

  assert.deepEqual(selected.map((skill) => skill.name), ["enterprise-info"]);
});

test("selectPlanningSkills selects a source-provider for current Chinese news without an explicit research keyword", () => {
  const aihot = skillFixture({
    id: "aihot",
    name: "aihot",
    description: "查询 AIHOT 的中文 AI 资讯、精选、当前热点和日报。用户询问今天或最近的 AI 新闻时使用。",
    agentLoop: agentLoopMetadata(["source_provider"], ["none"], ["api"]),
  });

  const selected = selectPlanningSkills([aihot], "今天有什么 AI 热点新闻", []);

  assert.deepEqual(selected.map((skill) => skill.name), ["aihot"]);
});

test("selectPlanningSkills recalls the checked-in presentation Skill for PPTX artifact requests", async () => {
  const inspected = await inspectSkillPackage(resolve(import.meta.dirname, "..", "..", "agentloop-skills", "skills", "presentation-skill"));
  const presentation = skillFixture({
    id: inspected.name,
    name: inspected.name,
    description: inspected.description,
    instructions: inspected.instructions,
    contentHash: inspected.packageHash,
    agentLoop: inspected.agentLoop,
  });
  const xlsx = skillFixture({
    id: "xlsx",
    name: "xlsx",
    description: "Use this skill any time a spreadsheet file is the primary input or output.",
    agentLoop: agentLoopMetadata(["primary_builder"], ["spreadsheet"]),
  });

  const selected = selectPlanningSkills(
    [xlsx, presentation],
    "基于这个设计稿帮我生成一份 pptx ，以一种惊悚，悬疑的风格来推介这个游戏。",
    [],
  );

  assert.deepEqual(inspected.agentLoop, {
    roles: ["primary_builder"],
    artifactKinds: ["presentation"],
    sourceKinds: [],
    qaKinds: [],
  });
  assert.deepEqual(selected.map((skill) => skill.name), ["presentation-skill"]);
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

test("selectPlanningSkills treats spreadsheet repair feedback as an xlsx task", () => {
  const xlsx = skillFixture({
    id: "xlsx",
    name: "xlsx",
    description: "Use this skill any time a spreadsheet file is the primary input or output, including opening, reading, editing, or fixing an existing .xlsx, .xlsm, .csv, or .tsv file.",
    agentLoop: agentLoopMetadata(["primary_builder"], ["spreadsheet"]),
  });
  const docx = skillFixture({
    id: "docx",
    name: "docx",
    description: "Create and edit Word documents.",
    agentLoop: agentLoopMetadata(["primary_builder"], ["document"]),
  });

  const selected = selectPlanningSkills(
    [docx, xlsx],
    "这个 excel 文件里面中文全是乱码",
    [],
  );

  assert.deepEqual(selected.map((skill) => skill.name), ["xlsx"]);
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

test("selectPlanningSkills prefers source-kind compatible HTML builders for uploaded spreadsheets", () => {
  const dashboard = skillFixture({
    id: "dashboard",
    name: "build-dashboard",
    description: "Build an interactive HTML dashboard with charts, filters, and tables from query results or datasets.",
    agentLoop: agentLoopMetadata(["primary_builder"], ["html"], ["dataset"]),
  });
  const projectAssessment = skillFixture({
    id: "project-assessment",
    name: "project-assessment",
    description: "Evaluate project materials and produce structured assessment advice and reports.",
    agentLoop: agentLoopMetadata(["primary_builder", "source_provider"], ["html", "document", "none"], ["document", "rubric"]),
  });

  const selected = selectPlanningSkills(
    [projectAssessment, dashboard],
    "帮我阅读分析这儿 excel，然后形成一份 html 格式的详细场景分析报告",
    [],
    [{
      id: "src_uploaded",
      originalName: "场景清单.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: ".xlsx",
      byteSize: 250_732,
      sha256: "a".repeat(64),
      status: "ready",
      summary: "场景清单.xlsx is a XLSX source with 264 lines.",
      chunkCount: 4,
      truncated: false,
    }],
  );

  assert.deepEqual(selected.map((skill) => skill.name), ["build-dashboard"]);
});

test("ModelPlanner fails closed on invalid OutcomePlan structure after one admission correction turn", async () => {
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
              requiredCapabilities: [],
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
  assert.equal(calls, 2);
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
      assert.match(request.runtimeContext?.content ?? "", /workspace_artifact_write/);
      assert.doesNotMatch(request.runtimeContext?.content ?? "", /computer_write_file/);
      assert.doesNotMatch(request.runtimeContext?.content ?? "", /Create, overwrite, or append to a UTF-8 file/);
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
              requiredCapabilities: ["workspace_artifact_write"],
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
      { name: "computer_write_file", description: "Create, overwrite, or append to a UTF-8 file under the workspace root.", dangerous: true },
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
              requiredCapabilities: [],
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

test("ModelPlanner rejects pure Skill activation leaves after one admission correction turn", async () => {
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
            requiredCapabilities: [],
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

  assert.equal(calls, 2);
});

test("legacy interrupted Runs enter recovery review instead of being terminally failed on restart", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const runId = "interrupted-run";
    await database.prepare(`
      INSERT INTO runs(
        id, owner_user_id, parent_run_id, depth, allow_dangerous_tools,
        status, input, created_at
      ) VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "create an artifact", Date.now() - 120_000);
    const plans = new PlanRepository(database);
    const plan = await plans.create(admitPlan({
      runId,
      proposal: {
        goal: "create an artifact",
        selectedSkillIds: [],
        steps: [step("create-artifact")],
      },
      availableSkills: [],
      availableToolNames: new Set(),
    }));
    await plans.startStep(plan.id, "create-artifact");
    const runs = new RunService({ database, skills, modelFactory: () => new StaticModel({ content: "", toolCalls: [], finishReason: "stop" }) });

    assert.equal(await runs.reconcileInterruptedRuns(), 1);
    assert.equal((await runs.get(owner.user.id, runId)).status, "running");
    assert.equal((await plans.get(plan.id)).status, "running");
    assert.equal((await plans.get(plan.id)).steps[0].status, "running");
    const actions = await runs.actionsForRun(owner.user.id, runId);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].kind, "recovery_review");
    assert.equal(actions[0].state, "recovery_required");
    assert.equal(actions[0].metadata.reason, "legacy_state_incomplete");
    assert.equal((await runs.events(owner.user.id, runId)).at(-1)?.type, "action.recovery_required");
    assert.equal(await runs.reconcileInterruptedRuns(), 0);
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
          requiredCapabilities: [],
          successCriteria: [{ id: "phase-defined", description: "The research phase boundary is explicit.", source: "planner" }],
        },
        {
          ...step("collect-evidence"),
          dependencies: ["research-phase"],
          objective: "Collect durable evidence for the next implementation step.",
          requiredCapabilities: ["workspace_file_read"],
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
          requiredCapabilities: ["workspace_file_read"],
        },
        {
          ...step("implementation-phase"),
          kind: "milestone",
          dependencies: ["collect-evidence"],
          objective: "Implementation phase starts only after evidence collection.",
          requiredCapabilities: [],
        },
        {
          ...step("implement"),
          parentId: "implementation-phase",
          objective: "Implement from collected evidence.",
          requiredCapabilities: ["workspace_file_read"],
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
          requiredCapabilities: ["workspace_file_read"],
        }],
      },
      availableSkills: [],
      availableToolNames: new Set(["computer_read_file"]),
    }),
    (error: unknown) => hasCode(error, "PLAN_NOT_ADMITTED")
      && String((error as Error).message).includes("cannot require execution capabilities"),
  );

  assert.throws(
    () => admitPlan({
      runId: "run-only-milestone",
      proposal: {
        goal: "invalid skeleton",
        selectedSkillIds: [],
        steps: [{ ...step("phase"), kind: "milestone", requiredCapabilities: [] }],
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

    const owner = testOwner();
    const runId = "run-milestone-terminal";
    await database.prepare(`
      INSERT INTO runs(
        id, owner_user_id, parent_run_id, depth, allow_dangerous_tools,
        status, input, created_at
      ) VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "research then build", Date.now());
    const plans = new PlanRepository(database);
    let plan = await plans.create(admitPlan({
      runId,
      proposal: {
        goal: "research then build",
        selectedSkillIds: [],
        steps: [
          { ...step("phase"), kind: "milestone", requiredCapabilities: [] },
          { ...step("build"), dependencies: ["phase"] },
        ],
      },
      availableSkills: [],
      availableToolNames: new Set(),
    }));
    plan = await plans.startStep(plan.id, "build");
    plan = await plans.completeStep(plan.id, "build", "leaf output", {
      candidateOutput: "leaf output",
      toolCalls: [],
      modelSteps: 1,
    });
    await plans.saveAssessment({
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
    const action = await new RuntimeActionRepository(database).requireRecoveryReview({
      runId,
      planId: plan.id,
      stepId: "build",
      reason: "assessment_failed_boundary",
    });
    assert.equal(action.state, "recovery_required");

    await new TerminalCommitter(plans, new RunOutcomeRepository(database)).commitCompleted(runId, plan.id, "leaf output");
    const outcome = await database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
      .get(runId) as { status: string; reason_code: string };
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reason_code, "plan_assessed_and_completed");
    const recoveryState = await database.prepare("SELECT COUNT(*) AS count FROM run_recovery_states WHERE run_id = ?")
      .get(runId) as { count: number };
    assert.equal(recoveryState.count, 0);
  } finally {
    database.close();
  }
});

test("PlanRepository preserves OutcomePlan evidence contracts and assessment failed boundaries", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const owner = testOwner();
    const runId = "evidence-contract-run";
    await database.prepare(`
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
    const plan = await plans.create(admitPlan({
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
          requiredCapabilities: ["workspace_artifact_write"],
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

    assert.deepEqual((await plans.get(plan.id)).steps[0].evidenceContract, evidenceContract);

    const failedBoundary = {
      stepId: "produce-html",
      missingEvidenceKinds: ["artifact_openable"],
      violatedSkillRequirements: [],
      reusableEvidenceRefs: ["write-file"],
      suggestedRepairShape: "repair_leaf" as const,
    };
    await plans.saveAssessment({
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

    assert.deepEqual((await plans.assessments(plan.id))[0].failedBoundary, failedBoundary);
  } finally {
    database.close();
  }
});

test("AppDatabase keeps legacy Plan step tool recommendations as inert history", async () => {
  const filename = join(tmpdir(), `agentloop-plan-tools-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const legacy = new DatabaseSync(filename);
  try {
    legacy.exec(`
      CREATE TABLE plan_steps (
        plan_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        objective TEXT NOT NULL,
        dependencies_json TEXT NOT NULL,
        skill_ids_json TEXT NOT NULL,
        required_tool_names_json TEXT NOT NULL,
        success_criteria_json TEXT NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY(plan_id, step_id)
      );
      INSERT INTO plan_steps(
        plan_id, step_id, position, objective, dependencies_json, skill_ids_json,
        required_tool_names_json, success_criteria_json, status
      ) VALUES (
        'plan-1', 'step-1', 0, 'Produce artifact', '[]', '[]',
        '["computer_write_file"]', '[{"id":"done","description":"done","source":"planner"}]', 'pending'
      );
    `);
  } finally {
    legacy.close();
  }

  const database = new AppDatabase(filename);
  try {
    const columns = await database.prepare("PRAGMA table_info(plan_steps)").all() as unknown as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === "required_tool_names_json"), false);
    assert.equal(columns.some((column) => column.name === "recommended_tool_names_json"), true);
    const row = await database.prepare(`
      SELECT recommended_tool_names_json FROM plan_steps WHERE plan_id = ? AND step_id = ?
    `).get("plan-1", "step-1") as { recommended_tool_names_json: string } | undefined;
    assert.deepEqual(JSON.parse(row?.recommended_tool_names_json ?? "[]"), []);
  } finally {
    await database.close();
    rmSync(filename, { force: true });
  }
});

test("Admission adds only the generic Skill activation Tool to a Skill-bound Step", async () => {
  const skill = skillFixture();
  const plan = admitPlan({
    runId: "run",
    proposal: {
      goal: "verify artifact",
      selectedSkillIds: [skill.id],
      steps: [{ ...step("qa"), skillIds: [skill.id], requiredCapabilities: ["workspace_file_read"] }],
    },
    availableSkills: [skill],
    availableToolNames: new Set(["computer_read_file", "load_skill"]),
  });
  assert.deepEqual(plan.steps[0].requiredCapabilities, ["workspace_file_read", "skill_instruction_load"]);
  assert.deepEqual(plan.steps[0].executionBinding.resolvedToolNames, ["computer_read_file", "load_skill"]);
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
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
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
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
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

test("ModelStepAssessor does not reject satisfied criteria solely for Skill non-adherence", async () => {
  const skill = skillFixture({
    id: "source-skill",
    name: "source-skill",
    instructions: "Use a preferred lookup workflow before answering.",
  });
  const assessor = new ModelStepAssessor(new StaticModel({
    content: "",
    finishReason: "tool_calls",
    toolCalls: [{
      id: "assessment",
      name: "submit_assessment",
      arguments: {
        criteria: [
          { criterionId: "answer-ready", satisfied: true, rationale: "The answer is supported by canonical evidence.", evidenceRefs: ["lookup"] },
        ],
        skills: [{
          skillId: skill.id,
          status: "not_followed",
          followed: false,
          rationale: "The preferred Skill workflow was not independently verified.",
          evidenceRefs: ["candidateOutput"],
        }],
        feedback: "Skill QA was not independently verified.",
        failedBoundary: {
          stepId: "answer",
          missingEvidenceKinds: [],
          violatedSkillRequirements: [`${skill.id}:not_followed`],
          reusableEvidenceRefs: ["candidateOutput"],
          suggestedRepairShape: "repair_leaf",
        },
      },
    }],
  }));
  const assessment = await assessor.assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("answer"),
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
      successCriteria: [{ id: "answer-ready", description: "The answer is supported by canonical evidence.", source: "planner" }],
    },
    skills: [skill],
    evidence: {
      candidateOutput: "Answer is ready.",
      toolCalls: [{ toolCallId: "lookup", toolName: "computer_run_command", isError: false, result: "lookup ok" }],
      modelSteps: 1,
    },
    attempt: 1,
  });

  assert.equal(assessment.approved, true);
  assert.equal(assessment.feedback, "");
  assert.equal(assessment.failedBoundary, undefined);
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
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
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
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
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

test("ModelStepAssessor normalizes long evidence refs without masking failed boundaries", async () => {
  const longRef = `computer_run_command stdoutRef ${"nested/path/".repeat(20)}result.stdout.txt`;
  const assessor = new ModelStepAssessor(new StaticModel({
    content: "",
    finishReason: "tool_calls",
    toolCalls: [{
      id: "assessment",
      name: "submit_assessment",
      arguments: {
        criteria: [
          { criterionId: "artifact_path", satisfied: false, rationale: "No final artifact path was recorded.", evidenceRefs: [longRef] },
          { criterionId: "delivery_receipt", satisfied: true, rationale: "Inline answer is present.", evidenceRefs: ["candidateOutput"] },
        ],
        skills: [],
        feedback: "Artifact path is missing.",
        failedBoundary: {
          stepId: "produce-analysis",
          missingEvidenceKinds: ["artifact_path"],
          violatedSkillRequirements: [],
          reusableEvidenceRefs: [longRef],
          suggestedRepairShape: "repair_leaf",
        },
      },
    }],
  }));

  const assessment = await assessor.assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("produce-analysis"),
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
      evidenceContract: {
        requiredKinds: ["artifact_path", "delivery_receipt"],
        caveatPolicy: "none",
      },
      successCriteria: [
        { id: "artifact_path", description: "Artifact path evidence is present", source: "planner" },
        { id: "delivery_receipt", description: "Delivery receipt evidence is present", source: "planner" },
      ],
    },
    skills: [],
    evidence: {
      candidateOutput: "Inline answer",
      toolCalls: [],
      modelSteps: 1,
    },
    attempt: 1,
  });

  assert.equal(assessment.approved, false);
  assert.deepEqual(assessment.failedBoundary?.missingEvidenceKinds, ["artifact_path"]);
  assert.equal(assessment.failedBoundary?.reusableEvidenceRefs.length, 1);
  assert.ok((assessment.failedBoundary?.reusableEvidenceRefs[0]?.length ?? 0) <= 128);
});

test("RuleBasedStepAssessor derives failed boundaries from rejected evidence contracts", async () => {
  const assessment = await new RuleBasedStepAssessor().assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("produce-html"),
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
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

test("ProfiledRuleStepAssessor does not block Skill-bound lookup completion on unassessed Skill QA", async () => {
  const skill = skillFixture({ id: "discovered:api-query", name: "api-query" });
  const assessment = await new ProfiledRuleStepAssessor("lookup_lite").assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("query-api"),
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
      skillIds: [skill.id],
      requiredCapabilities: ["skill_instruction_load", "workspace_artifact_write", "web_research"],
      successCriteria: [
        { id: "delivery_receipt", description: "A delivery receipt identifies the final user-facing result.", source: "planner" },
        { id: "explicit_caveats", description: "Unavailable or unverified facts are explicitly caveated.", source: "planner" },
      ],
    },
    skills: [skill],
    evidence: {
      candidateOutput: "Found one API catalog candidate with input and output parameters plus explicit caveats.",
      toolCalls: [
        { toolCallId: "load-api-query", toolName: "load_skill", isError: false, result: "loaded api-query" },
        { toolCallId: "query-api-catalog", toolName: "computer_run_command", isError: false, result: "api_catalog_result/v1" },
      ],
      modelSteps: 2,
    },
    attempt: 1,
  });

  assert.equal(assessment.approved, true);
  assert.equal(assessment.feedback, "");
  assert.equal(assessment.skills[0].status, "not_assessed");
  assert.equal(assessment.failedBoundary, undefined);
});

test("evidence-gate rejects an artifact receipt when a source contract is unmet", async () => {
  const assessment = await new ProfiledRuleStepAssessor("evidence_gate").assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("query-api"),
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
      evidenceContract: {
        requiredKinds: ["source_summary", "explicit_caveats"],
        caveatPolicy: "mark_unverified_facts",
      },
      successCriteria: [
        { id: "source_summary", description: "Structured source evidence is present", source: "planner" },
        { id: "explicit_caveats", description: "Source caveats are explicit", source: "planner" },
      ],
    },
    skills: [],
    evidence: {
      candidateOutput: "The API parameters were written into an artifact.",
      toolCalls: [{
        toolCallId: "artifact-receipt",
        toolName: "implementation_detail_is_irrelevant",
        isError: false,
        result: JSON.stringify({
          artifactReceipt: {
            schema: "agentloop.artifactReceipt/v1",
            evidenceKinds: { satisfied: ["artifact_path", "artifact_non_empty"], caveated: [], failed: [] },
          },
        }),
      }],
      modelSteps: 1,
    },
    attempt: 1,
  });

  assert.equal(assessment.approved, false);
  assert.deepEqual(assessment.failedBoundary?.missingEvidenceKinds, ["source_summary", "explicit_caveats"]);
});

test("evidence-gate recognizes source references and caveats embedded in a source receipt", async () => {
  const assessment = await new ProfiledRuleStepAssessor("evidence_gate").assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("query-enterprise"),
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
      evidenceContract: {
        requiredKinds: ["source_summary", "source_urls", "explicit_caveats"],
        caveatPolicy: "mark_unverified_facts",
      },
      successCriteria: [
        { id: "source_summary", description: "Source facts are available.", source: "planner" },
        { id: "source_urls", description: "Source URLs or equivalent references are available.", source: "planner" },
        { id: "explicit_caveats", description: "Source limitations are explicit.", source: "planner" },
      ],
    },
    skills: [],
    evidence: {
      candidateOutput: "The source returned a bounded enterprise record with the stated limitations.",
      toolCalls: [{
        toolCallId: "enterprise-detail",
        toolName: "computer_run_command",
        isError: false,
        result: JSON.stringify({
          evidenceReceipt: {
            schema: "agentloop.toolEvidenceReceipt/v1",
            sourceRefs: [{ uri: "https://example.test/enterprise/detail", title: "Enterprise detail" }],
            caveats: ["The response is a point-in-time record."],
            evidenceKinds: { satisfied: ["source_summary"], caveated: [], failed: [] },
          },
        }),
      }],
      modelSteps: 1,
    },
    attempt: 1,
  });

  assert.equal(assessment.approved, true);
  assert.equal(assessment.feedback, "");
});

test("evidence-gate accepts structured source evidence and semantic caveats", async () => {
  const assessment = await new ProfiledRuleStepAssessor("evidence_gate").assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("query-api"),
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
      evidenceContract: {
        requiredKinds: ["source_summary", "source_urls", "explicit_caveats"],
        caveatPolicy: "mark_unverified_facts",
      },
      successCriteria: [
        { id: "source_summary", description: "Structured source evidence is present", source: "planner" },
        { id: "source_urls", description: "Source URLs are present", source: "planner" },
        { id: "explicit_caveats", description: "Source caveats are explicit", source: "planner" },
      ],
    },
    skills: [],
    evidence: {
      candidateOutput: "已基于当前 API 响应整理结果，并标注范围限制。",
      deliveryCandidate: {
        schema: "agentloop.runtimeDeliveryCandidate/v1",
        output: "已基于当前 API 响应整理结果，并标注范围限制。",
        caveats: ["响应只覆盖当前可用条目。"],
        evidenceKinds: { satisfied: ["source_summary", "source_urls"], caveated: ["explicit_caveats"], failed: [] },
        sourceToolCallIds: ["source-call"],
      },
      toolCalls: [{
        toolCallId: "source-call",
        toolName: "webfetch",
        isError: false,
        result: JSON.stringify({
          schema: "agentloop.webFetch/v1",
          evidenceReceipt: {
            schema: "agentloop.toolEvidenceReceipt/v1",
            evidenceKinds: { satisfied: ["source_summary", "source_urls"], caveated: ["explicit_caveats"], failed: [] },
          },
        }),
      }],
      modelSteps: 1,
    },
    attempt: 1,
  });

  assert.equal(assessment.approved, true);
  assert.equal(assessment.feedback, "");
});

test("RuleBasedStepAssessor accepts source summary receipts for directory analysis evidence gates", async () => {
  const assessment = await new RuleBasedStepAssessor().assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("analyze-directory"),
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
      evidenceContract: {
        requiredKinds: ["source_summary", "explicit_caveats", "delivery_receipt"],
        caveatPolicy: "mark_unverified_facts",
      },
      successCriteria: [
        { id: "source_summary", description: "A structured directory source summary is available.", source: "planner" },
        { id: "explicit_caveats", description: "Coverage caveats are explicitly recorded.", source: "planner" },
        { id: "delivery_receipt", description: "The final response identifies the delivered report.", source: "planner" },
      ],
    },
    skills: [],
    evidence: {
      candidateOutput: "Delivered knowledge analysis report at report.md",
      toolCalls: [{
        toolCallId: "directory-index",
        toolName: "visible_index_directory",
        isError: false,
        result: JSON.stringify({
          schema: "agentloop.sourceSummary/v1",
          evidenceKinds: {
            satisfied: ["source_summary"],
            caveated: ["explicit_caveats"],
            failed: [],
          },
          totalFiles: 999,
          samplePaths: ["KB-0001.md"],
          caveats: ["Directory profile did not read every file body."],
        }),
      }],
      modelSteps: 1,
    },
    attempt: 1,
  });

  assert.equal(assessment.approved, true);
  assert.equal(assessment.feedback, "");
  assert.equal(assessment.criteria.every((criterion) => criterion.satisfied), true);
});

test("ProfiledRuleStepAssessor treats explicit empty caveats as satisfied source caveat evidence", async () => {
  const assessment = await new ProfiledRuleStepAssessor("evidence_gate").assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("profile-tables"),
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
      evidenceContract: {
        requiredKinds: ["source_summary", "schema_summary", "record_counts", "structured_extraction_artifact", "explicit_caveats"],
        caveatPolicy: "mark_unverified_facts",
      },
      successCriteria: [
        { id: "source_summary", description: "Source summary evidence is present.", source: "planner" },
        { id: "schema_summary", description: "Schema evidence is present.", source: "planner" },
        { id: "record_counts", description: "Record count evidence is present.", source: "planner" },
        { id: "structured_extraction_artifact", description: "Structured extraction artifact evidence is present.", source: "planner" },
        { id: "explicit_caveats", description: "Caveat evidence is explicit.", source: "planner" },
      ],
    },
    skills: [],
    evidence: {
      candidateOutput: "Profiled and extracted visible table data with no tool caveats.",
      toolCalls: [{
        toolCallId: "extract-tables",
        toolName: "visible_extract_tables",
        isError: false,
        result: JSON.stringify({
          schema: "agentloop.visibleTableExtraction/v1",
          caveats: [],
          evidenceReceipt: {
            schema: "agentloop.toolEvidenceReceipt/v1",
            sourceType: "visible_table_extraction",
            caveats: [],
            evidenceKinds: {
              satisfied: ["source_summary", "schema_summary", "record_counts", "structured_extraction_artifact"],
              caveated: [],
              failed: [],
            },
          },
        }),
      }],
      modelSteps: 1,
    },
    attempt: 1,
  });

  assert.equal(assessment.approved, true);
  assert.equal(assessment.criteria.find((criterion) => criterion.criterionId === "explicit_caveats")?.satisfied, true);
});

test("ProfiledRuleStepAssessor rejects an artifact that lacks its declared source evidence", async () => {
  const assessment = await new ProfiledRuleStepAssessor("evidence_gate").assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("extract-design"),
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
      evidenceContract: {
        requiredKinds: ["source_summary", "structured_extraction_artifact", "explicit_caveats"],
        caveatPolicy: "mark_unverified_facts",
      },
      successCriteria: [
        { id: "source_summary", description: "The source was summarized.", source: "planner" },
        { id: "structured_extraction_artifact", description: "A structured extraction was produced.", source: "planner" },
        { id: "explicit_caveats", description: "Unknowns are marked.", source: "planner" },
      ],
    },
    skills: [],
    evidence: {
      candidateOutput: "已基于设计稿生成结构化提取 JSON，并标注未覆盖事项。",
      toolCalls: [{
        toolCallId: "write-extraction",
        toolName: "computer_write_file",
        isError: false,
        result: JSON.stringify({
          path: "game-facts.json",
          bytes: 512,
          sha256: "a".repeat(64),
          artifactReceipt: {
            schema: "agentloop.artifactReceipt/v1",
            receiptId: "artifact:game-facts",
            sourceTool: "computer_write_file",
            artifact: { path: "game-facts.json", bytes: 512, characters: 300, totalLines: 12, sha256: "a".repeat(64) },
            inspection: { sha256: "a".repeat(64), characters: 300, totalLines: 12, outline: [], outlineTruncated: false, sampleRangeCount: 1 },
            evidenceKinds: { satisfied: ["artifact_path", "artifact_non_empty"], caveated: [], failed: [] },
            canonicalEvidence: { fullInspectionInToolResult: true },
          },
        }),
      }],
      modelSteps: 1,
    },
    attempt: 1,
  });

  assert.equal(assessment.approved, false);
  assert.deepEqual(assessment.failedBoundary?.missingEvidenceKinds, [
    "source_summary",
    "structured_extraction_artifact",
    "explicit_caveats",
  ]);
});

test("ProfiledRuleStepAssessor accepts artifact receipts from written file evidence gates", async () => {
  const assessment = await new ProfiledRuleStepAssessor("evidence_gate").assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("write-evidence"),
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
      evidenceContract: {
        requiredKinds: ["artifact_path", "artifact_non_empty"],
        caveatPolicy: "none",
      },
      successCriteria: [
        { id: "artifact_path", description: "The evidence artifact path is recorded.", source: "planner" },
        { id: "artifact_non_empty", description: "The evidence artifact is non-empty.", source: "planner" },
      ],
    },
    skills: [],
    evidence: {
      candidateOutput: "Evidence file written to ai_rd_platform_evidence.md",
      toolCalls: [{
        toolCallId: "write-evidence",
        toolName: "computer_write_file",
        isError: false,
        result: JSON.stringify({
          path: "ai_rd_platform_evidence.md",
          bytes: 16624,
          sha256: "12feef3f2b9f67fca7c88bf0d80d2a7d16e50bcb6d5f1ad7d93a5b83364010a3",
          characters: 9586,
          totalLines: 387,
          artifactReceipt: {
            schema: "agentloop.artifactReceipt/v1",
            receiptId: "artifact:test",
            sourceTool: "computer_write_file",
            artifact: {
              path: "ai_rd_platform_evidence.md",
              bytes: 16624,
              characters: 9586,
              totalLines: 387,
              sha256: "12feef3f2b9f67fca7c88bf0d80d2a7d16e50bcb6d5f1ad7d93a5b83364010a3",
            },
            inspection: {
              sha256: "12feef3f2b9f67fca7c88bf0d80d2a7d16e50bcb6d5f1ad7d93a5b83364010a3",
              characters: 9586,
              totalLines: 387,
              outline: [{ line: 1, text: "# AI 研发底座证据汇总" }],
              outlineTruncated: false,
              sampleRangeCount: 2,
            },
            evidenceKinds: {
              satisfied: ["artifact_path", "artifact_non_empty", "artifact_integrity", "artifact_inspection"],
              caveated: [],
              failed: [],
            },
            canonicalEvidence: {
              fullInspectionInToolResult: true,
            },
          },
        }),
      }],
      modelSteps: 1,
    },
    attempt: 1,
    assessmentProfile: "evidence_gate",
  });

  assert.equal(assessment.approved, true);
  assert.equal(assessment.feedback, "");
  assert.deepEqual(assessment.criteria.map((criterion) => [criterion.criterionId, criterion.satisfied]), [
    ["artifact_path", true],
    ["artifact_non_empty", true],
  ]);
});

test("ProfiledRuleStepAssessor treats Skill-owned QA evidence as non-blocking for Runtime gates", async () => {
  const assessment = await new ProfiledRuleStepAssessor("evidence_gate").assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("analyze-and-report"),
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
      evidenceContract: {
        requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance", "format_matches_request", "basic_navigation"],
        caveatPolicy: "none",
      },
      successCriteria: [
        { id: "artifact_path", description: "The delivered report path is recorded.", source: "planner" },
        { id: "artifact_non_empty", description: "The delivered report is non-empty.", source: "planner" },
        { id: "artifact_acceptance", description: "The artifact acceptance receipt is recorded.", source: "planner" },
        { id: "format_matches_request", description: "The delivered report format matches the request.", source: "planner" },
        { id: "basic_navigation", description: "Basic navigation is available when applicable.", source: "planner" },
      ],
    },
    skills: [],
    evidence: {
      candidateOutput: "Delivered performance_analysis_report.md",
      toolCalls: [{
        toolCallId: "verify-report",
        toolName: "verify_artifact_acceptance",
        isError: false,
        result: JSON.stringify({
          schema: "agentloop.artifactAcceptance/v1",
          artifact: { path: "performance_analysis_report.md" },
          verdict: "accepted",
          evidenceKinds: {
            satisfied: ["artifact_path", "artifact_non_empty", "artifact_acceptance", "format_matches_request"],
            caveated: [],
            failed: [],
          },
        }),
      }],
      modelSteps: 1,
    },
    attempt: 1,
    assessmentProfile: "evidence_gate",
  });

  assert.equal(assessment.approved, true);
  assert.equal(assessment.feedback, "");
  assert.equal(assessment.criteria.every((criterion) => criterion.satisfied), true);
});

test("ProfiledRuleStepAssessor uses the latest acceptance for a repaired artifact", async () => {
  const assessment = await new ProfiledRuleStepAssessor("evidence_gate").assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("repair-artifact-acceptance"),
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
      evidenceContract: {
        requiredKinds: ["artifact_acceptance"],
        caveatPolicy: "none",
      },
      successCriteria: [{
        id: "artifact_acceptance",
        description: "The repaired artifact has a valid final acceptance receipt.",
        source: "planner",
      }],
    },
    skills: [],
    evidence: {
      candidateOutput: "Delivered repaired report.html.",
      toolCalls: [{
        toolCallId: "accept-before-repair",
        toolName: "verify_artifact_acceptance",
        isError: false,
        result: JSON.stringify({
          schema: "agentloop.artifactAcceptance/v1",
          artifact: { path: "report.html" },
          verdict: "rejected",
          evidenceKinds: {
            satisfied: [],
            caveated: [],
            failed: ["artifact_acceptance"],
          },
        }),
      }, {
        toolCallId: "accept-after-repair",
        toolName: "verify_artifact_acceptance",
        isError: false,
        result: JSON.stringify({
          schema: "agentloop.artifactAcceptance/v1",
          artifact: { path: "report.html" },
          verdict: "caveated",
          evidenceKinds: {
            satisfied: ["artifact_acceptance"],
            caveated: ["artifact_acceptance"],
            failed: [],
          },
        }),
      }],
      modelSteps: 1,
    },
    attempt: 1,
    assessmentProfile: "evidence_gate",
  });

  assert.equal(assessment.approved, true);
  assert.equal(assessment.criteria[0]?.satisfied, true);
});

test("ProfiledRuleStepAssessor accepts artifact acceptance JSON emitted on command stdout", async () => {
  const assessment = await new ProfiledRuleStepAssessor("evidence_gate").assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("generate-pdf"),
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
      evidenceContract: {
        requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance", "artifact_openable", "format_matches_request"],
        caveatPolicy: "none",
      },
      successCriteria: [
        { id: "artifact_path", description: "The PDF path is recorded.", source: "planner" },
        { id: "artifact_non_empty", description: "The PDF is non-empty.", source: "planner" },
        { id: "artifact_acceptance", description: "The artifact acceptance receipt is recorded.", source: "planner" },
        { id: "artifact_openable", description: "The PDF can be opened.", source: "planner" },
        { id: "format_matches_request", description: "The delivered format is PDF.", source: "planner" },
      ],
    },
    skills: [],
    evidence: {
      candidateOutput: "Delivered report.pdf with command-emitted acceptance evidence.",
      toolCalls: [{
        toolCallId: "verify-by-command",
        toolName: "computer_run_command",
        isError: false,
        result: JSON.stringify({
          exitCode: 0,
          stdout: JSON.stringify({
            schema: "agentloop.artifactAcceptance/v1",
            artifact: "report.pdf",
            verdict: "pass",
            satisfiedEvidenceKinds: [
              "artifact_path",
              "artifact_non_empty",
              "artifact_acceptance",
              "artifact_openable",
              "format_matches_request",
            ],
            failedEvidenceKinds: [],
            caveats: [],
          }),
          stderr: "",
          fileChanges: [],
        }),
      }],
      modelSteps: 1,
    },
    attempt: 1,
    assessmentProfile: "evidence_gate",
  });

  assert.equal(assessment.approved, true);
  assert.equal(assessment.feedback, "");
  assert.equal(assessment.criteria.every((criterion) => criterion.satisfied), true);
});

test("ProfiledRuleStepAssessor rejects incomplete table coverage despite the model claim", async () => {
  const assessment = await new ProfiledRuleStepAssessor("evidence_gate").assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("analyze-table-artifacts"),
      objective: "Summarize all tables in the extracted table artifact and report coverage.",
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
      evidenceContract: {
        requiredKinds: ["source_summary", "schema_summary", "record_counts", "table_coverage", "structured_extraction_artifact", "explicit_caveats"],
        caveatPolicy: "mark_unverified_facts",
      },
      successCriteria: [
        { id: "source_summary", description: "Structured source evidence is present.", source: "planner" },
        { id: "schema_summary", description: "Schema and field summary are present.", source: "planner" },
        { id: "record_counts", description: "Record counts are present.", source: "planner" },
        { id: "table_coverage", description: "All extracted tables are covered by the summary.", source: "planner" },
        { id: "structured_extraction_artifact", description: "A durable structured extraction artifact is present.", source: "planner" },
        { id: "explicit_caveats", description: "Any unverified facts are explicitly caveated.", source: "planner" },
      ],
    },
    skills: [],
    evidence: {
      candidateOutput: "Summarized 3 of 20 tables from the artifact.",
      toolCalls: [{
        toolCallId: "table-summary",
        toolName: "computer_summarize_table_artifact",
        isError: false,
        result: JSON.stringify({
          schema: "agentloop.tableArtifactSummary/v1",
          path: ".agentloop/table-extractions/aa/artifact.json",
          requested: 20,
          returned: 20,
          totalRows: 673,
          totalRecords: 633,
          totalCells: 4012,
          truncated: false,
          tableCount: 20,
          returnedTables: 3,
          tables: [
            { filePath: "a.xlsx", recordsPointer: "/files/0/sheets/0/records", recordCount: 2 },
            { filePath: "b.xlsx", recordsPointer: "/files/1/sheets/0/records", recordCount: 2 },
            { filePath: "c.xlsx", recordsPointer: "/files/2/sheets/0/records", recordCount: 2 },
          ],
          caveats: ["Table artifact summary returned 3 of 20 tables; increase maxTables or use computer_read_json for later table pointers."],
          evidenceReceipt: {
            schema: "agentloop.toolEvidenceReceipt/v1",
            sourceType: "table_artifact_summary",
            receiptId: "table-summary-receipt",
            sourceRefs: [
              { fileIndex: 0, sheetIndex: 0, filePath: "a.xlsx", sheetName: "Scores", recordsPointer: "/files/0/sheets/0/records" },
              { fileIndex: 1, sheetIndex: 0, filePath: "b.xlsx", sheetName: "Scores", recordsPointer: "/files/1/sheets/0/records" },
              { fileIndex: 2, sheetIndex: 0, filePath: "c.xlsx", sheetName: "Scores", recordsPointer: "/files/2/sheets/0/records" },
            ],
            facts: [{ kind: "table_artifact_summary", fullTableCoverage: false, tableCount: 20, returnedTables: 3 }],
            caveats: ["Table artifact summary returned 3 of 20 tables; increase maxTables or use computer_read_json for later table pointers."],
            evidenceKinds: {
              satisfied: ["source_summary", "schema_summary", "record_counts", "structured_extraction_artifact"],
              caveated: ["explicit_caveats"],
              failed: [],
            },
          },
        }),
      }],
      modelSteps: 1,
    },
    attempt: 1,
    assessmentProfile: "evidence_gate",
  });

  assert.equal(assessment.approved, false);
  assert.equal(assessment.criteria.find((criterion) => criterion.criterionId === "table_coverage")?.satisfied, false);
  assert.deepEqual(assessment.failedBoundary?.missingEvidenceKinds, ["table_coverage", "explicit_caveats"]);
});

test("ProfiledRuleStepAssessor does not re-assess the model's interpretation of an aggregation", async () => {
  const assessment = await new ProfiledRuleStepAssessor("evidence_gate").assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("answer-owner-count"),
      objective: "Count records by owner from the structured artifact.",
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
      evidenceContract: {
        requiredKinds: ["derived_aggregation", "explicit_caveats"],
        caveatPolicy: "mark_unverified_facts",
      },
      successCriteria: [
        { id: "derived_aggregation", description: "A complete aggregation is available.", source: "planner" },
        { id: "explicit_caveats", description: "Caveats are explicit.", source: "planner" },
      ],
    },
    skills: [],
    evidence: {
      candidateOutput: "无法确认每位责任人的任务数量。",
      toolCalls: [{
        toolCallId: "aggregate",
        toolName: "computer_aggregate_table_artifact",
        isError: false,
        result: JSON.stringify({
          schema: "agentloop.tableArtifactAggregation/v1",
          coverage: { complete: true, totalTables: 1, totalRecords: 18, truncated: false },
          results: [{ operation: "count", groupBy: "责任人", groups: [{ value: "甲", count: 1 }], complete: true }],
          evidenceReceipt: {
            schema: "agentloop.toolEvidenceReceipt/v1",
            sourceType: "table_artifact_aggregation",
            receiptId: "complete-aggregation",
            sourceRefs: [],
            facts: [{ kind: "table_artifact_aggregation", complete: true }],
            caveats: [],
            evidenceKinds: {
              satisfied: ["derived_aggregation"],
              caveated: [],
              failed: [],
            },
          },
        }),
      }],
      modelSteps: 1,
    },
    attempt: 1,
    assessmentProfile: "evidence_gate",
  });

  assert.equal(assessment.approved, true);
  assert.equal(assessment.criteria.find((criterion) => criterion.criterionId === "derived_aggregation")?.satisfied, true);
  assert.equal(assessment.feedback, "");
});

test("ModelStepAssessor receives candidate projection instead of full long output", async () => {
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
            criteria: [{ criterionId: "delivery_receipt", satisfied: true, rationale: "Projected candidate is non-empty.", evidenceRefs: ["candidateOutput"] }],
            skills: [],
            feedback: "",
          },
        }],
      };
    },
  });
  const longOutput = [
    "# Report",
    "intro",
    "## Section",
    "body ".repeat(900),
    "UNIQUE_FULL_OUTPUT_TAIL_SHOULD_NOT_REACH_ASSESSOR",
  ].join("\n");

  const assessment = await assessor.assess({
    runId: "run",
    planId: "plan",
    step: {
      ...step("deliver"),
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
      successCriteria: [{ id: "delivery_receipt", description: "The final delivery exists.", source: "planner" }],
    },
    skills: [],
    evidence: { candidateOutput: longOutput, toolCalls: [], modelSteps: 1 },
    attempt: 1,
  });

  assert.equal(assessment.approved, true);
  assert.match(observedContext, /agentloop\.candidateProjection\/v1/);
  assert.match(observedContext, /sha256/);
  assert.doesNotMatch(observedContext, /UNIQUE_FULL_OUTPUT_TAIL_SHOULD_NOT_REACH_ASSESSOR/);
});

test("RunService keeps Planner-declared direct-answer leaves rule-assessed without revoking Run tools", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const skills = new SkillService(database);
    const owner = testOwner();
    const model = new PlannedDirectAnswerModel();
    const planner: Planner = {
      plan: async () => ({
        goal: "answer from prior conversation",
        selectedSkillIds: [],
        steps: [{
          id: "direct-answer",
          objective: "直接回答上一轮问题并引用已有来源",
          dependencies: [],
          role: "deliver",
          skillIds: [],
          requiredCapabilities: [],
          successCriteria: [{
            id: "answered",
            description: "A complete answer addresses the user's request.",
            source: "planner",
          }],
        }],
      }),
    };
    const websearch: RuntimeTool<unknown> = {
      name: "websearch",
      description: "Search the web",
      inputSchema: { type: "object" },
      async execute() {
        throw new Error("direct-answer step must not receive websearch");
      },
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
      tools: [websearch],
    });

    const run = await runs.execute(owner.user.id, "你倒是回答啊", { allowDangerousTools: true });

    assert.equal(run.status, "completed");
    assert.equal(model.executionToolCounts.length, 1);
    assert.equal(model.executionToolCounts[0]! > 0, true);
    assert.equal(model.assessmentCalls, 0);
    const detail = await runs.plan(owner.user.id, run.id);
    assert.equal(detail.plan.steps[0].status, "completed");
    assert.equal(detail.assessments[0]?.assessmentProfile, "deterministic");
    assert.equal(detail.assessments[0]?.assessmentMethod, "rule");
    const outcome = await database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
      .get(run.id) as { status: string; reason_code: string };
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reason_code, "plan_assessed_and_completed");
  } finally {
    database.close();
  }
});

test("RunService emits assessment failed boundaries for rejected candidates", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
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
        assess: async (input) => {
          assert.equal(input.evidence.deliveryCandidate?.schema, "agentloop.runtimeDeliveryCandidate/v1");
          return {
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
          };
        },
      }),
      maxSteps: 2,
    });

    const run = await runs.execute(owner.user.id, "produce a delivery receipt");
    const started = (await runs.events(owner.user.id, run.id)).find((event) => event.type === "run.started");
    assert.equal((started?.data as { allowDangerousTools?: boolean } | undefined)?.allowDangerousTools, true);
    const recovery = await waitForRecoveryState(runs, owner.user.id, run.id, "waiting_recovery");
    assert.equal((await runs.get(owner.user.id, run.id)).status, "running");
    assert.equal(recovery.action?.stepId, "test-step");
    assert.deepEqual(recovery.action?.metadata.failedBoundary, failedBoundary);
    const events = await runs.events(owner.user.id, run.id);
    const assessed = events.find((event) => event.type === "skill.compliance.assessed");
    assert.deepEqual((assessed?.data as { failedBoundary?: unknown } | undefined)?.failedBoundary, failedBoundary);
    const boundary = events.find((event) => event.type === "assessment.failed_boundary");
    assert.deepEqual((boundary?.data as { failedBoundary?: unknown } | undefined)?.failedBoundary, failedBoundary);
    assert.equal(events.some((event) => event.type === "run.recovery_required"), true);
  } finally {
    database.close();
  }
});

test("RunService terminally fails source evidence gaps with no acquisition path", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const skills = new SkillService(database);
    const owner = testOwner();
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => new StaticModel({ content: "The requested source was not acquired.", toolCalls: [], finishReason: "stop" }),
      plannerFactory: () => ({
        plan: async () => ({
          goal: "summarize current source material",
          selectedSkillIds: [],
          steps: [{
            id: "summarize-current-source",
            objective: "Summarize the current source material.",
            dependencies: [],
            role: "deliver",
            skillIds: [],
            requiredCapabilities: [],
            evidenceContract: {
              requiredKinds: ["source_summary", "source_urls", "explicit_caveats"],
              caveatPolicy: "mark_unverified_facts",
            },
            successCriteria: [
              { id: "source_summary", description: "A current source summary is recorded.", source: "planner" },
              { id: "source_urls", description: "Source URLs are recorded.", source: "planner" },
            ],
          }],
        }),
      }),
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
            rationale: "No source was acquired.",
            evidenceRefs: [],
          })),
          skills: [],
          evidenceDigest: "no-source-evidence",
          feedback: "No source evidence was acquired.",
          failedBoundary: {
            stepId: input.step.id,
            missingEvidenceKinds: ["source_summary", "source_urls", "explicit_caveats"],
            violatedSkillRequirements: [],
            reusableEvidenceRefs: [],
            suggestedRepairShape: "repair_leaf",
          },
          createdAt: Date.now(),
        }),
      }),
    });

    const run = await runs.execute(owner.user.id, "summarize the current source material");

    assert.equal(run.status, "failed");
    const detail = await runs.plan(owner.user.id, run.id);
    assert.deepEqual(detail.plan.steps[0]?.executionBinding.sourceKinds, ["conversation_workset"]);
    assert.equal(detail.plan.steps[0]?.status, "failed");
    const outcome = await database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
      .get(run.id) as { status: string; reason_code: string };
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.reason_code, "STEP_NOT_COMPLETED");
    const events = await runs.events(owner.user.id, run.id);
    assert.equal(events.some((event) => event.type === "run.failed"), true);
    assert.equal(events.some((event) => event.type === "run.recovery_required"), false);
    assert.equal((await runs.recoveryForRun(owner.user.id, run.id)).state, undefined);
  } finally {
    database.close();
  }
});

test("failedBoundary recovery creates and executes only a targeted repair leaf", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
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
    assert.equal((await runs.get(owner.user.id, run.id)).status, "completed");
    const detail = await runs.plan(owner.user.id, run.id);
    const original = detail.plan.steps.find((step) => step.id === "test-step");
    const repair = detail.plan.steps.find((step) => step.id === "test-step.repair.2");
    assert.notEqual(original?.retiredAt, undefined);
    assert.equal(repair?.role, "repair");
    assert.equal(repair?.status, "completed");
    assert.equal(repair?.evidenceContract, undefined);
    assert.equal(detail.assessments.some((assessment) => assessment.stepId === "test-step" && !assessment.approved), true);
    assert.equal(detail.assessments.some((assessment) => assessment.stepId === "test-step.repair.2" && assessment.approved), true);
    const events = await runs.events(owner.user.id, run.id);
    assert.equal(events.filter((event) => event.type === "recovery.repair_leaf_created").length, 1);
    assert.equal(recovery.decisions[0]?.planRevision?.shape, "recovery_patch");
    const outcome = await database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
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
  assert.deepEqual(plan.steps[0].requiredCapabilities, ["skill_instruction_load"]);
  assert.deepEqual(plan.steps[0].executionBinding.resolvedToolNames, ["load_skill"]);
});

test("Admission allows unbound non-executing support Skills only for recovery patches", () => {
  const sourceSkill = skillFixture({
    id: "source-skill",
    name: "source-skill",
    agentLoop: agentLoopMetadata(["source_provider"], ["none"], ["document"]),
  });
  const builderSkill = skillFixture({
    id: "builder-skill",
    name: "builder-skill",
    agentLoop: agentLoopMetadata(["primary_builder"], ["document"]),
  });
  const recoveryProposal: PlanProposal = {
    goal: "Repair the prior artifact",
    shape: "recovery_patch",
    selectedSkillIds: [sourceSkill.id],
    selectedSkillRoles: [{
      skillId: sourceSkill.id,
      role: "source_provider",
      reason: "Use prior source workflow context while patching.",
    }],
    steps: [{
      ...step("repair-artifact"),
      role: "repair",
      objective: "Patch the artifact using existing source evidence.",
      requiredCapabilities: ["workspace_artifact_write"],
    }],
  };

  const admitted = admitPlan({
    runId: "run-recovery-unbound-source",
    proposal: recoveryProposal,
    availableSkills: [sourceSkill],
    availableToolNames: new Set(["computer_write_file"]),
  });
  assert.deepEqual(admitted.selectedSkillIds, [sourceSkill.id]);
  assert.deepEqual(admitted.steps[0].skillIds, []);

  assert.throws(
    () => admitPlan({
      runId: "run-recovery-unbound-builder",
      proposal: {
        ...recoveryProposal,
        selectedSkillIds: [builderSkill.id],
        selectedSkillRoles: [{
          skillId: builderSkill.id,
          role: "primary_builder",
          reason: "Builder still owns executable production.",
        }],
      },
      availableSkills: [builderSkill],
      availableToolNames: new Set(["computer_write_file"]),
    }),
    (error: unknown) => {
      assert.equal(hasCode(error, "PLAN_NOT_ADMITTED"), true);
      assert.match((error as Error).message, /not bound to any Plan step/);
      return true;
    },
  );
});

test("Admission adds local script execution tools for Skill-bound leaves", () => {
  const skill = skillFixture({
    id: "api-query",
    name: "api-query",
    agentLoop: {
      roles: ["source_provider"],
      artifactKinds: ["none"],
      sourceKinds: ["api"],
      qaKinds: [],
      executionProfiles: ["local_script"],
    },
  });
  const plan = admitPlan({
    runId: "run",
    proposal: {
      goal: "Query API catalog",
      selectedSkillIds: [skill.id],
      selectedSkillRoles: [{
        skillId: skill.id,
        role: "source_provider",
        reason: "Skill metadata declares source_provider for requested source-grounded work.",
      }],
      steps: [{
        ...step("query-api-catalog"),
        objective: "Load and apply the API catalog Skill to answer the requested API parameter query",
        role: "fact_acquisition",
        skillIds: [skill.id],
        requiredCapabilities: [],
        successCriteria: [{
          id: "api-catalog-answer",
          description: "The API catalog query result answers the requested API parameter information.",
          source: "planner",
        }],
      }],
    },
    availableSkills: [skill],
    availableToolNames: new Set(["load_skill", "computer_run_command"]),
  });
  assert.deepEqual(plan.steps[0].requiredCapabilities, ["skill_instruction_load", "workspace_artifact_write"]);
  assert.deepEqual(plan.steps[0].executionBinding.resolvedToolNames, ["load_skill", "computer_run_command"]);
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
        kind: "leaf",
        position: 0,
        status: "running",
        refinementState: "not_refinable",
        requiredFacts: [],
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
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
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
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
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
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
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
  assert.match(observedContext, /Skill QA is not a completion gate/);
  assert.match(observedContext, /process-only Skill gaps/);
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
      kind: "leaf",
      position: 0,
      status: "running",
      refinementState: "not_refinable",
      requiredFacts: [],
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

    const skills = new SkillService(database);
    const owner = testOwner();
    const skill = await skills.create(owner.user.id, {
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
    const detail = await runs.plan(owner.user.id, run.id);
    assert.deepEqual(detail.plan.steps[0].skillIds, [skill.id]);
    assert.equal(detail.assessments.at(-1)?.skills[0].followed, true);
    const events = await runs.events(owner.user.id, run.id);
    assert.equal(events.filter((event) => event.type === "skill.activation.available").length, 1);
    assert.equal(events.filter((event) => event.type === "skill.activated").length, 1);
  } finally {
    database.close();
  }
});

test("Plan-bound Skill instructions can be loaded by selected Skill id", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const skill = await skills.create(owner.user.id, {
      name: "strict-private",
      description: "Private procedure",
      instructions: instructionsWithAgentLoopMetadata("MANDATORY-PRIVATE-INSTRUCTION"),
    });
    const model = new InspectSkillModel(skill.id, /strict-private/);
    const planner: Planner = {
      plan: async () => ({
        goal: "apply selected private procedure",
        selectedSkillIds: [skill.id],
        steps: [{
          id: "apply-private-procedure",
          objective: "Apply the selected private procedure to produce the requested answer.",
          dependencies: [],
          role: "deliver",
          skillIds: [skill.id],
          requiredCapabilities: [],
          evidenceContract: { requiredKinds: ["delivery_receipt"], caveatPolicy: "none" },
          successCriteria: [{ id: "delivery_receipt", description: "The selected Skill was applied to a final answer.", source: "planner" }],
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
    const run = await runs.execute(owner.user.id, "apply private procedure by selected id", {
      allowDangerousTools: true,
    });

    assert.equal(run.status, "completed");
    assert.equal(model.sawInstruction, true);
    assert.equal((await runs.events(owner.user.id, run.id)).filter((event) => event.type === "skill.activated").length, 1);
  } finally {
    database.close();
  }
});

test("Skill-bound artifact execution context carries workspace and evidence discipline", async () => {
  const database = new AppDatabase(":memory:");
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-skill-artifact-workspace-"));
  const imports = await fs.mkdtemp(join(tmpdir(), "agentloop-skill-artifact-imports-"));
  const store = await fs.mkdtemp(join(tmpdir(), "agentloop-skill-artifact-store-"));
  try {
    const source = join(imports, "presentation-skill");
    await fs.mkdir(join(source, "scripts"), { recursive: true });
    await fs.writeFile(join(source, "SKILL.md"), [
      "---",
      "name: presentation-skill",
      'description: "Build editable PowerPoint .pptx decks."',
      "agentloop:",
      "  roles:",
      "    - primary_builder",
      "  artifactKinds:",
      "    - presentation",
      "  sourceKinds: []",
      "  qaKinds: []",
      "---",
      "",
      "# Presentation Skill",
      "",
      "Run package scripts from this Skill root.",
      "",
    ].join("\n"));
    await fs.writeFile(join(source, "scripts/build.py"), "print('ok')\n");
    const expected = await inspectSkillPackage(source);
    const skills = new SkillService(database, { packageStoreRoot: store, allowedImportRoots: [imports] });
    const owner = testOwner();
    const skill = await skills.installFromDirectory(owner.user.id, {
      sourceDirectory: source,
      sourceUrl: "https://example.com/skills/presentation-skill",
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      expectedPackageHash: expected.packageHash,
    });
    const planner: Planner = {
      plan: async () => ({
        goal: "build a training deck",
        selectedSkillIds: [skill.id],
        steps: [{
          id: "build-pptx",
          objective: "Build the requested editable .pptx deck using the presentation Skill.",
          dependencies: [],
          role: "produce",
          skillIds: [skill.id],
          requiredCapabilities: ["skill_instruction_load", "workspace_artifact_write", "artifact_acceptance"],
          evidenceContract: {
            requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance"],
            caveatPolicy: "none",
          },
          successCriteria: [{
            id: "pptx-accepted",
            description: "A non-empty .pptx artifact has acceptance evidence.",
            source: "planner",
          }],
        }],
      }),
    };
    let executionRuntimeContext = "";
    const model: ModelAdapter = {
      limits: TEST_MODEL_LIMITS,
      complete: async (request) => {
        if (request.phase === "execution") executionRuntimeContext = request.runtimeContext?.content ?? "";
        return { content: "deck artifact evidence is ready", finishReason: "stop", toolCalls: [] };
      },
    };
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => model,
      plannerFactory: () => planner,
      assessorFactory: () => approvingTestAssessor(),
    });

    const run = await runs.execute(owner.user.id, "制作一个培训 PPTX", { allowDangerousTools: true });

    assert.equal(run.status, "completed");
    assert.match(executionRuntimeContext, /agentloop\.skillArtifactWorkflowDiscipline\/v1/);
    assert.match(executionRuntimeContext, /"evidenceContract":\{"requiredKinds":\["artifact_path","artifact_non_empty","artifact_acceptance"\]/);
    assert.match(executionRuntimeContext, /If computer_run_command cwd is a read-only @skills\/<name> root/);
    assert.match(executionRuntimeContext, /A relative writable argument passed while cwd is @skills\/<name> resolves under the read-only Skill package/);
    assert.match(executionRuntimeContext, /After the required Skill entrypoint and generated brief\/readiness file are read/);
    assert.match(executionRuntimeContext, /Do not add optional strict QA or fail-on-warning command flags/);
    assert.equal(executionRuntimeContext.includes(workspace), true);
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(imports, { recursive: true, force: true });
    await removeSkillPackage(store).catch(() => undefined);
  }
});

test("unused Plan-bound Skills do not block completion when output criteria are met", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const pptx = await skills.create(owner.user.id, {
      name: "pptx",
      description: "Build PowerPoint decks",
      instructions: "PPTX-WORKFLOW-MUST-BE-FOLLOWED-WHEN-USED",
    });
    const presentation = await skills.create(owner.user.id, {
      name: "presentation-skill",
      description: "Design presentation structure",
      instructions: "PRESENTATION-WORKFLOW-MUST-BE-FOLLOWED-WHEN-USED",
    });
    const theme = await skills.create(owner.user.id, {
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
          requiredCapabilities: ["workspace_file_read"],
          successCriteria: [{ id: "output-ready", description: "The requested output is ready", source: "planner" }],
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
    const detail = await runs.plan(owner.user.id, run.id);
    assert.deepEqual(detail.plan.steps[0].skillIds, [pptx.id, presentation.id, theme.id]);
    assert.equal(detail.assessments.length, 1);
    assert.equal(detail.assessments[0].approved, true);
    assert.deepEqual(detail.assessments[0].skills.map((skill) => skill.skillId), [pptx.id]);
    assert.equal(model.sawPptxInstruction, true);
  } finally {
    database.close();
  }
});

test("Plan step capability binding guides execution without revoking Run-authorized tools", async () => {
  const database = new AppDatabase(":memory:");
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-tool-recommendation-"));
  try {
    await fs.writeFile(join(workspace, "evidence.txt"), "verified evidence\n");

    const skills = new SkillService(database);
    const owner = testOwner();
    const model = new RunAuthorizedCommandModel();
    const planner: Planner = {
      plan: async () => ({
        goal: "read evidence",
        selectedSkillIds: [],
        steps: [{
          ...step("read-evidence"),
          objective: "Read evidence using whatever authorized inspection Tool is needed.",
          requiredCapabilities: ["workspace_file_read"],
          successCriteria: [{ id: "evidence-read", description: "Evidence file is read.", source: "planner" }],
        }],
      }),
    };
    const runs = new RunService({
      database, skills, modelFactory: () => model, plannerFactory: () => planner,
      assessorFactory: () => new RuleBasedStepAssessor(),
      workspaceRoot: workspace,
    });
    const run = await runs.execute(owner.user.id, "read evidence", { allowDangerousTools: true });
    assert.equal(run.status, "completed");
    assert.equal(model.commandToolWasVisible, true);
    assert.equal(model.requestedCommandOutsidePlanBinding, true);
    assert.equal(model.requiredCapabilityWasPresentInContext, true);
    const started = (await runs.events(owner.user.id, run.id)).find((event) => event.type === "plan.step.started");
    const startedData = started?.data as { toolNames?: string[]; requiredCapabilities?: string[] } | undefined;
    assert.equal(Boolean(startedData?.toolNames?.includes("computer_run_command")), true);
    assert.deepEqual(startedData?.requiredCapabilities, ["workspace_file_read"]);
  } finally {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("candidate rejection repair keeps the current leaf objective without revoking Run-authorized tools", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const skill = await skills.create(owner.user.id, {
      name: "downstream-builder",
      description: "Build the downstream artifact",
      instructions: instructionsWithAgentLoopMetadata("Build only in the downstream leaf."),
    });
    const model = new RejectedRepairLeafGrantModel();
    const planner: Planner = {
      plan: async () => ({
        goal: "research then build",
        selectedSkillIds: [skill.id],
        steps: [
          {
            ...step("research"),
            objective: "Produce a bounded research statement.",
            dependencies: [],
            requiredCapabilities: [],
            successCriteria: [{ id: "research-ready", description: "The research statement is bounded.", source: "planner" }],
          },
          {
            ...step("build"),
            objective: "Build the downstream artifact after research is complete.",
            dependencies: ["research"],
            skillIds: [skill.id],
            requiredCapabilities: ["skill_instruction_load"],
            successCriteria: [{ id: "build-ready", description: "The downstream artifact work is complete.", source: "planner" }],
          },
        ],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
      assessorFactory: () => rejectFirstResearchCandidateAssessor(),
      maxSteps: 4,
    });

    const run = await runs.execute(owner.user.id, "research then build");

    assert.equal(run.status, "completed");
    assert.equal(model.sawRepairDirective, true);
    assert.equal(model.runToolVisibleDuringRepair, true);
    const events = await runs.events(owner.user.id, run.id);
    assert.equal(events.some((event) => event.type === "candidate.rejected"), true);
  } finally {
    database.close();
  }
});

test("RunService builds a cross-turn conversation workset from prior persisted facts", async () => {
  const database = new AppDatabase(":memory:");
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-conversation-workset-"));
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const skill = await skills.create(owner.user.id, {
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

    await database.prepare(`
      INSERT INTO conversations(id, owner_user_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(conversationId, owner.user.id, "Deck conversation", now - 20_000, now - 1_000);
    await database.prepare(`
      INSERT INTO runs(
        id, owner_user_id, conversation_id, parent_run_id, depth, allow_dangerous_tools,
        model_key, status, input, output, error_code, created_at, finished_at
      ) VALUES (?, ?, ?, NULL, 0, 1, NULL, 'completed', ?, ?, NULL, ?, ?)
    `).run(olderRunId, owner.user.id, conversationId, "first completed turn", "done", now - 19_000, now - 18_000);
    await database.prepare(`
      INSERT INTO runs(
        id, owner_user_id, conversation_id, parent_run_id, depth, allow_dangerous_tools,
        model_key, status, input, output, error_code, created_at, finished_at
      ) VALUES (?, ?, ?, NULL, 0, 1, NULL, 'failed', ?, NULL, 'MODEL_ERROR', ?, ?)
    `).run(priorRunId, owner.user.id, conversationId, "生成一份游戏推介 PPT", now - 10_000, now - 1_000);
    await database.prepare(`
      INSERT INTO plans(id, run_id, version, goal, selected_skill_ids_json, status, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, 'failed', ?, ?)
    `).run(priorPlanId, priorRunId, "Create a suspense game pitch deck", JSON.stringify([skill.id]), now - 9_000, now - 1_000);
    const insertStep = await database.prepare(`
      INSERT INTO plan_steps(
        plan_id, step_id, position, objective, dependencies_json, skill_ids_json,
        required_capabilities_json, recommended_tool_names_json, execution_binding_json,
        success_criteria_json, status, output, evidence_json, error,
        started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `);
    await insertStep.run(
      priorPlanId,
      "extract",
      0,
      "Extract source-grounded deck outline.",
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify(["workspace_artifact_write"]),
      JSON.stringify([]),
      executionBindingJson({
        requiredCapabilities: ["workspace_artifact_write"],
        resolvedToolNames: ["computer_write_file"],
        sourceKinds: ["workspace_file", "generated_artifact"],
        sideEffect: "workspace_write",
        evidenceKinds: ["source_summary"],
      }),
      JSON.stringify([{ id: "outline", description: "Outline is written.", source: "planner" }]),
      "completed",
      "Created reusable source outline at artifacts/content.md.",
      null,
      now - 8_000,
      now - 7_000,
    );
    await database.prepare("UPDATE plan_steps SET evidence_json = ? WHERE plan_id = ? AND step_id = 'extract'").run(
      JSON.stringify({
        candidateOutput: JSON.stringify({
          schema: "agentloop.sourceSummaryCandidate/v1",
          coveredTopics: ["游戏定位", "目标用户"],
          facts: [{
            claim: "前序研究确认该项目面向企业培训场景，并已形成可供课件生产使用的事实摘要。",
            sourceRefs: [{ sourceRefId: "web:training-source", url: "https://source.test/training" }],
            confidence: "high",
          }],
          missingOrUnverified: ["具体市场规模仍待进一步核验"],
          recommendedNextStep: "produce_deck",
        }),
        toolCalls: [],
        modelSteps: 1,
      }),
      priorPlanId,
    );
    await insertStep.run(
      priorPlanId,
      "build",
      1,
      "Generate the editable PPTX from artifacts/outline.json.",
      JSON.stringify(["extract"]),
      JSON.stringify([skill.id]),
      JSON.stringify(["skill_instruction_load", "workspace_file_read", "workspace_artifact_write"]),
      JSON.stringify([]),
      executionBindingJson({
        requiredCapabilities: ["skill_instruction_load", "workspace_file_read", "workspace_artifact_write"],
        resolvedToolNames: ["load_skill", "computer_read_file", "computer_write_file", "computer_run_command"],
        sourceKinds: ["workspace_file", "generated_artifact"],
        sideEffect: "workspace_write",
        evidenceKinds: ["artifact_path"],
      }),
      JSON.stringify([{ id: "pptx", description: "Editable pptx is generated.", source: "planner" }]),
      "failed",
      null,
      "Model provider returned HTTP 502",
      now - 6_000,
      now - 1_000,
    );
    await insertStep.run(
      priorPlanId,
      "verify",
      2,
      "Render and verify the final PPTX.",
      JSON.stringify(["build"]),
      JSON.stringify([skill.id]),
      JSON.stringify(["skill_instruction_load", "workspace_artifact_write", "workspace_file_read"]),
      JSON.stringify([]),
      executionBindingJson({
        requiredCapabilities: ["skill_instruction_load", "workspace_artifact_write", "workspace_file_read"],
        resolvedToolNames: ["load_skill", "computer_run_command", "computer_find_files"],
        sourceKinds: ["workspace_file"],
        sideEffect: "workspace_write",
        evidenceKinds: ["artifact_acceptance"],
      }),
      JSON.stringify([{ id: "verified", description: "Deck rendering is verified.", source: "planner" }]),
      "pending",
      null,
      null,
      null,
      null,
    );
    await database.prepare(`
      INSERT INTO run_outcomes(run_id, plan_id, status, output, reason_code, committed_at)
      VALUES (?, ?, 'failed', NULL, 'MODEL_ERROR', ?)
    `).run(priorRunId, priorPlanId, now - 1_000);
    await database.prepare(`
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
    const deckArtifactPath = join(workspace, "conversations", conversationId, "build", "training.pptx");
    await fs.mkdir(join(workspace, "conversations", conversationId, "build"), { recursive: true });
    await fs.writeFile(deckArtifactPath, "pptx bytes");
    await database.prepare(`
      INSERT INTO runtime_actions(
        id, run_id, plan_id, step_id, kind, state, attempt, max_attempts, replay_policy,
        deadline_at, lease_until, fence, revision, metadata_json, result_ref, error_code,
        created_at, updated_at, closed_at
      ) VALUES (?, ?, ?, ?, 'tool_call', 'succeeded', 1, 1, 'unsafe', NULL, NULL, 1, 1, ?, NULL, NULL, ?, ?, ?)
    `).run(
      "build-deck-action",
      priorRunId,
      priorPlanId,
      "build",
      JSON.stringify({ toolCallId: "build-deck", toolName: "computer_run_command" }),
      now - 4_000,
      now - 4_000,
      now - 4_000,
    );
    const insertEvent = await database.prepare(`
      INSERT INTO run_events(run_id, seq, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    await insertEvent.run(
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
    await insertEvent.run(
      priorRunId,
      2,
      "tool.completed",
      JSON.stringify({
        step: 10,
        toolCallId: "build-deck",
        toolName: "computer_run_command",
        result: JSON.stringify({
          exitCode: 0,
          stdout: `Wrote ${deckArtifactPath} (12 slides)\n`,
          stderr: "[preflight] 1 error(s).",
          fileChanges: [],
        }),
      }),
      now - 4_000,
    );
    await insertEvent.run(
      priorRunId,
      3,
      "plan.step.failed",
      JSON.stringify({
        stepId: "build",
        error: "Model provider returned HTTP 502",
      }),
      now - 1_500,
    );
    await insertEvent.run(
      priorRunId,
      4,
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
            requiredCapabilities: ["workspace_artifact_write"],
            successCriteria: [{ id: "continued", description: "Continuation completed.", source: "planner" }],
          }],
        };
      },
    };
    let executionRuntimeContext = "";
    const model: ModelAdapter = {
      limits: TEST_MODEL_LIMITS,
      complete: async (request) => {
        if (request.phase === "execution") executionRuntimeContext = request.runtimeContext?.content ?? "";
        return { content: "continued", finishReason: "stop", toolCalls: [] };
      },
    };
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => model,
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
    assert.equal(workset?.evidenceLedger?.schema, "conversation.evidenceLedger/v1");
    assert.equal(workset?.evidenceLedger?.sourceSummaries[0]?.stepId, "extract");
    assert.equal(workset?.evidenceLedger?.sourceSummaries[0]?.facts[0]?.claim.includes("企业培训场景"), true);
    assert.equal(workset?.evidenceLedger?.sourceSummaries[0]?.facts[0]?.sourceRefs[0]?.url, "https://source.test/training");
    assert.match(executionRuntimeContext, /conversationEvidenceLedger/);
    assert.match(executionRuntimeContext, /企业培训场景/);
    const extractHandoff = workset?.completedStepHandoffs?.find((handoff) => handoff.stepId === "extract");
    assert.equal(extractHandoff?.runId, priorRunId);
    assert.equal(extractHandoff?.output, "Created reusable source outline at artifacts/content.md.");
    assert.equal(extractHandoff?.outputTruncated, false);
    assert.match(executionRuntimeContext, /conversationReuseContext/);
    assert.match(executionRuntimeContext, /completedStepHandoffs/);
    assert.match(executionRuntimeContext, /Created reusable source outline/);
    assert.ok(executionRuntimeContext.length < 20_000);
    assert.deepEqual(workset?.recommendedCapabilities.skillIds, [skill.id]);
    assert.equal(workset?.recommendedCapabilities.capabilityIds.includes("workspace_artifact_write"), true);
    assert.equal(workset?.reusableArtifacts.some((artifact) =>
      artifact.path === "artifacts/outline.json"
      && artifact.sourceToolCallId === "write-outline"
      && artifact.sourcePlanStepId === "build"
      && artifact.reusable
    ), true);
    assert.equal(workset?.reusableArtifacts.some((artifact) =>
      artifact.path === "build/training.pptx"
      && artifact.sourceToolCallId === "build-deck"
      && artifact.sourcePlanStepId === "build"
      && artifact.reusable
    ), true);
    assert.equal(workset?.failedBoundaries[0]?.category, "provider");
    assert.equal(workset?.failedBoundaries[0]?.stepId, "build");
    assert.match(workset?.resumeSuggestion ?? "", /Continue from prior Run/);
    assert.match(workset?.resumeSuggestion ?? "", /artifacts\/outline\.json/);
    assert.match(workset?.resumeSuggestion ?? "", /build\/training\.pptx/);
  } finally {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("RunService routes follow-up file creation through completed delivery text when no artifact exists", async () => {
  const database = new AppDatabase(":memory:");
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-delivery-text-followup-"));
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const conversationId = "conversation-delivery-text-followup";
    const priorRunId = "prior-summary-run";
    const priorPlanId = "prior-summary-plan";
    const now = Date.now();
    await database.prepare(`
      INSERT INTO conversations(id, owner_user_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(conversationId, owner.user.id, "Summary conversation", now - 20_000, now - 1_000);
    await database.prepare(`
      INSERT INTO runs(
        id, owner_user_id, conversation_id, parent_run_id, depth, allow_dangerous_tools,
        model_key, status, input, output, error_code, created_at, finished_at
      ) VALUES (?, ?, ?, NULL, 0, 1, NULL, 'completed', ?, ?, NULL, ?, ?)
    `).run(
      priorRunId,
      owner.user.id,
      conversationId,
      "检索资料并总结",
      "上一轮完成的总结文本。",
      now - 10_000,
      now - 8_000,
    );
    await database.prepare(`
      INSERT INTO plans(id, run_id, version, goal, selected_skill_ids_json, status, created_at, updated_at)
      VALUES (?, ?, 1, ?, '[]', 'completed', ?, ?)
    `).run(priorPlanId, priorRunId, "Summarize source documents", now - 9_000, now - 8_000);
    await database.prepare(`
      INSERT INTO plan_steps(
        plan_id, step_id, position, objective, dependencies_json, skill_ids_json,
        required_capabilities_json, recommended_tool_names_json, execution_binding_json,
        success_criteria_json, status, output, evidence_json, error,
        started_at, finished_at
      ) VALUES (?, 'summarize', 0, ?, '[]', '[]', ?, '[]', ?, ?, 'completed', ?, NULL, NULL, ?, ?)
    `).run(
      priorPlanId,
      "Summarize the selected source documents.",
      JSON.stringify(["visible_directory_read"]),
      executionBindingJson({
        requiredCapabilities: ["visible_directory_read"],
        resolvedToolNames: ["visible_read_files"],
        sourceKinds: ["visible_directory"],
        sideEffect: "workspace_read",
        evidenceKinds: ["source_summary"],
      }),
      JSON.stringify([{ id: "summary", description: "Summary text is delivered.", source: "planner" }]),
      "上一轮完成的总结文本。",
      now - 9_000,
      now - 8_000,
    );
    await database.prepare(`
      INSERT INTO run_outcomes(run_id, plan_id, status, output, reason_code, committed_at)
      VALUES (?, ?, 'completed', ?, 'plan_assessed_and_completed', ?)
    `).run(priorRunId, priorPlanId, "上一轮完成的总结文本。", now - 8_000);

    let capturedTask: TaskSpec | undefined;
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => new StaticModel({ content: "summary file written", finishReason: "stop", toolCalls: [] }),
      plannerFactory: () => ({
        plan: async (task) => {
          capturedTask = task;
          return {
            goal: "write prior summary file",
            selectedSkillIds: [],
            steps: [{
              id: "write-summary-file",
              objective: "Create a Markdown file from the completed delivery text.",
              dependencies: [],
              skillIds: [],
              requiredCapabilities: ["workspace_artifact_write"],
              successCriteria: [{ id: "written", description: "Summary file is written.", source: "planner" }],
            }],
          };
        },
      }),
      assessorFactory: () => approvingTestAssessor(),
    });

    const run = await runs.executeConversation(owner.user.id, "你倒是生成一个总结文件啊", {
      conversationId,
      allowDangerousTools: true,
    });

    assert.equal(run.status, "completed");
    assert.equal(capturedTask?.conversationWorkingSet?.reusableArtifacts.length, 0);
    assert.equal(capturedTask?.conversationWorkingSet?.planCursors[0]?.steps[0]?.output, "上一轮完成的总结文本。");
    assert.deepEqual((await runs.events(owner.user.id, run.id)).find((event) => event.type === "conversation.intent.classified")?.data, { kind: "execute" });
  } finally {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("RunService skips conversation intent classifier for deterministic artifact execution", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const skills = new SkillService(database);
    const owner = testOwner();
    let capturedTask: TaskSpec | undefined;
    const model: ModelAdapter = {
      limits: TEST_MODEL_LIMITS,
      complete: async (request) => {
        assert.equal(request.runId.startsWith("conversation-intent:"), false);
        return { content: "poster execution reached", finishReason: "stop", toolCalls: [] };
      },
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => ({
        plan: async (task) => {
          capturedTask = task;
          return {
            goal: task.input,
            selectedSkillIds: [],
            steps: [{
              id: "create-poster",
              objective: "Create the requested poster image.",
              dependencies: [],
              skillIds: [],
              requiredCapabilities: [],
              successCriteria: [{ id: "poster-created", description: "The poster image request reached execution planning.", source: "planner" }],
            }],
          };
        },
      }),
      assessorFactory: () => approvingTestAssessor(),
    });

    const run = await runs.executeConversation(owner.user.id, "2026 年是中华人民共和国成立 77 年，请你帮我生成一张国庆庆祝海报", {
      allowDangerousTools: true,
    });

    assert.equal(run.status, "completed");
    assert.equal(capturedTask?.responseOnly, undefined);
    assert.deepEqual((await runs.events(owner.user.id, run.id)).find((event) => event.type === "conversation.intent.classified")?.data, { kind: "execute" });
  } finally {
    database.close();
  }
});

test("RunService retries malformed conversation intent output and defaults uncertainty to execution", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const skills = new SkillService(database);
    const owner = testOwner();
    let classifierCalls = 0;
    let capturedTask: TaskSpec | undefined;
    const model: ModelAdapter = {
      limits: TEST_MODEL_LIMITS,
      complete: async (request) => {
        if (request.runId.startsWith("conversation-intent:")) {
          classifierCalls += 1;
          if (classifierCalls === 1) {
            return { content: "", finishReason: "stop", toolCalls: [] };
          }
          assert.match(request.systemPrompt, /previous classifier response was invalid/i);
          return { content: "execute", finishReason: "stop", toolCalls: [] };
        }
        return { content: "execution fallback reached", finishReason: "stop", toolCalls: [] };
      },
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => ({
        plan: async (task) => {
          capturedTask = task;
          return {
            goal: task.input,
            selectedSkillIds: [],
            steps: [{
              id: "handle-turn",
              objective: "Handle the latest turn through execution after classifier uncertainty.",
              dependencies: [],
              skillIds: [],
              requiredCapabilities: [],
              successCriteria: [{ id: "handled", description: "The uncertain turn reached execution planning.", source: "planner" }],
            }],
          };
        },
      }),
      assessorFactory: () => approvingTestAssessor(),
    });

    const run = await runs.executeConversation(owner.user.id, "这件事怎么处理？", {
      allowDangerousTools: true,
    });

    assert.equal(run.status, "completed");
    assert.equal(classifierCalls, 2);
    assert.equal(capturedTask?.responseOnly, undefined);
    assert.deepEqual((await runs.events(owner.user.id, run.id)).find((event) => event.type === "conversation.intent.classified")?.data, { kind: "execute" });
  } finally {
    database.close();
  }
});

test("RunService carries completed artifact lineage into qualitative follow-up planning", async () => {
  const database = new AppDatabase(":memory:");
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-artifact-lineage-"));
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const skill = await skills.create(owner.user.id, {
      name: "canvas-design",
      description: "Create polished image and poster artifacts on canvas.",
      instructions: instructionsWithAgentLoopMetadata(
        "Generate high-quality canvas image artifacts.",
        ["primary_builder"],
        ["image"],
      ),
    });
    const conversationId = "conversation-artifact-lineage";
    const priorRunId = "prior-completed-image-run";
    const priorPlanId = "prior-image-plan";
    const now = Date.now();
    const conversationRoot = join(workspace, "conversations", conversationId);
    await fs.mkdir(join(conversationRoot, "artifacts"), { recursive: true });
    await fs.writeFile(join(conversationRoot, "artifacts", "m9-poster.png"), "png");

    await database.prepare(`
      INSERT INTO conversations(id, owner_user_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(conversationId, owner.user.id, "Image conversation", now - 20_000, now - 1_000);
    await database.prepare(`
      INSERT INTO runs(
        id, owner_user_id, conversation_id, parent_run_id, depth, allow_dangerous_tools,
        model_key, status, input, output, error_code, created_at, finished_at
      ) VALUES (?, ?, ?, NULL, 0, 1, NULL, 'completed', ?, ?, NULL, ?, ?)
    `).run(priorRunId, owner.user.id, conversationId, "生成问界 M9 科技感海报", "已生成 artifacts/m9-poster.png", now - 10_000, now - 8_000);
    await database.prepare(`
      INSERT INTO plans(id, run_id, version, goal, selected_skill_ids_json, status, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, 'completed', ?, ?)
    `).run(priorPlanId, priorRunId, "Generate a technology poster", JSON.stringify([skill.id]), now - 9_000, now - 8_000);
    await database.prepare(`
      INSERT INTO plan_steps(
        plan_id, step_id, position, objective, dependencies_json, skill_ids_json,
        required_capabilities_json, recommended_tool_names_json, execution_binding_json,
        success_criteria_json, status, output, evidence_json, error,
        started_at, finished_at
      ) VALUES (?, 'render', 0, ?, '[]', ?, ?, '[]', ?, ?, 'completed', ?, NULL, NULL, ?, ?)
    `).run(
      priorPlanId,
      "Render the requested poster image.",
      JSON.stringify([skill.id]),
      JSON.stringify(["skill_instruction_load", "workspace_artifact_write", "artifact_acceptance"]),
      executionBindingJson({
        requiredCapabilities: ["skill_instruction_load", "workspace_artifact_write", "artifact_acceptance"],
        resolvedToolNames: ["load_skill", "computer_write_file", "computer_run_command", "verify_artifact_acceptance"],
        sourceKinds: ["workspace_file", "generated_artifact"],
        sideEffect: "workspace_write",
        evidenceKinds: ["artifact_path", "artifact_acceptance"],
      }),
      JSON.stringify([{ id: "poster", description: "Poster image is written.", source: "planner" }]),
      "Created artifacts/m9-poster.png.",
      now - 9_000,
      now - 8_000,
    );
    await database.prepare(`
      INSERT INTO runtime_actions(
        id, run_id, plan_id, step_id, kind, state, attempt, max_attempts, replay_policy,
        deadline_at, lease_until, fence, revision, metadata_json, result_ref, error_code,
        created_at, updated_at, closed_at
      ) VALUES ('write-poster-action', ?, ?, 'render', 'tool_call', 'succeeded', 1, 1, 'unsafe', NULL, NULL, 1, 1, ?, NULL, NULL, ?, ?, ?)
    `).run(
      priorRunId,
      priorPlanId,
      JSON.stringify({ toolCallId: "write-poster", toolName: "computer_write_file" }),
      now - 8_500,
      now - 8_500,
      now - 8_500,
    );
    await database.prepare(`
      INSERT INTO run_events(run_id, seq, type, payload_json, created_at)
      VALUES (?, 1, 'tool.completed', ?, ?)
    `).run(
      priorRunId,
      JSON.stringify({
        step: 2,
        toolCallId: "write-poster",
        toolName: "computer_write_file",
        result: JSON.stringify({ path: "artifacts/m9-poster.png", bytes: 3 }),
      }),
      now - 8_500,
    );
    await database.prepare(`
      INSERT INTO run_outcomes(run_id, plan_id, status, output, reason_code, committed_at)
      VALUES (?, ?, 'completed', ?, ?, ?)
    `).run(priorRunId, priorPlanId, "已生成 artifacts/m9-poster.png", "plan_assessed_and_completed", now - 8_000);

    let capturedTask: TaskSpec | undefined;
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => new StaticModel({ content: "regenerated", finishReason: "stop", toolCalls: [] }),
      plannerFactory: () => ({
        plan: async (task) => {
          capturedTask = task;
          return {
            goal: "regenerate poster",
            selectedSkillIds: task.availableSkills.map((item) => item.id),
            steps: [{
              id: "regenerate",
              objective: "Regenerate the prior poster artifact with the same image production capability.",
              dependencies: [],
              skillIds: task.availableSkills.map((item) => item.id),
              requiredCapabilities: ["skill_instruction_load", "workspace_artifact_write"],
              successCriteria: [{ id: "regenerated", description: "Poster is regenerated.", source: "planner" }],
            }],
          };
        },
      }),
      assessorFactory: () => approvingTestAssessor(),
    });

    const run = await runs.executeConversation(owner.user.id, "大哥，你重新生成啊", {
      conversationId,
      allowDangerousTools: true,
    });

    assert.equal(run.status, "completed");
    assert.deepEqual(capturedTask?.availableSkills.map((item) => item.id), [skill.id]);
    const workset = capturedTask?.conversationWorkingSet;
    assert.deepEqual(workset?.recommendedCapabilities.skillIds, [skill.id]);
    assert.equal(workset?.recommendedCapabilities.capabilityIds.includes("workspace_artifact_write"), true);
    assert.equal(workset?.reusableArtifacts[0]?.sourceSkillIds?.includes(skill.id), true);
    assert.deepEqual((await runs.events(owner.user.id, run.id)).find((event) => event.type === "conversation.intent.classified")?.data, { kind: "execute" });
  } finally {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("execution context injects data-analysis operation profile before the first model action", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
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
          requiredCapabilities: [],
          successCriteria: [{ id: "analysis-ready", description: "Workbook schema, record counts, and analysis conclusions are available.", source: "planner" }],
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

    const skills = new SkillService(database);
    const owner = testOwner();
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
          requiredCapabilities: ["web_research"],
          successCriteria: [{ id: "answer-returned", description: "The answer is returned.", source: "planner" }],
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
    const detail = await runs.plan(owner.user.id, run.id);
    assert.equal(detail.assessments.length, 1);
    assert.equal(detail.assessments[0].approved, true);
    assert.equal(detail.assessments[0].assessmentProfile, "lookup_lite");
    assert.equal(detail.assessments[0].assessmentMethod, "rule");
    assert.ok((await runs.actionsForRun(owner.user.id, run.id)).some((action) => action.kind === "assessment" && action.state === "succeeded"));
    const event = (await runs.events(owner.user.id, run.id)).find((item) => item.type === "skill.compliance.assessed");
    assert.equal((event?.data as { assessmentProfile?: string } | undefined)?.assessmentProfile, "lookup_lite");
    const outcome = await database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
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

    const skills = new SkillService(database);
    const owner = testOwner();
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
          requiredCapabilities: ["web_research"],
          successCriteria: [
            { id: "event-facts", description: "Event time and venue are returned.", source: "planner" },
            { id: "result-link", description: "A result link is included.", source: "planner" },
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
    const events = await runs.events(owner.user.id, run.id);
    assert.equal(events.filter((event) => event.type === "loop.convergence_queued").length, 1);
    const requested = events.find((event) => event.type === "loop.convergence_requested");
    assert.equal(requested?.data.reason, "lookup_evidence_ready:websearch_results");
    assert.equal(events.some((event) => event.type === "loop.limit_exceeded"), false);
    const detail = await runs.plan(owner.user.id, run.id);
    assert.equal(detail.assessments.length, 1);
    assert.equal(detail.assessments[0].assessmentProfile, "lookup_lite");
    assert.equal(detail.assessments[0].approved, true);
    const outcome = await database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
      .get(run.id) as { status: string; reason_code: string };
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reason_code, "plan_assessed_and_completed");
  } finally {
    database.close();
  }
});

test("rule-based assessment completes satisfied criteria without Skill QA repair loops", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const skill = await skills.create(owner.user.id, {
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
    const detail = await runs.plan(owner.user.id, runId);
    assert.equal(detail.assessments.at(-1)?.approved, true);
    assert.equal(detail.assessments.at(-1)?.skills[0]?.status, "not_assessed");
    assert.equal((await runs.get(owner.user.id, runId)).status, "completed");
    const events = await runs.events(owner.user.id, runId);
    assert.equal(events.filter((event) => event.type === "loop.candidate_repair_grace_granted").length, 0);
    assert.equal(events.filter((event) => event.type === "candidate.completion_caveated").length, 0);
    assert.equal(events.some((event) => event.type === "skill.compliance.assessment_reused"), false);
    assert.equal(events.some((event) => event.type === "candidate.assessment_reused"), false);
    const outcome = await database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
      .get(run.id) as { status: string; reason_code: string };
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reason_code, "plan_assessed_and_completed");
  } finally {
    database.close();
  }
});

test("process-only Skill gaps complete with process caveat outcome", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    await skills.create(owner.user.id, {
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
    const detail = await runs.plan(owner.user.id, run.id);
    assert.equal(detail.assessments.at(-1)?.approved, true);
    const assessment = await database.prepare(`
      SELECT skills_json FROM skill_compliance_assessments WHERE plan_id = ? ORDER BY attempt DESC LIMIT 1
    `).get(detail.plan.id) as { skills_json: string };
    assert.equal(JSON.parse(assessment.skills_json)[0].status, "process_caveat");
    const outcome = await database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
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

    const skills = new SkillService(database);
    const owner = testOwner();
    const skill = await skills.create(owner.user.id, {
      name: "presentation-skill",
      description: "Build and render editable pptx artifacts",
      instructions: "Create the deck and run visual validation when available.",
    });
    const model = new DeferredValidationRunModel();
    const planner: Planner = {
      plan: async () => ({
        goal: "generate deck with deferred validation",
        selectedSkillIds: [skill.id],
        steps: [{
          ...step("build-deck"),
          objective: "Generate deck.pptx and report that required local render validation remains unavailable.",
          skillIds: [skill.id],
          requiredCapabilities: ["skill_instruction_load", "workspace_artifact_write"],
          successCriteria: [{
            id: "deck-with-validation-caveat",
            description: "The deck artifact is produced and local render validation status is reported.", source: "planner",
          }],
        }],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
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
    const detail = await runs.plan(owner.user.id, run.id);
    assert.equal(detail.plan.status, "completed");
    assert.equal(detail.assessments.at(-1)?.approved, false);
    assert.equal(detail.assessments.at(-1)?.skills[0].status, "skipped_unavailable");
    assert.equal((await runs.events(owner.user.id, run.id)).filter((event) => event.type === "candidate.validation_deferred").length, 1);
    const outcome = await database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
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

    const skills = new SkillService(database);
    const owner = testOwner();
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
          requiredCapabilities: ["web_research"],
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
    const detail = await runs.plan(owner.user.id, run.id);
    assert.equal(detail.plan.status, "completed");
    assert.equal(detail.assessments.length, 1);
    assert.equal(detail.assessments.at(-1)?.approved, false);
    assert.equal(detail.plan.steps[0].evidence?.completionCaveat?.reason, "evidence_boundary");
    assert.equal((await runs.events(owner.user.id, run.id)).filter((event) => event.type === "candidate.evidence_boundary_accepted").length, 1);
    const outcome = await database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
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

    const skills = new SkillService(database);
    const owner = testOwner();
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
            requiredCapabilities: ["web_research"],
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
            requiredCapabilities: ["workspace_artifact_write"],
            successCriteria: [{
              id: "report-written",
              description: "An HTML report file is written and states the evidence boundary.",
            }],
          },
        ],
      }),
    };
    const model = new MissingSourceFactsReportModel();
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
      assessorFactory: () => missingSourceFactsAssessor(),
      tools: [websearch, webfetch],
      workspaceRoot: workspace,
      maxSteps: 8,
    });

    const run = await runs.execute(owner.user.id, "Generate the DCMM training report", { allowDangerousTools: true });

    assert.equal(run.status, "completed");
    assert.equal(model.sawRepairDirective, true);
    assert.match(run.output ?? "", /dcmm-training.html/);
    const artifacts = await runs.processArtifacts(owner.user.id, run.id);
    const report = artifacts.find((artifact) => artifact.path.endsWith("dcmm-training.html"));
    assert.ok(report);
    const readReport = await runs.readProcessArtifact(owner.user.id, run.id, report.id);
    assert.equal(readReport.content.toString("utf8").includes("Evidence boundary"), true);
    const detail = await runs.plan(owner.user.id, run.id);
    assert.equal(detail.plan.status, "completed");
    assert.equal(detail.plan.steps[0].evidence?.completionCaveat?.reason, "evidence_boundary");
    assert.equal(detail.plan.steps[1].status, "completed");
    const outcome = await database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
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

    const skills = new SkillService(database);
    const owner = testOwner();
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
          requiredCapabilities: ["web_research"],
          successCriteria: [{
            id: "strict-source-facts",
            description: "必须按照官方标准全文逐条给出精确条款；缺少全文时不能交付。", source: "planner",
          }],
        }],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => new StrictSourceRequirementModel(),
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

test("artifact delivery evidence gates bypass risk-sensitive words when Skill QA is not declared", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const skill = await skills.create(owner.user.id, {
      name: "html-training-builder",
      description: "Build browser-presentable training materials.",
      instructions: [
        "---",
        "agentloop:",
        "  roles:",
        "    - primary_builder",
        "  artifactKinds:",
        "    - html",
        "  sourceKinds: []",
        "  qaKinds: []",
        "---",
        "Create paginated HTML and rely on artifact acceptance receipts for Runtime delivery evidence.",
      ].join("\n"),
    });
    const model = new ArtifactAcceptanceGateModel();
    const planner: Planner = {
      plan: async () => ({
        goal: "build a high-safety verified HTML-PPT training artifact",
        selectedSkillIds: [skill.id],
        steps: [{
          id: "build-html-ppt",
          objective: "Build the requested HTML-PPT with 高安全 messaging and record artifact acceptance evidence.",
          dependencies: [],
          skillIds: [skill.id],
          requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"],
          evidenceContract: {
            requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance"],
            caveatPolicy: "none",
          },
          successCriteria: [
            { id: "artifact_path", description: "The generated HTML artifact path is recorded.", source: "planner" },
            { id: "artifact_non_empty", description: "The generated HTML artifact is non-empty.", source: "planner" },
            { id: "artifact_acceptance", description: "The artifact acceptance receipt is recorded for the safety-themed artifact.", source: "planner" },
          ],
        }],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
    });

    const run = await runs.execute(owner.user.id, "生成突出高安全能力的 HTML-PPT 培训材料", { allowDangerousTools: true });

    assert.equal(run.status, "completed");
    assert.equal(model.assessmentCalls, 0);
    const detail = await runs.plan(owner.user.id, run.id);
    const latestAssessment = detail.assessments.at(-1);
    assert.equal(latestAssessment?.approved, true);
    assert.equal(latestAssessment?.assessmentProfile, "evidence_gate");
    assert.equal(latestAssessment?.assessmentMethod, "rule");
    assert.equal(latestAssessment?.skills[0]?.status, "not_assessed");
    assert.equal(latestAssessment?.skills[0]?.followed, false);
    assert.match(latestAssessment?.skills[0]?.rationale ?? "", /does not reperform Skill QA/);
    assert.ok((await runs.events(owner.user.id, run.id)).some((event) =>
      event.type === "skill.compliance.assessed"
      && (event.data as { assessmentProfile?: string; assessmentMethod?: string }).assessmentProfile === "evidence_gate"
      && (event.data as { assessmentProfile?: string; assessmentMethod?: string }).assessmentMethod === "rule"
    ));
  } finally {
    database.close();
  }
});

test("declared Skill QA does not force artifact delivery onto model-backed assessment", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const skill = await skills.create(owner.user.id, {
      name: "browser-qa-artifact-builder",
      description: "Build browser-presentable artifacts with declared visual QA.",
      instructions: [
        "---",
        "agentloop:",
        "  roles:",
        "    - primary_builder",
        "  artifactKinds:",
        "    - html",
        "  sourceKinds: []",
        "  qaKinds:",
        "    - browser",
        "---",
        "Create paginated HTML and perform the declared browser QA.",
      ].join("\n"),
    });
    let assessmentCalls = 0;
    let loaded = false;
    let materialized = false;
    let verified = false;
    const model: ModelAdapter = {
      limits: TEST_MODEL_LIMITS,
      complete: async (request) => {
        if (request.phase === "assessment") {
          assessmentCalls += 1;
          return {
            content: "",
            finishReason: "tool_calls",
            toolCalls: [{
              id: "assessment",
              name: "submit_assessment",
              arguments: {
                criteria: [
                  { criterionId: "artifact_path", satisfied: true, rationale: "Artifact path receipt is present.", evidenceRefs: ["verify-html"] },
                  { criterionId: "artifact_non_empty", satisfied: true, rationale: "Artifact non-empty receipt is present.", evidenceRefs: ["verify-html"] },
                  { criterionId: "artifact_acceptance", satisfied: true, rationale: "Artifact acceptance receipt is present.", evidenceRefs: ["verify-html"] },
                ],
                skills: [{
                  skillId: skill.id,
                  followed: true,
                  rationale: "Declared browser QA remains observable when model-backed assessment is explicitly selected.",
                  evidenceRefs: ["verify-html"],
                }],
                feedback: "",
              },
            }],
          };
        }
        if (request.phase !== "execution") {
          return { content: "", finishReason: "stop", toolCalls: [] };
        }
        const toolNames = request.tools.map((tool) => tool.name);
        if (!loaded && toolNames.includes("load_skill")) {
          loaded = true;
          return {
            content: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: "load-browser-qa-skill", name: "load_skill", arguments: { name: "browser-qa-artifact-builder" } }],
          };
        }
        if (!materialized && toolNames.includes("materialize_paginated_html")) {
          materialized = true;
          return {
            content: "",
            finishReason: "tool_calls",
            toolCalls: [{
              id: "materialize-html",
              name: "materialize_paginated_html",
              arguments: {
                path: "deliverables/qa.html",
                title: "QA",
                renderMode: "slides",
                acceptanceProfile: "html_ppt",
                pages: [{ title: "Overview", bullets: ["Artifact", "Acceptance", "QA"] }],
              },
            }],
          };
        }
        if (!verified && toolNames.includes("verify_artifact_acceptance")) {
          verified = true;
          return {
            content: "",
            finishReason: "tool_calls",
            toolCalls: [{
              id: "verify-html",
              name: "verify_artifact_acceptance",
              arguments: { artifactPath: "deliverables/qa.html", profileId: "html_ppt" },
            }],
          };
        }
        return {
          content: "Created deliverables/qa.html with artifact_acceptance evidence and declared QA.",
          finishReason: "stop",
          toolCalls: [],
        };
      },
    };
    const planner: Planner = {
      plan: async () => ({
        goal: "build a browser-QA artifact",
        selectedSkillIds: [skill.id],
        steps: [{
          id: "build-browser-qa-html",
          objective: "Build the requested HTML-PPT and record artifact acceptance evidence.",
          dependencies: [],
          skillIds: [skill.id],
          requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"],
          evidenceContract: {
            requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance"],
            caveatPolicy: "none",
          },
          successCriteria: [
            { id: "artifact_path", description: "The generated HTML artifact path is recorded.", source: "planner" },
            { id: "artifact_non_empty", description: "The generated HTML artifact is non-empty.", source: "planner" },
            { id: "artifact_acceptance", description: "The artifact acceptance receipt is recorded.", source: "planner" },
          ],
        }],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
    });

    const run = await runs.execute(owner.user.id, "生成需要浏览器 QA 的 HTML-PPT", { allowDangerousTools: true });

    assert.equal(run.status, "completed");
    assert.equal(assessmentCalls, 0);
    const latestAssessment = (await runs.plan(owner.user.id, run.id)).assessments.at(-1);
    assert.equal(latestAssessment?.assessmentProfile, "evidence_gate");
    assert.equal(latestAssessment?.assessmentMethod, "rule");
    assert.equal(latestAssessment?.skills[0]?.status, "not_assessed");
  } finally {
    database.close();
  }
});

test("source summary receipts use principle assessment without model-backed QA", async () => {
  const database = new AppDatabase(":memory:");
  const visible = await fs.mkdtemp(join(tmpdir(), "agentloop-source-gate-"));
  try {
    await fs.writeFile(join(visible, "KB-0001.md"), "# Topic\nAnswer\n");

    const skills = new SkillService(database);
    const owner = testOwner();
    const model = new SourceSummaryGateModel();
    const planner: Planner = {
      plan: async () => ({
        goal: "summarize a visible directory",
        selectedSkillIds: [],
        steps: [{
          id: "summarize-source",
          objective: "Index the visible directory and deliver a caveated source summary.",
          dependencies: [],
          skillIds: [],
          requiredCapabilities: ["visible_directory_read"],
          evidenceContract: {
            requiredKinds: ["source_summary", "explicit_caveats", "delivery_receipt"],
            caveatPolicy: "mark_unverified_facts",
          },
          successCriteria: [
            { id: "source_summary", description: "A structured source summary receipt is present.", source: "planner" },
            { id: "explicit_caveats", description: "Source coverage caveats are recorded.", source: "planner" },
            { id: "delivery_receipt", description: "The final delivery identifies the summary.", source: "planner" },
          ],
        }],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
    });

    const run = await runs.execute(owner.user.id, "总结这个目录", { visibleDirectories: [visible] });

    assert.equal(run.status, "completed");
    assert.equal(model.assessmentCalls, 0);
    const latestAssessment = (await runs.plan(owner.user.id, run.id)).assessments.at(-1);
    assert.equal(latestAssessment?.approved, true);
    assert.equal(latestAssessment?.assessmentProfile, "evidence_gate");
    assert.equal(latestAssessment?.assessmentMethod, "rule");
  } finally {
    await fs.rm(visible, { recursive: true, force: true });
    database.close();
  }
});

test("large structured source Tool results preserve receipts for evidence-gate assessment", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const skills = new SkillService(database);
    const owner = testOwner();
    let called = false;
    const largeSourceTool: RuntimeTool = {
      name: "large_structured_source",
      description: "Return a large structured source extraction with a canonical receipt.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      executionMode: "parallel",
      replaySafe: true,
      maxResultCharacters: 4_000,
      parse: () => ({}),
      execute: async () => ({
        schema: "agentloop.visibleTableExtraction/v1",
        files: Array.from({ length: 80 }, (_, index) => ({
          path: `sheet-${index}.xlsx`,
          records: Array.from({ length: 20 }, (__, row) => ({ row, values: { name: `person-${index}-${row}`, score: row } })),
        })),
        requested: 80,
        returned: 80,
        totalRows: 1_600,
        totalRecords: 1_600,
        totalCells: 3_200,
        artifact: {
          schema: "agentloop.tableExtractionArtifact/v1",
          path: ".agentloop/table-extractions/aa/source.json",
          bytes: 95_000,
          sha256: "a".repeat(64),
        },
        caveats: ["Large extraction rows are stored in the durable artifact."],
        evidenceReceipt: {
          schema: "agentloop.toolEvidenceReceipt/v1",
          sourceType: "visible_table_extraction",
          receiptId: "large-source-receipt",
          sourceRefs: [{ path: "sheet-0.xlsx", sha256: "b".repeat(64) }],
          facts: [{
            kind: "structured_table_extraction",
            requested: 80,
            returned: 80,
            totalRows: 1_600,
            totalRecords: 1_600,
            totalCells: 3_200,
            artifact: { path: ".agentloop/table-extractions/aa/source.json", sha256: "a".repeat(64) },
          }],
          caveats: ["Large extraction rows are stored in the durable artifact."],
          evidenceKinds: {
            satisfied: ["source_summary", "schema_summary", "record_counts", "structured_extraction_artifact"],
            caveated: ["explicit_caveats"],
            failed: [],
          },
        },
      }),
    };
    const model: ModelAdapter = {
      limits: TEST_MODEL_LIMITS,
      complete: async (request) => {
        if (request.phase === "assessment") throw new Error("large source gate should use rule assessment");
        if (request.phase !== "execution") return { content: "", finishReason: "stop", toolCalls: [] };
        if (!called) {
          called = true;
          return {
            content: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: "large-source", name: "large_structured_source", arguments: {} }],
          };
        }
        return {
          content: "Structured extraction evidence is available in the durable artifact with counts and caveats.",
          finishReason: "stop",
          toolCalls: [],
        };
      },
    };
    const planner: Planner = {
      plan: async () => ({
        goal: "collect large structured source evidence",
        selectedSkillIds: [],
        steps: [{
          id: "collect-large-source",
          objective: "Collect large structured source evidence with a durable artifact receipt.",
          dependencies: [],
          role: "fact_acquisition",
          skillIds: [],
          requiredCapabilities: ["external_api_call"],
          evidenceContract: {
            requiredKinds: ["source_summary", "schema_summary", "record_counts", "structured_extraction_artifact", "explicit_caveats"],
            caveatPolicy: "mark_unverified_facts",
          },
          successCriteria: [
            { id: "source_summary", description: "A structured source summary receipt is present.", source: "planner" },
            { id: "schema_summary", description: "A schema summary is present.", source: "planner" },
            { id: "record_counts", description: "Record counts are present.", source: "planner" },
            { id: "structured_extraction_artifact", description: "A durable extraction artifact is present.", source: "planner" },
            { id: "explicit_caveats", description: "Extraction caveats are explicit.", source: "planner" },
          ],
        }],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
      tools: [largeSourceTool],
    });

    const run = await runs.execute(owner.user.id, "收集大量结构化来源证据");

    assert.equal(run.status, "completed");
    const events = await runs.events(owner.user.id, run.id);
    const completed = events.find((event) => event.type === "tool.completed" && event.data.toolCallId === "large-source");
    assert.match(String(completed?.data.result), /large_tool_result_receipt_preserved/);
    assert.match(String(completed?.data.result), /agentloop\.toolEvidenceReceipt\/v1/);
    const latestAssessment = (await runs.plan(owner.user.id, run.id)).assessments.at(-1);
    assert.equal(latestAssessment?.approved, true);
    assert.equal(latestAssessment?.assessmentProfile, "evidence_gate");
    assert.equal(latestAssessment?.assessmentMethod, "rule");
  } finally {
    database.close();
  }
});

test("visible command steps expose read-only visible command roots in execution context", async () => {
  const database = new AppDatabase(":memory:");
  const visible = await fs.mkdtemp(join(tmpdir(), "agentloop-visible-command-context-"));
  try {
    await fs.writeFile(join(visible, "source.pdf"), "pdf-like bytes");

    const skills = new SkillService(database);
    const owner = testOwner();
    let sawVisibleCommandRoot = false;
    const planner: Planner = {
      plan: async () => ({
        goal: "process visible PDF sources",
        selectedSkillIds: [],
        steps: [{
          id: "process-visible-pdfs",
          objective: "Find visible PDF files and process them with a local parser command.",
          dependencies: [],
          role: "produce",
          skillIds: [],
          requiredCapabilities: ["visible_directory_read", "workspace_artifact_write"],
          evidenceContract: { requiredKinds: ["delivery_receipt"], caveatPolicy: "none" },
          successCriteria: [{ id: "delivery_receipt", description: "The processing result is delivered.", source: "planner" }],
        }],
      }),
    };
    const model: ModelAdapter = {
      limits: TEST_MODEL_LIMITS,
      complete: async (request) => {
        const toolNames = request.tools.map((tool) => tool.name);
        assert.equal(toolNames.includes("visible_find_files"), true);
        assert.equal(toolNames.includes("computer_run_command"), true);
        const context = request.runtimeContext?.content ?? "";
        sawVisibleCommandRoot = context.includes("\"cwd\":\"@visible/visible_dir_1\"")
          && context.includes("Do not reconstruct absolute visible-directory paths")
          && context.includes("do not use ls/find for visible source discovery");
        return { content: "processed visible PDFs with delivery receipt", finishReason: "stop", toolCalls: [] };
      },
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
      assessorFactory: () => approvingTestAssessor(),
    });

    const run = await runs.execute(owner.user.id, "处理 visible PDF", {
      allowDangerousTools: true,
      visibleDirectories: [visible],
    });

    assert.equal(run.status, "completed");
    assert.equal(sawVisibleCommandRoot, true);
  } finally {
    await fs.rm(visible, { recursive: true, force: true });
    database.close();
  }
});

test("source provider command receipts satisfy principle assessment evidence gates", async () => {
  const database = new AppDatabase(":memory:");
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-command-source-receipt-"));
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const skill = await skills.create(owner.user.id, {
      name: "api-query",
      description: "Query API catalog metadata.",
      instructions: [
        "---",
        "agentloop:",
        "  roles:",
        "    - source_provider",
        "  artifactKinds:",
        "    - none",
        "  sourceKinds:",
        "    - api",
        "  qaKinds: []",
        "---",
        "Query API catalog metadata and return structured source receipts.",
      ].join("\n"),
    });
    const model = new CommandSourceReceiptGateModel();
    const planner: Planner = {
      plan: async () => ({
        goal: "summarize API catalog command output",
        selectedSkillIds: [skill.id],
        steps: [{
          id: "query-api-catalog",
          objective: "Run a source-provider command and deliver its structured source summary.",
          dependencies: [],
          skillIds: [skill.id],
          requiredCapabilities: ["skill_instruction_load", "workspace_artifact_write", "workspace_file_read"],
          evidenceContract: {
            requiredKinds: ["delivery_receipt", "explicit_caveats"],
            caveatPolicy: "mark_unverified_facts",
          },
          successCriteria: [
            { id: "delivery_receipt", description: "The final answer identifies the delivered summary.", source: "planner" },
            { id: "explicit_caveats", description: "Caveats from source collection are present.", source: "planner" },
          ],
        }],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      computerExecutableAliases: { "trusted-node": process.execPath },
      modelFactory: () => model,
      plannerFactory: () => planner,
    });

    const run = await runs.execute(owner.user.id, "查询 API 目录", { allowDangerousTools: true });

    assert.equal(run.status, "completed");
    assert.equal(model.assessmentCalls, 0);
    const latestAssessment = (await runs.plan(owner.user.id, run.id)).assessments.at(-1);
    assert.equal(latestAssessment?.approved, true);
    assert.equal(latestAssessment?.assessmentProfile, "evidence_gate");
    assert.equal(latestAssessment?.assessmentMethod, "rule");
  } finally {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("produce source-summary steps deliver a user summary instead of internal source summary JSON", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const model = new ProduceSourceSummaryModel();
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => ({
        plan: async (task) => {
          const sourceId = task.sources?.[0]?.id;
          assert.ok(sourceId);
          return {
            goal: "summarize uploaded AI planning material",
            selectedSkillIds: [],
            steps: [{
              id: "produce-ai-summary",
              objective: `读取上传源文件 ${sourceId}，提取 AI 相关规划，并以中文总结形式交付。`,
              dependencies: [],
              skillIds: [],
              role: "produce",
              requiredCapabilities: ["uploaded_source_read"],
              sourceConstraint: { requiredUploadedSourceIds: [sourceId] },
              evidenceContract: {
                requiredKinds: ["source_summary", "explicit_caveats"],
                caveatPolicy: "mark_unverified_facts",
              },
              successCriteria: [
                { id: "source_summary", description: "Source evidence is available." },
                { id: "explicit_caveats", description: "Caveats are explicit when needed." },
              ],
            }],
          };
        },
      }),
    });
    const source = await runs.uploadSource(owner.user.id, {
      originalName: "foreign-affairs-ai-plan.md",
      content: Buffer.from("利用AI进行风险预警与合规检查，推进风险国别AI预警和照片AI质检。", "utf8"),
    });
    model.sourceId = source.id;

    const run = await runs.execute(owner.user.id, "分析总结外事业务在十五五 AI 领域的工作计划", {
      allowDangerousTools: true,
      sourceIds: [source.id],
    });

    assert.equal(run.status, "completed");
    assert.equal(model.sawSourceSummaryConvergencePrompt, false);
    assert.match(run.output ?? "", /AI风险预警/);
    assert.doesNotMatch(run.output ?? "", /agentloop\.sourceSummaryCandidate\/v1/);
  } finally {
    database.close();
  }
});

test("uploaded source reads converge once all chunks are covered without injecting coverage text", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const model = new UploadedSourceCoverageModel();
    const planner: Planner = {
      plan: async () => ({
        goal: "summarize uploaded source",
        selectedSkillIds: [],
        steps: [{
          id: "summarize-upload",
          objective: "Read the uploaded paper and produce a Chinese summary.",
          dependencies: [],
          skillIds: [],
          role: "deliver",
          requiredCapabilities: ["uploaded_source_read"],
          evidenceContract: {
            requiredKinds: ["source_summary", "explicit_caveats", "delivery_receipt"],
            caveatPolicy: "mark_unverified_facts",
          },
          successCriteria: [
            { id: "source_summary", description: "Uploaded source chunks have been read.", source: "planner" },
            { id: "delivery_receipt", description: "A user-facing summary is delivered.", source: "planner" },
          ],
        }],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
      assessorFactory: () => approvingTestAssessor(),
      maxSteps: 6,
    });
    const source = await runs.uploadSource(owner.user.id, {
      originalName: "six-chunk-paper.md",
      content: Buffer.from(Array.from({ length: 6 }, (_, index) =>
        `# Section ${index}\n` + `Evidence ${index} `.repeat(650)
      ).join("\n"), "utf8"),
    });
    assert.equal(source.chunkCount, 6);
    model.sourceId = source.id;

    const run = await runs.execute(owner.user.id, "总结这篇上传材料", { sourceIds: [source.id] });

    assert.equal(run.status, "completed");
    assert.equal(model.repeatedReadAttempted, false);
    assert.equal(model.sawConvergenceTurn, true);
    assert.equal(model.executionCalls, 3);
    const events = await runs.events(owner.user.id, run.id);
    assert.equal(events.some((event) =>
      event.type === "loop.convergence_queued"
      && (event.data as { reason?: string }).reason === "lookup_evidence_ready:uploaded_source_coverage_complete"
    ), true);
  } finally {
    database.close();
  }
});

test("fact acquisition converges a complete structured upload extraction despite artifact-write capability", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const skills = new SkillService(database);
    const owner = testOwner();
    const model = new StructuredUploadExtractionModel();
    let useContinuationModel = false;
    let continuationTask: TaskSpec | undefined;
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => useContinuationModel
        ? new StaticModel({ content: "Continued from the persisted extraction receipt.", finishReason: "stop", toolCalls: [] })
        : model,
      plannerFactory: () => ({
        plan: async (task) => {
          if (task.input === "继续") {
            continuationTask = task;
            return {
              goal: "continue from persisted extraction evidence",
              selectedSkillIds: [],
              steps: [{
                id: "continue-from-extraction",
                objective: "Use the persisted extraction evidence without rereading the source.",
                dependencies: [],
                skillIds: [],
                role: "deliver",
                requiredCapabilities: [],
                successCriteria: [{ id: "continued", description: "The persisted evidence is reused." }],
              }],
            };
          }
          const sourceId = task.sources?.[0]?.id;
          assert.ok(sourceId);
          model.sourceId = sourceId;
          return {
            goal: "extract reusable task-table facts",
            selectedSkillIds: [],
            steps: [{
              id: "extract-task-table",
              objective: "Extract the uploaded task table into a durable structured artifact for the following analysis step.",
              dependencies: [],
              skillIds: [],
              role: "fact_acquisition",
              requiredCapabilities: ["uploaded_source_read", "workspace_artifact_write"],
              sourceConstraint: { requiredUploadedSourceIds: [sourceId] },
              evidenceContract: {
                requiredKinds: ["source_summary", "schema_summary", "record_counts", "structured_extraction_artifact"],
                caveatPolicy: "mark_unverified_facts",
              },
              successCriteria: [{ id: "extracted", description: "A complete structured extraction artifact is available." }],
            }],
          };
        },
      }),
    });
    const source = await runs.uploadSource(owner.user.id, {
      originalName: "tasks.csv",
      content: Buffer.from("任务名称,责任人\n任务A,张三\n任务B,李四\n", "utf8"),
    });

    const run = await runs.execute(owner.user.id, "统计上传任务表", { sourceIds: [source.id] });

    assert.equal(run.status, "completed");
    assert.equal(model.sawConvergenceTurn, true);
    assert.equal(model.executionCalls, 2);
    const plan = await runs.plan(owner.user.id, run.id);
    assert.match(plan.plan.steps[0]?.evidence?.candidateOutput ?? "", /agentloop\.sourceSummaryCandidate\/v1/);
    const events = await runs.events(owner.user.id, run.id);
    assert.equal(events.some((event) =>
      event.type === "loop.convergence_queued"
      && (event.data as { reason?: string }).reason === "lookup_evidence_ready:complete_structured_extraction"
    ), true);

    // Simulate a Run produced before source-summary convergence existed: the
    // accepted extraction receipt remains, but the model candidate was prose
    // and the later Run terminalized with a provider failure.
    await database.prepare("UPDATE plan_steps SET evidence_json = ? WHERE plan_id = ? AND step_id = ?").run(
      JSON.stringify({
        ...plan.plan.steps[0]?.evidence,
        candidateOutput: "Legacy prose did not preserve a structured source summary.",
      }),
      plan.plan.id,
      "extract-task-table",
    );
    await database.prepare("UPDATE plans SET status = 'failed' WHERE id = ?").run(plan.plan.id);
    await database.prepare("UPDATE runs SET status = 'failed', output = NULL, error_code = 'MODEL_ERROR' WHERE id = ?").run(run.id);
    await database.prepare("UPDATE run_outcomes SET status = 'failed', output = NULL, reason_code = 'MODEL_ERROR' WHERE run_id = ?").run(run.id);

    useContinuationModel = true;
    const continuation = await runs.execute(owner.user.id, "继续", { conversationId: run.conversationId });
    assert.equal(continuation.status, "completed");
    const fallbackSummary = continuationTask?.conversationWorkingSet?.evidenceLedger?.sourceSummaries
      .find((summary) => summary.runId === run.id);
    assert.ok(fallbackSummary);
    assert.equal(fallbackSummary?.facts[0]?.claim.includes("2 record(s)"), true);
    assert.equal(fallbackSummary?.facts[0]?.sourceRefs.some((ref) => ref.sourceRefId === "extract-task-table"), true);
  } finally {
    database.close();
  }
});

test("large uploaded source reads use bounded convergence instead of forcing full coverage", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const model = new LargeUploadedSourceBoundedModel();
    const planner: Planner = {
      plan: async () => ({
        goal: "summarize large uploaded source",
        selectedSkillIds: [],
        steps: [{
          id: "summarize-large-upload",
          objective: "Read enough of the uploaded paper and produce a Chinese summary.",
          dependencies: [],
          skillIds: [],
          role: "deliver",
          requiredCapabilities: ["uploaded_source_read"],
          evidenceContract: {
            requiredKinds: ["source_summary", "explicit_caveats", "delivery_receipt"],
            caveatPolicy: "mark_unverified_facts",
          },
          successCriteria: [
            { id: "source_summary", description: "Uploaded source evidence has been read.", source: "planner" },
            { id: "delivery_receipt", description: "A user-facing summary is delivered.", source: "planner" },
          ],
        }],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
      assessorFactory: () => approvingTestAssessor(),
      maxSteps: 6,
    });
    const source = await runs.uploadSource(owner.user.id, {
      originalName: "large-paper.md",
      content: Buffer.from(Array.from({ length: 12 }, (_, index) =>
        `# Section ${index}\n` + `Evidence ${index} `.repeat(650)
      ).join("\n"), "utf8"),
    });
    assert.equal(source.chunkCount > 10, true);
    model.sourceId = source.id;

    const run = await runs.execute(owner.user.id, "总结这篇大型上传材料", { sourceIds: [source.id] });

    assert.equal(run.status, "completed");
    assert.equal(model.executionCalls, 2);
    assert.equal(model.sawConvergenceTurn, true);
    const events = await runs.events(owner.user.id, run.id);
    assert.equal(events.some((event) =>
      event.type === "loop.convergence_queued"
      && (event.data as { reason?: string }).reason === "lookup_evidence_ready"
    ), true);
  } finally {
    database.close();
  }
});

test("fact acquisition source reads are not capped by file-output skill heuristics", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const skills = new SkillService(database);
    const owner = testOwner();
    const skill = await skills.create(owner.user.id, {
      name: "city-carbon-ai-assessment",
      description: "Generate a polished report artifact from uploaded source evidence.",
      instructions: instructionsWithAgentLoopMetadata(
        "Read uploaded source evidence and summarize it accurately.",
        ["source_provider"],
        ["none"],
        ["document"],
      ),
    });
    const model = new FactAcquisitionReadSkillModel();
    const planner: Planner = {
      plan: async () => ({
        goal: "summarize uploaded PDF",
        selectedSkillIds: [skill.id],
        steps: [{
          id: "leaf1",
          objective: "读取上传PDF并输出中文要点整理：概括文章核心结论、主要论据/发现、方法或数据来源、局限与适用范围，必要时标注无法从原文确认的信息。",
          dependencies: [],
          skillIds: [skill.id],
          role: "fact_acquisition",
          requiredCapabilities: ["uploaded_source_read", "skill_instruction_load"],
          evidenceContract: {
            requiredKinds: ["source_summary", "explicit_caveats"],
            caveatPolicy: "mark_unverified_facts",
          },
          successCriteria: [
            { id: "source_summary", description: "Source evidence is available.", source: "planner" },
            { id: "explicit_caveats", description: "Caveats are explicit when needed.", source: "planner" },
          ],
        }],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
    });
    const source = await runs.uploadSource(owner.user.id, {
      originalName: "2603.16975v1.md",
      content: Buffer.from(Array.from({ length: 420 }, (_, index) =>
        `# Section ${index + 1}\n` + `Evidence ${index + 1} `.repeat(10)
      ).join("\n"), "utf8"),
    });
    model.sourceId = source.id;

    const run = await runs.execute(owner.user.id, "整理这篇文章要点", {
      allowDangerousTools: true,
      sourceIds: [source.id],
    });

    assert.equal(run.status, "completed");
    assert.equal(model.executionCalls, 5);
    const events = await runs.events(owner.user.id, run.id);
    assert.equal(events.some((event) =>
      event.type === "tool.rejected"
      && event.data.toolName === "read_source"
      && event.data.reason === "Read-only exploratory tool calls exceeded the artifact step primary budget"
    ), false);
    assert.equal(events.filter((event) =>
      event.type === "tool.completed"
      && event.data.toolName === "read_source"
    ).length, 4);
  } finally {
    database.close();
  }
});

test("source fact acquisition keeps the Run-authorized catalog while projecting action-aware guidance", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const skills = new SkillService(database);
    const owner = testOwner();
    const model = new SourceFactAcquisitionActionAwareModel();
    const planner: Planner = {
      plan: async () => ({
        goal: "extract uploaded source facts",
        selectedSkillIds: [],
        steps: [{
          id: "extract-source-facts",
          objective: "Read the uploaded article and produce reusable source facts for a downstream report.",
          dependencies: [],
          skillIds: [],
          role: "fact_acquisition",
          requiredCapabilities: ["uploaded_source_read"],
          evidenceContract: {
            requiredKinds: ["source_summary", "explicit_caveats", "delivery_receipt"],
            caveatPolicy: "mark_unverified_facts",
          },
          successCriteria: [
            { id: "source_summary", description: "Uploaded source evidence is available.", source: "planner" },
            { id: "explicit_caveats", description: "Source caveats are explicit.", source: "planner" },
            { id: "delivery_receipt", description: "A completion candidate is delivered.", source: "planner" },
          ],
        }],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
      maxSteps: 4,
    });
    const source = await runs.uploadSource(owner.user.id, {
      originalName: "article.md",
      content: Buffer.from("# Article\n" + "Source fact. ".repeat(100), "utf8"),
    });
    model.sourceId = source.id;

    const run = await runs.execute(owner.user.id, "整理这篇文章要点", {
      allowDangerousTools: true,
      sourceIds: [source.id],
    });

    assert.equal(run.status, "completed");
    assert.ok(model.firstToolNames.includes("read_source"));
    assert.equal(model.firstToolNames.includes("computer_write_file"), true);
    assert.equal(model.firstToolNames.includes("convert_artifact"), true);
    assert.equal(model.firstToolNames.includes("verify_artifact_acceptance"), true);
    assert.equal(model.sawActionAwareProjection, true);
    const events = await runs.events(owner.user.id, run.id);
    const firstPolicy = events.find((event) => event.type === "step_execution.policy_applied");
    assert.equal(firstPolicy?.data.toolCatalogMode, "full");
    assert.equal(firstPolicy?.data.promptProjectionMode, "action_aware");
  } finally {
    database.close();
  }
});

test("pdf uploads prefer pdftotext extraction over the custom fallback", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const skills = new SkillService(database);
    const owner = testOwner();
    const sourceRepository = new SourceRepository(database);
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => { throw new Error("model is not used"); },
    });
    const pdfPath = "/Users/zhujun/coding/agentloop/apps/agentloop-app/workspace/uploads/35618237-f930-401c-8edb-5e37c2808c22/sources/src_cebc40aa600740739268cc8e1f279298/original";
    const content = await fs.readFile(pdfPath);

    const source = await runs.uploadSource(owner.user.id, {
      originalName: "2603.16975v1.pdf",
      content,
    });
    const summary = await runs.source(owner.user.id, source.id);
    const chunkText = (await sourceRepository.chunks(source.id)).map((chunk) => chunk.content).join("\n");
    const normalizedChunkText = chunkText.replace(/\s+/g, " ");

    assert.equal(source.status, "ready");
    assert.equal(source.chunkCount > 1, true);
    assert.match(summary.summary ?? "", /The State of Generative AI in Software Development/);
    assert.doesNotMatch(summary.summary ?? "", /eawe darry/i);
    assert.match(normalizedChunkText, /The State of Generative AI in Software Development/);
    assert.doesNotMatch(chunkText, /eawe darry/i);
  } finally {
    database.close();
  }
});

test("lookup source-summary steps converge after bounded distinct source reads", async () => {
  const database = new AppDatabase(":memory:");
  const visible = await fs.mkdtemp(join(tmpdir(), "agentloop-bounded-source-"));
  try {
    for (let index = 1; index <= 5; index += 1) {
      await fs.writeFile(join(visible, `KB-${String(index).padStart(4, "0")}.md`), `# Topic ${index}\n分类：差旅报支\nFact ${index}\n`);
    }

    const skills = new SkillService(database);
    const owner = testOwner();
    const model = new BoundedSourceReadModel();
    const planner: Planner = {
      plan: async () => ({
        goal: "collect bounded source evidence",
        selectedSkillIds: [],
        steps: [{
          id: "collect-source",
          objective: "Find and read representative local knowledge files, then provide a bounded source summary.",
          dependencies: [],
          skillIds: [],
          role: "fact_acquisition",
          requiredCapabilities: ["visible_directory_read"],
          evidenceContract: {
            requiredKinds: ["source_summary", "explicit_caveats"],
            caveatPolicy: "mark_unverified_facts",
          },
          successCriteria: [
            { id: "source_summary", description: "A bounded source summary is available.", source: "planner" },
            { id: "explicit_caveats", description: "Source caveats are recorded.", source: "planner" },
          ],
        }],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
    });

    const run = await runs.execute(owner.user.id, "总结差旅报支知识", { visibleDirectories: [visible] });

    assert.equal(run.status, "completed");
    assert.equal(model.assessmentCalls, 0);
    assert.equal(model.sawConvergenceTurn, true);
    assert.equal(model.executionCalls, 3);
    assert.match(run.output ?? "", /agentloop\.sourceSummaryCandidate\/v1/);
  } finally {
    await fs.rm(visible, { recursive: true, force: true });
    database.close();
  }
});

test("visible source reads with continuation keep tools available before lookup convergence", async () => {
  const database = new AppDatabase(":memory:");
  const visible = await fs.mkdtemp(join(tmpdir(), "agentloop-visible-continuation-"));
  try {
    await fs.writeFile(join(visible, "long-plan.md"), Array.from({ length: 260 }, (_, index) =>
      `Line ${index + 1}: AI platform implementation detail`
    ).join("\n"));

    const skills = new SkillService(database);
    const owner = testOwner();
    const model = new VisibleReadContinuationModel();
    const planner: Planner = {
      plan: async () => ({
        goal: "summarize a long visible source",
        selectedSkillIds: [],
        steps: [{
          id: "summarize-long-visible-source",
          objective: "Read the long visible source and produce a detailed summary from the available evidence.",
          dependencies: [],
          skillIds: [],
          role: "produce",
          requiredCapabilities: ["visible_directory_read"],
          evidenceContract: {
            requiredKinds: ["source_summary", "explicit_caveats", "delivery_receipt"],
            caveatPolicy: "mark_unverified_facts",
          },
          successCriteria: [
            { id: "source_summary", description: "Source evidence is available.", source: "planner" },
            { id: "explicit_caveats", description: "Coverage caveats are explicit.", source: "planner" },
            { id: "delivery_receipt", description: "A user-facing summary is delivered.", source: "planner" },
          ],
        }],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
    });

    const run = await runs.execute(owner.user.id, "详细总结 long-plan.md", { visibleDirectories: [visible] });

    assert.equal(run.status, "completed");
    assert.equal(model.secondWindowRequested, true);
    assert.equal(model.sawConvergenceTurn, true);
    assert.equal(model.executionCalls, 3);
    const events = await runs.events(owner.user.id, run.id);
    assert.equal(events.some((event) =>
      event.type === "loop.convergence_queued"
      && (event.data as { reason?: string }).reason === "lookup_evidence_ready"
    ), true);
  } finally {
    await fs.rm(visible, { recursive: true, force: true });
    database.close();
  }
});

test("lookup source-summary steps converge when repeated reads add no new sources", async () => {
  const database = new AppDatabase(":memory:");
  const visible = await fs.mkdtemp(join(tmpdir(), "agentloop-repeat-source-"));
  try {
    for (let index = 1; index <= 6; index += 1) {
      await fs.writeFile(join(visible, `KB-${String(index).padStart(4, "0")}.md`), `# Topic ${index}\n分类：差旅报支\nFact ${index}\n`);
    }

    const skills = new SkillService(database);
    const owner = testOwner();
    const model = new RepeatedSourceReadModel();
    const planner: Planner = {
      plan: async () => ({
        goal: "collect bounded source evidence without rereading forever",
        selectedSkillIds: [],
        steps: [{
          id: "collect-source",
          objective: "Find and read local knowledge files, then provide a bounded source summary.",
          dependencies: [],
          skillIds: [],
          role: "fact_acquisition",
          requiredCapabilities: ["visible_directory_read"],
          evidenceContract: {
            requiredKinds: ["source_summary", "explicit_caveats"],
            caveatPolicy: "mark_unverified_facts",
          },
          successCriteria: [
            { id: "source_summary", description: "A bounded source summary is available.", source: "planner" },
            { id: "explicit_caveats", description: "Source caveats are recorded.", source: "planner" },
          ],
        }],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
    });

    const run = await runs.execute(owner.user.id, "总结差旅报支知识", { visibleDirectories: [visible] });

    assert.equal(run.status, "completed");
    assert.equal(model.sawConvergenceTurn, true);
    assert.equal(model.executionCalls, 4);
    assert.match(run.output ?? "", /repeat_source_reads/);
    const events = await runs.events(owner.user.id, run.id);
    assert.ok(events.some((event) =>
      event.type === "loop.convergence_queued"
      && (event.data as { reason?: string }).reason === "lookup_evidence_ready:repeat_source_reads"
    ));
  } finally {
    await fs.rm(visible, { recursive: true, force: true });
    database.close();
  }
});

test("web source-summary steps converge only after bounded distinct source reads", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const model = new WebSourceSummaryConvergenceModel();
    const websearch = webSearchFixtureTool([
      "https://source.test/one",
      "https://source.test/two",
      "https://source.test/three",
    ]);
    const webfetch = webFetchFixtureTool();
    const planner: Planner = {
      plan: async () => ({
        goal: "collect web source evidence",
        selectedSkillIds: [],
        steps: [{
          ...step("collect-web-sources"),
          role: "fact_acquisition",
          objective: "Read representative web sources and return a bounded source summary.",
          requiredCapabilities: ["web_research"],
          evidenceContract: {
            requiredKinds: ["source_summary", "source_urls", "explicit_caveats"],
            caveatPolicy: "mark_unverified_facts",
          },
          successCriteria: [
            { id: "source_summary", description: "A source summary receipt is present.", source: "planner" },
            { id: "source_urls", description: "Source URLs are recorded.", source: "planner" },
            { id: "explicit_caveats", description: "Source caveats are explicit.", source: "planner" },
          ],
        }],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
      tools: [websearch, webfetch],
      maxSteps: 6,
    });

    const run = await runs.execute(owner.user.id, "collect web source evidence");

    assert.equal(run.status, "completed");
    assert.equal(model.sawConvergenceTurn, true);
    assert.equal(model.fetchCalls, 3);
    assert.equal(model.assessmentCalls, 0);
    const events = await runs.events(owner.user.id, run.id);
    assert.equal(events.some((event) =>
      event.type === "loop.convergence_queued"
      && (event.data as { reason?: string }).reason === "lookup_evidence_ready:bounded_source_reads"
    ), true);
    const latestAssessment = (await runs.plan(owner.user.id, run.id)).assessments.at(-1);
    assert.equal(latestAssessment?.approved, true);
    assert.equal(latestAssessment?.assessmentProfile, "evidence_gate");
    assert.equal(latestAssessment?.assessmentMethod, "rule");
  } finally {
    database.close();
  }
});

test("web source-summary steps do not converge from search metadata alone", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const skills = new SkillService(database);
    const owner = testOwner();
    const model = new WebSearchThenFetchSourceSummaryModel();
    const websearch = webSearchFixtureTool([
      "https://source.test/one",
    ]);
    const webfetch = webFetchFixtureTool();
    const planner: Planner = {
      plan: async () => ({
        goal: "collect current market price evidence",
        selectedSkillIds: [],
        steps: [{
          ...step("collect-market-price"),
          role: "fact_acquisition",
          objective: "Search current market price sources and return a bounded source summary.",
          requiredCapabilities: ["web_research"],
          evidenceContract: {
            requiredKinds: ["source_summary", "source_urls", "explicit_caveats"],
            caveatPolicy: "mark_unverified_facts",
          },
          successCriteria: [
            { id: "source_summary", description: "A source summary receipt is present.", source: "planner" },
            { id: "source_urls", description: "Source URLs are recorded.", source: "planner" },
            { id: "explicit_caveats", description: "Source caveats are explicit.", source: "planner" },
          ],
        }],
      }),
    };
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => planner,
      tools: [websearch, webfetch],
      maxSteps: 6,
    });

    const run = await runs.execute(owner.user.id, "查一下当前市场价格");

    assert.equal(run.status, "completed");
    assert.equal(model.sawToolEnabledFetchTurn, true);
    assert.equal(model.sawConvergenceTurn, true);
    assert.equal(model.executionCalls, 3);
    const events = await runs.events(owner.user.id, run.id);
    assert.equal(events.filter((event) => event.type === "loop.convergence_queued").length, 1);
    assert.equal(events.some((event) =>
      event.type === "loop.convergence_queued"
      && (event.data as { reason?: string }).reason === "lookup_evidence_ready:bounded_source_reads"
    ), true);
    assert.equal(events.some((event) =>
      event.type === "loop.convergence_requested"
      && (event.data as { priorToolResultCount?: number }).priorToolResultCount === 1
    ), false);
  } finally {
    database.close();
  }
});

test("Structured planning, execution, assessment, and terminal commit form one complete chain", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const skill = await skills.create(owner.user.id, {
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
    const detail = await runs.plan(owner.user.id, run.id);
    assert.equal(detail.plan.status, "completed");
    assert.equal(detail.assessments.length, 1);
    assert.equal(detail.assessments[0].approved, true);
    const actions = await runs.actionsForRun(owner.user.id, run.id);
    assert.ok(actions.every((action) => action.state === "succeeded"));
    assert.ok(actions.some((action) => action.kind === "planning"));
    assert.ok(actions.some((action) => action.kind === "model_turn"));
    assert.ok(actions.some((action) => action.kind === "assessment"));
    const outcome = await database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
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

    const skills = new SkillService(database);
    const owner = testOwner();
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
          requiredCapabilities: ["external_api_call"],
          successCriteria: [{ id: "artifact-ready", description: "A verified artifact is produced.", source: "planner" }],
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
    const detail = await runs.plan(owner.user.id, run.id);
    assert.equal(detail.plan.status, "completed");
    assert.equal(detail.assessments.length, 1);
    assert.equal(detail.assessments[0].approved, true);
    const proofAction = (await runs.actionsForRun(owner.user.id, run.id))
      .find((action) => action.kind === "tool_call");
    assert.equal(proofAction?.state, "succeeded");
    assert.equal(proofAction?.replayPolicy, "safe");
    const events = await runs.events(owner.user.id, run.id);
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
    const committed = events.find((event) => event.type === "tool.result_committed" && event.data.toolCallId === "proof-1");
    const completed = events.find((event) => event.type === "tool.completed" && event.data.toolCallId === "proof-1");
    const completedResult = JSON.stringify({ artifact: "ready", validation: "passed" });
    assert.equal(committed?.data.result, undefined);
    assert.equal(committed?.data.resultCharacters, completedResult.length);
    assert.equal(committed?.data.resultSha256, createHash("sha256").update(completedResult).digest("hex"));
    assert.equal(committed?.data.resultPreview, completedResult);
    assert.equal(completed?.data.result, completedResult);
    const terminalIndex = events.findIndex((event) => event.type === "terminal.delivery_committed");
    const completedIndex = events.findIndex((event) => event.type === "run.completed");
    assert.notEqual(terminalIndex, -1);
    assert.notEqual(completedIndex, -1);
    assert.equal(terminalIndex < completedIndex, true);
    assert.equal(events[terminalIndex].data.reasonCode, "plan_assessed_and_completed");
    const outcome = await database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
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

    const skills = new SkillService(database);
    const owner = testOwner();
    const planner: Planner = {
      plan: async () => ({
        goal: "produce poster files",
        selectedSkillIds: [],
        steps: [{
          id: "design-poster",
          objective: "Create a poster and output PNG and PDF files.",
          dependencies: [],
          skillIds: [],
          requiredCapabilities: ["workspace_artifact_write"],
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
    const events = await runs.events(owner.user.id, run.id);
    assert.equal(events.filter((event) => event.type === "loop.convergence_queued").length, 1);
    const requested = events.find((event) => event.type === "loop.convergence_requested");
    assert.match(String(requested?.data.reason), /required_file_artifacts_observed/);
    assert.equal(events.filter((event) => event.type === "tool.completed").length, 2);
    assert.equal(events.some((event) => event.type === "loop.limit_exceeded"), false);
    const detail = await runs.plan(owner.user.id, run.id);
    assert.equal(detail.assessments.length, 1);
    const outcome = await database.prepare("SELECT status, reason_code FROM run_outcomes WHERE run_id = ?")
      .get(run.id) as { status: string; reason_code: string };
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reason_code, "plan_assessed_and_completed");
  } finally {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a rejected artifact acceptance receipt keeps file repair tools available", async () => {
  const database = new AppDatabase(":memory:");
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-file-rejected-acceptance-"));
  try {
    const skills = new SkillService(database);
    const owner = testOwner();
    const planner: Planner = {
      plan: async () => ({
        goal: "produce a navigable HTML report",
        selectedSkillIds: [],
        steps: [{
          id: "produce-report",
          objective: "Create an HTML report with basic navigation and verify it.",
          dependencies: [],
          skillIds: [],
          requiredCapabilities: ["workspace_artifact_write", "artifact_acceptance"],
          evidenceContract: {
            requiredKinds: ["artifact_path", "artifact_non_empty", "artifact_acceptance"],
            caveatPolicy: "none",
          },
          successCriteria: [{
            id: "navigation",
            description: "Basic navigation works for the report.",
            source: "planner",
          }],
        }],
      }),
    };
    const model = new RejectedArtifactAcceptanceRepairModel();
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => model,
      plannerFactory: () => planner,
      assessorFactory: () => approvingSkillAssessor(),
    });

    const run = await runs.execute(owner.user.id, "make a navigable report", { allowDangerousTools: true });

    assert.equal(run.status, "completed");
    assert.equal(run.output, "report.html passed the repaired navigation acceptance check");
    assert.equal(model.calls, 5);
    const events = await runs.events(owner.user.id, run.id);
    assert.equal(events.filter((event) => event.type === "loop.convergence_queued").length, 1);
    assert.equal(events.some((event) => event.type === "run.failed"), false);
  } finally {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("file artifact convergence ignores command stdout that only mentions output paths", async () => {
  const database = new AppDatabase(":memory:");
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-file-stdout-mention-"));
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const planner: Planner = {
      plan: async () => ({
        goal: "produce poster files",
        selectedSkillIds: [],
        steps: [{
          id: "design-poster",
          objective: "Create a poster and output PNG and PDF files.",
          dependencies: [],
          skillIds: [],
          requiredCapabilities: ["workspace_artifact_write"],
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
      stepExecutionStrategy: createStepExecutionStrategyProfile("full-catalog"),
    });

    const run = await runs.execute(owner.user.id, "make a poster", { allowDangerousTools: true });

    assert.equal(run.status, "completed");
    assert.equal(run.output, "poster.png and poster.pdf are ready");
    assert.equal(model.calls, 3);
    const events = await runs.events(owner.user.id, run.id);
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

    const skills = new SkillService(database);
    const owner = testOwner();
    const planner: Planner = {
      plan: async () => ({
        goal: "produce poster files",
        selectedSkillIds: [],
        steps: [{
          id: "design-poster",
          objective: "Create a poster and output PNG and PDF files.",
          dependencies: [],
          skillIds: [],
          requiredCapabilities: ["workspace_artifact_write"],
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
    const events = await runs.events(owner.user.id, run.id);
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

    const skills = new SkillService(database);
    const owner = testOwner();
    const planner: Planner = {
      plan: async () => ({
        goal: "verify deck artifact",
        selectedSkillIds: [],
        steps: [{
          id: "verify-deck",
          objective: "Verify existing deck.pptx with QA checks.",
          dependencies: [],
          skillIds: [],
          requiredCapabilities: ["workspace_artifact_write"],
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
      stepExecutionStrategy: createStepExecutionStrategyProfile("full-catalog"),
    });

    const run = await runs.execute(owner.user.id, "verify deck", { allowDangerousTools: true });

    assert.equal(run.status, "completed");
    assert.equal(run.output, "deck.pptx was inspected and verified by QA command");
    assert.equal(model.calls, 2);
    const events = await runs.events(owner.user.id, run.id);
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

    const skills = new SkillService(database);
    const owner = testOwner();
    const runId = "recovery-revision-run";
    await database.prepare(`
      INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "produce the requested artifact", Date.now());
    const plans = new PlanRepository(database);
    const plan = await plans.create(admitPlan({
      runId,
      proposal: {
        goal: "produce the requested artifact",
        selectedSkillIds: [],
        steps: [step("build"), { ...step("critique-polish"), dependencies: ["build"] }],
      },
      availableSkills: [],
      availableToolNames: new Set(),
    }));
    await plans.startStep(plan.id, "build");
    await plans.saveAssessment({
      id: "build-assessment", planId: plan.id, stepId: "build", attempt: 1, approved: true,
      criteria: [{ criterionId: "build-done", satisfied: true, rationale: "canonical evidence", evidenceRefs: ["candidateOutput"] }],
      skills: [], evidenceDigest: "build-evidence", feedback: "", createdAt: Date.now(),
    });
    await plans.completeStep(plan.id, "build", "verified artifact", { candidateOutput: "verified artifact", toolCalls: [], modelSteps: 1 });
    const actions = new RuntimeActionRepository(database);
    const action = await actions.dispatch({
      runId, planId: plan.id, stepId: "critique-polish", kind: "model_turn", replayPolicy: "safe", deadlineMs: 1_000,
    });
    await database.prepare("UPDATE runtime_actions SET deadline_at = 0, lease_until = 0 WHERE id = ?").run(action.id);
    assert.equal(await actions.reconcileRunningRuns(), 1);
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
    assert.equal((await runs.get(owner.user.id, runId)).status, "completed");
    assert.equal((await runs.get(owner.user.id, runId)).output, "verified artifact");
    const revised = (await runs.plan(owner.user.id, runId)).plan;
    assert.equal(revised.status, "completed");
    assert.ok(revised.steps.find((item) => item.id === "critique-polish")?.retiredAt !== undefined);
    const outcome = await database.prepare("SELECT reason_code FROM run_outcomes WHERE run_id = ?").get(runId) as { reason_code: string };
    assert.equal(outcome.reason_code, "plan_assessed_and_completed");
  } finally {
    database.close();
  }
});

test("recovery never resumes an unsafe Action and preserves the Run for a new decision", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const runId = "unsafe-recovery-run";
    await database.prepare(`
      INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "perform external effect", Date.now());
    const actions = new RuntimeActionRepository(database);
    const action = await actions.dispatch({ runId, kind: "tool_call", replayPolicy: "unsafe", deadlineMs: 1_000 });
    await database.prepare("UPDATE runtime_actions SET deadline_at = 0, lease_until = 0 WHERE id = ?").run(action.id);
    await actions.reconcileRunningRuns();
    const runs = new RunService({
      database, skills, modelFactory: () => new StaticModel({ content: "", toolCalls: [], finishReason: "stop" }),
      recoveryPlannerFactory: () => ({
        decide: async () => ({ actionId: action.id, expectedActionRevision: 2, decision: "resume_step", rationale: "retry", evidenceRefs: [] }),
      }),
    });

    await assert.rejects(() => runs.advanceRecovery(owner.user.id, runId), (error: unknown) => hasCode(error, "TOOL_POLICY_DENIED"));
    assert.equal((await runs.get(owner.user.id, runId)).status, "running");
    const recovery = await runs.recoveryForRun(owner.user.id, runId);
    assert.equal(recovery.state?.state, "waiting_recovery");
    assert.equal(recovery.decisions[0]?.state, "rejected");
  } finally {
    database.close();
  }
});

test("recovery records a user question instead of inferring an unsafe external fact", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const runId = "question-recovery-run";
    await database.prepare(`
      INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "confirm whether email was sent", Date.now());
    const actions = new RuntimeActionRepository(database);
    const action = await actions.dispatch({ runId, kind: "tool_call", replayPolicy: "unsafe", deadlineMs: 1_000 });
    await database.prepare("UPDATE runtime_actions SET deadline_at = 0, lease_until = 0 WHERE id = ?").run(action.id);
    await actions.reconcileRunningRuns();
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
    assert.equal((await runs.get(owner.user.id, runId)).status, "running");
  } finally {
    database.close();
  }
});

test("source contract mismatch routes recovery into a Plan revision instead of repeating the same leaf repair", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const skills = new SkillService(database);
    const owner = testOwner();
    const runId = "plan-revision-recovery-run";
    const planner: Planner = {
      plan: async () => ({
        goal: "summarize the API catalog with structured receipts",
        selectedSkillIds: [],
        steps: [{
          id: "summarize-api-catalog",
          objective: "Summarize the API catalog with a source receipt and explicit caveats.",
          dependencies: [],
          role: "deliver",
          skillIds: [],
          requiredCapabilities: [],
          evidenceContract: {
            requiredKinds: ["source_summary", "explicit_caveats"],
            caveatPolicy: "mark_unverified_facts",
          },
          successCriteria: [
            { id: "source_summary", description: "A structured source summary receipt is present.", source: "planner" },
            { id: "explicit_caveats", description: "Explicit caveats are recorded.", source: "planner" },
          ],
        }],
      }),
    };
    let initialAssessment = true;
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => new StaticModel({ content: "repaired result", toolCalls: [], finishReason: "stop" }),
      plannerFactory: () => planner,
      assessorFactory: () => ({
        assess: async (input) => {
          const approved = !initialAssessment && input.step.role === "repair";
          if (initialAssessment) initialAssessment = false;
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
                ? "The revised Plan step is acceptable."
                : "The original step still lacks the required Runtime evidence receipt.",
              evidenceRefs: approved ? ["candidateOutput"] : ["functions.computer_write_file:9"],
            })),
            skills: [],
            evidenceDigest: `digest-${input.step.id}`,
            feedback: approved
              ? ""
              : "Completion rejected by principle assessment; provide the missing Runtime evidence receipt or repair the failed receipt.",
            ...(approved ? {} : {
              failedBoundary: {
                stepId: input.step.id,
                missingEvidenceKinds: ["source_summary", "explicit_caveats"],
                violatedSkillRequirements: [],
                reusableEvidenceRefs: ["artifact-receipt"],
                suggestedRepairShape: "repair_leaf" as const,
              },
            }),
            createdAt: Date.now(),
          };
        },
      }),
      recoveryPlannerFactory: () => ({
        decide: async (input) => {
          assert.deepEqual(input.failedBoundary?.missingEvidenceKinds, ["source_summary", "explicit_caveats"]);
          return {
            actionId: input.action.id,
            expectedActionRevision: input.action.revision,
            decision: "revise_plan",
            rationale: "The original leaf pointed at source receipts, but the persisted evidence is artifact-shaped; revise the Plan boundary.",
            evidenceRefs: ["functions.computer_write_file:9"],
            planRevision: {
              shape: "recovery_patch",
              goal: input.plan?.goal ?? "summarize the API catalog with structured receipts",
              selectedSkillIds: [],
              steps: [{
                id: "summarize-api-catalog.repair.2",
                objective: "Repair the Plan boundary so the run can complete from the evidence that actually exists.",
                dependencies: [],
                role: "repair",
                skillIds: [],
                requiredCapabilities: [],
                evidenceContract: {
                  requiredKinds: ["delivery_receipt"],
                  caveatPolicy: "none",
                },
                successCriteria: [
                  { id: "delivery_receipt", description: "The revised step records a delivery receipt.", source: "planner" },
                ],
              }],
            },
          };
        },
      }),
      planRevisionAssessorFactory: () => ({
        assess: async () => ({
          approved: true,
          feedback: "",
          evidenceRefs: ["candidateOutput"],
        }),
      }),
    });

    const run = await runs.execute(owner.user.id, "查询宝武集团数据中台中员工画像API 的参数信息");
    const waiting = await waitForRecoveryState(runs, owner.user.id, run.id, "waiting_recovery");
    assert.equal(waiting.state?.state, "waiting_recovery");
    await database.prepare(`
      INSERT INTO run_events(run_id, seq, type, payload_json, created_at)
      VALUES (?, ?, 'tool.completed', ?, ?)
    `).run(
      run.id,
      10_000,
      JSON.stringify({
        toolCallId: "artifact-receipt",
        toolName: "implementation_detail_is_irrelevant",
        result: JSON.stringify({
          artifactReceipt: {
            schema: "agentloop.artifactReceipt/v1",
            evidenceKinds: { satisfied: ["artifact_path"], caveated: [], failed: [] },
          },
        }),
      }),
      Date.now(),
    );

    const recovery = await runs.advanceRecovery(owner.user.id, run.id);
    assert.equal(recovery.decisions[0]?.decision, "revise_plan");
    assert.equal(recovery.decisions[0]?.planRevision?.steps[0].id, "summarize-api-catalog.repair.2");
    assert.deepEqual(recovery.decisions[0]?.planRevision?.steps[0].evidenceContract, {
      requiredKinds: ["delivery_receipt"],
      caveatPolicy: "none",
    });
    assert.equal((await runs.get(owner.user.id, run.id)).status, "completed");
  } finally {
    database.close();
  }
});

test("safe recovery rebuilds only complete exchanges, resumes the interrupted step, and continues dependent Plan work", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const runId = "recovery-resume-run";
    await database.prepare(`
      INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "recover the interrupted work", Date.now());
    const plans = new PlanRepository(database);
    const plan = await plans.create(admitPlan({
      runId,
      proposal: {
        goal: "recover the interrupted work",
        selectedSkillIds: [],
        steps: [step("build"), { ...step("verify"), dependencies: ["build"] }],
      },
      availableSkills: [],
      availableToolNames: new Set(),
    }));
    await plans.startStep(plan.id, "build");
    const actions = new RuntimeActionRepository(database);
    const action = await actions.dispatch({
      runId, planId: plan.id, stepId: "build", kind: "model_turn", replayPolicy: "safe", deadlineMs: 1_000,
    });
    await database.prepare(`
      INSERT INTO run_events(run_id, seq, type, payload_json, created_at) VALUES
        (?, 20, 'plan.step.started', ?, ?),
        (?, 21, 'assistant.committed', ?, ?),
        (?, 22, 'tool.effect_pending', ?, ?)
    `).run(
      runId, JSON.stringify({ planId: plan.id, stepId: "build" }), Date.now(),
      runId, JSON.stringify({ step: 1, content: "", toolCalls: [{ id: "unfinished-tool", name: "external_write", arguments: {} }] }), Date.now(),
      runId, JSON.stringify({ step: 1, toolCallId: "unfinished-tool", toolName: "external_write", replaySafe: true }), Date.now(),
    );
    await database.prepare("UPDATE runtime_actions SET deadline_at = 0, lease_until = 0 WHERE id = ?").run(action.id);
    await actions.reconcileRunningRuns();
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
    const detail = await runs.plan(owner.user.id, runId);
    assert.ok(detail.plan.steps.every((item) => item.status === "completed"));
    assert.equal(detail.assessments.length, 2);
    assert.ok(detail.assessments.every((assessment) => assessment.approved));
    assert.equal((await runs.recoveryForRun(owner.user.id, runId)).state, undefined);
  } finally {
    database.close();
  }
});

test("a persisted user recovery response reopens Planner decision-making for the same Action", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const runId = "recovery-answer-run";
    await database.prepare(`
      INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, NULL, 0, 0, 'running', ?, ?)
    `).run(runId, owner.user.id, "confirm external effect", Date.now());
    const actions = new RuntimeActionRepository(database);
    const action = await actions.dispatch({ runId, kind: "tool_call", replayPolicy: "unsafe", deadlineMs: 1_000 });
    await database.prepare("UPDATE runtime_actions SET deadline_at = 0, lease_until = 0 WHERE id = ?").run(action.id);
    await actions.reconcileRunningRuns();
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
    const answered = await runs.respondRecovery(owner.user.id, runId, "No, it was not applied.");
    assert.equal(answered.state?.state, "waiting_recovery");
    assert.equal(answered.userResponses[0]?.response, "No, it was not applied.");
    await runs.advanceRecovery(owner.user.id, runId);
    assert.equal(decisions, 2);
    assert.equal((await runs.get(owner.user.id, runId)).status, "failed");
    assert.equal((await runs.recoveryForRun(owner.user.id, runId)).decisions.filter((item) => item.state === "admitted").length, 2);
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

class ArtifactAcceptanceGateModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  assessmentCalls = 0;
  private loaded = false;
  private materialized = false;
  private verified = false;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.phase === "assessment") {
      this.assessmentCalls += 1;
      throw new Error("artifact acceptance gate should use rule assessment");
    }
    if (request.phase !== "execution") {
      return { content: "", finishReason: "stop", toolCalls: [] };
    }
    const toolNames = request.tools.map((tool) => tool.name);
    if (!this.loaded && toolNames.includes("load_skill")) {
      this.loaded = true;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "load-html-skill", name: "load_skill", arguments: { name: "html-training-builder" } }],
      };
    }
    if (!this.materialized && toolNames.includes("materialize_paginated_html")) {
      this.materialized = true;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "materialize-html",
          name: "materialize_paginated_html",
          arguments: {
            path: "deliverables/training.html",
            title: "Training",
            renderMode: "slides",
            acceptanceProfile: "html_ppt",
            pages: [
              { title: "Overview", bullets: ["Goal", "Evidence", "Acceptance"] },
              { title: "Delivery", body: "The artifact is generated from a compact page specification." },
            ],
          },
        }],
      };
    }
    if (!this.verified && toolNames.includes("verify_artifact_acceptance")) {
      this.verified = true;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "verify-html",
          name: "verify_artifact_acceptance",
          arguments: { artifactPath: "deliverables/training.html", profileId: "html_ppt" },
        }],
      };
    }
    return {
      content: "Created deliverables/training.html with artifact_acceptance evidence.",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class SourceSummaryGateModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  assessmentCalls = 0;
  private indexed = false;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.phase === "assessment") {
      this.assessmentCalls += 1;
      throw new Error("source summary gate should use rule assessment");
    }
    if (request.phase !== "execution") {
      return { content: "", finishReason: "stop", toolCalls: [] };
    }
    const toolNames = request.tools.map((tool) => tool.name);
    if (!this.indexed && toolNames.includes("visible_index_directory")) {
      this.indexed = true;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "index-source",
          name: "visible_index_directory",
          arguments: { rootId: "visible_dir_1", path: ".", sampleLimit: 5 },
        }],
      };
    }
    return {
      content: "Delivered a caveated source summary from the visible directory index; file bodies were not all read.",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class SourceFactAcquisitionActionAwareModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  sourceId = "";
  firstToolNames: string[] = [];
  sawActionAwareProjection = false;
  private executionCalls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.phase !== "execution") {
      return { content: "", finishReason: "stop", toolCalls: [] };
    }
    this.executionCalls += 1;
    const toolNames = request.tools.map((tool) => tool.name);
    if (this.executionCalls === 1) {
      this.firstToolNames = toolNames;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "read-uploaded-source",
          name: "read_source",
          arguments: { sourceId: this.sourceId, chunkIndex: 0, maxChunks: 1 },
        }],
      };
    }
    this.sawActionAwareProjection = /<prompt_projection_policy source="server">[\s\S]*"mode":"action_aware"/.test(
      request.runtimeContext?.content ?? "",
    );
    return {
      content: "Uploaded source facts are available with explicit caveats recorded in the source receipt.",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class CommandSourceReceiptGateModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  assessmentCalls = 0;
  private loaded = false;
  private queried = false;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.phase === "assessment") {
      this.assessmentCalls += 1;
      throw new Error("command source receipt gate should use rule assessment");
    }
    if (request.phase !== "execution") {
      return { content: "", finishReason: "stop", toolCalls: [] };
    }
    const toolNames = request.tools.map((tool) => tool.name);
    if (!this.loaded && toolNames.includes("load_skill")) {
      this.loaded = true;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "load-api-query", name: "load_skill", arguments: { name: "api-query" } }],
      };
    }
    if (!this.queried && toolNames.includes("computer_run_command")) {
      this.queried = true;
      const payload = {
        schema: "api_catalog_result/v1",
        deliveryCandidate: { output: "Found one API catalog candidate from the source-provider command." },
        evidenceReceipt: {
          schema: "agentloop.toolEvidenceReceipt/v1",
          sourceType: "api_catalog",
          receiptId: "command-source-receipt-1",
          sourceRefs: [{ url: "https://eplat.baocloud.cn/service/D_A_BSTABD00_SHUTU_AGENT" }],
          facts: [{ kind: "source_summary", match_count: 1, primary_api_id: "M.TEST.D_A_TEST" }],
          caveats: ["Candidate ranking requires confirmation with an exact API_ID."],
          evidenceKinds: {
            satisfied: ["source_summary", "source_urls"],
            caveated: ["explicit_caveats"],
            failed: [],
          },
        },
      };
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "query-api-catalog",
          name: "computer_run_command",
          arguments: {
            command: "trusted-node",
            args: ["-e", `process.stdout.write(${JSON.stringify(JSON.stringify(payload))})`],
          },
        }],
      };
    }
    return {
      content: "Delivered API catalog summary with explicit source caveats.",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class BoundedSourceReadModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  assessmentCalls = 0;
  executionCalls = 0;
  sawConvergenceTurn = false;
  private found = false;
  private read = false;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.phase === "assessment") {
      this.assessmentCalls += 1;
      throw new Error("bounded source summary gate should use rule assessment");
    }
    if (request.phase !== "execution") {
      return { content: "", finishReason: "stop", toolCalls: [] };
    }
    this.executionCalls += 1;
    const toolNames = request.tools.map((tool) => tool.name);
    if (!this.found && toolNames.includes("visible_find_files")) {
      this.found = true;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "find-kb",
          name: "visible_find_files",
          arguments: { rootId: "visible_dir_1", pattern: "*.md", limit: 20 },
        }],
      };
    }
    if (!this.read && toolNames.includes("visible_read_files")) {
      this.read = true;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "read-kb",
          name: "visible_read_files",
          arguments: {
            rootId: "visible_dir_1",
            files: [1, 2, 3, 4, 5].map((index) => ({ path: `KB-${String(index).padStart(4, "0")}.md` })),
            maxTotalCharacters: 20_000,
          },
        }],
      };
    }
    this.sawConvergenceTurn = true;
    assert.equal(request.tools.length, 0);
    assert.match(request.runtimeContext?.content ?? "", /agentloop\.sourceSummaryCandidate\/v1/);
    return {
      content: JSON.stringify({
        schema: "agentloop.sourceSummaryCandidate/v1",
        coveredTopics: ["差旅报支"],
        facts: [{
          claim: "Five source files were read and summarized as bounded source evidence.",
          sourceRefs: ["read-kb"],
          confidence: "source_supported",
        }],
        missingOrUnverified: [],
        recommendedNextStep: "produce_report",
      }),
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class VisibleReadContinuationModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  executionCalls = 0;
  secondWindowRequested = false;
  sawConvergenceTurn = false;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.phase === "assessment") {
      throw new Error("visible continuation source gate should use rule assessment");
    }
    if (request.phase !== "execution") {
      return { content: "", finishReason: "stop", toolCalls: [] };
    }
    this.executionCalls += 1;
    const toolNames = request.tools.map((tool) => tool.name);
    if (this.executionCalls === 1) {
      assert.equal(toolNames.includes("visible_read_files"), true);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "read-first-window",
          name: "visible_read_files",
          arguments: {
            rootId: "visible_dir_1",
            files: [{ path: "long-plan.md", offset: 1, limit: 200 }],
          },
        }],
      };
    }
    if (this.executionCalls === 2) {
      assert.equal(toolNames.includes("visible_read_files"), true);
      this.secondWindowRequested = true;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "read-second-window",
          name: "visible_read_files",
          arguments: {
            rootId: "visible_dir_1",
            files: [{ path: "long-plan.md", offset: 201, limit: 200 }],
          },
        }],
      };
    }
    this.sawConvergenceTurn = true;
    assert.equal(request.tools.length, 0);
    return {
      content: "已读取 long-plan.md 的两个连续窗口并形成带证据边界的详细总结。",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class PlannedDirectAnswerModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  readonly executionToolCounts: number[] = [];
  assessmentCalls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.phase === "assessment") {
      this.assessmentCalls += 1;
      throw new Error("direct-answer delivery should use deterministic rule assessment");
    }
    if (request.phase !== "execution") {
      return { content: "", finishReason: "stop", toolCalls: [] };
    }
    this.executionToolCounts.push(request.tools.length);
    return {
      content: "根据上一轮已取得的信息，宝信软件董事长是夏雪松。",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class ProduceSourceSummaryModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  sawSourceSummaryConvergencePrompt = false;
  sourceId = "";
  private calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.phase !== "execution") return { content: "", finishReason: "stop", toolCalls: [] };
    this.calls += 1;
    const context = request.runtimeContext?.content ?? "";
    if (/agentloop\.sourceSummaryCandidate\/v1/.test(context)) this.sawSourceSummaryConvergencePrompt = true;
    if (this.calls === 1) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "read-source",
          name: "read_source",
          arguments: { sourceId: this.sourceId, maxChunks: 1 },
        }],
      };
    }
    return {
      content: "外事业务十五五 AI 工作计划可总结为：围绕AI风险预警、合规检查和照片AI质检推进智能化外事服务。",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class UploadedSourceCoverageModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  sourceId = "";
  executionCalls = 0;
  sawConvergenceTurn = false;
  repeatedReadAttempted = false;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.phase !== "execution") return { content: "", finishReason: "stop", toolCalls: [] };
    this.executionCalls += 1;
    if (this.executionCalls === 1) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "read-first-half",
          name: "read_source",
          arguments: { sourceId: this.sourceId, chunkIndex: 0, maxChunks: 3 },
        }],
      };
    }
    if (this.executionCalls === 2) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "read-second-half",
          name: "read_source",
          arguments: { sourceId: this.sourceId, chunkIndex: 3, maxChunks: 3 },
        }],
      };
    }
    this.sawConvergenceTurn = true;
    assert.equal(request.tools.length, 0);
    assert.match(request.runtimeContext?.content ?? "", /runtime_source_evidence_convergence/);
    assert.doesNotMatch(request.runtimeContext?.content ?? "", /uploadedSourceCoverage/);
    this.repeatedReadAttempted = request.tools.some((tool) => tool.name === "read_source");
    return {
      content: "已基于上传材料的全部 chunk 覆盖生成中文总结。",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class StructuredUploadExtractionModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  sourceId = "";
  executionCalls = 0;
  sawConvergenceTurn = false;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.phase !== "execution") return { content: "", finishReason: "stop", toolCalls: [] };
    this.executionCalls += 1;
    if (this.executionCalls === 1) {
      assert.equal(request.tools.some((tool) => tool.name === "extract_source_tables"), true);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "extract-task-table",
          name: "extract_source_tables",
          arguments: { sourceId: this.sourceId, maxRowsPerSheet: 100 },
        }],
      };
    }
    this.sawConvergenceTurn = true;
    assert.equal(request.tools.length, 0);
    assert.match(request.runtimeContext?.content ?? "", /agentloop\.sourceSummaryCandidate\/v1/);
    return {
      content: JSON.stringify({
        schema: "agentloop.sourceSummaryCandidate/v1",
        coveredTopics: ["任务名称和责任人"],
        facts: [{
          claim: "tasks.csv 已完整提取为结构化表格，共 2 条任务记录，可供后续按责任人聚合。",
          sourceRefs: ["extract-task-table"],
          confidence: "source_supported",
        }],
        missingOrUnverified: [],
        recommendedNextStep: "aggregate_tasks_by_owner",
      }),
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class LargeUploadedSourceBoundedModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  sourceId = "";
  executionCalls = 0;
  sawConvergenceTurn = false;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.phase !== "execution") return { content: "", finishReason: "stop", toolCalls: [] };
    this.executionCalls += 1;
    if (this.executionCalls === 1) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "read-large-first-window",
          name: "read_source",
          arguments: { sourceId: this.sourceId, chunkIndex: 0, maxChunks: 3 },
        }],
      };
    }
    this.sawConvergenceTurn = true;
    assert.equal(request.tools.length, 0);
    assert.match(request.runtimeContext?.content ?? "", /runtime_source_evidence_convergence/);
    assert.doesNotMatch(request.runtimeContext?.content ?? "", /uploadedSourceCoverage/);
    return {
      content: "已基于上传材料的已读 chunk 生成中文总结，并保留未覆盖内容的 caveat。",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class FactAcquisitionReadSkillModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  sourceId = "";
  executionCalls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.phase !== "execution") {
      return { content: "", finishReason: "stop", toolCalls: [] };
    }
    this.executionCalls += 1;
    if (this.executionCalls <= 4) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: `read-source-${this.executionCalls}`,
          name: "read_source",
          arguments: {
            sourceId: this.sourceId,
            chunkIndex: this.executionCalls - 1,
            maxChunks: 1,
          },
        }],
      };
    }
    return {
      content: "已基于上传 PDF 的多个 chunk 完成中文要点整理。",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class RepeatedSourceReadModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  executionCalls = 0;
  sawConvergenceTurn = false;
  private found = false;
  private readCount = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.phase === "assessment") {
      throw new Error("repeated source summary gate should use rule assessment");
    }
    if (request.phase !== "execution") {
      return { content: "", finishReason: "stop", toolCalls: [] };
    }
    this.executionCalls += 1;
    const toolNames = request.tools.map((tool) => tool.name);
    if (!this.found && toolNames.includes("visible_find_files")) {
      this.found = true;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "find-kb",
          name: "visible_find_files",
          arguments: { rootId: "visible_dir_1", pattern: "*.md", limit: 20 },
        }],
      };
    }
    if (this.readCount < 2 && toolNames.includes("visible_read_files")) {
      this.readCount += 1;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: `read-kb-${this.readCount}`,
          name: "visible_read_files",
          arguments: {
            rootId: "visible_dir_1",
            files: [1, 2, 3, 4].map((index) => ({ path: `KB-${String(index).padStart(4, "0")}.md` })),
            maxTotalCharacters: 20_000,
          },
        }],
      };
    }
    this.sawConvergenceTurn = true;
    assert.equal(request.tools.length, 0);
    return {
      content: JSON.stringify({
        schema: "agentloop.sourceSummaryCandidate/v1",
        coveredTopics: ["bounded repeat source reads"],
        facts: [{
          claim: "Repeated reads added no new sources, so the runtime converged to a bounded source summary.",
          sourceRefs: ["read-kb-1", "read-kb-2"],
          confidence: "source_supported",
        }],
        missingOrUnverified: ["reason:lookup_evidence_ready:repeat_source_reads"],
        recommendedNextStep: "produce_report",
      }),
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class InspectSkillModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  sawInstruction = false;
  private calls = 0;
  private readonly loadSkillArgument: string;
  private readonly catalogPattern: RegExp;

  constructor(
    loadSkillArgument = "strict-private",
    catalogPattern: RegExp = /strict-private/,
  ) {
    this.loadSkillArgument = loadSkillArgument;
    this.catalogPattern = catalogPattern;
  }

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.match(request.runtimeContext?.content ?? "", this.catalogPattern);
      assert.doesNotMatch(request.runtimeContext?.content ?? "", /MANDATORY-PRIVATE-INSTRUCTION/);
      assert.ok(request.tools.some((tool) => tool.name === "load_skill"));
      assert.equal(request.toolChoice, "auto");
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "load", name: "load_skill", arguments: { name: this.loadSkillArgument } }],
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

class RejectedRepairLeafGrantModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;
  sawRepairDirective = false;
  runToolVisibleDuringRepair = false;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    const toolNames = request.tools.map((tool) => tool.name);
    if (this.calls === 1) {
      assert.equal(toolNames.includes("computer_read_file"), true);
      return { content: "premature downstream answer", finishReason: "stop", toolCalls: [] };
    }
    if (this.calls === 2) {
      this.sawRepairDirective = /runtime_candidate_repair/.test(request.runtimeContext?.content ?? "");
      this.runToolVisibleDuringRepair = toolNames.includes("computer_read_file");
      assert.equal(this.sawRepairDirective, true);
      assert.equal(this.runToolVisibleDuringRepair, true);
      return { content: "bounded research repaired for the current leaf", finishReason: "stop", toolCalls: [] };
    }
    assert.equal(toolNames.includes("load_skill"), true);
    return { content: "downstream leaf complete", finishReason: "stop", toolCalls: [] };
  }
}

class RunAuthorizedCommandModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;
  commandToolWasVisible = false;
  requestedCommandOutsidePlanBinding = false;
  requiredCapabilityWasPresentInContext = false;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    const toolNames = request.tools.map((tool) => tool.name);
    this.commandToolWasVisible = this.commandToolWasVisible || toolNames.includes("computer_run_command");
    this.requiredCapabilityWasPresentInContext = this.requiredCapabilityWasPresentInContext
      || (request.runtimeContext?.content ?? "").includes("\"requiredCapabilities\":[\"workspace_file_read\"]");
    if (this.calls === 1) {
      assert.equal(toolNames.includes("computer_run_command"), true);
      this.requestedCommandOutsidePlanBinding = true;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "run-authorized-command",
          name: "computer_run_command",
          arguments: { command: "node", args: ["-e", "console.log('command completed')"] },
        }],
      };
    }
    return { content: "Ran a Run-authorized command while completing the current Plan objective.", toolCalls: [], finishReason: "stop" };
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
  sawRepairDirective = false;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.phase === "assessment") {
      throw new Error("missing-source-facts test uses a focused assessor");
    }
    this.executionCalls += 1;
    const toolNames = request.tools.map((tool) => tool.name);
    const currentStepIsWriteReport = (request.runtimeContext?.content ?? "").includes('"currentPlanStep":{"id":"write-report"');
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
    if (this.executionCalls >= 4 && !currentStepIsWriteReport) {
      const context = request.runtimeContext?.content ?? "";
      if (/runtime_candidate_repair/.test(context)) {
        this.sawRepairDirective = true;
        return {
          content: "Verified facts are limited to public metadata. The standard full text remains unverified, so missing source facts and exact clauses are not claimed as verified; downstream report content must label those sections as training interpretation.",
          finishReason: "stop",
          toolCalls: [],
        };
      }
      assert.match(context, /runtime_convergence/);
      return {
        content: "dcmm-training.html was generated from the bounded source outline and states the evidence boundary.",
        finishReason: "stop",
        toolCalls: [],
      };
    }
    if (currentStepIsWriteReport && toolNames.includes("computer_write_file")) {
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

class StrictSourceRequirementModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private executionCalls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.phase === "assessment") {
      throw new Error("strict-source test uses a focused assessor");
    }
    this.executionCalls += 1;
    const toolNames = request.tools.map((tool) => tool.name);
    if (this.executionCalls === 1) {
      assert.equal(toolNames.includes("websearch"), true);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "search-metadata", name: "websearch", arguments: { query: "official standard full text" } }],
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
    return {
      content: "无法交付：必须严格依据官方标准全文逐条核验，但当前只取得公开元数据，未取得官方标准全文，不能给出精确条款。",
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

class ResearchPolicyExecutionContextModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  readonly systemPrompts: string[] = [];
  readonly contexts: string[] = [];

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.phase === "assessment") {
      throw new Error("research-policy execution context test uses a focused assessor");
    }
    this.systemPrompts.push(request.systemPrompt);
    this.contexts.push(request.runtimeContext?.content ?? "");
    const stepId = /"currentPlanStep":\{"id":"write"/.test(request.runtimeContext?.content ?? "")
      ? "write"
      : "research";
    return {
      content: stepId === "research"
        ? "Bounded public source evidence is ready with caveats."
        : "The Markdown summary file is ready from the completed research evidence.",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class WebSourceSummaryConvergenceModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  executionCalls = 0;
  assessmentCalls = 0;
  fetchCalls = 0;
  sawConvergenceTurn = false;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.phase === "assessment") {
      this.assessmentCalls += 1;
      throw new Error("web source summary gate should use rule assessment");
    }
    this.executionCalls += 1;
    const toolNames = request.tools.map((tool) => tool.name);
    if (this.executionCalls === 1) {
      assert.equal(toolNames.includes("websearch"), true);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "search-web", name: "websearch", arguments: { query: "bounded web sources" } }],
      };
    }
    if (this.executionCalls >= 2 && this.executionCalls <= 4) {
      assert.equal(toolNames.includes("webfetch"), true);
      this.fetchCalls += 1;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: `fetch-web-${this.fetchCalls}`,
          name: "webfetch",
          arguments: { url: `https://source.test/${["one", "two", "three"][this.fetchCalls - 1]}` },
        }],
      };
    }
    this.sawConvergenceTurn = true;
    assert.equal(request.tools.length, 0);
    assert.match(request.runtimeContext?.content ?? "", /agentloop\.sourceSummaryCandidate\/v1/);
    return {
      content: JSON.stringify({
        schema: "agentloop.sourceSummaryCandidate/v1",
        coveredTopics: ["bounded web source reads"],
        facts: [{
          claim: "Three distinct web sources were read before source-summary convergence.",
          sourceRefs: ["fetch-web-1", "fetch-web-2", "fetch-web-3"],
          confidence: "source_supported",
        }],
        missingOrUnverified: [],
        recommendedNextStep: "produce_artifact",
      }),
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class WebSearchThenFetchSourceSummaryModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  executionCalls = 0;
  sawToolEnabledFetchTurn = false;
  sawConvergenceTurn = false;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.phase === "assessment") {
      throw new Error("web source summary metadata gate should use rule assessment");
    }
    this.executionCalls += 1;
    const toolNames = request.tools.map((tool) => tool.name);
    if (this.executionCalls === 1) {
      assert.equal(toolNames.includes("websearch"), true);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "search-market", name: "websearch", arguments: { query: "current market price" } }],
      };
    }
    if (this.executionCalls === 2) {
      assert.equal(toolNames.includes("webfetch"), true);
      this.sawToolEnabledFetchTurn = true;
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "fetch-market", name: "webfetch", arguments: { url: "https://source.test/one" } }],
      };
    }
    this.sawConvergenceTurn = true;
    assert.equal(request.tools.length, 0);
    assert.match(request.runtimeContext?.content ?? "", /agentloop\.sourceSummaryCandidate\/v1/);
    return {
      content: JSON.stringify({
        schema: "agentloop.sourceSummaryCandidate/v1",
        coveredTopics: ["current market price"],
        facts: [{
          claim: "A fetched web source provided the source summary evidence.",
          sourceRefs: ["fetch-market"],
          confidence: "source_supported",
        }],
        missingOrUnverified: [],
        recommendedNextStep: "answer_user",
      }),
      finishReason: "stop",
      toolCalls: [],
    };
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
              requiredCapabilities: [],
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

function toolCallResponse(id: string, name: string, arguments_: Record<string, unknown>): ModelResponse {
  return {
    content: "",
    finishReason: "tool_calls",
    toolCalls: [{ id, name, arguments: arguments_ }],
  };
}

class RejectedArtifactAcceptanceRepairModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.equal(request.tools.some((tool) => tool.name === "computer_write_file"), true);
      return toolCallResponse("write-incomplete-report", "computer_write_file", {
        path: "report.html",
        content: "<!doctype html><html><body><main>Weekly report</main></body></html>",
      });
    }
    if (this.calls === 2) {
      assert.equal(request.tools.some((tool) => tool.name === "verify_artifact_acceptance"), true);
      return toolCallResponse("verify-incomplete-report", "verify_artifact_acceptance", {
        artifactPath: "report.html",
        profileId: "html",
        checks: ["Basic navigation via in-page anchor links"],
      });
    }
    if (this.calls === 3) {
      assert.equal(request.tools.some((tool) => tool.name === "computer_write_file"), true);
      assert.doesNotMatch(request.runtimeContext?.content ?? "", /runtime_convergence/);
      return toolCallResponse("write-repaired-report", "computer_write_file", {
        path: "report-repaired.html",
        content: [
          "<!doctype html>",
          "<html><body>",
          "<nav><a href=\"#summary\">Summary</a><a href=\"#details\">Details</a></nav>",
          "<main><section id=\"summary\">Weekly report</section><section id=\"details\">Details</section></main>",
          "</body></html>",
        ].join(""),
      });
    }
    if (this.calls === 4) {
      assert.equal(request.tools.some((tool) => tool.name === "verify_artifact_acceptance"), true);
      return toolCallResponse("verify-repaired-report", "verify_artifact_acceptance", {
        artifactPath: "report-repaired.html",
        profileId: "html",
        checks: ["Basic navigation via in-page anchor links"],
      });
    }
    assert.deepEqual(request.tools, []);
    assert.match(request.runtimeContext?.content ?? "", /runtime_convergence/);
    return {
      content: "report.html passed the repaired navigation acceptance check",
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
    requiredCapabilities: [],
    executionBinding: {
      schema: "agentloop.stepExecutionBinding/v1",
      requiredCapabilities: [],
      resolvedToolNames: [],
      sourceKinds: [],
      sideEffect: "none",
      evidenceKinds: [],
    },
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
  sourceKinds: NonNullable<PrivateSkill["agentLoop"]>["sourceKinds"] = [],
  qaKinds: NonNullable<PrivateSkill["agentLoop"]>["qaKinds"] = [],
): NonNullable<PrivateSkill["agentLoop"]> {
  return { roles, artifactKinds, sourceKinds, qaKinds };
}

function instructionsWithAgentLoopMetadata(
  body: string,
  roles: NonNullable<PrivateSkill["agentLoop"]>["roles"] = ["primary_builder"],
  artifactKinds: NonNullable<PrivateSkill["agentLoop"]>["artifactKinds"] = ["none"],
  sourceKinds: NonNullable<PrivateSkill["agentLoop"]>["sourceKinds"] = [],
  qaKinds: NonNullable<PrivateSkill["agentLoop"]>["qaKinds"] = [],
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
    const recovery = await runs.recoveryForRun(ownerUserId, runId);
    if (recovery.state?.state === state) return recovery;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return await runs.recoveryForRun(ownerUserId, runId);
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

function rejectFirstResearchCandidateAssessor(): import("../src/planning/contracts.ts").StepAssessor {
  const attempts = new Map<string, number>();
  return {
    assess: async (input) => {
      const attempt = (attempts.get(input.step.id) ?? 0) + 1;
      attempts.set(input.step.id, attempt);
      const approved = input.step.id !== "research" || attempt > 1;
      return {
        id: `assessment-${input.step.id}-${input.attempt}`,
        planId: input.planId,
        stepId: input.step.id,
        attempt: input.attempt,
        approved,
        criteria: input.step.successCriteria.map((criterion) => ({
          criterionId: criterion.id,
          satisfied: approved,
          rationale: approved
            ? "The candidate is bounded to the current leaf."
            : "The candidate drifted beyond the current leaf and must be repaired in place.",
          evidenceRefs: ["candidateOutput"],
        })),
        skills: input.skills.map((skill) => ({
          skillId: skill.id,
          followed: approved,
          rationale: approved ? "The candidate is acceptable for this focused test." : "The candidate was rejected.",
          evidenceRefs: ["candidateOutput"],
        })),
        evidenceDigest: `reject-first-${input.step.id}-${attempt}`,
        feedback: approved ? "" : "Repair only the current research leaf; do not start downstream build work.",
        createdAt: Date.now(),
      };
    },
  };
}

function webSearchFixtureTool(urls: readonly string[]): RuntimeTool<unknown> {
  return {
    name: "websearch",
    description: "Search fixture web sources",
    inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string" } } },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, value) => {
      const query = typeof (value as { query?: unknown }).query === "string"
        ? (value as { query: string }).query
        : "query";
      return {
        schema: "agentloop.webSearch/v1",
        query,
        returned: urls.length,
        results: urls.map((url, index) => ({ title: `Source ${index + 1}`, url, snippet: `Snippet ${index + 1}` })),
        evidenceReceipt: webFixtureReceipt({
          sourceType: "web_search",
          sourceRefs: urls.map((url) => ({ sourceRefId: `web:${url}`, url, path: url })),
          facts: [{ kind: "source_urls", query, returned: urls.length, urls }],
          satisfied: ["source_urls"],
          caveats: ["Search results are discovery metadata."],
        }),
      };
    },
  };
}

function webFetchFixtureTool(): RuntimeTool<unknown> {
  return {
    name: "webfetch",
    description: "Fetch fixture web source text",
    inputSchema: { type: "object", additionalProperties: false, properties: { url: { type: "string" } } },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, value) => {
      const url = typeof (value as { url?: unknown }).url === "string"
        ? (value as { url: string }).url
        : "https://source.test/unknown";
      const content = `Fixture source content for ${url}`;
      return {
        schema: "agentloop.webFetch/v1",
        url,
        title: `Title ${url}`,
        content,
        bytes: content.length,
        truncated: false,
        evidenceReceipt: webFixtureReceipt({
          sourceType: "web_page",
          sourceRefs: [{ sourceRefId: `web:${url}`, url, path: url, characters: content.length }],
          facts: [{ kind: "source_summary", url, title: `Title ${url}`, characters: content.length }],
          satisfied: ["source_read", "source_summary", "source_urls"],
          caveats: ["Full Tool result remains in canonical events."],
        }),
      };
    },
  };
}

function webFixtureReceipt(input: {
  readonly sourceType: "web_search" | "web_page";
  readonly sourceRefs: readonly Record<string, unknown>[];
  readonly facts: readonly Record<string, unknown>[];
  readonly satisfied: readonly string[];
  readonly caveats: readonly string[];
}) {
  return {
    schema: "agentloop.toolEvidenceReceipt/v1",
    sourceType: input.sourceType,
    receiptId: `fixture:${input.sourceType}:${input.sourceRefs.length}:${input.facts.length}`,
    sourceRefs: input.sourceRefs,
    facts: input.facts,
    caveats: input.caveats,
    evidenceKinds: {
      satisfied: input.satisfied,
      caveated: input.caveats.length === 0 ? [] : ["explicit_caveats"],
      failed: [],
    },
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
