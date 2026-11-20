import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { AppDatabase, type SqlConnection } from "@zhujun/agentloop";
import { EncryptedLocalRuntimeSecretStore, LocalMemorySettlementReader, LocalModelConfigurationStore } from "@zhujun/agentloop-local-runtime/host";
import { SqliteMemoryStore, settleV2Batch, type MemorySettlementEvidence, type MemorySettlementModel } from "@zhujun/agentloop-memory";
import { accountDataDirectory } from "../src/accounts/account-managers.ts";

/** Read-only source, fresh destination, no apply path and no tool execution.
 * The model receives the same bounded Memory evidence as the real worker.
 * This is a clean-room sequential learning evaluation, not a claim that the
 * complete historical memory library was available at each original Run. */
const { values } = parseArgs({ strict: true, options: { "data-dir": { type: "string" }, "account-id": { type: "string" },
  run: { type: "string", multiple: true }, output: { type: "string" }, resume: { type: "boolean", default: false }, "with-model": { type: "boolean", default: false } } });
if (!values["data-dir"] || !values["account-id"] || !values.output || !values.run?.length
  || values.run.some(id => !/^[a-f0-9-]{8,36}$/u.test(id))) throw new Error("memory_evaluation_arguments_required");
const owner = values["account-id"], root = accountDataDirectory(resolve(values["data-dir"]), owner), output = resolve(values.output);
if (output === root || output.startsWith(`${root}/`)) throw new Error("memory_evaluation_destination_must_be_isolated");
const marker = JSON.parse(await readFile(join(root, "account.json"), "utf8"));
if (marker.version !== 1 || marker.ownerUserId !== owner) throw new Error("desktop_account_marker_invalid");
if (!values.resume) await mkdir(output, { mode: 0o700 });
const connections: SqlConnection[] = [];
function readonly(file: string): SqlConnection {
  const db = new DatabaseSync(file, { readOnly: true });
  const connection: SqlConnection = { dialect: "sqlite", close: async () => db.close(),
    exec: async () => { throw new Error("memory_evaluation_read_only"); }, transaction: async () => { throw new Error("memory_evaluation_read_only"); },
    prepare: sql => {
      const statement = db.prepare(sql);
      return { run: async () => { throw new Error("memory_evaluation_read_only"); },
        get: async <T>(...args: unknown[]) => statement.get(...args as SQLInputValue[]) as T | undefined,
        all: async <T>(...args: unknown[]) => statement.all(...args as SQLInputValue[]) as T[] };
    } };
  connections.push(connection); return connection;
}
let modelDb: AppDatabase | undefined, destination: AppDatabase | undefined;
const report: Record<string, any> = values.resume ? JSON.parse(await readFile(join(output, "report.json"), "utf8")) : { schema: "agentloop.memoryLearningEvaluation/v1", mode: values["with-model"] ? "clean_room_model_replay" : "evidence_only",
  sourceReadOnly: true, historicalLibraryImported: false, toolExecution: false, startedAt: new Date().toISOString(), runs: [] };
if (values.resume && (report.schema !== "agentloop.memoryLearningEvaluation/v1" || report.mode !== "clean_room_model_replay" || !values["with-model"])) throw new Error("memory_evaluation_resume_mismatch");
const frozenEvidence = values.resume ? JSON.parse(await readFile(join(output, "evidence.json"), "utf8")) as MemorySettlementEvidence[] : [];
if (frozenEvidence.some(value => value.scope.ownerUserId !== owner)) throw new Error("memory_evaluation_resume_owner_mismatch");
const implementation = Object.fromEntries(await Promise.all([
  "packages/agentloop-memory/src/semantic-v2.ts", "packages/agentloop-memory/src/knowledge.ts", "packages/agentloop-memory/src/knowledge-relations.ts",
  "packages/agentloop-memory/src/knowledge-comparison.ts", "packages/agentloop-memory/src/independent-knowledge.ts",
  "packages/agentloop-memory/src/task-knowledge.ts", "packages/agentloop-memory/src/plugin.ts",
  "packages/agentloop-memory/src/store.ts", "packages/agentloop-memory/src/sqlite-store.ts",
  "packages/agentloop-memory/src/settlement-repair.ts", "packages/agentloop-local-runtime/src/memory/local-memory-settlement-reader.ts",
].map(async file => [file, createHash("sha256").update(await readFile(new URL(`../../../${file}`, import.meta.url))).digest("hex")])));
report.evaluationPasses ??= [];
report.evaluationPasses.push({ startedAt: new Date().toISOString(), resume: !!values.resume, requestedRuns: values.run, implementation });
const save = async () => {
  await writeFile(join(output, "report.next.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  await rename(join(output, "report.next.json"), join(output, "report.json"));
};
try {
  const memory = new DatabaseSync(join(root, "memory.db"), { readOnly: true });
  let tenantId: string;
  try {
    const scopes = memory.prepare("SELECT DISTINCT tenant_id FROM local_memory_items WHERE owner_user_id=?").all(owner);
    if (scopes.length !== 1) throw new Error("memory_evaluation_scope_ambiguous");
    tenantId = scopes[0]!.tenant_id as string;
  } finally { memory.close(); }
  readonly(join(root, "runtime.db"));
  for (const entry of await readdir(join(root, "runtimes"), { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const file = join(root, "runtimes", entry.name, "agentloop.db");
    if ((await lstat(file).catch(() => undefined))?.isFile()) readonly(file);
  }
  const scope = { tenantId, ownerUserId: owner }, reader = new LocalMemorySettlementReader(() => connections, tenantId);
  const evidence: MemorySettlementEvidence[] = [];
  for (const prefix of values.run) {
    const matches = (await Promise.all(connections.map(db => db.prepare(`SELECT r.id, o.result_ref, o.committed_at FROM runs r
      JOIN run_outcomes o ON o.run_id=r.id WHERE r.owner_user_id=? AND r.id LIKE ?`).all<{ id: string; result_ref: string | null; committed_at: number }>(owner, `${prefix}%`)))).flat();
    const unique = [...new Map(matches.map(row => [row.id, row])).values()];
    if (unique.length !== 1) throw new Error("memory_evaluation_run_ambiguous_or_missing");
    const row = unique[0]!, value = await reader.read({ ...scope, runId: row.id, terminalCommitRef: row.result_ref ?? `${row.id}:${row.committed_at}` });
    if (!value) throw new Error("memory_evaluation_evidence_missing");
    if (values.resume) {
      const frozen = frozenEvidence.find(row => row.runId === value.runId);
      if (!frozen || JSON.stringify(frozen) !== JSON.stringify(value)) throw new Error("memory_evaluation_resume_evidence_changed");
    }
    evidence.push(value);
    if (!values.resume) report.runs.push({ runId: value.runId, request: value.taskRequest, quality: value.quality, coverage: value.coverage, evidenceGaps: value.evidenceGaps,
      delivery: value.observations?.filter(item => item.kind === "delivery"), feedback: value.observations?.filter(item => item.kind === "feedback") });
  }
  if (!values.resume) await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  await save();
  if (values["with-model"]) {
    const supervisor = new DatabaseSync(join(root, "supervisor.db"), { readOnly: true });
    let config: Record<string, any>, settings: Record<string, any>;
    try {
      config = supervisor.prepare("SELECT * FROM local_model_configuration WHERE singleton=1").get()!;
      settings = supervisor.prepare("SELECT * FROM local_memory_configuration WHERE singleton=1").get()!;
    } finally { supervisor.close(); }
    if (!config || !settings?.settlement_model_key?.startsWith("local:")) throw new Error("memory_settlement_model_required");
    modelDb = new AppDatabase(":memory:"); await modelDb.ready();
    await modelDb.exec("CREATE TABLE local_model_configuration(singleton INTEGER PRIMARY KEY,configuration_json TEXT NOT NULL,secret_storage_key TEXT,updated_at INTEGER NOT NULL)");
    await modelDb.prepare("INSERT INTO local_model_configuration VALUES(1,?,?,?)").run(config.configuration_json, config.secret_storage_key, config.updated_at);
    const models = new LocalModelConfigurationStore(modelDb, new EncryptedLocalRuntimeSecretStore(join(root, "private", "model-secrets")));
    await models.ready();
    const adapter = models.createModelAdapter(settings.settlement_model_key);
    const model: MemorySettlementModel = { modelKey: settings.settlement_model_key, completeTimeoutMs: adapter.completeTimeoutMs,
      complete: async ({ runId, systemPrompt, input, signal }) => {
        console.log(JSON.stringify({ run: runId.slice(0, 8), stage: (input as any).stage, repair: (input as any).correction?.mode ?? !!(input as any).correction }));
        try {
          const response = await adapter.complete({ runId, phase: "compaction", systemPrompt,
            messages: [{ role: "user", content: JSON.stringify(input) }], tools: [], maxOutputTokens: 6000 }, signal);
          return { content: response.content, usage: response.usage };
        } catch (error) {
          // The adapter already redacts configured secrets. Retain only bounded
          // diagnostic fields, never provider bodies, requests or credentials.
          const failure = error as { name?: string; code?: string; status?: number; message?: string; details?: Record<string, unknown> };
          const diagnostic = { runId, stage: (input as any).stage, recordedAt: new Date().toISOString(),
            name: failure.name, code: failure.code, status: failure.status,
            message: failure.code === "MODEL_ERROR" || failure.code === "CANCELLED" ? failure.message?.slice(0, 240) : "adapter_request_failed",
            details: Object.fromEntries(["status", "causeCode", "abortReason", "streamFailureStage", "sdkConfigurationError", "attempts", "limitKind"]
              .flatMap(key => { const value = failure.details?.[key]; return typeof value === "string" ? [[key, value.slice(0, 300)]] : typeof value === "number" ? [[key, value]] : []; })) };
          (report.modelFailures ??= []).push(diagnostic);
          await save(); console.log(JSON.stringify({ modelFailure: diagnostic }));
          throw error;
        }
      } };
    destination = new AppDatabase(join(output, "evaluation.db")); await destination.ready();
    const store = new SqliteMemoryStore(destination); await store.ready();
    for (const value of evidence) {
      const index = report.runs.findIndex((row: any) => row.runId === value.runId);
      if (index < 0) throw new Error("memory_evaluation_resume_run_mismatch");
      if (values.resume && report.runs[index].settlement && !report.runs[index].settlement.error) continue;
      report.runs[index].evaluationPass = report.evaluationPasses.length;
      const now = Date.now(), job = { ...scope, runId: value.runId, terminalCommitRef: value.terminalCommitRef, settlementJobId: `evaluation:${value.runId}`,
        enqueuedAt: now, status: "processing" as const, attempts: 1, nextAttemptAt: now };
      try {
        report.runs[index].settlement = await settleV2Batch({ store, evidences: [value], jobs: [job], model, consolidate: true, now });
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown";
        report.runs[index].settlement = { error: /^settlement_v2:/u.test(message) ? message : "memory_evaluation_failed" };
      }
      report.runs[index].attempts = await store.settlementAttempts(scope, value.runId);
      await save();
    }
    report.knowledge = (await store.active(scope)).filter(entry => ["experience.task_group", "experience.independent_knowledge", "experience.knowledge", "experience.procedure"].includes(entry.item.subtype ?? ""))
      .map(entry => ({ id: entry.item.id, revisionId: entry.revision.id, subtype: entry.item.subtype, value: entry.revision.value }));
    const attempts = report.runs.flatMap((run: any) => run.attempts ?? []);
    report.cost = { reportedUsageOnly: true, comparisonControlled: false,
      requestsWithoutReportedUsage: attempts.filter((attempt: any) => attempt.elapsedMs > 0 && attempt.inputTokens === undefined && attempt.outputTokens === undefined).length, inputTokens: attempts.reduce((sum: number, attempt: any) => sum + (attempt.inputTokens ?? 0), 0),
      outputTokens: attempts.reduce((sum: number, attempt: any) => sum + (attempt.outputTokens ?? 0), 0), modelCalls: attempts.filter((attempt: any) => attempt.elapsedMs > 0).length };
  }
  report.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ completed: true, runs: report.runs.length, report: join(output, "report.json"), cost: report.cost }));
} catch (error) {
  report.error = error instanceof Error && /^(memory_|desktop_)/u.test(error.message) ? error.message : "memory_evaluation_failed";
  await save(); console.error(report.error); process.exitCode = 1;
} finally { await modelDb?.close(); await destination?.close(); for (const connection of connections) await connection.close(); }
