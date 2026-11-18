import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { parseArgs } from "node:util";
import { AppDatabase, type SqlConnection } from "@zhujun/agentloop";
import { EncryptedLocalRuntimeSecretStore, LocalMemorySettlementReader, LocalModelConfigurationStore } from "@zhujun/agentloop-local-runtime/host";
import { accountDataDirectory } from "../src/accounts/account-managers.ts";
import { applyExperienceRebuild, prepareExperienceRebuild } from "../src/memory/rebuild-experiences.ts";

const { values } = parseArgs({ options: { "data-dir": { type: "string" }, "account-id": { type: "string" }, apply: { type: "string" }, resume: { type: "string" } }, strict: true });
if (values.apply && values.resume) throw new Error("memory_rebuild_choose_apply_or_resume");
if (!values["data-dir"] || !values["account-id"]) throw new Error("用法：node apps/agentloop-desktop/scripts/rebuild-memory-experiences.ts --data-dir <目录> --account-id <账号> [--apply <已核对的重建目录>]");
const dataRoot = resolve(values["data-dir"]), owner = values["account-id"], root = accountDataDirectory(dataRoot, owner);
const marker = JSON.parse(await readFile(join(root, "account.json"), "utf8"));
if (marker.version !== 1 || marker.ownerUserId !== owner) throw new Error("desktop_account_marker_invalid");
const connections: SqlConnection[] = [];
function readonly(file: string): SqlConnection {
  const db = new DatabaseSync(file, { readOnly: true });
  const connection: SqlConnection = {
    dialect: "sqlite", exec: async () => { throw new Error("memory_rebuild_read_only"); },
    transaction: async () => { throw new Error("memory_rebuild_read_only"); },
    close: async () => db.close(),
    prepare: sql => {
      const statement = db.prepare(sql);
      return { run: async () => { throw new Error("memory_rebuild_read_only"); },
        get: async <T>(...args: unknown[]) => statement.get(...args as SQLInputValue[]) as T | undefined,
        all: async <T>(...args: unknown[]) => statement.all(...args as SQLInputValue[]) as T[] };
    },
  };
  connections.push(connection); return connection;
}
let modelDb: AppDatabase | undefined;
try {
  const memory = new DatabaseSync(join(root, "memory.db"), { readOnly: true });
  let tenantId: string;
  try {
    const scopes = memory.prepare("SELECT DISTINCT tenant_id FROM local_memory_items WHERE owner_user_id=? AND kind='experience'").all(owner);
    if (scopes.length !== 1) throw new Error("memory_rebuild_scope_ambiguous");
    tenantId = scopes[0]!.tenant_id as string;
  } finally { memory.close(); }
  const scope = { tenantId, ownerUserId: owner };
  readonly(join(root, "runtime.db"));
  for (const directory of await readdir(join(root, "runtimes"), { withFileTypes: true }).catch(() => [])) {
    if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
    const file = join(root, "runtimes", directory.name, "agentloop.db");
    if ((await lstat(file).catch(() => undefined))?.isFile()) readonly(file);
  }
  const canonical = new LocalMemorySettlementReader(() => connections, tenantId);
  const reader = { read: async (input: Parameters<typeof canonical.read>[0]) => await canonical.isDeleted(input) ? undefined : canonical.read(input) };
  if (values.apply) {
    const directory = resolve(values.apply);
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    if (manifest.memoryFile !== join(root, "memory.db") || manifest.scope?.tenantId !== tenantId || manifest.scope?.ownerUserId !== owner) throw new Error("memory_rebuild_scope_mismatch");
    const result = await applyExperienceRebuild(directory, reader);
    console.log(JSON.stringify({ applied: true, replaced: result.before.length, current: result.after.length, directory }));
  } else {
    const supervisor = new DatabaseSync(join(root, "supervisor.db"), { readOnly: true });
    let config: Record<string, any>, memoryConfiguration: Record<string, any>;
    try {
      config = supervisor.prepare("SELECT * FROM local_model_configuration WHERE singleton=1").get()!;
      memoryConfiguration = supervisor.prepare("SELECT * FROM local_memory_configuration WHERE singleton=1").get()!;
    } finally { supervisor.close(); }
    if (!config || typeof memoryConfiguration?.settlement_model_key !== "string" || !memoryConfiguration.settlement_model_key.startsWith("local:")) throw new Error("memory_settlement_model_required");
    // Resolve the existing model catalog in memory; live settings stay read-only.
    modelDb = new AppDatabase(":memory:"); await modelDb.ready();
    await modelDb.exec("CREATE TABLE local_model_configuration(singleton INTEGER PRIMARY KEY,configuration_json TEXT NOT NULL,secret_storage_key TEXT,updated_at INTEGER NOT NULL)");
    await modelDb.prepare("INSERT INTO local_model_configuration VALUES(1,?,?,?)").run(config.configuration_json, config.secret_storage_key, config.updated_at);
    const models = new LocalModelConfigurationStore(modelDb, new EncryptedLocalRuntimeSecretStore(join(root, "private", "model-secrets")));
    await models.ready();
    const adapter = models.createModelAdapter(memoryConfiguration.settlement_model_key);
    const directory = values.resume ? resolve(values.resume) : join(root, "private", "memory-rebuilds", new Date().toISOString().replace(/[:.]/g, "-"));
    console.log(`重建副本：${directory}`);
    const result = await prepareExperienceRebuild({ memoryFile: join(root, "memory.db"), directory, scope, reader, resume: !!values.resume,
      progress: message => console.log(message), model: { modelKey: memoryConfiguration.settlement_model_key, completeTimeoutMs: adapter.completeTimeoutMs,
        complete: async ({ runId, systemPrompt, input, signal }) => {
          const response = await adapter.complete({ runId, phase: "compaction", systemPrompt,
            messages: [{ role: "user", content: JSON.stringify(input) }], tools: [], maxOutputTokens: 6000 }, signal);
          return { content: response.content, usage: response.usage };
        } } });
    console.log(JSON.stringify({ prepared: true, previous: result.before.length, current: result.after, unavailableRuns: result.unavailableRuns, directory }));
  }
} catch (error) {
  // Do not expose raw provider exceptions, endpoints or credentials.
  const message = error instanceof Error ? error.message : "unknown";
  console.error(/^(memory_|desktop_|settlement_v2:|local_runtime_secret_)/u.test(message) ? message : "memory_rebuild_failed");
  process.exitCode = 1;
} finally { await modelDb?.close(); for (const connection of connections) await connection.close(); }
