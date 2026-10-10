import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ComputerExecutor } from "../src/computer/computer-executor.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { RuntimeActionRepository } from "../src/runtime/runtime-action-repository.ts";
import { RuntimeResultRepository } from "../src/runtime/runtime-result-repository.ts";
import { createRuntimeResult } from "../src/runtime/runtime-result.ts";
import { runtimeEvidenceRecordsFromToolResult } from "../src/runtime/tool-result-evidence.ts";
import { AssessmentEvidenceBundleVerifier } from "../src/planning/runtime-evidence-bundle.ts";
import { AppError } from "../src/shared/errors.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { createResultJsonMaterializer } from "../src/tools/result-materializer.ts";

const runId = "result-materialize-run";
const planId = "result-materialize-plan";
const stepId = "result-materialize-step";
const owner = "result-materialize-owner";

test("Runtime materializes only an authorized JSON Result into a hash-bound extraction artifact", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-result-materialize-"));
  const database = new AppDatabase(":memory:");
  try {
    await seedRun(database);
    const actions = new RuntimeActionRepository(database);
    const results = new RuntimeResultRepository(database);
    const jsonResultId = await commitToolResult(actions, {
      toolCallId: "mcp-query",
      toolName: "mcp_ontoflow_jtbc_query",
      value: { fields: ["TABLE_NAME", "ROW_COUNT"], rows: [["T_ODS_CUSTOMER", 4117]] },
    });
    const textResultId = await commitToolResult(actions, {
      toolCallId: "text-result",
      toolName: "mcp_ontoflow_jtbc_query",
      value: "not JSON",
    });
    const tool = createResultJsonMaterializer(results, new ComputerExecutor(root));
    const grant = createCapabilityGrant({
      actorUserId: owner,
      runId,
      planId,
      stepId,
      depth: 0,
      workspaceRoot: root,
      allowedToolNames: [tool.name],
      allowedSkillIds: [],
    });
    const materialized = await tool.execute({ grant }, tool.parse({
      resultIds: [jsonResultId],
      path: "extractions/customer.json",
    })) as {
      sourceResultRefs: readonly { resultId: string }[];
      artifact: { path: string; sha256: string };
      evidenceReceipt: { evidenceKinds: { satisfied: string[] } };
    };
    assert.equal(materialized.sourceResultRefs[0]?.resultId, jsonResultId);
    assert.equal(materialized.artifact.path, "extractions/customer.json");
    assert.ok(/^[a-f0-9]{64}$/u.test(materialized.artifact.sha256));
    assert.ok(materialized.evidenceReceipt.evidenceKinds.satisfied.includes("structured_extraction_artifact"));
    const observableReceipts = runtimeEvidenceRecordsFromToolResult(JSON.stringify(materialized));
    assert.ok(observableReceipts.some((receipt) => receipt.schema === "agentloop.toolEvidenceReceipt/v1"));
    const document = JSON.parse(await fs.readFile(join(root, "extractions/customer.json"), "utf8")) as Record<string, unknown>;
    assert.equal(document.schema, "agentloop.runtimeResultEvidenceBundle/v1");
    assert.deepEqual(document.sources, [{
      sourceResultRef: { schema: "agentloop.resultRef/v1", resultId: jsonResultId },
      source: {
        kind: "tool",
        toolName: "mcp_ontoflow_jtbc_query",
        sha256: document.sources instanceof Array && document.sources[0] !== null && typeof document.sources[0] === "object"
          ? ((document.sources[0] as Record<string, unknown>).source as Record<string, unknown>).sha256
          : undefined,
      },
      value: { fields: ["TABLE_NAME", "ROW_COUNT"], rows: [["T_ODS_CUSTOMER", 4117]] },
    }]);

    await assert.rejects(
      () => tool.execute({ grant }, tool.parse({ resultIds: [textResultId], path: "extractions/text.json" })),
      (error: unknown) => error instanceof AppError && error.code === "BAD_REQUEST" && error.message.includes("Only JSON Runtime Results"),
    );
    const otherStepGrant = createCapabilityGrant({
      actorUserId: owner,
      runId,
      planId,
      stepId: "other-step",
      depth: 0,
      workspaceRoot: root,
      allowedToolNames: [tool.name],
      allowedSkillIds: [],
    });
    await assert.rejects(
      () => tool.execute({ grant: otherStepGrant }, tool.parse({ resultIds: [jsonResultId], path: "extractions/forbidden.json" })),
      (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
    );
  } finally {
    await database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Assessment rereads every Runtime Result in a multi-result evidence bundle and rejects a forged envelope", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "agentloop-assessment-evidence-bundle-"));
  const database = new AppDatabase(":memory:");
  try {
    await seedRun(database);
    const actions = new RuntimeActionRepository(database);
    const results = new RuntimeResultRepository(database);
    const resultIds = await Promise.all([
      commitToolResult(actions, { toolCallId: "query-tables", toolName: "mcp_query", value: { table: "T_ODS_A", rows: 11 } }),
      commitToolResult(actions, { toolCallId: "query-columns", toolName: "mcp_query", value: { table: "T_ODS_A", columns: ["ID", "AMOUNT"] } }),
      commitToolResult(actions, { toolCallId: "query-counts", toolName: "mcp_query", value: { table: "T_ODS_A", count: 11 } }),
    ]);
    const tool = createResultJsonMaterializer(results, new ComputerExecutor(root));
    const grant = createCapabilityGrant({
      actorUserId: owner,
      runId,
      planId,
      stepId,
      depth: 0,
      workspaceRoot: root,
      allowedToolNames: [tool.name],
      allowedSkillIds: [],
    });
    const materialized = await commitMaterialization(actions, tool, grant, resultIds);
    const verifier = new AssessmentEvidenceBundleVerifier(results);
    const verified = await verifier.verify({
      runId,
      planId,
      stepId,
      actorUserId: owner,
      toolCalls: [{
        toolCallId: "materialize-evidence",
        toolName: tool.name,
        result: JSON.stringify(materialized.value),
        resultRef: materialized.resultRef,
        isError: false,
      }],
    });
    assert.equal(verified.verified.length, 1);
    assert.deepEqual(verified.verified[0]?.sourceResultRefs.map((ref) => ref.resultId), resultIds);

    const forged = await verifier.verify({
      runId,
      planId,
      stepId,
      actorUserId: owner,
      toolCalls: [{
        toolCallId: "model-authored-json",
        toolName: tool.name,
        result: JSON.stringify({
          schema: "agentloop.runtimeResultMaterialization/v2",
          evidenceBundleSchema: "agentloop.runtimeResultEvidenceBundle/v1",
          sourceResultRefs: resultIds.map((resultId) => ({ schema: "agentloop.resultRef/v1", resultId })),
          artifact: { path: "ods_evidence/handwritten.json", bytes: 1, sha256: "0".repeat(64) },
        }),
        isError: false,
      }],
    });
    assert.equal(forged.verified.length, 0);
    assert.equal(forged.rejected[0]?.reason, "materialization action has no committed Runtime Result");
  } finally {
    await database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function seedRun(database: AppDatabase): Promise<void> {
  const now = Date.now();
  await database.prepare(`
    INSERT INTO runs(id, owner_user_id, parent_run_id, depth, allow_dangerous_tools, status, input, created_at)
    VALUES (?, ?, NULL, 0, 0, 'running', 'materialize result', ?)
  `).run(runId, owner, now);
  await database.prepare(`
    INSERT INTO plans(id, run_id, version, goal, selected_skill_ids_json, input_bindings_json, status, created_at, updated_at)
    VALUES (?, ?, 1, 'materialize result', '[]', '[]', 'running', ?, ?)
  `).run(planId, runId, now, now);
}

async function commitToolResult(
  actions: RuntimeActionRepository,
  input: { toolCallId: string; toolName: string; value: unknown },
): Promise<string> {
  let resultId = "";
  await actions.execute({
    runId,
    planId,
    stepId,
    kind: "tool_call",
    replayPolicy: "safe",
    deadlineMs: 1_000,
    metadata: { toolCallId: input.toolCallId, toolName: input.toolName },
    prepareResult: async (value, action) => {
      const result = createRuntimeResult({
        kind: "tool",
        producer: { actionId: action.id, runId, planId, stepId, toolCallId: input.toolCallId, toolName: input.toolName },
        value,
        publication: { status: "committed" },
      });
      resultId = result.ref.resultId;
      return result;
    },
  }, async () => input.value);
  return resultId;
}

async function commitMaterialization(
  actions: RuntimeActionRepository,
  tool: ReturnType<typeof createResultJsonMaterializer>,
  grant: ReturnType<typeof createCapabilityGrant>,
  resultIds: readonly string[],
): Promise<{ readonly value: unknown; readonly resultRef: { readonly schema: "agentloop.resultRef/v1"; readonly resultId: string } }> {
  let resultRef: { readonly schema: "agentloop.resultRef/v1"; readonly resultId: string } | undefined;
  const value = await actions.execute({
    runId,
    planId,
    stepId,
    kind: "tool_call",
    replayPolicy: "unsafe",
    deadlineMs: 1_000,
    metadata: { toolCallId: "materialize-evidence", toolName: tool.name },
    prepareResult: async (value, action) => {
      const result = createRuntimeResult({
        kind: "tool",
        producer: { actionId: action.id, runId, planId, stepId, toolCallId: "materialize-evidence", toolName: tool.name },
        value,
        publication: { status: "committed" },
      });
      resultRef = result.ref;
      return result;
    },
  }, async () => await tool.execute({ grant }, tool.parse({ resultIds, path: "extractions/ods-evidence.json" })));
  if (resultRef === undefined) throw new Error("materialization Result was not committed");
  return { value, resultRef };
}
