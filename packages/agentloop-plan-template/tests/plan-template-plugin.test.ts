import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PlanProposal } from "@zhujun/agentloop";
import { createPlanTemplatePlugin } from "../src/index.ts";

test("observeEnabled records a match in the plugin-owned sqlite database", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "agentloop-plan-template-"));
  const databasePath = join(directory, "plan-template.db");
  const plugin = createPlanTemplatePlugin({
    storage: {
      type: "sqlite",
      databasePath,
      migrateOnStart: true,
    },
    config: {
      enabled: true,
      observeEnabled: true,
      mode: "off",
    },
    now: () => new Date("2026-09-02T00:00:00.000Z"),
  });
  try {
    const decision = await plugin.extension().beforePlanning({
      runId: "run-observe",
      actorUserId: "owner",
      input: "请基于上传的 Excel 生成 HTML 分析报告",
      responseOnly: false,
      availableSkills: [],
      selectedSkillRoles: [],
      availableToolNames: ["read_source", "computer_write_file", "verify_artifact_acceptance"],
      availableTools: [],
      visibleDirectories: [],
      sources: [{
        id: "source-1",
        originalName: "data.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        extension: ".xlsx",
        byteSize: 100,
        sha256: "abc",
        status: "ready",
        chunkCount: 1,
        truncated: false,
      }],
    });

    const store = await plugin.store();
    const matches = await store.matchesByRun("run-observe");

    assert.equal(decision.kind, "none");
    assert.equal(matches.length, 1);
    assert.equal(matches[0].decision, "observed");
    assert.equal(matches[0].taskFingerprint.sourceNeed, "uploaded_file");
    assert.equal(matches[0].taskFingerprint.sourceTypes[0], "xlsx");
    assert.equal(matches[0].taskFingerprint.artifactKind, "html");
  } finally {
    await plugin.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("observe mode can run alongside direct use routing", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "agentloop-plan-template-observe-route-"));
  const databasePath = join(directory, "plan-template.db");
  const plugin = createPlanTemplatePlugin({
    storage: {
      type: "sqlite",
      databasePath,
      migrateOnStart: true,
    },
    config: {
      enabled: true,
      observeEnabled: true,
      mode: "direct_use",
      allowDirectUse: true,
      minDirectUseScore: 0.1,
      minPlannerContextScore: 0.1,
    },
    now: () => new Date("2026-09-02T00:00:00.000Z"),
  });
  try {
    const store = await plugin.store();
    await store.migrate();
    await store.upsertTemplate({
      schema: "agentloop.planTemplate/v1",
      id: "template_observe_direct_use",
      version: 1,
      status: "active",
      intentFamily: "research",
      sourceNeed: "web_research",
      acceptedSourceTypes: [],
      artifactKind: "none",
      sideEffectKind: "none",
      requiredCapabilities: [],
      requiredEvidenceKinds: ["delivery_receipt", "explicit_caveats"],
      riskCeiling: "low",
      planSkeleton: [],
      positiveExampleRefs: [],
      negativeExampleRefs: [],
      reliability: {
        completedRuns: 1,
        admittedRuns: 1,
        failedRuns: 0,
        planAdmissionFailureRate: 0,
        assessmentFailureRate: 0,
        repairRate: 0,
        avgPlannerSavedMs: 0,
        updatedAt: "2026-09-02T00:00:00.000Z",
      },
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    });

    const decision = await plugin.extension().beforePlanning({
      runId: "run-observe-direct-use",
      actorUserId: "owner",
      input: "研究 web search result and deliver a summary",
      responseOnly: false,
      availableSkills: [],
      selectedSkillRoles: [],
      availableToolNames: ["websearch", "webfetch"],
      availableTools: [],
      visibleDirectories: [],
      sources: [],
    });
    const matches = await store.matchesByRun("run-observe-direct-use");

    assert.equal(decision.kind, "plan_proposal");
    assert.equal(matches.length, 2);
    assert.equal(matches[0].decision, "observed");
    assert.equal(matches[1].decision, "direct_use");
  } finally {
    await plugin.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("observeEnabled can run alongside direct use routing", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "agentloop-plan-template-observe-route-"));
  const databasePath = join(directory, "plan-template.db");
  const plugin = createPlanTemplatePlugin({
    storage: {
      type: "sqlite",
      databasePath,
      migrateOnStart: true,
    },
    config: {
      enabled: true,
      observeEnabled: true,
      mode: "direct_use",
      allowDirectUse: true,
      minDirectUseScore: 0.1,
      minPlannerContextScore: 0.1,
    },
    now: () => new Date("2026-09-02T00:00:00.000Z"),
  });
  try {
    const store = await plugin.store();
    await store.migrate();
    await store.upsertTemplate({
      schema: "agentloop.planTemplate/v1",
      id: "template_observe_direct_use",
      version: 1,
      status: "active",
      intentFamily: "research",
      sourceNeed: "web_research",
      acceptedSourceTypes: [],
      artifactKind: "none",
      sideEffectKind: "none",
      requiredCapabilities: [],
      requiredEvidenceKinds: ["delivery_receipt", "explicit_caveats"],
      riskCeiling: "low",
      planSkeleton: [],
      positiveExampleRefs: [],
      negativeExampleRefs: [],
      reliability: {
        completedRuns: 1,
        admittedRuns: 1,
        failedRuns: 0,
        planAdmissionFailureRate: 0,
        assessmentFailureRate: 0,
        repairRate: 0,
        avgPlannerSavedMs: 0,
        updatedAt: "2026-09-02T00:00:00.000Z",
      },
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    });

    const decision = await plugin.extension().beforePlanning({
      runId: "run-observe-direct-use",
      actorUserId: "owner",
      input: "研究 web search result and deliver a summary",
      responseOnly: false,
      availableSkills: [],
      selectedSkillRoles: [],
      availableToolNames: ["websearch", "webfetch"],
      availableTools: [],
      visibleDirectories: [],
      sources: [],
    });
    const matches = await store.matchesByRun("run-observe-direct-use");

    assert.equal(decision.kind, "plan_proposal");
    assert.equal(matches.length, 2);
    assert.equal(matches[0].decision, "observed");
    assert.equal(matches[1].decision, "direct_use");
  } finally {
    await plugin.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("direct-use templates rebind leaf objectives to the current task input", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "agentloop-plan-template-objective-rebind-"));
  const databasePath = join(directory, "plan-template.db");
  const plugin = createPlanTemplatePlugin({
    storage: {
      type: "sqlite",
      databasePath,
      migrateOnStart: true,
    },
    config: {
      enabled: true,
      observeEnabled: true,
      mode: "direct_use",
      allowDirectUse: true,
      minDirectUseScore: 0.1,
      minPlannerContextScore: 0.1,
    },
    now: () => new Date("2026-09-04T00:00:00.000Z"),
  });
  try {
    const store = await plugin.store();
    await store.migrate();
    await store.upsertTemplate({
      schema: "agentloop.planTemplate/v1",
      id: "template_api_query_rebind",
      version: 1,
      status: "active",
      intentFamily: "research",
      sourceNeed: "web_research",
      acceptedSourceTypes: [],
      artifactKind: "none",
      sideEffectKind: "none",
      requiredCapabilities: ["web_research"],
      requiredEvidenceKinds: ["delivery_receipt", "explicit_caveats"],
      riskCeiling: "low",
      planSkeleton: [{
        id: "step_1",
        role: "produce",
        operationRef: "produce:discovered:api-query",
        dependsOn: [],
        inputBindings: {},
        requiredEvidenceKinds: ["delivery_receipt", "explicit_caveats"],
        producedEvidenceKinds: ["delivery_receipt", "explicit_caveats"],
        requiredCapabilities: [],
        skillRoleHints: ["source_provider"],
        objective: "查询并返回合同备案 API 的完整参数信息（入参、出参、数据表等）",
      }],
      positiveExampleRefs: ["run-contract-api"],
      negativeExampleRefs: [],
      reliability: {
        completedRuns: 9,
        admittedRuns: 9,
        failedRuns: 0,
        planAdmissionFailureRate: 0,
        assessmentFailureRate: 0,
        repairRate: 0,
        avgPlannerSavedMs: 0,
        updatedAt: "2026-09-04T00:00:00.000Z",
      },
      createdAt: "2026-09-04T00:00:00.000Z",
      updatedAt: "2026-09-04T00:00:00.000Z",
    });

    const decision = await plugin.extension().beforePlanning({
      runId: "run-api-query-rebind",
      actorUserId: "owner",
      input: "查询宝武集团数据中台客商画像API 的参数信息",
      responseOnly: false,
      availableSkills: [{ id: "discovered:api-query", ownerUserId: "owner", name: "api-query", description: "API query", sourceKind: "package" }],
      selectedSkillRoles: [{ skillId: "discovered:api-query", role: "source_provider", reason: "metadata" }],
      availableToolNames: ["load_skill", "computer_run_command", "websearch"],
      availableTools: [],
      visibleDirectories: [],
      sources: [],
    });

    assert.equal(decision.kind, "plan_proposal");
    if (decision.kind !== "plan_proposal") return;
    assert.equal(decision.proposal.goal, "查询宝武集团数据中台客商画像API 的参数信息");
    assert.equal(decision.proposal.steps[0].objective, "完成当前任务：查询宝武集团数据中台客商画像API 的参数信息");
    assert.match(decision.proposal.steps[0].objective, /客商画像API/);
    assert.doesNotMatch(decision.proposal.steps[0].objective, /合同备案/);
  } finally {
    await plugin.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("observed and routed matches are both marked completed on outcome", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "agentloop-plan-template-outcome-"));
  const databasePath = join(directory, "plan-template.db");
  const plugin = createPlanTemplatePlugin({
    storage: {
      type: "sqlite",
      databasePath,
      migrateOnStart: true,
    },
    config: {
      enabled: true,
      observeEnabled: true,
      mode: "direct_use",
      allowDirectUse: true,
      minDirectUseScore: 0.1,
      minPlannerContextScore: 0.1,
    },
    now: () => new Date("2026-09-03T00:00:00.000Z"),
  });
  try {
    const store = await plugin.store();
    await store.migrate();
    await store.upsertTemplate({
      schema: "agentloop.planTemplate/v1",
      id: "template_outcome_rewrite",
      version: 1,
      status: "active",
      intentFamily: "research",
      sourceNeed: "web_research",
      acceptedSourceTypes: [],
      artifactKind: "none",
      sideEffectKind: "none",
      requiredCapabilities: [],
      requiredEvidenceKinds: ["delivery_receipt", "explicit_caveats"],
      riskCeiling: "low",
      planSkeleton: [],
      positiveExampleRefs: [],
      negativeExampleRefs: [],
      reliability: {
        completedRuns: 1,
        admittedRuns: 1,
        failedRuns: 0,
        planAdmissionFailureRate: 0,
        assessmentFailureRate: 0,
        repairRate: 0,
        avgPlannerSavedMs: 0,
        updatedAt: "2026-09-03T00:00:00.000Z",
      },
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
    });

    await plugin.extension().beforePlanning({
      runId: "run-outcome-rewrite",
      actorUserId: "owner",
      input: "研究 web search result and deliver a summary",
      responseOnly: false,
      availableSkills: [],
      selectedSkillRoles: [],
      availableToolNames: ["websearch", "webfetch"],
      availableTools: [],
      visibleDirectories: [],
      sources: [],
    });
    await plugin.extension().afterPlanAdmission?.({
      runId: "run-outcome-rewrite",
      admitted: true,
      planId: "plan-outcome-rewrite",
      proposal: apiQueryPlanProposal({
        role: "deliver",
        recommendedToolNames: ["websearch", "webfetch"],
      }),
    });
    await plugin.extension().afterOutcome?.({
      runId: "run-outcome-rewrite",
      status: "completed",
      planId: "plan-outcome-rewrite",
      reasonCode: "plan_assessed_and_completed",
      output: "done",
    });

    const matches = await store.matchesByRun("run-outcome-rewrite");
    assert.equal(matches.length, 2);
    assert.equal(matches[0].decision, "observed");
    assert.equal(matches[0].outcomeStatus, "completed");
    assert.equal(matches[1].decision, "direct_use");
    assert.equal(matches[1].outcomeStatus, "completed");
  } finally {
    await plugin.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("disabled mode does not create the plugin database", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "agentloop-plan-template-off-"));
  const databasePath = join(directory, "plan-template.db");
  const plugin = createPlanTemplatePlugin({
    storage: {
      type: "sqlite",
      databasePath,
      migrateOnStart: true,
    },
    config: {
      enabled: false,
      observeEnabled: false,
      mode: "off",
    },
  });
  try {
    const decision = await plugin.extension().beforePlanning({
      runId: "run-off",
      actorUserId: "owner",
      input: "hello",
      responseOnly: false,
      availableSkills: [],
      selectedSkillRoles: [],
      availableToolNames: [],
      availableTools: [],
      visibleDirectories: [],
      sources: [],
    });

    assert.equal(decision.kind, "none");
    await assert.rejects(() => fs.stat(databasePath));
  } finally {
    await plugin.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("plugin resolves relative sqlite storage paths from plugin config context", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "agentloop-plan-template-relative-"));
  const databasePath = join(directory, "plan-template.db");
  const plugin = createPlanTemplatePlugin({
    storage: {
      type: "sqlite",
      databasePath: "./plan-template.db",
      migrateOnStart: true,
    },
    config: {
      enabled: true,
      observeEnabled: true,
      mode: "off",
    },
  }, {
    configDir: directory,
  });
  try {
    const decision = await plugin.extension().beforePlanning({
      runId: "run-relative-storage",
      actorUserId: "owner",
      input: "hello",
      responseOnly: false,
      availableSkills: [],
      selectedSkillRoles: [],
      availableToolNames: [],
      availableTools: [],
      visibleDirectories: [],
      sources: [],
    });

    assert.equal(decision.kind, "none");
    await fs.stat(databasePath);
  } finally {
    await plugin.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("miner promotes repeated completed observations to candidate templates only", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "agentloop-plan-template-miner-"));
  const databasePath = join(directory, "plan-template.db");
  const plugin = createPlanTemplatePlugin({
    storage: {
      type: "sqlite",
      databasePath,
      migrateOnStart: true,
    },
    config: {
      enabled: true,
      observeEnabled: true,
      mode: "off",
    },
    mining: {
      minCompletedRunsForCandidate: 2,
    },
    now: () => new Date("2026-09-02T00:00:00.000Z"),
  });
  try {
    for (const [index, runId] of ["run-mine-1", "run-mine-2"].entries()) {
      await plugin.extension().beforePlanning({
        runId,
        actorUserId: "owner",
        input: "查询宝武集团数据中台中合同备案 API 的参数信息",
        responseOnly: false,
        availableSkills: [{ id: "discovered:api-query", ownerUserId: "owner", name: "api-query", description: "API query", sourceKind: "package" }],
        selectedSkillRoles: [{ skillId: "discovered:api-query", role: "source_provider", reason: "metadata" }],
        availableToolNames: ["load_skill", "computer_run_command"],
        availableTools: [],
        visibleDirectories: [],
        sources: [],
      });
      await plugin.extension().afterPlanAdmission?.({
        runId,
        admitted: true,
        planId: `plan-${runId}`,
        proposal: apiQueryPlanProposal({
          role: index === 0 ? "produce" : "deliver",
          recommendedToolNames: index === 0
            ? ["load_skill", "computer_run_command"]
            : ["load_skill", "computer_run_command", "computer_read_file"],
        }),
      });
      await plugin.extension().afterOutcome?.({
        runId,
        status: "completed",
        planId: `plan-${runId}`,
        reasonCode: "plan_assessed_and_completed",
        output: "done",
      });
    }

    await plugin.extension().beforePlanning({
      runId: "run-missing-proposal",
      actorUserId: "owner",
      input: "查询宝武集团数据中台中合同备案 API 的参数信息",
      responseOnly: false,
      availableSkills: [],
      selectedSkillRoles: [],
      availableToolNames: ["load_skill", "computer_run_command"],
      availableTools: [],
      visibleDirectories: [],
      sources: [],
    });
    await plugin.extension().afterOutcome?.({
      runId: "run-missing-proposal",
      status: "completed",
      reasonCode: "plan_assessed_and_completed",
      output: "done",
    });

    const result = await plugin.managementApi().runMiner();
    const templates = await plugin.managementApi().listTemplates({ status: "candidate" });

    assert.equal(result.scannedMatches, 3);
    assert.equal(result.eligibleExamples, 2);
    assert.deepEqual(result.skippedMatches, [{
      runId: "run-missing-proposal",
      reason: "plan_not_admitted",
    }]);
    assert.equal(result.candidateTemplatesCreated, 1);
    assert.equal(templates.length, 1);
    assert.equal(templates[0].status, "candidate");
    assert.equal(templates[0].intentFamily, "research");
    assert.equal(templates[0].planSkeleton[0].objective, undefined);
    assert.equal(templates[0].positiveExampleRefs.length, 2);
  } finally {
    await plugin.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("manual management can approve and retire mined templates", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "agentloop-plan-template-manage-"));
  const databasePath = join(directory, "plan-template.db");
  const plugin = createPlanTemplatePlugin({
    storage: {
      type: "sqlite",
      databasePath,
      migrateOnStart: true,
    },
    config: {
      enabled: true,
      observeEnabled: true,
      mode: "off",
    },
    mining: {
      minCompletedRunsForCandidate: 1,
    },
  });
  try {
    await plugin.extension().beforePlanning({
      runId: "run-manage",
      actorUserId: "owner",
      input: "查询宝武集团数据中台中合同备案 API 的参数信息",
      responseOnly: false,
      availableSkills: [],
      selectedSkillRoles: [],
      availableToolNames: ["load_skill", "computer_run_command"],
      availableTools: [],
      visibleDirectories: [],
      sources: [],
    });
    await plugin.extension().afterPlanAdmission?.({
      runId: "run-manage",
      admitted: true,
      planId: "plan-manage",
      proposal: apiQueryPlanProposal(),
    });
    await plugin.extension().afterOutcome?.({
      runId: "run-manage",
      status: "completed",
      planId: "plan-manage",
      reasonCode: "plan_assessed_and_completed",
      output: "done",
    });

    await plugin.managementApi().runMiner();
    const [candidate] = await plugin.managementApi().listTemplates({ status: "candidate" });
    assert.notEqual(candidate, undefined);

    const active = await plugin.managementApi().approveTemplate(candidate.id);
    assert.equal(active.status, "active");

    const retired = await plugin.managementApi().retireTemplate(candidate.id);
    assert.equal(retired.status, "retired");
  } finally {
    await plugin.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function apiQueryPlanProposal(input?: {
  readonly role?: "produce" | "deliver";
  readonly recommendedToolNames?: readonly string[];
}): PlanProposal {
  return {
    schema: "agentloop.outcomePlan/v2",
    shape: "single_leaf",
    goal: "查询宝武集团数据中台 API 参数信息",
    selectedSkillIds: ["discovered:api-query"],
    selectedSkillRoles: [{ skillId: "discovered:api-query", role: "source_provider", reason: "metadata" }],
    steps: [{
      id: "query-api",
      kind: "leaf",
      objective: "Load api-query and query API catalog parameters.",
      dependencies: [],
      role: input?.role ?? "produce",
      skillIds: ["discovered:api-query"],
      recommendedToolNames: input?.recommendedToolNames ?? ["load_skill", "computer_run_command"],
      evidenceContract: {
        requiredKinds: ["delivery_receipt", "explicit_caveats"],
        caveatPolicy: "mark_unverified_facts",
      },
      successCriteria: [{
        id: "delivery_receipt",
        description: "A delivery receipt identifies the final answer.",
        source: "planner",
      }],
    }],
  };
}
