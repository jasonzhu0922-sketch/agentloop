import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FileAttachmentBroker } from "../src/attachments/attachment-broker.ts";
import { SharedFilesystemAttachmentBroker } from "../src/attachments/shared-filesystem-attachment-broker.ts";
import { MultiRuntimeRouter, RuntimeCapacityError } from "../src/control-plane/router.ts";
import { AgentLoopRuntimeHost } from "../src/runtime/runtime-host.ts";
import {
  assertRequiredRuntimeCommands,
  assertRequiredRuntimeNodeModules,
  assertRequiredRuntimePythonModules,
  hasRuntimePlaywrightChromium,
  requiredRuntimeCommands,
  requiredRuntimeNodeModules,
  requiredRuntimePythonModules,
  runtimeCommandProbeArguments,
} from "../src/runtime/runtime-command-preflight.ts";
import { HttpResourceImporter } from "../src/runtime/http-resource-importer.ts";
import {
  mergeSkillDirectories,
  loadSkillDirectoriesConfig,
  loadPracticeProfileConfig,
  loadStepExecutionStrategyProfileConfig,
  parseMultiRuntimeConfig,
  parseSkillDirectoriesConfig,
  parsePracticeProfileConfig,
  parseStepExecutionStrategyProfileConfig,
  resolveSkillDirectoriesConfig,
  webToolsOptionsFromEnvironment,
} from "../src/config/config.ts";
import { assertRuntimeDispatchEnvelope } from "../src/runtime/runtime-host.ts";
import { assignmentIdFromPath, bindRouterEvents, streamEvents, taskFromRequest, webOriginMatches } from "../src/http/router-http.ts";
import { cancellationTarget, persistedCancellableAssistant } from "../web/cancellation-target.js";
import { EventEmitter } from "node:events";
import { AppDatabase } from "@zhujun/agentloop";
import { ControlPlaneStore, ConversationDeleteConflictError, RuntimeCapacityError as PersistentRuntimeCapacityError } from "../src/control-plane/control-plane-store.ts";
import { PersistentMultiRuntimeRouter } from "../src/control-plane/persistent-router.ts";
import { SharedWorkspaceArtifactCatalog } from "../src/artifacts/shared-workspace-artifact-catalog.ts";
import { HostDispatchStore } from "../src/runtime/host-dispatch-store.ts";
import { openStateDatabase, stateDatabaseConfigFromEnvironment } from "../src/storage/state-database.ts";
import { SchemaMigrationError } from "../src/storage/schema-migration-ledger.ts";
import { migrateRouterState } from "../src/storage/router-state-migrations.ts";
import type { RuntimeDispatchEnvelope, RuntimeEndpoint, RuntimeInstance } from "../src/domain/contracts.ts";
import { hasIncompleteCompletedPlan, mergeRuntimeEvents, projectAssistantEvent, replayAssistantEvents } from "../web/assistant-event-projection.js";
import { createCoalescedUpdater } from "../web/live-update-scheduler.js";
import { persistSessions } from "../web/session-persistence.js";
import { renderMarkdown } from "@zhujun/agentloop-artifact-preview";
import { isNearBottom, nextScrollTop } from "../web/scroll-follow.js";
import { conversationMessagesFromTurns } from "../web/conversation-history.js";
import { executionLocationLabel, executionProvenanceParts } from "../web/execution-provenance.js";
import { assistantMessagePresentation, completedArtifactSummary, terminalAwarePlanStepStatus } from "../web/assistant-message-presentation.js";
import { isExecutionLogArtifact, isFinalDeliveryArtifact } from "../web/artifact-display.js";
import { commandToolCallIds, executionActivities } from "../web/execution-detail-projection.js";
import { hasSelectedTextWithin } from "../web/message-selection.js";
import {
  LOCAL_MARKITDOWN_VERSION,
  localRuntimeHostEnvironment,
  localRuntimeToolsBin,
  localRuntimeToolsRoot,
  requiredLocalRuntimePythonModules,
} from "../scripts/local-runtime-tools.mjs";
// @ts-expect-error The Web server is a plain Node module and is intentionally tested without a build step.
import { runtimeConfigScript } from "../web/server.mjs";

function runtime(id: string, overrides: Partial<RuntimeInstance> = {}): RuntimeInstance {
  return {
    id,
    profile: "general",
    capabilities: ["document"],
    maxConcurrentRuns: 1,
    activeRunCount: 0,
    status: "ready",
    ...overrides,
  };
}

async function localModuleClosure(entry: string, files = new Set<string>()): Promise<Set<string>> {
  if (files.has(entry)) return files;
  files.add(entry);
  const source = await readFile(entry, "utf8");
  const imports = source.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g);
  for (const match of imports) {
    const specifier = match[1];
    if (specifier === undefined || !specifier.startsWith(".")) continue;
    await localModuleClosure(resolve(dirname(entry), specifier), files);
  }
  return files;
}

test("shared state configuration switches between local SQLite and PostgreSQL without changing Host code", () => {
  assert.deepEqual(stateDatabaseConfigFromEnvironment({
    environment: {}, appRoot: "/application", sqliteFallbackPath: "./data/legacy.db",
  }), { driver: "sqlite", databasePath: "/application/data/legacy.db" });
  assert.deepEqual(stateDatabaseConfigFromEnvironment({
    environment: { AGENTLOOP_STATE_DRIVER: "sqlite", AGENTLOOP_STATE_SQLITE_PATH: "./data/shared.db" },
    appRoot: "/application", sqliteFallbackPath: "./data/legacy.db",
  }), { driver: "sqlite", databasePath: "/application/data/shared.db" });
  assert.deepEqual(stateDatabaseConfigFromEnvironment({
    environment: {
      AGENTLOOP_STATE_DRIVER: "postgres",
      AGENTLOOP_STATE_DATABASE_URL: "postgresql://agentloop@db/agentloop",
      AGENTLOOP_STATE_POOL_SIZE: "8",
    },
    appRoot: "/application", sqliteFallbackPath: "./data/legacy.db",
  }), { driver: "postgres", connectionString: "postgresql://agentloop@db/agentloop", poolSize: 8 });
  assert.deepEqual(stateDatabaseConfigFromEnvironment({
    environment: {
      AGENTLOOP_STATE_DRIVER: "tidb",
      AGENTLOOP_STATE_DATABASE_URL: "mysql://agentloop@tidb/agentloop",
      AGENTLOOP_STATE_POOL_SIZE: "12",
    },
    appRoot: "/application", sqliteFallbackPath: "./data/legacy.db",
  }), { driver: "tidb", connectionString: "mysql://agentloop@tidb/agentloop", poolSize: 12 });
  assert.deepEqual(stateDatabaseConfigFromEnvironment({
    environment: {
      AGENTLOOP_STATE_DRIVER: "sqlite",
      AGENTLOOP_ROUTER_STATE_DRIVER: "tidb",
      AGENTLOOP_ROUTER_STATE_DATABASE_URL: "mysql://router@tidb/agentloop_router",
      AGENTLOOP_RUNTIME_STATE_DRIVER: "tidb",
      AGENTLOOP_RUNTIME_STATE_DATABASE_URL: "mysql://runtime@tidb/agentloop_runtime",
    },
    appRoot: "/application", sqliteFallbackPath: "./data/router.db", environmentPrefix: "AGENTLOOP_ROUTER_STATE",
  }), { driver: "tidb", connectionString: "mysql://router@tidb/agentloop_router" });
  assert.deepEqual(stateDatabaseConfigFromEnvironment({
    environment: {
      AGENTLOOP_STATE_DRIVER: "sqlite",
      AGENTLOOP_ROUTER_STATE_DRIVER: "tidb",
      AGENTLOOP_ROUTER_STATE_DATABASE_URL: "mysql://router@tidb/agentloop_router",
      AGENTLOOP_RUNTIME_STATE_DRIVER: "tidb",
      AGENTLOOP_RUNTIME_STATE_DATABASE_URL: "mysql://runtime@tidb/agentloop_runtime",
    },
    appRoot: "/application", sqliteFallbackPath: "./data/runtime.db", environmentPrefix: "AGENTLOOP_RUNTIME_STATE",
  }), { driver: "tidb", connectionString: "mysql://runtime@tidb/agentloop_runtime" });
  assert.throws(
    () => stateDatabaseConfigFromEnvironment({ environment: { AGENTLOOP_STATE_DRIVER: "postgres" }, appRoot: "/application", sqliteFallbackPath: "./data/legacy.db" }),
    /AGENTLOOP_STATE_DATABASE_URL/,
  );
  assert.throws(
    () => stateDatabaseConfigFromEnvironment({ environment: { AGENTLOOP_STATE_DRIVER: "tidb" }, appRoot: "/application", sqliteFallbackPath: "./data/legacy.db" }),
    /AGENTLOOP_STATE_DATABASE_URL/,
  );
});

test("Router state never initializes Runtime kernel tables, while Runtime state does", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-state-schema-"));
  try {
    const router = await openStateDatabase({ driver: "sqlite", databasePath: join(root, "router.db") }, { schema: "router" });
    try {
      const routerTables = await router.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      assert.equal(routerTables.some((table) => table.name === "runs"), false);
    } finally {
      await router.close();
    }
    const runtime = await openStateDatabase({ driver: "sqlite", databasePath: join(root, "runtime.db") }, { schema: "runtime" });
    try {
      const runtimeTables = await runtime.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      assert.equal(runtimeTables.some((table) => table.name === "runs"), true);
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("role migrations record an immutable checksum and fail closed on history drift", async () => {
  const database = new AppDatabase(":memory:");
  try {
    await migrateRouterState(database);
    await migrateRouterState(database);
    const row = await database.prepare(`
      SELECT id, checksum FROM mr_schema_migrations
      WHERE id = 'router/0001_identity_control_plane_devices_attachments_artifacts'
    `).get<{ id: string; checksum: string }>();
    assert.equal(row?.id, "router/0001_identity_control_plane_devices_attachments_artifacts");
    assert.match(row?.checksum ?? "", /^[a-f0-9]{64}$/);
    await database.prepare("UPDATE mr_schema_migrations SET checksum = 'unknown' WHERE id = ?").run(row?.id ?? "");
    await assert.rejects(
      () => migrateRouterState(database),
      SchemaMigrationError,
    );
  } finally {
    await database.close();
  }
});

test("Runtime Host validates deployment-required commands before accepting Runs", () => {
  assert.deepEqual(requiredRuntimeCommands(undefined), []);
  assert.deepEqual(requiredRuntimeCommands(" markitdown, markitdown , python3 "), ["markitdown", "python3"]);
  assert.throws(() => requiredRuntimeCommands("markitdown;curl"), /Invalid required Runtime command/);
  assert.deepEqual(runtimeCommandProbeArguments("pdftoppm"), ["-v"]);
  assert.deepEqual(runtimeCommandProbeArguments("qpdf"), ["--version"]);
  assert.equal(hasRuntimePlaywrightChromium("Browsers:\n  /root/.cache/ms-playwright/chromium-1234"), true);
  assert.equal(hasRuntimePlaywrightChromium("Browsers:\n  /root/.cache/ms-playwright/firefox-1500"), false);
  assert.doesNotThrow(() => assertRequiredRuntimeCommands([process.execPath]));
  assert.throws(() => assertRequiredRuntimeCommands(["agentloop-command-that-does-not-exist"]), /Required Runtime command is unavailable/);
  assert.deepEqual(requiredRuntimePythonModules(" pymysql, pymysql "), ["pymysql"]);
  assert.throws(() => requiredRuntimePythonModules("pymysql;os"), /Invalid required Runtime Python module/);
  assert.doesNotThrow(() => assertRequiredRuntimePythonModules(["sys"]));
  assert.throws(() => assertRequiredRuntimePythonModules(["agentloop_module_that_does_not_exist"]), /Required Runtime Python module is unavailable/);
  assert.deepEqual(requiredRuntimeNodeModules(" docx, docx, @scope/pkg "), ["docx", "@scope/pkg"]);
  assert.throws(() => requiredRuntimeNodeModules("docx;fs"), /Invalid required Runtime Node module/);
  assert.doesNotThrow(() => assertRequiredRuntimeNodeModules(["docx"], () => ({ loaded: true })));
  assert.throws(() => assertRequiredRuntimeNodeModules(["not-installed"], () => { throw new Error("not found"); }), /Required Runtime Node module is unavailable/);
});

test("local launcher provisions a fixed MarkItDown contract and exposes it to Runtime Hosts", () => {
  const toolsRoot = localRuntimeToolsRoot("/application", { RUNTIME_TOOLS_ROOT: "./data/dev-tools" });
  const toolsBin = localRuntimeToolsBin(toolsRoot);
  assert.equal(toolsRoot, "/application/data/dev-tools");
  assert.equal(LOCAL_MARKITDOWN_VERSION, "0.1.7");
  assert.deepEqual(localRuntimeHostEnvironment({ PATH: "/usr/bin" }, toolsBin), {
    PATH: `${toolsBin}:/usr/bin`,
    RUNTIME_REQUIRED_COMMANDS: "markitdown,pandoc,pdftoppm,pdftotext,pdfinfo,qpdf,gs,tesseract,ffmpeg,unzip,zip",
    RUNTIME_REQUIRED_PYTHON_MODULES: "anthropic,defusedxml,imageio,lxml,mcp,numpy,openpyxl,pandas,pdf2image,pdfplumber,PIL,playwright,pymysql,pypdf,pytesseract,reportlab",
    RUNTIME_REQUIRED_NODE_MODULES: "docx,pptxgenjs,react,react-dom,react-icons,sharp",
  });
  assert.equal(localRuntimeHostEnvironment({ PATH: "/usr/bin", RUNTIME_REQUIRED_COMMANDS: "markitdown,soffice" }, toolsBin).RUNTIME_REQUIRED_COMMANDS, "markitdown,soffice");
  assert.deepEqual(requiredLocalRuntimePythonModules(), [
    "anthropic", "defusedxml", "imageio", "lxml", "mcp", "numpy", "openpyxl", "pandas",
    "pdf2image", "pdfplumber", "PIL", "playwright", "pymysql", "pypdf", "pytesseract", "reportlab",
  ]);
  assert.deepEqual(requiredLocalRuntimePythonModules({ RUNTIME_REQUIRED_PYTHON_MODULES: "anthropic, anthropic ,pymysql" }), ["anthropic", "pymysql"]);
});

test("Router conversation index paginates newest conversations in stable pages of 30", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  const insert = database.prepare(`
    INSERT INTO mr_tasks(
      id, tenant_id, owner_user_id, conversation_id, client_message_id, input,
      requested_runtime_id, requested_profile, required_capabilities_json,
      requested_model_key, allow_dangerous_tools, resource_refs_json, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, '[]', NULL, 1, '[]', ?, ?, ?)
  `);
  for (let index = 0; index < 65; index += 1) {
    const suffix = String(index).padStart(2, "0");
    await insert.run(
      `task-${suffix}`,
      "tenant",
      "user",
      `conversation-${suffix}`,
      `message-${suffix}`,
      `Conversation ${suffix}`,
      "completed",
      index,
      index,
    );
  }
  await insert.run("other-task", "tenant", "other-user", "other-conversation", "other-message", "Other", "completed", 1_000, 1_000);

  const first = await store.listConversations("tenant", "user", { limit: 30, offset: 0 });
  assert.equal(first.conversations.length, 30);
  assert.equal(first.conversations[0]?.id, "conversation-64");
  assert.equal(first.conversations[29]?.id, "conversation-35");
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 30);

  const second = await store.listConversations("tenant", "user", { limit: 30, offset: 30 });
  assert.equal(second.conversations.length, 30);
  assert.equal(second.conversations[0]?.id, "conversation-34");
  assert.equal(second.conversations[29]?.id, "conversation-05");
  assert.equal(second.hasMore, true);
  assert.equal(second.nextOffset, 60);

  const third = await store.listConversations("tenant", "user", { limit: 30, offset: 60 });
  assert.deepEqual(third.conversations.map((conversation) => conversation.id), [
    "conversation-04",
    "conversation-03",
    "conversation-02",
    "conversation-01",
    "conversation-00",
  ]);
  assert.equal(third.hasMore, false);
  assert.equal(third.nextOffset, undefined);

  await store.seedRuntimes([{ ...runtime("runtime-history"), endpoint: "http://runtime-history" }], 2_000);
  await database.prepare("UPDATE mr_tasks SET resource_refs_json = ? WHERE id = ?").run(JSON.stringify([{
    attachmentId: "attachment-64",
    uri: "http://router/internal/attachment-64",
    sha256: "a".repeat(64),
    mediaType: "text/plain",
    originalName: "history.txt",
    byteSize: 7,
  }]), "task-64");
  await database.prepare("UPDATE mr_tasks SET message_attachments_json = ? WHERE id = ?").run(JSON.stringify([{
    id: "local-source-64",
    originalName: "local-history.docx",
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    byteSize: 11,
  }]), "task-64");
  await database.prepare(`
    INSERT INTO mr_assignments(
      id, task_id, runtime_id, dispatch_key, remote_run_id, status,
      reservation_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run("assignment-history-old", "task-64", "runtime-history", "dispatch-history-old", "run-history-old", "failed", 63, 63);
  await database.prepare(`
    INSERT INTO mr_assignments(
      id, task_id, runtime_id, dispatch_key, remote_run_id, status,
      reservation_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run("assignment-history", "task-64", "runtime-history", "dispatch-history", "run-history", "completed", 64, 64);
  const detail = await store.conversation("tenant", "user", "conversation-64");
  assert.deepEqual(detail?.turns, [{
    clientMessageId: "message-64",
    input: "Conversation 64",
    createdAt: 64,
    updatedAt: 64,
    attachments: [{ id: "local-source-64", originalName: "local-history.docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", byteSize: 11 }],
    assignment: {
      id: "assignment-history",
      runtimeId: "runtime-history",
      executionLocation: "cloud",
      status: "completed",
      hasRun: true,
      remoteRunId: "run-history",
    },
  }]);
  assert.equal(await store.conversation("tenant", "other-user", "conversation-64"), undefined);
  await database.close();
});

test("deleting a terminal Router conversation removes its durable task tree but rejects active work", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([{ ...runtime("conversation-delete-runtime"), endpoint: "http://conversation-delete-runtime" }], 1_000);
  const insertTask = database.prepare(`
    INSERT INTO mr_tasks(
      id, tenant_id, owner_user_id, conversation_id, client_message_id, input,
      requested_runtime_id, requested_profile, required_capabilities_json,
      requested_model_key, allow_dangerous_tools, resource_refs_json, status,
      created_at, updated_at
    ) VALUES (?, 'tenant-delete', 'user-delete', ?, ?, 'test input', NULL, NULL, '[]', NULL, 1, '[]', ?, ?, ?)
  `);
  const insertAssignment = database.prepare(`
    INSERT INTO mr_assignments(
      id, task_id, runtime_id, dispatch_key, remote_run_id, status,
      reservation_expires_at, created_at, updated_at
    ) VALUES (?, ?, 'conversation-delete-runtime', ?, 'remote-run', ?, NULL, ?, ?)
  `);
  try {
    await insertTask.run("terminal-task", "terminal-conversation", "terminal-message", "completed", 10, 10);
    await insertAssignment.run("terminal-assignment", "terminal-task", "terminal-dispatch", "completed", 10, 10);
    await insertTask.run("active-task", "active-conversation", "active-message", "running", 20, 20);
    await insertAssignment.run("active-assignment", "active-task", "active-dispatch", "accepted", 20, 20);

    await store.deleteConversation("tenant-delete", "user-delete", "terminal-conversation");
    assert.equal((await store.listConversations("tenant-delete", "user-delete", { limit: 30, offset: 0 })).conversations.some((item) => item.id === "terminal-conversation"), false);
    assert.equal(await store.conversation("tenant-delete", "user-delete", "terminal-conversation"), undefined);
    assert.equal((await database.prepare("SELECT COUNT(*) AS count FROM mr_assignments WHERE task_id = ?").get("terminal-task") as { count: number }).count, 0);

    await assert.rejects(
      store.deleteConversation("tenant-delete", "user-delete", "active-conversation"),
      ConversationDeleteConflictError,
    );
    assert.notEqual(await store.conversation("tenant-delete", "user-delete", "active-conversation"), undefined);
  } finally {
    await database.close();
  }
});

test("persisted turns preserve actual Runtime data plane and resolved model", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.registerLocalRuntime({
    runtimeId: "local-runtime-provenance",
    displayName: "研究 Runtime",
    deviceId: "device-provenance",
    tenantId: "tenant-provenance",
    ownerUserId: "user-provenance",
    connectionId: "connection-provenance",
    connectionEpoch: 1,
    profile: "general",
    capabilities: [],
    maxConcurrentRuns: 1,
    status: "ready",
    catalogVersion: "1",
    leaseExpiresAt: 2_000,
    now: 1_000,
  });
  const assignment = await store.reserve({
    tenantId: "tenant-provenance",
    ownerUserId: "user-provenance",
    conversationId: "conversation-provenance",
    clientMessageId: "message-provenance",
    input: "本机任务",
    executionTarget: { kind: "local_device", deviceId: "device-provenance", runtimeId: "local-runtime-provenance" },
    dataPolicy: { mode: "local" },
  }, { heartbeatTtlMs: 1_000, reservationTtlMs: 1_000, now: 1_100 });
  await store.markAccepted(assignment.id, "run-provenance", 1_110);
  await store.observeRun(assignment.id, {
    remoteRunId: "run-provenance", status: "completed", modelKey: "model-resolved-by-runtime", output: "完成", finishedAt: 1_200,
  }, 1_201);
  const turn = (await store.conversation("tenant-provenance", "user-provenance", "conversation-provenance"))?.turns[0];
  assert.equal(turn?.assignment?.executionLocation, "local");
  assert.equal(turn?.assignment?.runtimeId, "local-runtime-provenance");
  assert.equal(turn?.assignment?.runtimeDisplayName, "研究 Runtime");
  assert.equal(turn?.finalTurn?.modelKey, "model-resolved-by-runtime");
  const assistant = conversationMessagesFromTurns(turn === undefined ? [] : [turn])[1];
  assert.deepEqual(executionProvenanceParts(assistant), [
    { kind: "location", label: "本机" },
    { kind: "runtime", label: "Runtime 研究 Runtime" },
    { kind: "model", label: "模型 model-resolved-by-runtime" },
  ]);
  await database.close();
});

test("execution provenance labels all supported data planes without Runtime ID inference", () => {
  assert.equal(executionLocationLabel("cloud"), "云端");
  assert.equal(executionLocationLabel("local"), "本机");
  assert.equal(executionLocationLabel("strict_local"), "严格本地");
  assert.equal(executionLocationLabel("runtime-local-01"), "执行位置未记录");
  assert.deepEqual(executionProvenanceParts({ runtimeId: "runtime-internal-id", status: "completed" }), [
    { kind: "location", label: "执行位置未记录" },
    { kind: "runtime", label: "Runtime 未命名" },
    { kind: "model", label: "模型未记录" },
  ]);
});

test("persisted conversation turns become a replayable conversation stream on click", () => {
  const messages = conversationMessagesFromTurns([{
    clientMessageId: "message-history",
    input: "历史问题",
    createdAt: 10,
    attachments: [{ id: "attachment", originalName: "history.txt" }],
    assignment: { id: "assignment-history", runtimeId: "runtime-history", hasRun: true },
  }]);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], {
    id: "message-history",
    role: "user",
    text: "历史问题",
    createdAt: 10,
    attachments: [{ id: "attachment", originalName: "history.txt" }],
  });
  const assistant = messages[1] as unknown as { status: string; text: string; reasoning: string; events: unknown[]; plan: unknown[] };
  assert.equal(assistant.status, "running");
  assert.equal(messages[1]?.assignmentId, "assignment-history");
  assert.equal(replayAssistantEvents(assistant, [{
    seq: 1,
    type: "run.completed",
    data: { output: "历史回答" },
    createdAt: 20,
  }]), true);
  assert.equal(assistant.status, "completed");
  assert.equal(assistant.text, "历史回答");
});

test("completed artifact delivery supplies a stable summary when prose is empty", () => {
  assert.equal(completedArtifactSummary(undefined), "");
  assert.equal(completedArtifactSummary([{ role: "process", name: "draft.html" }]), "");
  assert.equal(completedArtifactSummary([
    { role: "final", name: "weekly-report.html" },
    { role: "final", name: "weekly-report.html" },
    { role: "final", path: "report.pdf" },
  ]), "任务已完成，最终产物：weekly-report.html、report.pdf。");
});

test("Multi Runtime Web requests and appends conversation pages of 30", async () => {
  const [app, overrides] = await Promise.all([
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
    readFile(new URL("../web/runtime-overrides.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /const CONVERSATION_PAGE_SIZE = 30/);
  assert.match(app, /let recoveredSessions = \[\];\s*let sessions = \[\]/);
  assert.match(app, /recoveredSessions = sortSessions\(loadSessions\(sessionKey\(user\.id\)\)\)/);
  assert.match(app, /mergeConversationSummaries\(body\.conversations, reset\)/);
  assert.match(app, /if \(reset && sessions\.length === 0\)/);
  assert.match(app, /\/v1\/conversations\?limit=\$\{CONVERSATION_PAGE_SIZE\}&offset=\$\{offset\}/);
  assert.match(app, /conversationVisibleLimit \+= CONVERSATION_PAGE_SIZE/);
  assert.match(app, /加载更多对话/);
  assert.match(app, /\/v1\/conversations\/\$\{encodeURIComponent\(conversation\.id\)\}/);
  assert.match(app, /conversationMessagesFromTurns\(body\.turns\)/);
  assert.match(app, /hydratePersistedAssistant/);
  assert.match(app, /executionProvenanceParts/);
  assert.match(app, /executionLocation: executionTarget/);
  assert.match(app, /const executionTarget = isLocalExecution\(\) \? "local" : "cloud"/);
  assert.doesNotMatch(app, /\$\("execution-target"\)/);
  assert.match(overrides, /\.execution-provenance-chip/);
  assert.match(overrides, /\.sessions-more/);
});

test("Runtime Host forwards deployment search endpoint and credentials to generic web tools", () => {
  assert.deepEqual(webToolsOptionsFromEnvironment({
    WEB_SEARCH_ENDPOINT: "https://api.bochaai.com/v1/web-search",
    WEB_SEARCH_API_KEY: "bocha-test-key",
  }), {
    searchEndpoint: "https://api.bochaai.com/v1/web-search",
    searchApiKey: "bocha-test-key",
  });
  assert.deepEqual(webToolsOptionsFromEnvironment({}), {});
});

test("Router and Runtime Host remain isolated deployment dependency closures", async () => {
  const routerFiles = await localModuleClosure(fileURLToPath(new URL("../src/entrypoints/router-main.ts", import.meta.url)));
  const hostFiles = await localModuleClosure(fileURLToPath(new URL("../src/entrypoints/runtime-host-main.ts", import.meta.url)));
  assert.equal([...routerFiles].some((path) => path.includes("/src/runtime/")), false, "Router must not import Runtime Host execution");
  assert.equal([...hostFiles].some((path) => path.includes("/src/control-plane/") || path.endsWith("/src/http/router-http.ts")), false, "Runtime Host must not import Router control-plane code");
});

test("local launcher gives Router and Runtime Hosts the same shared workspace mount", async () => {
  const source = await readFile(new URL("../scripts/start-local.mjs", import.meta.url), "utf8");
  assert.ok(
    source.indexOf("let closing = false;") < source.indexOf('children.push(start("router"'),
    "the launcher must initialize shutdown state before a Router child can fail",
  );
  const routerEnvironment = source.slice(
    source.indexOf('children.push(start("router"'),
    source.indexOf("// The Router owns initial schema setup"),
  );
  assert.match(routerEnvironment, /RUNTIME_WORKSPACE_ROOT:\s*sharedWorkspaceRoot/);
  assert.match(source, /WORKSPACE_ROOT:\s*sharedWorkspaceRoot/);
});

test("Web runtime config keeps browser API traffic same-origin while the server owns the Router URL", () => {
  const script = runtimeConfigScript("http://127.0.0.1:9888/");
  assert.match(script, /AGENTLOOP_ROUTER_URL = "\/api"/, "browser API calls must use the same-origin Web proxy");
  assert.match(script, /AGENTLOOP_ROUTER_PUBLIC_URL = "http:\/\/127\.0\.0\.1:9888\/"/, "the fixed build/deployment Router address remains display-only browser metadata");
});

test("Windows Local Runtime MSI owns protocol activation, tray startup, and fixed release configuration", async () => {
  const [packager, macPackager, preflight, tray, wix, rootPackage, workspacePackage] = await Promise.all([
    readFile(new URL("../scripts/package-local-agent-windows.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/package-local-agent-macos.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/assert-windows-local-agent-build.mjs", import.meta.url), "utf8"),
    readFile(new URL("../distribution/windows/Program.cs", import.meta.url), "utf8"),
    readFile(new URL("../distribution/windows/AgentLoopLocalRuntime.wxs", import.meta.url), "utf8"),
    readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(packager, /process\.platform !== "win32" \|\| process\.arch !== "x64"/);
  assert.match(packager, /AGENTLOOP_ROUTER_URL_PRODUCTION/);
  assert.match(packager, /AGENTLOOP_WEB_ORIGIN_PRODUCTION/);
  assert.match(packager, /--experimental-sea-config/);
  assert.match(packager, /bundled Node fallback/);
  assert.match(packager, /agentloop-local-runtime\.manifest\.json/);
  assert.match(packager, /agent\.out\.log/);
  assert.match(packager, /agent\.err\.log/);
  assert.match(packager, /local-agent-runtime[\s\S]*agent-loop-runtime/);
  assert.match(macPackager, /local-agent-runtime[\s\S]*agent-loop-runtime/);
  assert.match(preflight, /Windows MSI must be built on Windows x64/);
  assert.match(preflight, /\.NET 8 SDK is required/);
  assert.match(preflight, /WiX Toolset v4 CLI is required/);
  assert.match(tray, /agentloop-local-runtime-agent\.cmd/);
  assert.match(tray, /CurrentVersion\\Run/);
  assert.match(tray, /StartAgent\(\)/);
  assert.match(wix, /agentloop-local-runtime/);
  assert.match(wix, /ProgramFiles6432Folder/);
  assert.match(wix, /MajorUpgrade/);
  assert.match(JSON.parse(rootPackage).scripts["package:local-agent:win"], /--workspace agentloop-multi-runtime/);
  assert.match(JSON.parse(workspacePackage).scripts["package:local-agent:win"], /assert-windows-local-agent-build\.mjs.*package-local-agent-windows\.mjs/);
});

test("Web serves authentication as a dedicated page rather than sidebar controls", async () => {
  const [index, login, loginScript, server] = await Promise.all([
    readFile(new URL("../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../web/login.html", import.meta.url), "utf8"),
    readFile(new URL("../web/login.js", import.meta.url), "utf8"),
    readFile(new URL("../web/server.mjs", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(index, /id="auth-form"|id="auth-email"|id="auth-password"/);
  assert.match(login, /id="auth-form"/);
  assert.match(login, /id="auth-mode-toggle"/);
  assert.match(loginScript, /location\.replace\(safeNextLocation\(\)\)/);
  assert.match(server, /pathname === "\/login" \|\| pathname === "\/register"/);
  assert.match(server, /pathname === "\/api" \|\| pathname\.startsWith\("\/api\/"\)/);
});

test("Web source disables caching so Router and browser protocol changes deploy together", async () => {
  const server = await readFile(new URL("../web/server.mjs", import.meta.url), "utf8");
  assert.match(server, /response\.setHeader\("cache-control", "no-store"\)/);
});

test("Web leaves conversation classification to the Runtime", async () => {
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /conversationIntent/);
});

test("Web uses the shared format-aware preview component instead of text-only artifact output", async () => {
  const [html, app, server, markdownStyles, overrides, overlay, dockerfile] = await Promise.all([
    readFile(new URL("../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
    readFile(new URL("../web/server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../../packages/agentloop-artifact-preview/markdown.css", import.meta.url), "utf8"),
    readFile(new URL("../web/runtime-overrides.css", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile.runtime-host-overlay", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
  ]);
  assert.match(html, /artifact-preview\.js/);
  assert.match(html, /artifact-markdown\.css/);
  assert.match(html, /"marked":"\/marked\.js"/);
  assert.match(app, /import \{[^}]*openArtifactPreview[^}]*renderMarkdown[^}]*\} from "\.\/artifact-preview\.js"/);
  assert.match(app, /fetchStructuredPreview/);
  assert.match(app, /fetchBytes/);
  assert.doesNotMatch(app, /function previewText\(/);
  assert.match(server, /packages\/agentloop-artifact-preview\/dist\/index\.js/);
  assert.match(server, /packages\/agentloop-artifact-preview\/markdown\.css/);
  assert.match(server, /node_modules\/marked\/lib\/marked\.esm\.js/);
  assert.match(markdownStyles, /\.md h1,.md h2,.md h3,.md h4,.md h5,.md h6/);
  assert.match(markdownStyles, /\.md hr/);
  assert.match(overrides, /\.preview-backdrop/);
  assert.match(overrides, /\.preview-slide-canvas/);
  assert.match(overlay, /COPY packages\/agentloop-artifact-preview \.\/packages\/agentloop-artifact-preview/);
  assert.match(overlay, /npm run build --workspace @zhujun\/agentloop-artifact-preview/);
  assert.match(dockerfile, /FROM runtime-host AS local-runtime/);
});

test("Web keeps execution evidence collapsed and attaches final artifacts to the assistant reply", async () => {
  const [app, html, overrides] = await Promise.all([
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
    readFile(new URL("../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../web/runtime-overrides.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /function renderExecutionTrace\(message\)/);
  assert.match(app, /classList\.toggle\("artifact-open"/);
  assert.match(app, /artifactPanelOpen = true/);
  assert.match(app, /data-trace-toggle/);
  assert.match(app, /查看工具 \$\{tools\.length\} 次/);
  assert.match(app, /function renderInlineArtifacts\(assistant\)/);
  assert.doesNotMatch(app, /function renderInlineArtifacts\(assistant\)\s*\{\s*if \(!assistant \|\| assistant\.status !== "completed"\) return "";/);
  assert.match(app, /const generatedBlock = assistant\.status !== "completed"/);
  assert.match(app, /已生成产物/);
  assert.match(app, /isArtifactProjectionEvent\(event\)/);
  assert.match(app, /function openSelectedArtifactFullscreen\(\)/);
  assert.match(app, /artifact-panel-close/);
  assert.match(app, /inline-skill-summary/);
  assert.match(app, /本轮 Skill 状态/);
  assert.match(app, /skillStatus/);
  assert.match(app, /function renderArtifactCard\(artifact, assistantId(?:, assistantStatus(?: = "completed")?)?\)/);
  assert.match(app, /data-other-artifacts-toggle/);
  assert.match(app, /查看其他产物/);
  assert.match(app, /data-artifact-assistant/);
  assert.match(app, /function fetchStructuredPreview\(endpoint, headers\)/);
  assert.match(html, /id="artifact-inline-preview"/);
  assert.match(html, /id="artifact-fullscreen"/);
  assert.match(overrides, /\.execution-trace-list/);
  assert.match(overrides, /\.artifact-inline-preview/);
});

test("Web keeps an earlier reply's artifact preview selected while a newer turn is active", async () => {
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(app, /renderArtifacts\(\);/);
  assert.match(app, /function renderArtifacts\(\) \{/);
  assert.match(app, /const previewAssistant = inlineArtifactPreview/);
  assert.match(app, /message\.id === inlineArtifactPreview\.assistantId/);
  assert.match(app, /const assistant = previewAssistant \|\| selectedAssistant/);
  assert.doesNotMatch(app, /renderArtifacts\(selectedAssistant\)/);
});

test("Web preserves an active artifact player across conversation re-renders", async () => {
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");

  assert.match(app, /updateArtifactPreviewMarkup/);
  assert.match(app, /updateArtifactPreviewMarkup\(previewHost, previewMarkup\)/);
  assert.doesNotMatch(app, /previewHost\.innerHTML\s*=/);
});

test("Web excludes command stdout and stderr captures from artifact cards", () => {
  const finalArtifact = { role: "final", name: "report.pdf", path: "deliveries/report.pdf" };
  const stdoutCapture = { role: "final", name: "run.stdout.txt", path: ".agentloop/tool-results/run.stdout.txt" };
  const stderrCapture = { role: "final", name: "run.stderr.txt", path: ".agentloop/tool-results/run.stderr.txt" };

  assert.equal(isFinalDeliveryArtifact(finalArtifact), true);
  assert.equal(isExecutionLogArtifact(finalArtifact), false);
  assert.equal(isExecutionLogArtifact(stdoutCapture), true);
  assert.equal(isExecutionLogArtifact(stderrCapture), true);
  assert.equal(isFinalDeliveryArtifact(stdoutCapture), false);
  assert.equal(isFinalDeliveryArtifact(stderrCapture), false);
  assert.equal(isExecutionLogArtifact({ role: "process", name: "report.pdf", path: "deliveries/report.pdf" }), false);
});

test("Runtime Hosts load only an explicit built-in step execution profile", async () => {
  const configured = parseStepExecutionStrategyProfileConfig(JSON.stringify({
    schema: "agentloop.stepExecutionStrategyConfig/v1",
    profile: "action-aware",
    projection: { diagnosticProjectionCharacters: 3000 },
  }));
  assert.equal(configured.profile, "action-aware");
  assert.equal(configured.projection.diagnosticProjectionCharacters, 3000);
  assert.throws(
    () => parseStepExecutionStrategyProfileConfig(JSON.stringify({
      schema: "agentloop.stepExecutionStrategyConfig/v1",
      profile: "action-aware",
      module: "./untrusted-strategy.mjs",
    })),
    /unsupported step execution strategy config field: module/,
  );

  const directory = await mkdtemp(join(tmpdir(), "agentloop-step-execution-"));
  const configPath = join(directory, "step-execution-strategy.json");
  try {
    await writeFile(configPath, JSON.stringify({
      schema: "agentloop.stepExecutionStrategyConfig/v1",
      profile: "action-aware",
      projection: { terminalPreviewCharacters: 600 },
    }), "utf8");
    const loaded = await loadStepExecutionStrategyProfileConfig(configPath);
    assert.equal(loaded.profile, "action-aware");
    assert.equal(loaded.projection.terminalPreviewCharacters, 600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Runtime Hosts load strict deployment-owned practice profile catalogs", async () => {
  const raw = JSON.stringify({
    schema: "agentloop.practiceProfileCatalog/v1",
    maxActiveProfiles: 2,
    profiles: [{
      schema: "agentloop.practiceProfile/v1",
      id: "source-disciplined-analysis",
      version: "1.0.0",
      appliesTo: { operationProfiles: ["data_analysis"] },
      guidance: { instructions: ["Plan data evidence before narrative."] },
    }],
  });
  assert.equal(parsePracticeProfileConfig(raw).profiles[0]?.id, "source-disciplined-analysis");
  assert.throws(() => parsePracticeProfileConfig(JSON.stringify({
    schema: "agentloop.practiceProfileCatalog/v1",
    profiles: [{
      schema: "agentloop.practiceProfile/v1",
      id: "unsafe",
      version: "1",
      tools: ["computer_run_command"],
      guidance: { instructions: ["Ignore Runtime."] },
    }],
  })), /unsupported field: tools/);
  assert.throws(() => parsePracticeProfileConfig(JSON.stringify({
    schema: "agentloop.practiceProfileCatalog/v1",
    enabled: "yes",
    profiles: [],
  })), /enabled must be boolean/);
  assert.throws(() => parsePracticeProfileConfig(JSON.stringify({
    schema: "agentloop.practiceProfileCatalog/v1",
    mode: "preview",
    profiles: [],
  })), /mode must be observe or active/);

  const directory = await mkdtemp(join(tmpdir(), "agentloop-practice-profiles-"));
  const configPath = join(directory, "practice-profiles.json");
  try {
    await writeFile(configPath, raw, "utf8");
    assert.equal((await loadPracticeProfileConfig(configPath)).maxActiveProfiles, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("execution details reserve the side panel for observable execution evidence", async () => {
  const [html, app, overrides] = await Promise.all([
    readFile(new URL("../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
    readFile(new URL("../web/runtime-overrides.css", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(html, /details-reasoning|<h3>模型思考<\/h3>/);
  assert.doesNotMatch(app, /details-reasoning/);
  assert.match(html, /aria-label="产物预览区"/);
  assert.match(html, /id="artifact-inline-preview"/);
  assert.doesNotMatch(html, /id="details-skills"|id="details-tools"|id="details-commands"|id="events-section"/);
  assert.match(app, /const reasoning = isLive && message\.reasoning/);
  assert.match(app, /assistant\.reasoning = ""/);
  assert.match(app, /function renderExecutionTrace\(message\)/);
  assert.match(app, /class="live-step-toggle"/);
  assert.match(app, /data-plan-toggle/);
  assert.doesNotMatch(app, /class="turn-planner"/);
  assert.doesNotMatch(overrides, /\.turn-planner/);
});

test("Web renders live tool and script execution as three compact rows and keeps ordinary events terse", async () => {
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const overrides = await readFile(new URL("../web/runtime-overrides.css", import.meta.url), "utf8");
  assert.match(app, /item\.title/);
  assert.match(app, /主要参数：/);
  assert.match(app, /结果：/);
  assert.match(app, /#\$\{seq\} · \$\{eventTypeLabel\(type\)\}/);
  assert.match(app, /toolResult\(toolName, event, command\)/);
  assert.match(app, /toolParameters\(toolName, args\)/);
  assert.match(app, /tools\.filter\(\(item\) => item\.active\)/);
  assert.match(app, /class="execution-tools"/);
  assert.match(app, /function renderLiveEventIndicator\(message\)/);
  assert.match(app, /class="live-event-indicator/);
  assert.match(overrides, /\.execution-trace-copy \.execution-trace-result/);
  assert.match(overrides, /\.live-event-indicator\.active \.live-event-number/);
});

test("execution details preserve loaded Skills and complete command evidence per tool call", () => {
  const events = [
    { seq: 0, type: "planning.skills.selected", createdAt: 5, data: { skills: [{ id: "discovered:docx", name: "docx" }, { id: "discovered:review-contract", name: "review-contract" }] } },
    { seq: 1, type: "assistant.tool_call.committed", createdAt: 10, data: { step: 1, toolCallId: "skill-call", name: "load_skill", arguments: { name: "discovered:docx" } } },
    { seq: 2, type: "tool.completed", createdAt: 12, data: { step: 1, toolCallId: "skill-call", toolName: "load_skill", result: "skill content" } },
    { seq: 3, type: "tool.planned", createdAt: 20, data: { step: 2, toolCallId: "command-call", toolName: "computer_run_command", arguments: { command: "python3", args: ["-c", "print('full inline script')"], cwd: "@skills/docx", timeoutMs: 30_000 } } },
    { seq: 4, type: "tool.dispatched", createdAt: 21, data: { step: 2, toolCallId: "command-call", toolName: "computer_run_command" } },
    { seq: 5, type: "tool.completed", createdAt: 25, data: { step: 2, toolCallId: "command-call", toolName: "computer_run_command", result: JSON.stringify({ exitCode: 0, stdout: "preview", stderr: "" }) } },
  ];
  const activities = executionActivities(events, {
    "command-call": {
      arguments: { command: "python3", args: ["-c", "print('full inline script')"], cwd: "@skills/docx", timeoutMs: 30_000 },
      stdout: "complete stdout",
      stderr: "complete stderr",
    },
  });
  assert.deepEqual(activities.skills.map((skill) => ({ name: skill.name, status: skill.status })), [
    { name: "discovered:docx", status: "completed" },
    { name: "discovered:review-contract", status: "selected" },
  ]);
  assert.deepEqual(commandToolCallIds(events), ["command-call"]);
  assert.deepEqual(activities.commands[0]?.arguments, { command: "python3", args: ["-c", "print('full inline script')"], cwd: "@skills/docx", timeoutMs: 30_000 });
  assert.equal(activities.commands[0]?.stdout, "complete stdout");
  assert.equal(activities.commands[0]?.stderr, "complete stderr");
});

test("command activity opens a stable detail dialog instead of a native dropdown", async () => {
  const [app, html, overrides] = await Promise.all([
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
    readFile(new URL("../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../web/runtime-overrides.css", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(app, /<details class="command-card/);
  assert.match(app, /data-command-detail/);
  assert.match(app, /function openCommandDetail/);
  assert.match(app, /function renderCommandDetailModal/);
  assert.match(app, /data-command-detail-close/);
  assert.match(html, /id="command-detail-modal"/);
  assert.match(overrides, /.command-card:focus-visible/);
  assert.match(overrides, /.command-detail-dialog/);
});

test("conversation Agent replies select their own Run execution detail", async () => {
  const [app, styles] = await Promise.all([
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
    readFile(new URL("../web/runtime-overrides.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /data-assistant-message/);
  assert.match(app, /function selectAssistantTurn\(conversation, messageId\)/);
  assert.match(app, /conversation\.selectedAssistantId = assistant\.id/);
  assert.match(app, /selectedAssistantMessage\(conversation, messages\)/);
  assert.match(app, /selectedAssistantMessage\(activeConversation\(\)\)/);
  assert.match(app, /assistant\.detailEvents \|\| assistant\.events/);
  assert.doesNotMatch(app, /events\.slice\(-80\)/);
  assert.match(styles, /\.msg\.assistant\.selected \.live-card/);
});

test("selecting reply text does not activate the reply card", async () => {
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const card = {};
  const selectedInsideCard = {
    isCollapsed: false,
    rangeCount: 1,
    toString: () => "要复制的回答",
    getRangeAt: () => ({ intersectsNode: (node: unknown) => node === card }),
  };
  const emptySelection = { isCollapsed: true, rangeCount: 0, toString: () => "" };
  assert.equal(hasSelectedTextWithin(selectedInsideCard, card), true);
  assert.equal(hasSelectedTextWithin(emptySelection, card), false);
  assert.match(app, /if \(hasSelectedTextWithin\(window\.getSelection\(\), card\)\) return;/);
});

test("Multi Runtime proxies full tool arguments and command output from the owning Host Run", async () => {
  const [routerHttp, hostHttp, persistentRouter, runtimeHost, app] = await Promise.all([
    readFile(new URL("../src/http/router-http.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/http/runtime-host-http.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/control-plane/persistent-router.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/runtime/runtime-host.ts", import.meta.url), "utf8"),
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
  ]);
  for (const source of [routerHttp, hostHttp]) {
    assert.match(source, /commandOutputMatch/);
    assert.match(source, /tool-arguments/);
  }
  assert.match(persistentRouter, /async commandOutput\(/);
  assert.match(persistentRouter, /async toolArguments\(/);
  assert.match(runtimeHost, /this\.runs\.readCommandOutput/);
  assert.match(runtimeHost, /this\.runs\.readToolArguments/);
  assert.match(app, /hydrateCommandEvidence/);
  assert.match(app, /Promise\.allSettled/);
});

test("live output, thought, and conversation scroll only follow readers who remain near the bottom", async () => {
  const [app, overrides] = await Promise.all([
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
    readFile(new URL("../web/runtime-overrides.css", import.meta.url), "utf8"),
  ]);
  assert.equal(isNearBottom({ scrollTop: 168, clientHeight: 200, scrollHeight: 400 }), true);
  assert.equal(isNearBottom({ scrollTop: 80, clientHeight: 200, scrollHeight: 400 }), false);
  assert.equal(nextScrollTop({ scrollHeight: 640, clientHeight: 240 }, true, 80), 400);
  assert.equal(nextScrollTop({ scrollHeight: 640, clientHeight: 240 }, false, 80), 80);
  assert.match(app, /const followConversation = renderedConversationId !== conversation\.id \|\| isNearBottom\(conversationScroll\)/);
  assert.match(app, /const followReasoning = previousReasoning === null \|\| isNearBottom\(previousReasoning\)/);
  assert.match(app, /const previousLiveOutputs = new Map\(\[\.\.\.document\.querySelectorAll\("\.msg\.assistant\.live \.live-output-text"\)\]/);
  assert.match(app, /follow: isNearBottom\(output\),/);
  assert.match(app, /document\.querySelectorAll\("\.msg\.assistant\.live \.live-output-text"\)\.forEach\(\(output\) => \{/);
  assert.match(app, /output\.scrollTop = nextScrollTop\(output, previous\?\.follow \?\? true, previous\?\.scrollTop \?\? 0\);/);
  assert.match(overrides, /\.reasoning-body\s*\{[^}]*max-height:\s*min\(240px, 36vh\);[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain/s);
});

test("artifact preview pane owns height and overflow instead of fixed-height previews", async () => {
  const [baseStyles, overrides] = await Promise.all([
    readFile(new URL("../web/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../web/runtime-overrides.css", import.meta.url), "utf8"),
  ]);
  assert.match(baseStyles, /\.workspace\{flex:1;min-height:0;display:grid/);
  assert.match(overrides, /\.app-shell\s*\{\s*grid-template-rows:\s*minmax\(0, 1fr\)/);
  assert.match(overrides, /\.main,\s*\.workspace,\s*\.details\s*\{\s*min-height:\s*0/);
  assert.match(overrides, /\.artifact-workspace\s*\{\s*display:\s*flex;\s*flex-direction:\s*column;\s*min-height:\s*0;\s*overflow:\s*hidden/);
  assert.match(overrides, /\.artifact-workspace-body\s*\{\s*flex:\s*1 1 auto;\s*min-height:\s*0;\s*height:\s*auto;\s*display:\s*flex;\s*flex-direction:\s*column;\s*overflow:\s*auto/);
  assert.match(overrides, /\.artifact-inline-preview\s*\{\s*flex:\s*1 1 auto;[^}]*height:\s*auto;[^}]*min-height:\s*0/);
  assert.match(overrides, /\.artifact-inline-preview \.preview-body\s*\{[^}]*max-height:\s*none/);
  assert.match(overrides, /\.artifact-inline-preview \.preview-frame\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0/);
});

test("Web projects durable Plan transitions, formats final Markdown, and preserves mixed tool outcomes", async () => {
  const [app, overrides, detailProjection] = await Promise.all([
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
    readFile(new URL("../web/runtime-overrides.css", import.meta.url), "utf8"),
    readFile(new URL("../web/execution-detail-projection.js", import.meta.url), "utf8"),
  ]);
  assert.match(app, /replayPersistedRunEvents/);
  assert.match(app, /function projectPlanStatuses\(plan, events, runStatus\)/);
  assert.match(app, /projectAssistantEvent\(assistant, event\)/);
  assert.match(app, /mergeRuntimeEvents\(assistant\.events, \[event\]\)/);
  assert.match(app, /message\.status === "completed" \? renderMarkdown\(message\.text\) : formatText\(message\.text\)/);
  assert.match(app, /function renderRecovery\(message\)/);
  assert.match(app, /checkpoint\/start/);
  assert.match(app, /从检查点启动/);
  assert.doesNotMatch(app, /data-recovery-advance/);
  assert.match(app, /import \{[^}]*openArtifactPreview[^}]*renderMarkdown[^}]*\} from "\.\/artifact-preview\.js"/);
  assert.match(app, /function toolOutcomeLabel\(tool\)/);
  assert.match(detailProjection, /completedCalls: 0, rejectedCalls: 0, failedCalls: 0, runningCalls: 0/);
  assert.match(app, /\$\{tool\.rejectedCalls\} 次被拒绝/);
  assert.match(overrides, /\.tool-tag\.partial \.tool-status-dot/);
  assert.match(overrides, /\.live-output-text\.md\s*\{[^}]*line-height:\s*1\.5;[^}]*white-space:\s*normal;/s);
});

test("completed-message Markdown renders screenshot-style GFM tables as structured HTML", () => {
  const html = renderMarkdown([
    "其余相关接口及参数如下：",
    "",
    "| 接口 | API ID | 入参 |",
    "|---|---|---|",
    "| 员工画像标签人员查询2 | `M_ADS_FACT_MDYG_USER_TRIP_LABEL.D_A_BSTAMDYG_CL0021` | `countNum`、`sql`（均非必填） |",
  ].join("\n"));
  assert.match(html, /<div class="md-table-wrap"><table>/);
  assert.match(html, /<th>接口<\/th>/);
  assert.match(html, /<code class="md-inline">M_ADS_FACT_MDYG_USER_TRIP_LABEL\.D_A_BSTAMDYG_CL0021<\/code>/);
  assert.doesNotMatch(html, /<p>\| 接口 \| API ID \| 入参 \|/);
});

test("Web recovery replays Host Plan events instead of leaving a completed card with a running step", () => {
  const assistant = {
    status: "completed",
    text: "final output",
    reasoning: "",
    events: [{ seq: 66, type: "plan.step.started", data: { stepId: "extract" }, createdAt: 66 }],
    plan: [
      { id: "extract", objective: "extract", status: "running" },
      { id: "deliver", objective: "deliver", status: "pending" },
    ],
  };
  assert.equal(hasIncompleteCompletedPlan(assistant), true);
  const terminal = replayAssistantEvents(assistant, [
    { seq: 65, type: "plan.admitted", data: { steps: [{ id: "extract", objective: "extract", status: "pending" }, { id: "deliver", objective: "deliver", status: "pending" }] }, createdAt: 65 },
    { seq: 66, type: "plan.step.started", data: { stepId: "extract" }, createdAt: 66 },
    { seq: 126, type: "plan.step.completed", data: { stepId: "extract" }, createdAt: 126 },
    { seq: 127, type: "plan.step.started", data: { stepId: "deliver" }, createdAt: 127 },
    { seq: 156, type: "plan.step.completed", data: { stepId: "deliver" }, createdAt: 156 },
    { seq: 158, type: "run.completed", data: { output: "final output" }, createdAt: 158 },
  ]);
  assert.equal(terminal, true);
  assert.equal(assistant.status, "completed");
  assert.deepEqual(assistant.plan.map((step) => step.status), ["completed", "completed"]);
  assert.equal(hasIncompleteCompletedPlan(assistant), false);
});

test("Web projects the persisted Human-in-the-Loop request from its waiting event", () => {
  const assistant = { status: "running", text: "", reasoning: "", events: [], plan: [], humanLoop: undefined as unknown };
  const request = {
    id: "hil-choice", runId: "run-choice", status: "open", revision: 1, kind: "selection",
    title: "Choose a company", prompt: "Select one candidate.", rationale: "Candidates differ.", evidenceRefs: [],
    responseSchema: { type: "select", minSelections: 1, maxSelections: 1, options: [{ id: "company-a", label: "Company A" }] },
    resume: { mode: "continue_step" }, createdAt: 1,
  };
  assert.equal(projectAssistantEvent(assistant, {
    seq: 7, type: "run.waiting_user", data: { runId: "run-choice", requestId: request.id, kind: request.kind, request }, createdAt: 7,
  }), false);
  assert.deepEqual(assistant.humanLoop, request);
});

test("Web keeps an open Human-in-the-Loop request reachable outside the bounded conversation scroller", async () => {
  const [app, html, overrides] = await Promise.all([
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
    readFile(new URL("../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../web/runtime-overrides.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="conversation-scroll"[\s\S]*id="human-loop-panel"[\s\S]*id="composer"/);
  assert.match(app, /function renderHumanLoopSurfaces\(messages\)/);
  assert.match(app, /function renderHumanLoopCard\(message\)/);
  assert.match(app, /function currentHumanLoopMessage\(messages\)/);
  assert.match(app, /panel\.hidden = false;/);
  assert.doesNotMatch(app, /data-human-loop-open/);
  assert.match(overrides, /\.human-loop-panel\s*\{[^}]*position:\s*absolute;[^}]*top:\s*50%;[^}]*width:\s*min\(780px, calc\(100% - 48px\)\);[^}]*height:\s*min\(760px, calc\(100% - 48px\)\);[^}]*overflow:\s*hidden/s);
  assert.match(overrides, /\.human-loop-panel-body\s*\{[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain/s);
  assert.doesNotMatch(overrides, /\.human-loop-card\s*\{[^}]*max-height:/s);
});

test("Web renders a cancelled Run as a stable terminal state instead of live progress", () => {
  const assistant = {
    status: "running",
    text: "",
    reasoning: "still working",
    recovery: { status: "required" },
    humanLoop: { id: "request", status: "open" },
  };
  assert.equal(projectAssistantEvent(assistant, {
    seq: 68, type: "run.cancelled", data: {}, createdAt: 68,
  }), true);
  assert.deepEqual(assistantMessagePresentation(assistant.status), {
    isLive: false,
    label: "已取消",
    icon: "×",
    cardClass: "cancelled",
    emptyText: "任务已取消",
  });
  assert.equal(assistant.reasoning, "");
  assert.equal(assistant.recovery, undefined);
  assert.equal(assistant.humanLoop, undefined);
  assert.equal(terminalAwarePlanStepStatus("running", assistant.status), "cancelled");
  assert.equal(terminalAwarePlanStepStatus("pending", assistant.status), "cancelled");
  assert.equal(terminalAwarePlanStepStatus("completed", assistant.status), "completed");
});

test("Web projects a durable recovery boundary without treating it as a terminal failure", () => {
  const assistant = { status: "running", text: "", reasoning: "", events: [], plan: [], recovery: undefined as unknown };
  assert.equal(projectAssistantEvent(assistant, {
    seq: 9,
    type: "run.recovery_required",
    data: {
      runId: "run-recovery",
      actionId: "action-recovery",
      failedBoundary: { stepId: "lookup", missingEvidenceKinds: ["source_summary", "explicit_caveats"] },
    },
    createdAt: 9,
  }), false);
  assert.deepEqual(assistant.recovery, {
    status: "required",
    runId: "run-recovery",
    actionId: "action-recovery",
    failedBoundary: { stepId: "lookup", missingEvidenceKinds: ["source_summary", "explicit_caveats"] },
  });
  assert.equal(assistant.status, "running");
});

test("Web preserves a checkpoint action after execution authority loss becomes terminal", () => {
  const assistant = { status: "running", text: "", reasoning: "", events: [], plan: [], checkpoint: undefined as unknown };
  assert.equal(projectAssistantEvent(assistant, {
    seq: 10,
    type: "run.checkpoint_created",
    data: { runId: "run-lost", checkpointId: "checkpoint-lost", reason: "execution_authority_lost" },
    createdAt: 10,
  }), false);
  assert.equal(projectAssistantEvent(assistant, {
    seq: 11,
    type: "run.failed",
    data: { runId: "run-lost", code: "EXECUTION_AUTHORITY_LOST", message: "execution authority lost" },
    createdAt: 11,
  }), true);
  assert.equal(assistant.status, "failed");
  assert.deepEqual(assistant.checkpoint, {
    id: "checkpoint-lost",
    reason: "execution_authority_lost",
    status: "available",
  });
});

test("Web bounds persisted event payloads without truncating the live assistant projection", () => {
  const fullText = "x".repeat(20_000);
  const assistant = { status: "running", text: "", reasoning: "", events: [], plan: [] };
  replayAssistantEvents(assistant, [{ seq: 1, type: "assistant.streaming", data: { content: fullText }, createdAt: 1 }]);
  assert.equal(assistant.text.length, fullText.length);
  const streamingEvent = { seq: 1, type: "assistant.streaming", data: { content: fullText }, createdAt: 1 };
  const compactStreamingEvents = mergeRuntimeEvents([streamingEvent].slice(0, 0), [streamingEvent]);
  assert.ok(String(compactStreamingEvents[0]?.data.content).length < fullText.length);

  const incomingEvents = Array.from({ length: 200 }, (_, seq) => ({ seq, type: "tool.completed", data: { result: JSON.stringify({ stdout: fullText }) }, createdAt: seq }));
  const events = mergeRuntimeEvents(incomingEvents.slice(0, 0), incomingEvents);
  assert.equal(events.length, 160);
  assert.equal(events[0]?.seq, 40);
  assert.ok(String(events.at(-1)?.data?.result).length < fullText.length);
});

test("Web session persistence falls back to a bounded recovery snapshot when localStorage quota is exhausted", () => {
  let stored = "";
  const attemptedLengths: number[] = [];
  const storage = {
    setItem(_key: string, value: string) {
      attemptedLengths.push(value.length);
      if (value.length > 10_000) throw new DOMException("quota exceeded", "QuotaExceededError");
      stored = value;
    },
    removeItem() { stored = ""; },
  };
  const oversized = "x".repeat(30_000);
  const sessions = Array.from({ length: 20 }, (_, conversationIndex) => ({
    id: `conversation-${conversationIndex}`,
    title: oversized,
    createdAt: conversationIndex,
    updatedAt: conversationIndex,
    messages: Array.from({ length: 24 }, (_, messageIndex) => messageIndex % 2 === 0
      ? { id: `user-${messageIndex}`, role: "user", text: oversized, createdAt: messageIndex }
      : {
        id: `assistant-${messageIndex}`,
        role: "assistant",
        text: oversized,
        reasoning: oversized,
        status: "running",
        assignmentId: "assignment-recoverable",
        events: Array.from({ length: 160 }, (_, seq) => ({ seq, type: "tool.completed", data: { result: oversized }, createdAt: seq })),
        createdAt: messageIndex,
      }),
  }));

  const result = persistSessions(storage, sessions);
  assert.equal(result.persisted, true);
  assert.ok(attemptedLengths.some((length) => length > 10_000));
  assert.ok(stored.length > 0 && stored.length <= 10_000);
  const recovered = JSON.parse(stored) as Array<{ messages: Array<{ assignmentId?: string; events?: unknown[] }> }>;
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.messages.some((message) => message.assignmentId === "assignment-recoverable"), true);
  assert.equal(recovered[0]?.messages.every((message) => (message.events?.length ?? 0) <= 4), true);
});

test("Web session persistence never turns an unavailable localStorage into a thrown submission error", () => {
  const storage = {
    setItem() { throw new DOMException("quota exceeded", "QuotaExceededError"); },
    removeItem() { throw new DOMException("quota exceeded", "QuotaExceededError"); },
  };
  assert.doesNotThrow(() => persistSessions(storage, [{ id: "conversation", messages: [] }]));
  assert.equal(persistSessions(storage, [{ id: "conversation", messages: [] }]).persisted, false);
});

test("Web batches high-frequency event rendering and persistence but flushes a terminal update", () => {
  let frame: (() => void) | undefined;
  let timer: (() => void) | undefined;
  let renders = 0;
  let persists = 0;
  const updater = createCoalescedUpdater({
    render: () => { renders += 1; },
    persist: () => { persists += 1; },
    requestFrame: (callback) => { frame = callback; return 1; },
    cancelFrame: () => { frame = undefined; },
    setTimer: (callback) => { timer = callback; return 2; },
    clearTimer: () => { timer = undefined; },
  });
  for (let index = 0; index < 100; index += 1) updater.request();
  assert.equal(renders, 0);
  assert.equal(persists, 0);
  assert.ok(frame);
  frame();
  assert.ok(timer);
  timer();
  assert.equal(renders, 1);
  assert.equal(persists, 1);

  updater.request();
  updater.flush();
  assert.equal(renders, 2);
  assert.equal(persists, 2);
});

test("Web tracks active Runs by conversation instead of imposing one global Run lock", async () => {
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(app, /const activeRunsByConversation = new Map\(\)/);
  assert.match(app, /activeRunsByConversation\.has\(conversation\.id\)/);
  assert.match(app, /activeRunsByConversation\.get\(conversation\.id\)/);
  assert.match(app, /void reconcilePersistedRuns\(\)/);
  assert.match(app, /function applyRecoveredRunState\(assistant, run\)/);
  assert.match(app, /当前会话仍在发起或执行；请等待或点击停止/);
  assert.match(app, /文件仍在上传，请稍候再发送/);
  assert.match(app, /submitAbortController: new AbortController\(\)/);
  assert.match(app, /发起会话超时，请重试/);
  assert.match(app, /await observeAssignment\(/);
  assert.match(app, /activeRun\.assistant\.status = "cancelled"/);
  assert.match(app, /cancellationTarget\(activeRunsByConversation\.get\(conversation\.id\), conversation\.messages\)/);
  assert.match(app, /停止失败：/);
  assert.doesNotMatch(app, /let activeAssignmentId|let streamAbort/);
});

test("Web recovers the Router cancellation target from a persisted running message", () => {
  const persisted = { role: "assistant", status: "running", assignmentId: "assignment-persisted" };
  const messages = [{ role: "user", text: "first" }, persisted, { role: "assistant", status: "completed", assignmentId: "assignment-old" }];
  assert.equal(persistedCancellableAssistant(messages), persisted);
  assert.deepEqual(cancellationTarget(undefined, messages), {
    activeRun: undefined,
    assistant: persisted,
    assignmentId: "assignment-persisted",
    canCancel: true,
  });
});

test("Web keeps Runtime directory authority above the composer and snapshots uploaded attachments into the user message", async () => {
  const [html, app, overrides] = await Promise.all([
    readFile(new URL("../web/index.html", import.meta.url), "utf8"),
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
    readFile(new URL("../web/runtime-overrides.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="local-directory-scopes" class="runtime-directory-scopes" aria-label="当前 Runtime 已授权目录"/);
  assert.ok(html.indexOf('id="local-directory-scopes"') < html.indexOf('<div class="composer-box">'), "Runtime directory authority belongs above the composer box");
  assert.match(app, /当前 Runtime 已授权目录/);
  assert.match(overrides, /\.runtime-directory-scopes/);
  assert.match(html, /id="pending-attachments"/);
  assert.match(html, /id="upload-file"/);
  assert.match(html, /accept="\.txt,\.md,\.csv,\.json,\.html,\.htm,\.pdf,\.doc,\.docx,\.xlsx,\.pptx"/);
  assert.ok(html.indexOf('id="pending-attachments"') < html.indexOf('id="input"'), "pending files belong above the text input");
  assert.match(app, /async function uploadAttachments\(fileList\)/);
  assert.match(app, /const MAX_ATTACHMENT_BYTES = 25 \* 1024 \* 1024;/);
  assert.match(app, /const rejected = selected\.filter\(\(file\) => file\.size > MAX_ATTACHMENT_BYTES\)/);
  assert.match(app, /function attachmentSizeError\(file, limit = MAX_ATTACHMENT_BYTES\)/);
  assert.match(app, /超过单个文件/);
  assert.match(app, /failures\.length > 0 \? uploadFailureStatus\(failures\) : "文件已准备好"/);
  assert.match(app, /conversation\.pendingAttachments = \[\.\.\.pendingAttachments\(conversation\), local \? \{ \.\.\.attachment, dataPlane: "local_runtime", runtimeId: localRuntimeId \} : attachment\]\.slice\(0, MAX_PENDING_ATTACHMENTS\);/);
  assert.match(app, /function removePendingAttachment\(conversation, attachmentId\)/);
  assert.match(app, /const cloudAttachmentIds = attachments\.filter\(\(attachment\) => attachment\.dataPlane !== "local_runtime"\)\.map\(\(attachment\) => attachment\.id\);/);
  assert.match(app, /attachmentIds: cloudAttachmentIds,/);
  assert.match(app, /localUploadedSourceIds: localSourceIds/);
  assert.match(app, /messageAttachments: attachmentSnapshots\(attachments\)/);
  assert.match(app, /function attachmentSnapshots\(attachments\)/);
  assert.match(app, /const submittedAt = Date\.now\(\)/);
  assert.match(app, /const userMessage = \{[^\n]+attachments, createdAt: submittedAt \}/);
  assert.match(html, /id="submit" class="composer-action" type="button"/);
  assert.doesNotMatch(html, /id="cancel"/);
  assert.match(app, /function runComposerAction\(\)/);
  assert.match(app, /if \(target\.canCancel\) \{ void cancelActive\(\); return; \}/);
  assert.match(app, /primaryAction\.classList\.toggle\("is-stop", stopping\)/);
  assert.match(app, /primaryAction\.textContent = stopping \? "■" : "↑"/);
  assert.match(app, /msg-source-row" aria-label="本轮上传文件"/);
});

test("Web renews the Local Runtime capability before it expires and rotates it when login identity changes", async () => {
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(app, /const LOCAL_SESSION_REFRESH_AHEAD_MS = 5 \* 60 \* 1000;/);
  assert.match(app, /let localSessionExpiresAt = 0;/);
  assert.match(app, /function clearLocalSession\(\)/);
  assert.match(app, /function scheduleLocalSessionRefresh\(deviceId, userId\)/);
  assert.match(app, /if \(!localSessionToken \|\| localSessionExpiresAt - Date\.now\(\) <= LOCAL_SESSION_REFRESH_AHEAD_MS\) await refreshLocalSessionOnce\(\);/);
  assert.match(app, /if \(authenticatedUser\?\.id !== user\.id\) \{[\s\S]*?clearLocalSession\(\);/);
  assert.match(app, /if \(authenticatedUser\?\.id !== userId \|\| localDevice\?\.id !== deviceId\) throw new Error\("本机 Runtime 登录身份已更新，请重试"\);/);
});

test("Web persists question and terminal-response timing for the conversation stream", async () => {
  const [app, overrides] = await Promise.all([
    readFile(new URL("../web/app.js", import.meta.url), "utf8"),
    readFile(new URL("../web/runtime-overrides.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /const submittedAt = Date\.now\(\)/);
  assert.match(app, /createdAt: submittedAt/);
  assert.match(app, /function completeAssistantMessage\(assistant, event\)/);
  assert.match(app, /assistant\.completedAt = numberValue\(event\?\.createdAt\) \?\? Date\.now\(\)/);
  assert.match(app, /function formatMessageTime\(timestamp\)/);
  assert.match(app, /回答结束于 \$\{completedAt\}/);
  assert.match(app, /耗时 \$\{duration\}/);
  assert.match(app, /提问于 \$\{askedAt\}/);
  assert.match(app, /class="msg assistant \$\{isLive \? "live" : "final"\}/);
  assert.doesNotMatch(app, /\$\{isLive \? liveEventIndicator : ""\}/);
  assert.match(app, /renderMessageFooter\(message, completedAt[^\n]+liveEventIndicator\)/);
  assert.match(app, /正在连接 Runtime/);
  assert.match(app, /function renderMessageFooter\(message, timing, kind, eventFeedback = ""\)/);
  assert.match(app, /data-copy-message=/);
  assert.match(app, /function copyConversationMessage\(message, button\)/);
  assert.match(app, /navigator\.clipboard\?\.writeText/);
  assert.match(app, /function showCopyFeedback\(button, kind\)/);
  assert.match(app, /button\.classList\.add\("copied"\)/);
  assert.match(overrides, /\.message-timing/);
  assert.match(overrides, /\.msg\.assistant\.live \.live-output-text\s*\{[^}]*max-height:\s*min\(240px, 32vh\);[^}]*overflow-y:\s*auto;/s);
  assert.doesNotMatch(overrides, /\.live-output-text\.completed-output\s*\{/);
  assert.match(overrides, /\.message-footer\.event-feedback/);
  assert.match(overrides, /\.event-feedback \.live-event-indicator\.active/);
  assert.match(overrides, /@keyframes live-progress-glow/);
  assert.match(overrides, /@keyframes terminal-event-arrive/);
});

test("router distributes independent user tasks by available Runtime capacity", async () => {
  const router = new MultiRuntimeRouter();
  router.register(runtime("runtime-a"), endpoint("run-a"));
  router.register(runtime("runtime-b"), endpoint("run-b"));

  const first = await router.submit(task("user-a", "message-a"));
  const second = await router.submit(task("user-b", "message-b"));

  assert.equal(first.runtimeId, "runtime-a");
  assert.equal(second.runtimeId, "runtime-b");
});

test("router retries one user message through one Assignment", async () => {
  const router = new MultiRuntimeRouter();
  let dispatches = 0;
  router.register(runtime("runtime-a", { maxConcurrentRuns: 2 }), {
    async dispatch(envelope) {
      dispatches += 1;
      return { remoteRunId: `run-${envelope.dispatchKey}` };
    },
  });
  const input = task("user-a", "message-a");
  const [first, second] = await Promise.all([router.submit(input), router.submit(input)]);
  assert.equal(first.id, second.id);
  assert.equal(dispatches, 1);
});

test("router rejects cloud visible directory input", () => {
  const router = new MultiRuntimeRouter();
  router.register(runtime("runtime-a"), endpoint("run-a"));
  assert.throws(() => router.submit({ ...task("user-a", "message-a"), visibleDirectories: ["/Users/test"] } as never), /visibleDirectories/);
});

test("router fails closed when no Runtime has remaining capacity", async () => {
  const router = new MultiRuntimeRouter();
  router.register(runtime("runtime-a"), endpoint("run-a"));
  await router.submit(task("user-a", "message-a"));
  await assert.rejects(() => router.submit(task("user-b", "message-b")), RuntimeCapacityError);
});

test("router permits a retry after dispatch fails before a Run is accepted", async () => {
  const router = new MultiRuntimeRouter();
  let attempts = 0;
  router.register(runtime("runtime-a"), {
    async dispatch() {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary network failure");
      return { remoteRunId: "run-after-retry" };
    },
  });
  const input = task("user-a", "message-a");
  await assert.rejects(() => router.submit(input), /temporary network failure/);
  const accepted = await router.submit(input);
  assert.equal(accepted.remoteRunId, "run-after-retry");
  assert.equal(attempts, 2);
});

test("Runtime Host imports resources once and reuses its dispatch key", async () => {
  let imports = 0;
  let starts = 0;
  let ensured: { ownerUserId: string; conversationId: string; input: string } | undefined;
  const host = new AgentLoopRuntimeHost({
    async ensureConversation(ownerUserId, conversationId, input) {
      ensured = { ownerUserId, conversationId, input };
    },
    async startConversation() {
      starts += 1;
      return { id: "remote-run-1" } as never;
    },
    async get() {
      return { id: "remote-run-1", status: "completed", output: "done" } as never;
    },
    async readCommandOutput(ownerUserId, runId, toolCallId, stream) {
      assert.deepEqual({ ownerUserId, runId, toolCallId, stream }, { ownerUserId: "user", runId: "remote-run-1", toolCallId: "command-1", stream: "stdout" });
      return { toolCallId, stream, content: "complete stdout" };
    },
    async readToolArguments(ownerUserId, runId, toolCallId) {
      assert.deepEqual({ ownerUserId, runId, toolCallId }, { ownerUserId: "user", runId: "remote-run-1", toolCallId: "command-1" });
      return { toolCallId, arguments: { command: "python3" }, content: '{"command":"python3"}' };
    },
  }, {
    async importForRun() {
      imports += 1;
      return ["src_local"];
    },
  });
  const envelope: RuntimeDispatchEnvelope = {
    schema: "agentloop.runtimeDispatch/v1",
    assignmentId: "assignment-1",
    dispatchKey: "dispatch-1",
    subject: { tenantId: "tenant", userId: "user" },
    conversationId: "conversation",
    input: "summarize the attachment",
    allowDangerousTools: false,
    resourceRefs: [],
  };
  const [first, second] = await Promise.all([host.dispatch(envelope), host.dispatch(envelope)]);
  assert.deepEqual(first, { remoteRunId: "remote-run-1" });
  assert.deepEqual(second, first);
  assert.equal(imports, 1);
  assert.equal(starts, 1);
  assert.deepEqual(ensured, { ownerUserId: "user", conversationId: "conversation", input: "summarize the attachment" });
  assert.deepEqual(await host.getRun("remote-run-1"), {
    remoteRunId: "remote-run-1",
    status: "completed",
    output: "done",
  });
  assert.deepEqual(await host.commandOutput("remote-run-1", "command-1", "stdout"), {
    toolCallId: "command-1", stream: "stdout", content: "complete stdout",
  });
  assert.deepEqual(await host.toolArguments("remote-run-1", "command-1"), {
    toolCallId: "command-1", arguments: { command: "python3" }, content: '{"command":"python3"}',
  });
});

test("Runtime Host keeps generic failed output as execution evidence", async () => {
  const report = "任务未完成，以下为已确认的处理说明。\n\n已整理可供参考的部分结果。";
  const host = new AgentLoopRuntimeHost({
    async ensureConversation() {},
    async startConversation() { return { id: "failed-run" } as never; },
    async get() { return { id: "failed-run", status: "failed", output: report, errorCode: "STEP_NOT_COMPLETED" } as never; },
    async events() {
      return [{
        seq: 4,
        type: "run.failed",
        data: { code: "STEP_NOT_COMPLETED", message: "internal failure detail", output: report },
        createdAt: 400,
      }];
    },
  }, { async importForRun() { return []; } });
  const envelope: RuntimeDispatchEnvelope = {
    schema: "agentloop.runtimeDispatch/v1",
    assignmentId: "assignment-failed-report",
    dispatchKey: "dispatch-failed-report",
    subject: { tenantId: "tenant", userId: "user" },
    conversationId: "conversation",
    input: "summarize the attachment",
    allowDangerousTools: false,
    resourceRefs: [],
  };
  await host.dispatch(envelope);
  assert.deepEqual(await host.getRun("failed-run"), {
    remoteRunId: "failed-run",
    status: "failed",
    output: report,
    errorCode: "STEP_NOT_COMPLETED",
  });
  assert.deepEqual(await host.events("failed-run", 0), [{
    seq: 4,
    type: "run.failed",
    data: { code: "STEP_NOT_COMPLETED", message: "internal failure detail", output: report },
    createdAt: 400,
  }]);
});

test("resource importer stops unsupported Sources before they can be bound to a Run", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer router-token");
    return new Response("legacy document");
  };
  try {
    const importer = new HttpResourceImporter({
      async uploadSource() {
        return {
          id: "src_legacy",
          originalName: "授权委托书.doc",
          mimeType: "application/msword",
          extension: ".doc",
          byteSize: 15,
          sha256: "a".repeat(64),
          status: "unsupported",
          chunkCount: 0,
          truncated: false,
        };
      },
    } as never, "router-token");
    await assert.rejects(
      () => importer.importForRun({
        subject: { tenantId: "tenant", userId: "user" },
        conversationId: "conversation",
        resources: [{
          attachmentId: "attachment-legacy",
          uri: "http://router.test/v1/internal/attachments/attachment-legacy",
          sha256: createHash("sha256").update("legacy document").digest("hex"),
          mediaType: "application/msword",
          originalName: "授权委托书.doc",
          byteSize: 15,
        }],
      }),
      /附件「授权委托书\.doc」：该格式暂不支持（\.doc）/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cloud runtime configuration accepts deployable Hosts but rejects desktop and local-directory settings", () => {
  const config = parseMultiRuntimeConfig(JSON.stringify({
    schema: "agentloop.multiRuntimeConfig/v1",
    runtimes: [{
      id: "general-01",
      endpoint: "http://runtime-general-01:8790",
      profile: "general",
      capabilities: ["document"],
      maxConcurrentRuns: 4,
    }],
  }));
  assert.equal(config.runtimes[0]?.id, "general-01");
  assert.throws(() => parseMultiRuntimeConfig(JSON.stringify({
    schema: "agentloop.multiRuntimeConfig/v1",
    runtimes: [{ ...config.runtimes[0], profile: "desktop" }],
  })), /not allowed/);
  assert.throws(() => parseMultiRuntimeConfig(JSON.stringify({
    schema: "agentloop.multiRuntimeConfig/v1",
    runtimes: [{ ...config.runtimes[0], visibleDirectories: ["/Users/test"] }],
  })), /visibleDirectories/);
});

test("Runtime Hosts merge app-configured custom Skill roots with bundled Skills", () => {
  const appRoot = "/srv/agentloop/apps/agentloop-multi-runtime";
  const customDirectories = resolveSkillDirectoriesConfig(parseSkillDirectoriesConfig(JSON.stringify({
    schema: "agentloop.skillDirectories/v1",
    customSkillDirectories: ["./custom-skills", "/opt/team-skills", "./custom-skills"],
  })), appRoot);

  assert.deepEqual(customDirectories, [
    "/srv/agentloop/apps/agentloop-multi-runtime/custom-skills",
    "/opt/team-skills",
  ]);
  assert.deepEqual(mergeSkillDirectories(["/packages/bundled-skills"], customDirectories), [
    "/packages/bundled-skills",
    "/srv/agentloop/apps/agentloop-multi-runtime/custom-skills",
    "/opt/team-skills",
  ]);
  assert.throws(() => parseSkillDirectoriesConfig("{}"), /schema/);
  assert.throws(() => parseSkillDirectoriesConfig(JSON.stringify({
    schema: "agentloop.skillDirectories/v1",
    customSkillDirectories: [""],
  })), /non-empty strings/);
});

test("Skill directory config resolves relative paths from the multi-runtime application root", async () => {
  const configRoot = await mkdtemp(join(tmpdir(), "agentloop-skill-config-"));
  const configPath = join(configRoot, "skill-directories.json");
  try {
    await writeFile(configPath, JSON.stringify({
      schema: "agentloop.skillDirectories/v1",
      customSkillDirectories: ["./custom-skills"],
    }));
    assert.deepEqual(await loadSkillDirectoriesConfig({
      appRoot: "/srv/agentloop/apps/agentloop-multi-runtime",
      configPath,
    }), ["/srv/agentloop/apps/agentloop-multi-runtime/custom-skills"]);
  } finally {
    await rm(configRoot, { recursive: true, force: true });
  }
});

test("Runtime Host rejects a dispatch carrying application-owned intent or visible directory data", () => {
  assert.throws(() => assertRuntimeDispatchEnvelope({
    schema: "agentloop.runtimeDispatch/v1",
    visibleDirectories: ["/Users/test"],
  }), /visibleDirectories/);
  assert.throws(() => assertRuntimeDispatchEnvelope({
    schema: "agentloop.runtimeDispatch/v1",
    assignmentId: "assignment-1",
    dispatchKey: "dispatch-1",
    subject: { tenantId: "tenant", userId: "user" },
    conversationId: "conversation-1",
    input: "hello",
    allowDangerousTools: false,
    conversationIntent: "auto",
  }), /conversationIntent is Runtime-owned/);
  assert.throws(() => assertRuntimeDispatchEnvelope({ schema: "unexpected" }), /unsupported runtime dispatch schema/);
});

test("Router converts owned attachment IDs and never accepts browser resource references", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-multi-runtime-test-"));
  const attachments = new FileAttachmentBroker(root, "http://router.test");
  try {
    const attachment = await attachments.upload({
      tenantId: "tenant",
      ownerUserId: "user",
      conversationId: "conversation-user",
      originalName: "brief.txt",
      mediaType: "text/plain",
      content: Buffer.from("hello router attachment"),
    });
    const dispatched = await taskFromRequest({
      conversationId: "conversation-user",
      clientMessageId: "message-1",
      input: "summarize attachment",
      attachmentIds: [attachment.id],
    }, { tenantId: "tenant", userId: "user", email: "test@example.test" }, attachments);
    assert.equal(dispatched.allowDangerousTools, true);
    assert.equal((await taskFromRequest({
      conversationId: "conversation-user",
      clientMessageId: "message-1-disabled",
      input: "summarize attachment",
      allowDangerousTools: false,
    }, { tenantId: "tenant", userId: "user", email: "test@example.test" }, attachments)).allowDangerousTools, false);
    assert.equal(dispatched.resourceRefs?.[0]?.originalName, "brief.txt");
    assert.equal(dispatched.resourceRefs?.[0]?.byteSize, "hello router attachment".length);
    const localDispatched = await taskFromRequest({
      conversationId: "conversation-user",
      clientMessageId: "message-local",
      input: "summarize local attachment",
      executionTarget: { kind: "local_device", deviceId: "device-1", runtimeId: "runtime-1" },
      dataPolicy: { mode: "local" },
      localUploadedSourceIds: ["source-local"],
      messageAttachments: [{ id: "source-local", originalName: "local-brief.txt", mediaType: "text/plain", byteSize: 23 }],
    }, { tenantId: "tenant", userId: "user", email: "test@example.test" }, attachments);
    assert.deepEqual(localDispatched.messageAttachments, [{ id: "source-local", originalName: "local-brief.txt", mediaType: "text/plain", byteSize: 23 }]);
    await assert.rejects(taskFromRequest({
      conversationId: "conversation-user",
      clientMessageId: "message-local-invalid",
      input: "summarize local attachment",
      executionTarget: { kind: "local_device", deviceId: "device-1", runtimeId: "runtime-1" },
      dataPolicy: { mode: "local" },
      localUploadedSourceIds: ["source-local"],
      messageAttachments: [{ id: "other-source", originalName: "wrong.txt", mediaType: "text/plain", byteSize: 1 }],
    }, { tenantId: "tenant", userId: "user", email: "test@example.test" }, attachments), /messageAttachments must exactly describe localUploadedSourceIds/);
    await assert.rejects(taskFromRequest({ conversationId: "c", clientMessageId: "m", input: "x", conversationIntent: "auto" }, { tenantId: "tenant", userId: "user", email: "test@example.test" }, attachments), /conversationIntent is Runtime-owned/);
    await assert.rejects(taskFromRequest({ conversationId: "c", clientMessageId: "m", input: "x", resourceRefs: [] }, { tenantId: "tenant", userId: "user", email: "test@example.test" }, attachments), /resourceRefs are Router-owned/);
    await assert.rejects(taskFromRequest({ tenantId: "attacker", ownerUserId: "attacker", conversationId: "c", clientMessageId: "m", input: "x" }, { tenantId: "tenant", userId: "user", email: "test@example.test" }, attachments), /derived from the authenticated session/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared attachment metadata is visible to another Router replica", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-multi-runtime-attachments-"));
  const database = new AppDatabase(join(root, "state.db"));
  const first = new SharedFilesystemAttachmentBroker(database, join(root, "attachments"), "http://router.test");
  const second = new SharedFilesystemAttachmentBroker(database, join(root, "attachments"), "http://router.test");
  try {
    await Promise.all([first.ready(), second.ready()]);
    const attachment = await first.upload({
      tenantId: "tenant", ownerUserId: "user", conversationId: "conversation-user",
      originalName: "shared.txt", mediaType: "text/plain", content: Buffer.from("available to both routers"),
    });
    const [reference] = await second.resolveForTask({
      tenantId: "tenant", ownerUserId: "user", conversationId: "conversation-user", attachmentIds: [attachment.id],
    });
    assert.equal(reference?.attachmentId, attachment.id);
    assert.equal((await second.readForRuntime(attachment.id)).content.toString("utf8"), "available to both routers");
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Router permits only configured Web origins for local development", () => {
  const configured = "http://localhost:5174,http://127.0.0.1:5174";
  assert.equal(webOriginMatches("http://localhost:5174", configured), true);
  assert.equal(webOriginMatches("http://127.0.0.1:5174", configured), true);
  assert.equal(webOriginMatches("http://localhost:5175", configured), false);
  assert.equal(webOriginMatches("https://example.invalid", configured), false);
});

test("Router reserves assignment lookup for its exact path so the SSE subroute remains reachable", () => {
  assert.equal(assignmentIdFromPath("/v1/assignments/assignment-1"), "assignment-1");
  assert.equal(assignmentIdFromPath("/v1/assignments/assignment-1/events"), undefined);
  assert.equal(assignmentIdFromPath("/v1/assignments/assignment-1/events/stream"), undefined);
});

test("Router SSE polling retains the Router receiver for persistent event projections", async () => {
  const router = {
    marker: "durable-router",
    async events(this: { readonly marker: string }, assignmentId: string, afterSeq: number) {
      assert.equal(this.marker, "durable-router");
      assert.equal(assignmentId, "assignment-1");
      assert.equal(afterSeq, 7);
      return { assignment: { tenantId: "tenant", ownerUserId: "user" }, events: [] };
    },
  };
  const projection = await bindRouterEvents(router)("assignment-1", 7);
  assert.deepEqual(projection, { assignment: { tenantId: "tenant", ownerUserId: "user" }, events: [] });
});

test("Router SSE keeps polling after the GET request is complete and stops only when its response closes", async () => {
  const request = new EventEmitter();
  const response = new EventEmitter() as EventEmitter & {
    statusCode?: number;
    setHeader(name: string, value: string): void;
    flushHeaders(): void;
    write(chunk: string): void;
    end(): void;
  };
  const writes: string[] = [];
  response.setHeader = () => {};
  response.flushHeaders = () => {};
  response.write = (chunk) => { writes.push(chunk); };
  response.end = () => {};
  let polls = 0;
  streamEvents(
    request as never,
    response as never,
    async () => {
      polls += 1;
      return {
        assignment: { tenantId: "tenant", ownerUserId: "user" },
        events: polls === 1 ? [{ seq: 2, type: "assistant.streaming", data: { reasoningContent: "still streaming" }, createdAt: 2 }] : [],
      };
    },
    "assignment-1",
    [{ seq: 1, type: "run.started", data: {}, createdAt: 1 }],
  );
  request.emit("close");
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  assert.equal(polls, 1);
  assert.match(writes.join(""), /assistant\.streaming/);
  response.emit("close");
});

test("Router projects a terminal Host event durably and never regresses it to running", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([{ ...runtime("runtime-terminal"), endpoint: "http://runtime-terminal" }], 100);
  await store.heartbeat({ runtimeId: "runtime-terminal", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  const router = new PersistentMultiRuntimeRouter({
    store,
    heartbeatTtlMs: 1_000,
    now: () => 200,
    endpointFactory: () => ({
      async dispatch() { return { remoteRunId: "terminal-run" }; },
      async events() { return [{ seq: 1, type: "run.completed", data: { output: "done" }, createdAt: 200 }]; },
    }),
  });
  const assignment = await router.submit(task("user-terminal", "message-terminal"));
  const observed = await router.events(assignment.id, 0);
  assert.equal(observed?.assignment.status, "completed");
  await store.observeRun(assignment.id, { remoteRunId: "terminal-run", status: "running" }, 201);
  assert.equal((await store.assignment(assignment.id))?.status, "completed");
  await database.close();
});

test("terminal event hydrates the final artifact catalog before browser projection", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "agentloop-terminal-event-artifact-"));
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([{ ...runtime("runtime-terminal-event-artifact"), endpoint: "http://runtime-terminal-event-artifact" }], 100);
  await store.heartbeat({ runtimeId: "runtime-terminal-event-artifact", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  const catalog = new SharedWorkspaceArtifactCatalog(database, workspaceRoot);
  const router = new PersistentMultiRuntimeRouter({
    store,
    artifactsCatalog: catalog,
    heartbeatTtlMs: 1_000,
    now: () => 200,
    endpointFactory: () => ({
      async dispatch() { return { remoteRunId: "terminal-event-artifact-run" }; },
      async events() { return [{ seq: 1, type: "run.completed", data: {}, createdAt: 200 }]; },
      async getRun() {
        return {
          remoteRunId: "terminal-event-artifact-run",
          status: "completed" as const,
          output: "artifact delivered",
          artifacts: [{
            id: "terminal-event-artifact", runId: "terminal-event-artifact-run", path: "deliveries/report.pdf", name: "report.pdf", bytes: 14,
            mimeType: "application/pdf", role: "final" as const, sourceTool: "computer_run_command" as const, previewable: true,
          }],
        };
      },
    }),
  });
  try {
    const assignment = await router.submit(task("user-terminal-event-artifact", "message-terminal-event-artifact"));
    const conversationRoot = join(workspaceRoot, "conversations", assignment.conversationId, "deliveries");
    await mkdir(conversationRoot, { recursive: true });
    await writeFile(join(conversationRoot, "report.pdf"), "%PDF-1.4\nfinal");

    const projection = await router.events(assignment.id, 0);

    assert.equal(projection?.assignment.status, "completed");
    assert.equal((await catalog.list(assignment.id))[0]?.id, "terminal-event-artifact");
    const conversation = await store.conversation("tenant", "user-terminal-event-artifact", assignment.conversationId);
    assert.equal(conversation?.turns[0]?.finalTurn?.assistantOutput, "artifact delivered");
  } finally {
    await database.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("terminal reconciliation captures shared-workspace artifacts before the original Host is unavailable", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "agentloop-terminal-artifact-catalog-"));
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([{ ...runtime("runtime-terminal-artifact"), endpoint: "http://runtime-terminal-artifact" }], 100);
  await store.heartbeat({ runtimeId: "runtime-terminal-artifact", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  const catalog = new SharedWorkspaceArtifactCatalog(database, workspaceRoot);
  let hostAvailable = true;
  const router = new PersistentMultiRuntimeRouter({
    store,
    artifactsCatalog: catalog,
    heartbeatTtlMs: 1_000,
    now: () => 200,
    endpointFactory: () => ({
      async dispatch() { return { remoteRunId: "terminal-artifact-run" }; },
      async getRun() {
        if (!hostAvailable) throw new Error("original Host is offline");
        return {
          remoteRunId: "terminal-artifact-run",
          status: "completed" as const,
          artifacts: [{
            id: "terminal-artifact", runId: "terminal-artifact-run", path: "deliveries/report.md", name: "report.md", bytes: 17,
            mimeType: "text/markdown", role: "final" as const, sourceTool: "computer_write_file" as const, previewable: true,
          }],
        };
      },
    }),
  });
  try {
    const assignment = await router.submit(task("user-terminal-artifact", "message-terminal-artifact"));
    const conversationRoot = join(workspaceRoot, "conversations", assignment.conversationId, "deliveries");
    await mkdir(conversationRoot, { recursive: true });
    await writeFile(join(conversationRoot, "report.md"), "# Durable report\n");

    await router.reconcileAssignments();
    assert.equal((await store.assignment(assignment.id))?.status, "completed");
    assert.equal((await catalog.list(assignment.id)).length, 1);

    hostAvailable = false;
    const artifacts = await router.artifacts(assignment.id);
    assert.equal(artifacts?.artifacts[0]?.id, "terminal-artifact");
    const read = await router.readArtifact(assignment.id, "terminal-artifact");
    assert.equal(Buffer.from(read?.content ?? []).toString("utf8"), "# Durable report\n");
    const preview = await router.previewArtifact(assignment.id, "terminal-artifact");
    assert.deepEqual(preview?.preview, {
      kind: "text", name: "report.md", mimeType: "text/markdown", text: "# Durable report\n", truncated: false,
    });
  } finally {
    await database.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Router preserves Host round-limit failures for browser replay and recovery", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([{ ...runtime("runtime-round-limit"), endpoint: "http://runtime-round-limit" }], 100);
  await store.heartbeat({ runtimeId: "runtime-round-limit", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  const router = new PersistentMultiRuntimeRouter({
    store,
    heartbeatTtlMs: 1_000,
    now: () => 200,
    endpointFactory: () => ({
      async dispatch() { return { remoteRunId: "round-limit-run" }; },
      async getRun() { return { remoteRunId: "round-limit-run", status: "failed" as const, errorCode: "RUN_LIMIT_EXCEEDED" }; },
      async events() {
        return [{
          seq: 7,
          type: "run.failed",
          data: {
            code: "RUN_LIMIT_EXCEEDED",
            message: "Run exceeded its 12-step limit while required evidence remained missing.",
          },
          createdAt: 200,
        }];
      },
    }),
  });
  const assignment = await router.submit(task("user-round-limit", "message-round-limit"));
  const observed = await router.events(assignment.id, 0);
  assert.equal(observed?.assignment.status, "failed");
  assert.equal(observed?.assignment.errorCode, "RUN_LIMIT_EXCEEDED");
  assert.match(observed?.assignment.errorMessage ?? "", /12-step limit/);

  const recovered = await router.assignment(assignment.id);
  assert.equal(recovered?.run?.errorCode, "RUN_LIMIT_EXCEEDED");
  assert.match(recovered?.run?.errorMessage ?? "", /required evidence remained missing/);

  const assistant: { status: string; text: string; reasoning: string; error?: string; events: never[]; plan: never[] } = {
    status: "running", text: "", reasoning: "still working", events: [], plan: [],
  };
  assert.equal(projectAssistantEvent(assistant, observed?.events[0] as unknown as Record<string, unknown>), true);
  assert.equal(assistant.status, "failed");
  assert.equal(assistant.error, "本轮达到可用轮次上限，尚未形成最终结果。");
  assert.equal(assistant.text, "");
  assert.doesNotMatch(assistant.error ?? "", /12-step limit|required evidence remained missing/);
  await database.close();
});

test("persistent Router dispatches only heartbeating Hosts and reuses the durable Assignment", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([
    { ...runtime("runtime-a", { maxConcurrentRuns: 2 }), endpoint: "http://runtime-a" },
    { ...runtime("runtime-b", { maxConcurrentRuns: 2 }), endpoint: "http://runtime-b" },
  ], 100);
  await store.heartbeat({ runtimeId: "runtime-b", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  let dispatches = 0;
  const router = new PersistentMultiRuntimeRouter({
    store,
    heartbeatTtlMs: 1_000,
    now: () => 200,
    endpointFactory: () => ({
      async dispatch() {
        dispatches += 1;
        return { remoteRunId: "remote-run-b" };
      },
    }),
  });
  const first = await router.submit(task("user-a", "message-a"));
  const duplicate = await router.submit(task("user-a", "message-a"));
  assert.equal(first.runtimeId, "runtime-b");
  assert.equal(duplicate.id, first.id);
  assert.equal(dispatches, 1);
  await database.close();
});

test("Router Runtime catalog exposes concrete statically registered Runtime IDs", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([
    { ...runtime("runtime-general"), endpoint: "http://runtime-general" },
    { ...runtime("runtime-artifact", { profile: "artifact" }), endpoint: "http://runtime-artifact" },
  ], 100);
  const router = new PersistentMultiRuntimeRouter({ store, endpointFactory: () => endpoint("unused") });
  assert.deepEqual((await router.runtimes()).map((runtime) => ({ ...runtime })), [
    { id: "runtime-artifact", profile: "artifact", kind: "cloud", status: "offline" },
    { id: "runtime-general", profile: "general", kind: "cloud", status: "offline" },
  ]);
  await database.close();
});

test("explicit Runtime selection uses that Host and rejects an unregistered ID", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([
    { ...runtime("general-01"), endpoint: "http://general-01" },
    { ...runtime("general-02"), endpoint: "http://general-02" },
  ], 100);
  await store.heartbeat({ runtimeId: "general-01", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  await store.heartbeat({ runtimeId: "general-02", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  const router = new PersistentMultiRuntimeRouter({
    store,
    now: () => 200,
    endpointFactory: () => ({ async dispatch() { return { remoteRunId: "remote-run" }; } }),
  });
  const assigned = await router.submit({ ...task("user-a", "message-a"), requestedRuntimeId: "general-02" });
  assert.equal(assigned.runtimeId, "general-02");
  await assert.rejects(
    () => router.submit({ ...task("user-b", "message-b"), requestedRuntimeId: "missing-runtime" }),
    /Runtime "missing-runtime" is not registered/,
  );
  await database.close();
});

test("persistent Router keeps a conversation on its original Runtime Host", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([
    { ...runtime("runtime-a", { maxConcurrentRuns: 3 }), endpoint: "http://runtime-a" },
    { ...runtime("runtime-b", { maxConcurrentRuns: 3 }), endpoint: "http://runtime-b" },
  ], 100);
  await store.heartbeat({ runtimeId: "runtime-a", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  await store.heartbeat({ runtimeId: "runtime-b", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  const router = new PersistentMultiRuntimeRouter({
    store,
    now: () => 200,
    endpointFactory: (endpoint) => ({ async dispatch() { return { remoteRunId: `${endpoint}-run` }; } }),
  });
  const first = await router.submit(task("user-a", "message-a", "conversation-sticky"));
  const second = await router.submit(task("user-a", "message-b", "conversation-sticky"));
  assert.equal(second.runtimeId, first.runtimeId);
  await database.close();
});

test("a stale preferred Runtime does not block the next conversation Run from using a healthy Host", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([
    { ...runtime("runtime-a", { maxConcurrentRuns: 2 }), endpoint: "http://runtime-a" },
    { ...runtime("runtime-b", { maxConcurrentRuns: 2 }), endpoint: "http://runtime-b" },
  ], 100);
  await store.heartbeat({ runtimeId: "runtime-a", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  await store.heartbeat({ runtimeId: "runtime-b", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });

  const first = await store.reserve(task("user-a", "message-first", "conversation-migrated"), {
    heartbeatTtlMs: 1_000,
    reservationTtlMs: 1_000,
    now: 200,
  });
  assert.equal(first.runtimeId, "runtime-a");
  await store.markAccepted(first.id, "run-on-a", 201);

  // runtime-a has missed its heartbeat, while runtime-b remains healthy.
  await store.heartbeat({ runtimeId: "runtime-b", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 1_300 });
  const next = await store.reserve(task("user-a", "message-next", "conversation-migrated"), {
    heartbeatTtlMs: 1_000,
    reservationTtlMs: 1_000,
    now: 1_300,
  });
  assert.equal(next.runtimeId, "runtime-b");
  const migration = await database.prepare(`
    SELECT previous_runtime_id, selected_runtime_id, reason
    FROM mr_conversation_runtime_migrations WHERE assignment_id = ?
  `).get(next.id) as { previous_runtime_id: string; selected_runtime_id: string; reason: string };
  assert.equal(migration.previous_runtime_id, "runtime-a");
  assert.equal(migration.selected_runtime_id, "runtime-b");
  assert.equal(migration.reason, "preferred_runtime_unavailable_or_at_capacity");
  await database.close();
});

test("a dispatch reservation does not bind a conversation before its Host starts the Run", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([
    { ...runtime("runtime-a", { maxConcurrentRuns: 2 }), endpoint: "http://runtime-a" },
    { ...runtime("runtime-b", { maxConcurrentRuns: 2 }), endpoint: "http://runtime-b" },
  ], 100);
  await store.heartbeat({ runtimeId: "runtime-a", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  await store.heartbeat({ runtimeId: "runtime-b", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });

  // The first submission is only a Router reservation: no Host has returned
  // a remote Run id yet. A later message in the conversation must therefore
  // still use normal load balancing instead of inheriting runtime-a.
  await store.reserve({ ...task("user-a", "message-reserved", "conversation-pending"), requestedRuntimeId: "runtime-a" }, {
    heartbeatTtlMs: 1_000,
    reservationTtlMs: 1_000,
    now: 200,
  });
  const next = await store.reserve(task("user-a", "message-balanced", "conversation-pending"), {
    heartbeatTtlMs: 1_000,
    reservationTtlMs: 1_000,
    now: 201,
  });
  assert.equal(next.runtimeId, "runtime-b");
  await database.close();
});

test("persistent capacity uses heartbeat load, reservations, and terminal release", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([{ ...runtime("runtime-a"), endpoint: "http://runtime-a" }], 100);
  await store.heartbeat({ runtimeId: "runtime-a", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  const first = await store.reserve(task("user-a", "message-a"), { heartbeatTtlMs: 1_000, reservationTtlMs: 1_000, now: 200 });
  await assert.rejects(
    () => store.reserve(task("user-b", "message-b"), { heartbeatTtlMs: 1_000, reservationTtlMs: 1_000, now: 200 }),
    PersistentRuntimeCapacityError,
  );
  await store.markAccepted(first.id, "remote-a", 201);
  await store.observeRun(first.id, { remoteRunId: "remote-a", status: "completed" }, 202);
  const next = await store.reserve(task("user-b", "message-b"), { heartbeatTtlMs: 1_000, reservationTtlMs: 1_000, now: 203 });
  assert.equal(next.runtimeId, "runtime-a");
  await database.close();
});

test("automatic routing honors the concurrency limit enforced by each Runtime Host", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  // The static inventory is deliberately more optimistic than the two Hosts.
  // Their heartbeats must be authoritative, otherwise a fresh conversation can
  // be dispatched to a Host that will reject it as already full.
  await store.seedRuntimes([
    { ...runtime("runtime-busy", { maxConcurrentRuns: 2 }), endpoint: "http://runtime-busy" },
    { ...runtime("runtime-idle", { maxConcurrentRuns: 2 }), endpoint: "http://runtime-idle" },
  ], 100);
  await store.heartbeat({ runtimeId: "runtime-busy", status: "ready", activeRunCount: 1, queuedRunCount: 0, maxConcurrentRuns: 1, observedAt: 100 });
  await store.heartbeat({ runtimeId: "runtime-idle", status: "ready", activeRunCount: 0, queuedRunCount: 0, maxConcurrentRuns: 1, observedAt: 100 });

  const router = new PersistentMultiRuntimeRouter({
    store,
    now: () => 200,
    endpointFactory: (endpoint) => ({ async dispatch() { return { remoteRunId: `${endpoint}-run` }; } }),
  });
  const assignment = await router.submit(task("user-new-conversation", "message-new-conversation", "conversation-new"));
  assert.equal(assignment.runtimeId, "runtime-idle");

  await store.heartbeat({ runtimeId: "runtime-idle", status: "ready", activeRunCount: 1, queuedRunCount: 0, maxConcurrentRuns: 1, observedAt: 300 });
  await assert.rejects(
    () => store.reserve(task("user-next-conversation", "message-next-conversation", "conversation-next"), { heartbeatTtlMs: 1_000, reservationTtlMs: 1_000, now: 301 }),
    PersistentRuntimeCapacityError,
  );
  await database.close();
});

test("a fresh Host heartbeat releases stale accepted assignment occupancy", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([{ ...runtime("runtime-a"), endpoint: "http://runtime-a" }], 100);
  await store.heartbeat({ runtimeId: "runtime-a", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  const first = await store.reserve(task("user-a", "message-a"), { heartbeatTtlMs: 1_000, reservationTtlMs: 1_000, now: 200 });
  await store.markAccepted(first.id, "remote-a", 201);
  await assert.rejects(
    () => store.reserve(task("user-b", "message-b"), { heartbeatTtlMs: 1_000, reservationTtlMs: 1_000, now: 202 }),
    PersistentRuntimeCapacityError,
  );
  await store.heartbeat({ runtimeId: "runtime-a", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 300 });
  const next = await store.reserve(task("user-b", "message-b"), { heartbeatTtlMs: 1_000, reservationTtlMs: 1_000, now: 301 });
  assert.equal(next.runtimeId, "runtime-a");
  await database.close();
});

test("expired dispatch reservation is recoverable without duplicating the task", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([{ ...runtime("runtime-a", { maxConcurrentRuns: 2 }), endpoint: "http://runtime-a" }], 100);
  await store.heartbeat({ runtimeId: "runtime-a", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  const initial = await store.reserve(task("user-a", "message-a"), { heartbeatTtlMs: 1_000, reservationTtlMs: 10, now: 200 });
  const retry = await store.reserve(task("user-a", "message-a"), { heartbeatTtlMs: 1_000, reservationTtlMs: 10, now: 211 });
  assert.notEqual(retry.id, initial.id);
  assert.equal(retry.runtimeId, "runtime-a");
  await database.close();
});

test("Host persists dispatch idempotency across a process restart", async () => {
  const database = new AppDatabase(":memory:");
  const dispatchStore = new HostDispatchStore(database);
  await dispatchStore.ready();
  let starts = 0;
  const runs = {
    async ensureConversation() {},
    async startConversation() {
      starts += 1;
      return { id: "durable-run" } as never;
    },
    async get() {
      return { id: "durable-run", status: "running" } as never;
    },
  };
  const firstHost = new AgentLoopRuntimeHost(runs, { async importForRun() { return []; } }, undefined, dispatchStore);
  const envelope: RuntimeDispatchEnvelope = {
    schema: "agentloop.runtimeDispatch/v1",
    assignmentId: "assignment-durable",
    dispatchKey: "dispatch-durable",
    subject: { tenantId: "tenant", userId: "user" },
    conversationId: "conversation",
    input: "durable task",
    allowDangerousTools: false,
    resourceRefs: [],
  };
  assert.deepEqual(await firstHost.dispatch(envelope), { remoteRunId: "durable-run" });
  const restartedHost = new AgentLoopRuntimeHost(runs, { async importForRun() { return []; } }, undefined, dispatchStore);
  assert.deepEqual(await restartedHost.dispatch(envelope), { remoteRunId: "durable-run" });
  assert.equal(starts, 1);
  assert.equal((await restartedHost.getRun("durable-run")).status, "running");
  await database.close();
});

test("a shared state database reports active Runs only to their accepting Host", async () => {
  const database = new AppDatabase(":memory:");
  const hostA = new HostDispatchStore(database, "runtime-a");
  const hostB = new HostDispatchStore(database, "runtime-b");
  await hostA.ready();
  await hostB.ready();
  await database.prepare(`
    INSERT INTO runs(id, owner_user_id, conversation_id, parent_run_id, depth, allow_dangerous_tools, model_key, status, input, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("shared-run-a", "user-a", null, null, 0, 0, null, "running", "task", 100);
  assert.deepEqual(await hostA.claim({ dispatchKey: "dispatch-shared-a", assignmentId: "assignment-shared-a", ownerUserId: "user-a", now: 100, leaseMs: 1_000 }), { kind: "claimed" });
  await hostA.accept("dispatch-shared-a", "shared-run-a", 101);
  assert.equal(await hostA.activeRunCount(), 1);
  assert.equal(await hostB.activeRunCount(), 0);

  await database.prepare(`
    INSERT INTO runtime_actions(
      id, run_id, plan_id, step_id, kind, state, attempt, max_attempts,
      replay_policy, deadline_at, lease_until, fence, revision, metadata_json,
      result_ref, error_code, created_at, updated_at, closed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "recovery-action-a", "shared-run-a", null, null, "recovery_review", "recovery_required", 0, 0,
    "unsafe", null, null, 0, 1, "{}", null, null, 102, 102, null,
  );
  await database.prepare(`
    INSERT INTO run_recovery_states(run_id, state, action_id, question, updated_at)
    VALUES (?, 'waiting_recovery', ?, NULL, ?)
  `).run("shared-run-a", "recovery-action-a", 102);

  // The Run is recoverable but no executor is running. It must release the
  // Host admission slot until recovery resumes and removes this state.
  assert.equal(await hostA.activeRunCount(), 0);
  await database.close();
});

test("a Runtime Host reconciles only Runs durably accepted by its own executor ledger", async () => {
  const database = new AppDatabase(":memory:");
  const hostA = new HostDispatchStore(database, "runtime-a");
  const hostB = new HostDispatchStore(database, "runtime-b");
  await hostA.ready();
  await hostB.ready();
  await hostA.claim({ dispatchKey: "dispatch-a", assignmentId: "assignment-a", ownerUserId: "user-a", now: 100, leaseMs: 1_000 });
  await hostA.accept("dispatch-a", "run-a", 101);
  await hostB.claim({ dispatchKey: "dispatch-b", assignmentId: "assignment-b", ownerUserId: "user-b", now: 100, leaseMs: 1_000 });
  await hostB.accept("dispatch-b", "run-b", 101);
  assert.deepEqual(await hostA.ownedRunIds(), ["run-a"]);
  assert.deepEqual(await hostB.ownedRunIds(), ["run-b"]);
  await database.close();
});

test("persistent Router forwards cancellation to the assigned Host and persists terminal state", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([{ ...runtime("runtime-a"), endpoint: "http://runtime-a" }], 100);
  await store.heartbeat({ runtimeId: "runtime-a", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  const router = new PersistentMultiRuntimeRouter({
    store,
    now: () => 200,
    heartbeatTtlMs: 1_000,
    endpointFactory: () => ({
      async dispatch() { return { remoteRunId: "run-a" }; },
      async cancelRun() { return { remoteRunId: "run-a", status: "cancelled" }; },
    }),
  });
  const assignment = await router.submit(task("user-a", "message-a"));
  const cancelled = await router.cancel(assignment.id);
  assert.equal(cancelled.run.status, "cancelled");
  assert.equal(cancelled.assignment.status, "cancelled");
  await database.close();
});

test("persistent Router forwards recovery advance and resume to the assigned Host", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([{ ...runtime("runtime-recovery"), endpoint: "http://runtime-recovery" }], 100);
  await store.heartbeat({ runtimeId: "runtime-recovery", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  const calls: string[] = [];
  const router = new PersistentMultiRuntimeRouter({
    store,
    now: () => 200,
    heartbeatTtlMs: 1_000,
    endpointFactory: () => ({
      async dispatch() { return { remoteRunId: "run-recovery" }; },
      async advanceRecovery(remoteRunId) {
        calls.push(`advance:${remoteRunId}`);
        return {
          state: { runId: remoteRunId, actionId: "action-recovery", state: "ready_to_resume", updatedAt: 200 },
          decisions: [], planRevisionAssessments: [], userResponses: [],
        };
      },
      async resumeRecovery(remoteRunId) {
        calls.push(`resume:${remoteRunId}`);
        return { remoteRunId, status: "running" as const };
      },
    }),
  });
  const assignment = await router.submit(task("user-recovery", "message-recovery"));
  const advanced = await router.advanceRecovery(assignment.id);
  assert.equal(advanced?.recovery.state?.state, "ready_to_resume");
  const resumed = await router.resumeRecovery(assignment.id);
  assert.equal(resumed?.run.status, "running");
  assert.deepEqual(calls, ["advance:run-recovery", "resume:run-recovery"]);
  await database.close();
});

test("persistent Router starts checkpoint continuation as a new Assignment on the same Host", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ControlPlaneStore(database);
  await store.ready();
  await store.seedRuntimes([{ ...runtime("runtime-checkpoint"), endpoint: "http://runtime-checkpoint" }], 100);
  await store.heartbeat({ runtimeId: "runtime-checkpoint", status: "ready", activeRunCount: 0, queuedRunCount: 0, observedAt: 100 });
  const calls: string[] = [];
  const router = new PersistentMultiRuntimeRouter({
    store,
    now: () => 200,
    heartbeatTtlMs: 1_000,
    endpointFactory: () => ({
      async dispatch() { return { remoteRunId: "run-failed" }; },
      async startFromCheckpoint(remoteRunId) {
        calls.push(remoteRunId);
        return { remoteRunId: "run-child", status: "running" as const };
      },
    }),
  });
  const original = await router.submit(task("user-checkpoint", "message-checkpoint"));
  const continued = await router.startFromCheckpoint(original.id);
  assert.equal(continued?.run.remoteRunId, "run-child");
  assert.notEqual(continued?.assignment.id, original.id);
  assert.equal(continued?.assignment.remoteRunId, "run-child");
  assert.equal(continued?.assignment.runtimeId, original.runtimeId);
  assert.deepEqual(calls, ["run-failed"]);
  const latest = await store.conversation(original.tenantId, original.ownerUserId, original.conversationId);
  assert.equal(latest?.turns.length, 1);
  assert.equal(latest?.turns[0]?.assignment?.id, continued?.assignment.id);
  await database.close();
});

test("Host capacity gate rejects an over-capacity dispatch before creating a Run", async () => {
  let starts = 0;
  const host = new AgentLoopRuntimeHost({
    async ensureConversation() {},
    async startConversation() { starts += 1; return { id: "should-not-start" } as never; },
    async get() { return { id: "should-not-start", status: "running" } as never; },
  }, { async importForRun() { return []; } }, {
    maxConcurrentRuns: 1,
    async activeRunCount() { return 1; },
  });
  await assert.rejects(() => host.dispatch({
    schema: "agentloop.runtimeDispatch/v1",
    assignmentId: "assignment-full",
    dispatchKey: "dispatch-full",
    subject: { tenantId: "tenant", userId: "user" },
    conversationId: "conversation",
    input: "over capacity",
    allowDangerousTools: false,
    resourceRefs: [],
  }), /no remaining capacity/);
  assert.equal(starts, 0);
});

function endpoint(remoteRunId: string): RuntimeEndpoint {
  return { async dispatch(): Promise<{ remoteRunId: string }> { return { remoteRunId }; } };
}

function task(ownerUserId: string, clientMessageId: string, conversationId = `conversation-${ownerUserId}`) {
  return {
    tenantId: "tenant",
    ownerUserId,
    conversationId,
    clientMessageId,
    input: "summarize this task",
    requiredCapabilities: ["document"],
  };
}
