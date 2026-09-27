import assert from "node:assert/strict";
import test from "node:test";
import { buildDynamicSystemPrompt, buildTaskProfile, formatDynamicPromptContext } from "../src/runtime/dynamic-prompt.ts";
import { resolvePracticeProfileResolution, resolvePracticeProfiles, type PracticeProfileCatalog } from "../src/runtime/practice-profiles.ts";
import { understandTask } from "../src/runtime/task-intent.ts";

test("practice profiles select deterministic, bounded guidance from Runtime task semantics", () => {
  const task = understandTask({
    objective: "分析财务数据并制作管理层汇报",
    toolNames: ["extract_source_tables", "computer_write_file"],
    uploadedSources: [{
      id: "financial-workbook",
      originalName: "financial-analysis.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: "xlsx",
      byteSize: 100,
      sha256: "a".repeat(64),
      status: "ready",
      chunkCount: 0,
      truncated: false,
    }],
  });
  const catalog: PracticeProfileCatalog = {
    schema: "agentloop.practiceProfileCatalog/v1",
    maxActiveProfiles: 1,
    maxInstructions: 2,
    profiles: [{
      schema: "agentloop.practiceProfile/v1",
      id: "executive-data-story",
      version: "1.0.0",
      priority: 10,
      appliesTo: { operationProfiles: ["data_analysis"], inputFamilies: ["tabular"], anyTerms: ["财务", "预算"] },
      guidance: {
        instructions: ["Identify sheets, headers, ranges, and coverage before analysis.", "Do not invent unsourced trends."],
        antiPatterns: ["Do not mistake a partial workbook preview for complete coverage."],
      },
    }, {
      schema: "agentloop.practiceProfile/v1",
      id: "lower-priority-data",
      version: "1.0.0",
      priority: 1,
      appliesTo: { anyTerms: ["财务"] },
      guidance: { instructions: ["This profile is outside the active budget."] },
    }],
  };

  assert.equal(task.operation, "analysis");
  assert.equal(task.operationProfiles.includes("data_analysis"), true);
  const selected = resolvePracticeProfiles(catalog, task);
  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.id, "executive-data-story");
  assert.match(selected[0]?.contentHash ?? "", /^[a-f0-9]{64}$/);
  assert.match(selected[0]?.reason ?? "", /input family/);

  const prompt = buildDynamicSystemPrompt({
    phase: "execution",
    baseInstructions: ["Plan."],
    contractLines: ["Runtime retains authority."],
    taskProfile: buildTaskProfile({ phase: "execution", intent: "execute", practices: selected }),
  });
  assert.match(prompt, /<dynamic_prompt_profile source="server" semantics="classification-only">/);
  assert.match(prompt, /Identify sheets, headers, ranges, and coverage before analysis/);
  assert.match(prompt, /Do not mistake a partial workbook preview for complete coverage/);
  assert.match(prompt, /Runtime owns authorization, evidence, assessment, Plan progression, and terminal completion/);
  const context = formatDynamicPromptContext(buildTaskProfile({ phase: "execution", intent: "execute", practices: selected }));
  assert.match(context, /executive-data-story/);
  assert.doesNotMatch(context, /Identify sheets, headers, ranges, and coverage before analysis/);
});

test("practice profile selection fails closed for unsupported authority-like configuration", () => {
  const task = understandTask({ objective: "分析数据", toolNames: [] });
  assert.throws(() => resolvePracticeProfiles({
    schema: "agentloop.practiceProfileCatalog/v1",
    profiles: [{
      schema: "agentloop.practiceProfile/v1",
      id: "bad-profile",
      version: "1",
      guidance: { instructions: [] },
    }],
  }, task), /guidance.instructions/);
});

test("practice profile catalog switch and observe mode separate matching from prompt injection", () => {
  const task = understandTask({
    objective: "分析上传的销售数据",
    toolNames: [],
    uploadedSources: [{
      id: "sales",
      originalName: "sales.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: "xlsx",
      byteSize: 1,
      sha256: "b".repeat(64),
      status: "ready",
      chunkCount: 0,
      truncated: false,
    }],
  });
  const catalog: PracticeProfileCatalog = {
    schema: "agentloop.practiceProfileCatalog/v1",
    enabled: true,
    mode: "observe",
    profiles: [{
      schema: "agentloop.practiceProfile/v1",
      id: "tabular-analysis",
      version: "1",
      appliesTo: { inputFamilies: ["tabular"] },
      guidance: { instructions: ["Observe schema before aggregation."] },
    }],
  };
  const observed = resolvePracticeProfileResolution(catalog, task, { selectionPoint: "task_understanding" });
  assert.equal(observed.mode, "observe");
  assert.equal(observed.profiles[0]?.id, "tabular-analysis");
  assert.equal(observed.guidanceInjected, false);

  const disabled = resolvePracticeProfileResolution({ ...catalog, enabled: false }, task, { selectionPoint: "task_understanding" });
  assert.equal(disabled.profiles.length, 0);
  assert.equal(disabled.guidanceInjected, false);

  const active = resolvePracticeProfileResolution({ ...catalog, mode: "active" }, task, { selectionPoint: "task_understanding" });
  assert.equal(active.guidanceInjected, true);
  assert.equal(resolvePracticeProfiles({ ...catalog, mode: "active" }, task)[0]?.id, "tabular-analysis");
  assert.equal(resolvePracticeProfileResolution({ ...catalog, mode: "active" }, task, {
    selectionPoint: "source_discovery",
    excludedProfileIds: ["tabular-analysis"],
  }).profiles.length, 0);
});
