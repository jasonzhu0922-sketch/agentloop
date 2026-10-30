import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { validateSkillArchive } from "./skill-archive-validator.mjs";

const SKILL_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 90 * 1024 * 1024,
  maxFiles: 2000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxCompressionRatio: 100,
});

// Development-only substitute for the host-owned production control daemon.
// It intentionally writes below data/local and never invokes Docker or shell.
export function createDevRuntimeControl({ root, skillsRoot, token = "development-operator-token", configurationPath, mcpConfigurationPath } = {}) {
  const storeRoot = resolve(root ?? "./data/local/cloud-skills");
  const customSkillsRoot = resolve(skillsRoot ?? join(storeRoot, "active"));
  const statePath = join(storeRoot, "runtime-reload.json");
  const modelPath = configurationPath ? resolve(configurationPath) : undefined;
  const mcpPath = mcpConfigurationPath ? resolve(mcpConfigurationPath) : undefined;
  let state = { status: "idle" };
  let configuration = { providers: {}, models: {} };
  let mcpConfiguration = { defaultTrust: "untrusted", servers: [] };
  let initialized = false;

  async function init() {
    if (initialized) return;
    initialized = true;
    await mkdir(storeRoot, { recursive: true, mode: 0o700 });
    await mkdir(customSkillsRoot, { recursive: true, mode: 0o700 });
    try { state = JSON.parse(await readFile(statePath, "utf8")); } catch {}
    if (modelPath) {
      try { configuration = JSON.parse(await readFile(modelPath, "utf8")); } catch {}
    }
    if (mcpPath) {
      try { mcpConfiguration = JSON.parse(await readFile(mcpPath, "utf8")); } catch {}
    }
  }

  return { handle: async (request, response, path) => {
    await init();
    if (!authorized(request, token)) return reply(response, 401, { error: "operator_unauthorized" });
    if (!["/runtime-reload", "/model-configuration", "/mcp-configuration", "/skill-configuration"].includes(path)) {
      return reply(response, 404, { error: "not_found" });
    }
    if (!["GET", "POST", "DELETE"].includes(request.method)) return reply(response, 405, { error: "method_not_allowed" });
    if (path === "/skill-configuration") {
      if (request.method === "GET") return reply(response, 200, { skills: await listSkills(customSkillsRoot, false) });
      if (request.method === "DELETE") return startSkillRemoveOperation(request, response);
      return startSkillOperation(request, response);
    }
    if (path === "/model-configuration") {
      if (request.method === "GET") return reply(response, 200, { configuration: redactConfiguration(configuration) });
      return startModelOperation(request, response);
    }
    if (path === "/mcp-configuration") {
      if (request.method === "GET") return reply(response, 200, { configuration: mcpConfiguration });
      return startMcpOperation(request, response);
    }
    if (request.method === "GET") return reply(response, 200, state);
    if (request.headers["content-length"] !== undefined && Number(request.headers["content-length"]) !== 0) {
      return reply(response, 400, { error: "body_not_allowed" });
    }
    await startOperation(async () => { state = { ...state, operation: "reload", phase: "checking_readiness" }; });
    return reply(response, 202, state);
  } };

  async function startSkillOperation(request, response) {
    const body = await readJson(request, 128 * 1024 * 1024);
    if (!body.ok) return reply(response, body.status, { error: body.error });
    if (state.status === "running") return reply(response, 409, state);
    if (!validSkillPayload(body.value)) return reply(response, 400, { error: "invalid_skill_configuration_request" });
    state = { id: cryptoRandomId(), operation: "skills", status: "running", phase: "validating", startedAt: Date.now() / 1000 };
    await persistState();
    void (async () => {
      try {
        const bytes = Buffer.from(body.value.archiveBase64, "base64");
        const skills = await installArchive(bytes, body.value.archiveName);
        state = { ...state, status: "succeeded", phase: "complete", skills, finishedAt: Date.now() / 1000 };
      } catch (error) {
        state = { ...state, status: "failed", phase: error?.code === "invalid_skill" ? "invalid_configuration" : error?.code === "ENOENT" ? "skill_not_found" : "reload_failed", finishedAt: Date.now() / 1000 };
      }
      await persistState();
    })();
    return reply(response, 202, state);
  }

  async function startSkillRemoveOperation(request, response) {
    const body = await readJson(request, 4096);
    if (!body.ok || !validSkillRemovePayload(body.value)) return reply(response, body.status ?? 400, { error: "invalid_skill_configuration_request" });
    if (state.status === "running") return reply(response, 409, state);
    state = { id: cryptoRandomId(), operation: "skills-remove", status: "running", phase: "validating", skillName: body.value.skillName, startedAt: Date.now() / 1000 };
    await persistState();
    void (async () => {
      try {
        const target = join(customSkillsRoot, body.value.skillName);
        const targetInfo = await stat(target);
        if (!targetInfo.isDirectory()) throw invalidSkill();
        await rm(target, { recursive: true, force: true });
        state = { ...state, status: "succeeded", phase: "complete", skills: await listSkills(customSkillsRoot, false), finishedAt: Date.now() / 1000 };
      } catch (error) {
        state = { ...state, status: "failed", phase: error?.code === "invalid_skill" ? "invalid_configuration" : error?.code === "ENOENT" ? "skill_not_found" : "reload_failed", finishedAt: Date.now() / 1000 };
      }
      await persistState();
    })();
    return reply(response, 202, state);
  }

  async function startModelOperation(request, response) {
    const body = await readJson(request, 1024 * 1024);
    if (!body.ok) return reply(response, body.status, { error: body.error });
    if (state.status === "running") return reply(response, 409, state);
    const value = body.value;
    if (!value || typeof value !== "object" || !value.configuration || typeof value.configuration !== "object") {
      return reply(response, 400, { error: "invalid_configuration_request" });
    }
    if (modelPath) {
      // Runtime Hosts read this file at startup. Persist the development
      // configuration so a launcher restart uses the same catalog the UI
      // reported as applied.
      const temporaryPath = `${modelPath}.${process.pid}.tmp`;
      await mkdir(dirname(modelPath), { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, `${JSON.stringify(value.configuration, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, modelPath);
    }
    configuration = value.configuration;
    state = { id: cryptoRandomId(), operation: "apply", status: "succeeded", phase: "complete", models: Object.entries(configuration.models ?? {}).map(([key, model]) => ({ key, displayName: model?.displayName ?? key })), finishedAt: Date.now() / 1000 };
    await persistState();
    return reply(response, 202, state);
  }

  async function startMcpOperation(request, response) {
    const body = await readJson(request, 2 * 1024 * 1024);
    if (!body.ok) return reply(response, body.status, { error: body.status === 413 ? "configuration_too_large" : "invalid_mcp_configuration_request" });
    const value = body.value;
    if (!value || typeof value !== "object" || !value.configuration || typeof value.configuration !== "object") {
      return reply(response, 400, { error: "invalid_mcp_configuration_request" });
    }
    try { validateMcpConfiguration(value.configuration); }
    catch { return reply(response, 400, { error: "invalid_mcp_configuration" }); }
    if (state.status === "running") return reply(response, 409, state);
    if (mcpPath) {
      const temporaryPath = `${mcpPath}.${process.pid}.tmp`;
      await mkdir(dirname(mcpPath), { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, `${JSON.stringify(value.configuration, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, mcpPath);
    }
    mcpConfiguration = value.configuration;
    state = {
      id: cryptoRandomId(), operation: "mcp-apply", status: "succeeded", phase: "complete",
      mcpServers: mcpConfiguration.servers.map((server) => ({ key: server.key, displayName: server.displayName ?? server.key })),
      finishedAt: Date.now() / 1000,
    };
    await persistState();
    return reply(response, 202, state);
  }

  async function startOperation(task) {
    await task();
    state = { ...state, status: "succeeded", phase: "complete", finishedAt: Date.now() / 1000 };
    await persistState();
  }

  async function persistState() {
    await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  }

  async function installArchive(bytes, archiveName) {
    const audited = await validateSkillArchive(bytes, { originalName: archiveName, limits: SKILL_ARCHIVE_LIMITS }).catch(() => { throw invalidSkill(); });
    const staging = await mkdtemp(join(tmpdir(), "agentloop-dev-skills-"));
    try {
      const paths = new Set();
      for (const entry of audited.entries) {
        const path = entry.path;
        if (paths.has(path)) throw invalidSkill();
        paths.add(path);
        const target = resolve(staging, ...path.split("/"));
        assertInside(staging, target);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, entry.data, { mode: 0o600, flag: "wx" });
      }
      const target = customSkillsRoot;
      const previous = `${customSkillsRoot}.previous`;
      for (const oldEnv of await findNamedFiles(target, ".env")) {
        const relativePath = relative(target, oldEnv);
        const destination = join(staging, relativePath);
        if (!(await exists(destination))) { await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); await copyFile(oldEnv, destination); }
      }
      await rm(previous, { recursive: true, force: true });
      try { await rename(target, previous); } catch {}
      await rename(staging, target);
      await rm(previous, { recursive: true, force: true });
      return await listSkills(customSkillsRoot, false);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
}

async function listSkills(root, nested = true) {
  const activeRoot = nested ? join(root, "active") : root;
  let entries;
  try { entries = await readdir(activeRoot, { withFileTypes: true }); } catch { return []; }
  const result = [];
  for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = join(activeRoot, entry.name);
    const skillFile = join(directory, "SKILL.md");
    try { await stat(skillFile); } catch { continue; }
    const files = await filesUnder(directory);
    const hash = createHash("sha256"); let totalBytes = 0;
    for (const file of files) { const data = await readFile(file); totalBytes += data.length; hash.update(relative(directory, file).split(sep).join("/")); hash.update("\0"); hash.update(data); }
    const text = await readFile(skillFile, "utf8");
    const description = text.split(/\r?\n/).find(line => line.startsWith("description:"))?.split(":").slice(1).join(":").trim() ?? "";
    result.push({ name: entry.name, description, packageHash: hash.digest("hex"), fileCount: files.length, totalBytes, hasEnvironment: await exists(join(directory, ".env")) });
  }
  return result;
}

async function filesUnder(root) { const output = []; async function visit(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await visit(path); else if (entry.isFile()) output.push(path); } } await visit(root); return output.sort(); }
async function findNamedFiles(root, name) { if (!(await exists(root))) return []; const output = []; async function visit(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await visit(path); else if (entry.isFile() && entry.name === name) output.push(path); } } await visit(root); return output; }
async function exists(path) { try { await stat(path); return true; } catch { return false; } }
function assertInside(root, target) { const value = relative(root, target); if (value === ".." || value.startsWith(`..${sep}`) || value.startsWith(sep)) throw invalidSkill(); }
function invalidSkill() { const error = new Error("invalid skill"); error.code = "invalid_skill"; return error; }
function validSkillPayload(value) { return value && typeof value === "object" && typeof value.archiveName === "string" && /^[A-Za-z0-9._-]{1,128}\.zip$/i.test(value.archiveName) && typeof value.archiveBase64 === "string" && value.archiveBase64.length > 0 && value.archiveBase64.length <= 120 * 1024 * 1024 && Buffer.byteLength(value.archiveBase64, "ascii") <= 120 * 1024 * 1024; }
function validSkillRemovePayload(value) { return value && typeof value === "object" && typeof value.skillName === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.skillName); }
function authorized(request, token) { return request.headers.authorization === `Bearer ${token}`; }
function cryptoRandomId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
async function readJson(request, limit) { const chunks = []; let size = 0; try { for await (const chunk of request) { size += chunk.length; if (size > limit) return { ok: false, status: 413, error: "skill_package_too_large" }; chunks.push(chunk); } return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }; } catch { return { ok: false, status: 400, error: "invalid_skill_configuration_request" }; } }
function redactConfiguration(value) { return { providers: value.providers ?? {}, models: value.models ?? {} }; }
function validateMcpConfiguration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.servers)) throw new Error("invalid_mcp_configuration");
  if (value.defaultTrust !== undefined && !["trusted", "untrusted"].includes(value.defaultTrust)) throw new Error("invalid_mcp_configuration");
  const keys = new Set();
  const normalizedKeys = new Set();
  for (const server of value.servers) {
    if (!server || typeof server !== "object" || Array.isArray(server)) throw new Error("invalid_mcp_configuration");
    if (typeof server.key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(server.key) || keys.has(server.key)) throw new Error("invalid_mcp_configuration");
    keys.add(server.key);
    const normalizedKey = server.key.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unnamed";
    if (normalizedKeys.has(normalizedKey)) throw new Error("invalid_mcp_configuration");
    normalizedKeys.add(normalizedKey);
    if (server.transport !== "http" || typeof server.url !== "string") throw new Error("invalid_mcp_configuration");
    const url = new URL(server.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error("invalid_mcp_configuration");
    if (server.protocolVersion !== undefined && (typeof server.protocolVersion !== "string" || !server.protocolVersion)) throw new Error("invalid_mcp_configuration");
    if (server.timeoutMs !== undefined && (!Number.isSafeInteger(server.timeoutMs) || server.timeoutMs <= 0)) throw new Error("invalid_mcp_configuration");
    for (const field of ["toolAllowlist", "toolBlocklist", "aliases"]) if (server[field] !== undefined && (!Array.isArray(server[field]) || server[field].some((item) => typeof item !== "string" || !item))) throw new Error("invalid_mcp_configuration");
    if (server.trust !== undefined && !["trusted", "untrusted"].includes(server.trust)) throw new Error("invalid_mcp_configuration");
    if (server.capabilities !== undefined && (!Array.isArray(server.capabilities) || server.capabilities.some((item) => !item || typeof item !== "object" || Array.isArray(item)))) throw new Error("invalid_mcp_configuration");
    if (server.auth !== undefined) {
      if (!server.auth || typeof server.auth !== "object" || !["none", "bearer", "headers", "headers_env", "query", "api_key_header", "query_parameter", "custom_headers"].includes(server.auth.kind)) throw new Error("invalid_mcp_configuration");
      const required = server.auth.kind === "bearer" ? ["tokenEnv"] : server.auth.kind === "headers_env" ? ["headerEnvs"] : server.auth.kind === "query" ? ["name", "secretEnv"] : server.auth.kind === "api_key_header" ? ["headerName", "value"] : server.auth.kind === "query_parameter" ? ["parameterName", "value"] : [];
      if (required.some((field) => typeof server.auth[field] !== "string" || !server.auth[field])) throw new Error("invalid_mcp_configuration");
      if (["headers", "headers_env", "custom_headers"].includes(server.auth.kind)) {
        const field = server.auth.kind === "headers_env" ? "headerEnvs" : "headers";
        if (!server.auth[field] || typeof server.auth[field] !== "object" || Array.isArray(server.auth[field]) || Object.values(server.auth[field]).some((item) => typeof item !== "string" || !item)) throw new Error("invalid_mcp_configuration");
      }
    }
  }
}
function reply(response, status, body) { const data = Buffer.from(JSON.stringify(body)); response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": data.length }); response.end(data); }
