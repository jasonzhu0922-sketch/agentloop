import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthService } from "../src/auth/auth-service.ts";
import { admitPlan } from "../src/planning/admission.ts";
import type { PlanProposal, Planner } from "../src/planning/contracts.ts";
import { ModelStepAssessor, RuleBasedStepAssessor } from "../src/planning/assessor.ts";
import { ModelPlanner } from "../src/planning/planner.ts";
import { PlanRepository } from "../src/planning/plan-repository.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { RunService, selectPlanningSkills } from "../src/runtime/run-service.ts";
import { RuntimeActionRepository } from "../src/runtime/runtime-action-repository.ts";
import type { RuntimeTool } from "../src/runtime/tool-registry.ts";
import { SkillService, type PrivateSkill } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

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
    proposal: {
      ...proposal,
      steps: [{ ...proposal.steps[0], requiredToolNames: ["computer_write_file"] }],
    },
    availableSkills: [skill],
    availableToolNames: new Set(["load_skill", "computer_write_file"]),
  });
  assert.deepEqual(admitted.steps[0].requiredToolNames, ["computer_write_file", "load_skill"]);
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

test("ModelPlanner repairs oversized steps into smaller dependency-linked steps", async () => {
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
      assert.match(request.runtimeContext?.content ?? "", /step is too broad/i);
      assert.match(request.runtimeContext?.content ?? "", /smaller dependency-linked steps/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "split-plan",
          name: "submit_plan",
          arguments: {
            goal: "create reusable data analysis script",
            selectedSkillIds: [],
            steps: [
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

test("ModelPlanner rejects Skill or Tool use in a response-only conversational Plan", async () => {
  const planner = new ModelPlanner(new StaticModel({
    content: "",
    finishReason: "tool_calls",
    toolCalls: [{
      id: "plan",
      name: "submit_plan",
      arguments: {
        goal: "answer the question",
        selectedSkillIds: ["pptx"],
        steps: [{
          id: "answer",
          objective: "answer the latest question",
          dependencies: [],
          skillIds: ["pptx"],
          requiredToolNames: ["computer_write_file"],
          successCriteria: [{ id: "answered", description: "A direct answer is returned" }],
        }],
      },
    }],
  }));
  await assert.rejects(
    () => planner.plan({
      runId: "reply-only",
      input: "Which Skill did you use?",
      availableSkills: [skillFixture({ id: "pptx", name: "pptx" })],
      availableToolNames: ["computer_write_file"],
      responseOnly: true,
    }),
    (error: unknown) => hasCode(error, "PLANNING_ERROR")
      && String((error as Error).message).includes("conversational reply"),
  );
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
      assert.match(request.runtimeContext?.content ?? "", /only loads or activates a Skill/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "repaired-plan",
          name: "submit_plan",
          arguments: {
            goal: "Design a poster",
            selectedSkillIds: [skill.id],
            steps: [{
              id: "design-poster",
              objective: "Design the requested poster using the bound Skill",
              dependencies: [],
              skillIds: [skill.id],
              requiredToolNames: [],
              successCriteria: [{ id: "poster-ready", description: "The poster design is produced" }],
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

test("Tools are materialized from each Plan step rather than the whole Run profile", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("tools@example.com", "tools secure password");
    const model = new StepToolVisibilityModel();
    const planner: Planner = {
      plan: async () => ({
        goal: "two steps",
        selectedSkillIds: [],
        steps: [
          step("first"),
          { ...step("second"), dependencies: ["first"], requiredToolNames: ["computer_read_file"] },
        ],
      }),
    };
    const runs = new RunService({
      database, skills, modelFactory: () => model, plannerFactory: () => planner,
      assessorFactory: () => new RuleBasedStepAssessor(),
    });
    const run = await runs.execute(owner.user.id, "two steps");
    assert.equal(run.status, "completed");
    assert.deepEqual(model.visibleTools, [[], ["computer_read_file"]]);
  } finally {
    database.close();
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

test("rule-based assessment cannot claim Skill compliance from activation alone", async () => {
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
    let runId = "";
    await assert.rejects(
      () => runs.execute(owner.user.id, "semantic task"),
      (error: unknown) => {
        runId = String((error as { details?: { runId?: string } }).details?.runId ?? "");
        return hasCode(error, "RUN_LIMIT_EXCEEDED");
      },
    );
    const detail = runs.plan(owner.user.id, runId);
    assert.equal(detail.assessments.length, 2);
    assert.ok(detail.assessments.every((item) => !item.approved));
    assert.equal(runs.get(owner.user.id, runId).status, "failed");
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
      assert.deepEqual(toolNames, ["computer_list_directory", "load_skill"]);
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

class StepToolVisibilityModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  visibleTools: string[][] = [];
  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.visibleTools.push(request.tools.map((tool) => tool.name));
    return { content: `step-${this.visibleTools.length}`, toolCalls: [], finishReason: "stop" };
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
      assert.deepEqual(request.tools.map((tool) => tool.name), ["load_skill"]);
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
      assert.deepEqual(request.tools.map((tool) => tool.name), ["collect_proof"]);
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
      assert.deepEqual(request.tools.map((tool) => tool.name), ["computer_write_file"]);
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
