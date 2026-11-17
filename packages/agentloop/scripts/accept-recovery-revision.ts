/** Real-model acceptance with isolated storage and explicit fault injection.
 * node packages/agentloop/scripts/accept-recovery-revision.ts <model-account> <output-directory>
 * Reads existing model configuration/secrets without modifying the source account.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EncryptedLocalRuntimeSecretStore } from "../../agentloop-local-runtime/src/persistence/encrypted-local-runtime-secret-store.ts";
import { LlmProviderRegistry } from "../src/runtime/provider-registry.ts";
import { modelProviderDefinition, modelServicePreset } from "../src/runtime/model-configuration-schema.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { ModelStepAssessor } from "../src/planning/assessor.ts";
import { CanonicalRunStateRepository } from "../src/runtime/canonical-run-state-repository.ts";
import type { ModelAdapter } from "../src/runtime/contracts.ts";

const [account, destination] = process.argv.slice(2);
assert.ok(account && destination, "model-account and isolated output-directory are required");
const output = resolve(destination);
await mkdir(output, { recursive: true });
await mkdir(join(output, "workspace"), { recursive: true });
const source = new DatabaseSync(join(account, "supervisor.db"), { readOnly: true });
const row = source.prepare("SELECT configuration_json, secret_storage_key FROM local_model_configuration WHERE singleton=1").get()!;
source.close();
const saved = JSON.parse(row.configuration_json as string);
const environment = await new EncryptedLocalRuntimeSecretStore(join(account, "private", "model-secrets"))
  .read(row.secret_storage_key as string);
assert.ok(environment, "Saved model credentials are unavailable");
const selected = saved.providers.find((provider: any) => provider.models.length > 0);
assert.ok(selected, "No configured model");
const { key: modelKey, ...modelConfiguration } = selected.models[0];
const registry = LlmProviderRegistry.fromConfigObject({ defaultProvider: selected.key, defaultModelKey: modelKey,
  providers: { [selected.key]: { kind: selected.kind ?? "openai-compatible", baseUrl: selected.baseUrl,
    apiKeyEnv: `LOCAL_MODEL_KEY_${selected.key.toUpperCase().replace(/-/g, "_")}`,
    defaultModel: modelConfiguration.providerModel, protocol: selected.preset === undefined
      ? modelProviderDefinition(selected.kind ?? "openai-compatible").defaultProtocol
      : modelServicePreset(selected.preset).defaultProtocol } },
  models: { [modelKey]: { ...modelConfiguration, providerKey: selected.key } },
}, environment);
const real = registry.create(modelKey);
const database = new AppDatabase(join(output, "runtime.db"));
const sample = { units: 7, unitPrice: 19, receipt: `sample-${randomUUID()}` };
let initialTurns = 0;
let queries = 0;
let injected = false;
let feedbackObserved = false;
const calls: { phase: string; tools: string[]; elapsedMs: number }[] = [];
const model: ModelAdapter = { limits: real.limits, completeTimeoutMs: real.completeTimeoutMs,
  complete: async (request, signal) => {
    if (request.phase === "execution" && initialTurns < 2) {
      initialTurns++;
      return initialTurns === 1
        ? { content: "", finishReason: "tool_calls", toolCalls: [{ id: "fixture-query", name: "read_sample", arguments: {} }] }
        : { content: "处理中。", finishReason: "stop", toolCalls: [] };
    }
    if (request.tools[0]?.name === "submit_recovery_decision") {
      const context = JSON.parse(request.runtimeContext!.content);
      feedbackObserved ||= context.revisionFeedback?.some((item: any) => item.stage === "admission" && item.proposal?.planRevision);
    }
    const started = Date.now();
    const response = await real.complete(request, signal);
    calls.push({ phase: request.phase, tools: response.toolCalls.map(call => call.name), elapsedMs: Date.now() - started });
    console.log(JSON.stringify({ phase: request.phase, tools: calls.at(-1)!.tools, call: calls.length }));
    // Fault injection is explicit: corrupt only the first real model revision to exercise correction.
    const decision = response.toolCalls.find(call => call.name === "submit_recovery_decision");
    if (!injected && decision) {
      const args = decision.arguments as any;
      assert.equal(args.decision, "revise_plan", "The fixture requires a revised continuation");
      args.planRevision.steps[0].requiredCapabilities.push("acceptance_missing_capability");
      injected = true;
    }
    return response;
  },
};
const goal = "只调用一次 read_sample 读取样本的 units、unitPrice 和 receipt，计算总金额，在对话中给出数量、单价、总金额以及原始 receipt。不要生成文件，不要再次读取样本。";
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), modelKey,
  scope: "isolated Runtime with real recovery planning, independent revision assessment and repaired execution",
  faultInjection: ["Initial tool observation succeeds but initial candidate publishes only a status notice", "First real revision references an unavailable capability"],
  output, status: "running" };
const runs = new RunService({ database, workspaceRoot: join(output, "workspace"), skills: new SkillService(database),
  maxSteps: 12, modelFactory: () => model,
  tools: [{ name: "read_sample", description: "Read the single sample of units, unitPrice and receipt exactly once.",
    source: { id: "acceptance-sample", transport: "api", capabilities: [{ id: "sample.read", category: "source_acquisition",
      sourceKinds: ["api"], producesEvidenceKinds: ["source_summary"] }] },
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, executionMode: "parallel", replaySafe: true,
    parse: value => value, execute: async () => {
      queries++;
      assert.equal(queries, 1, "A repair must consume the committed Result instead of querying again");
      return { ...sample, evidenceReceipt: { schema: "agentloop.toolEvidenceReceipt/v1",
        evidenceKinds: { satisfied: ["source_summary"], caveated: [], failed: [] } } };
    } }],
  plannerFactory: () => ({ plan: async task => ({ goal, selectedSkillIds: [], schema: "agentloop.outcomePlan/v2", shape: "single_leaf",
    steps: [{ id: "seed", role: "deliver", objective: goal, dependencies: [], skillIds: [],
      requiredCapabilities: ["sample.read", "conversation_delivery"],
      targetIds: Object.keys(task.canonicalState.targets),
      successCriteria: [{ id: "answer", description: "Give the units, unit price, calculated total and exact original receipt.", source: "task" }] }] }) }),
  assessorFactory: adapter => ({ assess: async input => {
    if (input.step.id !== "seed") return new ModelStepAssessor(adapter).assess(input);
    return { id: randomUUID(), planId: input.planId, stepId: input.step.id, attempt: input.attempt,
      approved: false, criteria: input.step.successCriteria.map(criterion => ({ criterionId: criterion.id,
        satisfied: false, rationale: "The candidate says only 处理中 and publishes none of the observed values.", evidenceRefs: ["candidateOutput", "fixture-query"] })),
      skills: [], evidenceDigest: "isolated-observation", feedback: "Use the committed fixture-query Result to publish all requested values and the computed total; do not query again.",
      failedBoundary: { stepId: "seed", missingEvidenceKinds: [], violatedSkillRequirements: [], reusableEvidenceRefs: ["fixture-query"], suggestedRepairShape: "revise_plan" },
      createdAt: Date.now() };
  } }),
});
try {
  const run = await runs.execute("acceptance-owner", goal);
  const events = await runs.events("acceptance-owner", run.id);
  const state = await new CanonicalRunStateRepository(database).get(run.id);
  const plan = (await runs.plan("acceptance-owner", run.id)).plan;
  Object.assign(report, { runId: run.id, runStatus: run.status, errorCode: run.errorCode, planVersion: plan.version,
    queries, feedbackObserved, finalOutput: run.output, gaps: state.gaps.map(gap => ({ id: gap.id, status: gap.status, repairAttempts: gap.repairAttempts })),
    events: events.filter(event => /recovery\.proposal|recovery\.plan_revision|plan\.revision_assessed|run\.failed|run\.completed/.test(event.type)) });
  assert.equal(run.status, "completed");
  assert.equal(queries, 1);
  assert.equal(feedbackObserved, true);
  assert.match(run.output!, /133/);
  assert.ok(run.output!.includes(sample.receipt));
  assert.ok(events.some(event => event.type === "tool.completed" && event.data.toolName === "read_result"));
  assert.ok(state.gaps.every(gap => gap.status === "resolved"));
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message.slice(0, 800) : "acceptance_failed";
  process.exitCode = 1;
} finally {
  report.calls = calls;
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await database.close();
  console.log(JSON.stringify({ status: report.status, report: join(output, "report.json") }));
}
