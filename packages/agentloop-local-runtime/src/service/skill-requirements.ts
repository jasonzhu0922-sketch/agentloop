import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile, constants } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { buildCommandEnvironment } from "@zhujun/agentloop";
import type { LocalRuntimeConfigurationStore } from "../configuration/local-runtime-configuration-store.ts";
import { LocalRuntimeConfigurationStoreError } from "../configuration/local-runtime-configuration-store.ts";
import { SKILL_PYTHON_PROBE } from "./skill-python-probe.ts";

export interface RequirementCheck {
  readonly kind: "python" | "command" | "environment" | "mcp" | "skill" | "file";
  readonly label: string;
  readonly status: "satisfied" | "missing" | "incompatible" | "unknown" | "manual" | "skipped";
  readonly detail: string;
  readonly origin: string;
  readonly installable: boolean;
}
export interface SkillRequirementsDiagnosis {
  readonly packageId: string;
  readonly packageHash: string;
  readonly metadataRevision: number;
  readonly scope: "device";
  readonly checkedAt: number;
  readonly environment: "host" | "managed";
  readonly status: "satisfied" | "attention";
  readonly checks: readonly RequirementCheck[];
  readonly pythonPackages: readonly string[];
  readonly canInstall: boolean;
  readonly installation?: Omit<SkillInstallation, "diagnosis">;
}
export interface SkillInstallation {
  readonly id: string;
  readonly packageId: string;
  readonly scope: "device";
  status: "running" | "completed" | "failed";
  phase: "preparing" | "installing" | "checking" | "activating" | "finished";
  readonly startedAt: number;
  finishedAt?: number;
  log: string;
  error?: string;
  diagnosis?: SkillRequirementsDiagnosis;
}
export type SkillProcessRunner = (command: string, args: readonly string[], options: {
  env: NodeJS.ProcessEnv; input?: string; timeoutMs: number; onOutput?: (text: string) => void;
}) => Promise<string>;

/** Host-owned argv only; package strings are data, never shell commands. */
export const runSkillProcess: SkillProcessRunner = (command, args, options) => new Promise((complete, reject) => {
  const child = spawn(command, [...args], { env: options.env, windowsHide: true, stdio: "pipe" });
  let stdout = "", bytes = 0, stopped = false;
  const timer = setTimeout(() => { stopped = true; child.kill(); }, options.timeoutMs);
  child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 2_000_000) { stopped = true; child.kill(); return; } stdout += chunk; options.onOutput?.(chunk.toString()); });
  child.stderr.on("data", chunk => { bytes += chunk.length; if (bytes > 2_000_000) { stopped = true; child.kill(); return; } options.onOutput?.(chunk.toString()); });
  child.on("error", () => { clearTimeout(timer); reject(new Error("skill_requirements_process_unavailable")); });
  child.on("close", code => { clearTimeout(timer); if (code === 0 && !stopped) complete(stdout); else reject(new Error(stopped ? "skill_requirements_process_timeout" : "skill_requirements_process_failed")); });
  child.stdin.on("error", () => {});
  child.stdin.end(options.input ?? "");
});

type ProbeInput = { entries: Array<{ text: string; origin: string }>; versions: Array<{ text: string; origin: string }>; checks: RequirementCheck[]; needsPython: boolean };
const attention = (checks: readonly RequirementCheck[]) => checks.some(check => !["satisfied", "skipped"].includes(check.status));
const safeLog = (text: string) => text.replace(/https?:\/\/[^\s]+/giu, "[package index]").replace(/\x1b\[[0-9;]*m/gu, "");

/** One account owns one device environment, shared by all of its local Runtimes. */
export class SkillRequirementsService {
  readonly #jobs = new Map<string, SkillInstallation>();
  readonly #cached = new Map<string, SkillRequirementsDiagnosis>();
  constructor(private root: string, private store: LocalRuntimeConfigurationStore,
    private hostEnvironment: Readonly<Record<string, string>> = {}, private run: SkillProcessRunner = runSkillProcess) {}

  private deviceRoot() { return join(this.root, "shared"); }
  cached(packageId: string) { return this.#cached.get(packageId); }
  async prune() {
    const root = this.deviceRoot(), active = JSON.parse(await readFile(join(root, "active.json"), "utf8"));
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && /^env-[a-f0-9-]{36}$/u.test(entry.name) && entry.name !== active.directory) await rm(join(root, entry.name), { recursive: true, force: true });
    }
  }

  async commandConfiguration() {
    const root = this.deviceRoot();
    const content = await readFile(join(root, "active.json"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (content === undefined) return { environment: { ...this.hostEnvironment }, readOnlyRoots: [] as string[], managed: false };
    const active = JSON.parse(content);
    if (typeof active.directory !== "string" || !/^env-[a-f0-9-]{36}$/u.test(active.directory)) throw new Error("skill_environment_invalid");
    const environmentRoot = join(root, active.directory), bin = join(environmentRoot, process.platform === "win32" ? "Scripts" : "bin");
    const python = join(bin, process.platform === "win32" ? "python.exe" : "python");
    await access(python);
    return { environment: { ...this.hostEnvironment, RUNTIME_PYTHON: python, VIRTUAL_ENV: environmentRoot,
      PATH: [bin, this.hostEnvironment.PATH ?? process.env.PATH ?? ""].join(delimiter) }, readOnlyRoots: [environmentRoot], managed: true };
  }

  private processEnvironment(environment: Readonly<Record<string, string>>) {
    return buildCommandEnvironment({ ...environment, PYTHONHOME: "", PYTHONPATH: "", PYTHONUSERBASE: "", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" });
  }

  private async collect(packageId: string): Promise<ProbeInput> {
    const { metadata, inspection } = await this.store.inspectSkill(packageId);
    const declared = metadata.declaration.requirements;
    const result: ProbeInput = { entries: [], versions: [], checks: [], needsPython: declared?.python !== undefined || inspection.files.some(path => path.endsWith(".py")) };
    const add = (label: string, status: RequirementCheck["status"], detail: string, origin: string) => result.checks.push({ kind: "file", label, status, detail, origin, installable: false });
    for (const text of declared?.python?.packages ?? []) result.entries.push({ text, origin: "requirements.python.packages" });
    if (declared?.python?.version) result.versions.push({ text: declared.python.version, origin: "requirements.python.version" });
    const seen = new Set<string>(); let bytes = 0;
    const readRequirements = async (path: string) => {
      if (seen.has(path)) return;
      if (seen.size >= 16 || !path || path.includes("\\") || path.includes(":") || isAbsolute(path) || path.split("/").some(part => !part || part === "." || part === "..")) {
        add(path, "manual", "依赖文件必须位于 Skill 包内，最多读取 16 个文件。", path); return;
      }
      seen.add(path);
      if (!inspection.files.includes(path)) { add(path, "missing", "包内没有此依赖文件。", path); return; }
      const text = await readFile(join(inspection.root, path), "utf8"); bytes += Buffer.byteLength(text);
      if (bytes > 128_000) { add(path, "manual", "依赖文件总量超过 128 KB，请精简声明。", path); return; }
      const lines = text.replace(/\\\r?\n/gu, "").split(/\r?\n/u);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index].split(/\s+#/u)[0]!.trim(), origin = `${path}:${index + 1}`;
        if (!line || line.startsWith("#")) continue;
        const include = /^(?:-r\s*|--requirement(?:=|\s+))(.+)$/u.exec(line);
        if (include) {
          const parent = dirname(path); const child = parent === "." ? include[1]! : `${parent}/${include[1]}`;
          await readRequirements(child); continue;
        }
        if (line.startsWith("-") || line.includes("--hash=")) { add(line.slice(0, 100), "manual", "索引参数、约束文件或构建选项需人工处理；不会作为安装命令执行。", origin); continue; }
        if (result.entries.length >= 256) { add(path, "manual", "依赖声明超过 256 条。", origin); break; }
        result.entries.push({ text: line, origin });
      }
    };
    const files = new Set([...(declared?.python?.files ?? []), ...inspection.files.filter(path => path === "requirements.txt")]);
    for (const file of files) { result.needsPython = true; await readRequirements(file); }
    // Optional requirements-*.txt files are not activated merely by their filename.
    for (const path of inspection.files.filter(path => /(^|\/)requirements[^/]*\.txt$/u.test(path) && !seen.has(path))) add(path, "manual", "发现可选依赖文件；请在运行依赖中选择需要启用的文件。", path);
    if (inspection.files.includes("pyproject.toml") && files.size === 0) add("pyproject.toml", "manual", "此包使用 Python 项目声明；请填写所需包或指定 requirements 文件。", "pyproject.toml");
    if (inspection.files.includes("package.json")) add("package.json", "manual", "发现 Node 项目依赖；请按包说明准备 Node 依赖。", "package.json");
    if (result.entries.length) result.needsPython = true;
    return result;
  }

  async diagnose(packageId: string, override?: Readonly<Record<string, string>>): Promise<SkillRequirementsDiagnosis> {
    const [{ metadata }, servers, library, command, input] = await Promise.all([
      this.store.inspectSkill(packageId), this.store.deviceMcpServers(), this.store.listSkillPackages(), this.commandConfiguration(), this.collect(packageId),
    ]);
    const env: Readonly<Record<string, string>> = override ?? command.environment;
    const checks = [...input.checks]; let packages: string[] = [];
    const add = (kind: RequirementCheck["kind"], label: string, status: RequirementCheck["status"], detail: string, origin: string) => checks.push({ kind, label, status, detail, origin, installable: false });
    if (input.needsPython) {
      try {
        const output = await this.run(env.RUNTIME_PYTHON ?? "python3", ["-I", "-B", "-c", SKILL_PYTHON_PROBE], {
          env: this.processEnvironment(env), input: JSON.stringify(input), timeoutMs: 15_000,
        });
        const probe = JSON.parse(output); checks.push(...probe.rows.map((row: RequirementCheck) => ({ ...row, label: safeLog(row.label), origin: safeLog(row.origin) }))); packages = probe.install;
        add("python", "Python", "satisfied", `Python ${probe.version}`, "本机共享执行环境");
      } catch { add("python", "Python", "unknown", "无法检查 Python 或缺少 packaging。请先准备可用的 Python 环境后重新诊断。", "本机共享执行环境"); }
    }
    for (const name of metadata.declaration.requirements?.commands ?? []) {
      const paths = (env.PATH ?? process.env.PATH ?? "").split(delimiter).filter(isAbsolute);
      const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
      let found = false;
      for (const path of paths) for (const extension of extensions) {
        try { await access(join(path, name + extension), process.platform === "win32" ? constants.F_OK : constants.X_OK); found = true; } catch { /* check next host PATH entry */ }
      }
      add("command", name, found ? "satisfied" : "missing", found ? "本机共享环境的 PATH 中已找到命令；未执行该命令。" : "请按工具官方说明安装，并使其对本机共享环境的 PATH 可见。", "requirements.commands");
    }
    for (const name of metadata.declaration.requirements?.environment ?? []) add("environment", name, env[name] ? "satisfied" : "missing", env[name] ? "执行环境已提供此变量；不显示变量值。" : "本机共享执行环境没有提供此变量，请配置对应的连接或宿主环境。", "requirements.environment");
    for (const key of metadata.declaration.requirements?.mcpServers ?? []) {
      const configured = servers.some(server => server.key === key);
      add("mcp", key, configured ? "unknown" : "missing", configured ? "已配置；请使用 MCP 连接测试确认服务及工具可用。" : "请在 MCP 配置中添加此服务并完成连接测试。", "requirements.mcpServers");
    }
    const available = new Set(library.filter(skill => skill.validationStatus === "valid").map(skill => skill.skillName));
    for (const name of metadata.declaration.workflow.requiredSkills) add("skill", name, available.has(name) ? "satisfied" : "missing", available.has(name) ? "本机 Skill 库中已有此 Skill；使用时由 Runtime 按需选择。" : "请先将此 Skill 添加到本机 Skill 库。", "workflow.requiredSkills");
    const blocked = checks.some(check => (check.kind === "python" && ["unknown", "manual"].includes(check.status)) || (check.kind === "python" && check.label.startsWith("Python ") && check.status === "incompatible") || (check.kind === "file" && check.status === "missing"));
    const active = [...this.#jobs.values()].find(job => job.packageId === packageId && job.status === "running");
    const installation = active ? (({ diagnosis: _diagnosis, ...summary }) => summary)(active) : undefined;
    const diagnosis: SkillRequirementsDiagnosis = { packageId, packageHash: metadata.packageHash, metadataRevision: metadata.revision, scope: "device",
      checkedAt: Date.now(), environment: override ? "managed" : command.managed ? "managed" : "host", status: attention(checks) ? "attention" : "satisfied", checks: checks.map(check => ({ ...check, label: safeLog(check.label), detail: safeLog(check.detail), origin: safeLog(check.origin) })),
      pythonPackages: packages, canInstall: !blocked && packages.length > 0 && checks.some(check => check.kind === "python" && ["missing", "incompatible"].includes(check.status)),
      ...(installation === undefined ? {} : { installation }) };
    if (!override) this.#cached.set(packageId, diagnosis);
    return diagnosis;
  }

  async installationPlan(packageId: string) {
    const library = await this.store.listSkillPackages();
    const ids = [...new Set([packageId, ...library.filter(skill => skill.validationStatus === "valid").map(skill => skill.packageId)])].sort();
    const diagnoses = await Promise.all(ids.map(id => this.diagnose(id)));
    const packages = [...new Set(diagnoses.flatMap(item => item.pythonPackages))].sort();
    const skills = diagnoses.map(item => ({ packageId: item.packageId, packageHash: item.packageHash, metadataRevision: item.metadataRevision }));
    const fingerprint = createHash("sha256").update(JSON.stringify({ scope: "device", packages, skills })).digest("hex");
    const blocked = diagnoses.some(item => item.checks.some(check => (check.kind === "python" && ["unknown", "manual"].includes(check.status)) || (check.kind === "python" && check.label.startsWith("Python ") && check.status === "incompatible") || (check.kind === "file" && check.status === "missing")));
    return { scope: "device" as const, fingerprint, packages, skills, blocked, canInstall: !blocked && packages.length <= 512 && diagnoses.find(item => item.packageId === packageId)!.canInstall };
  }

  beginInstall(packageId: string, fingerprint: string, operation: (install: () => Promise<void>) => Promise<void>) {
    const job: SkillInstallation = { id: randomUUID(), packageId, scope: "device", status: "running", phase: "preparing", startedAt: Date.now(), log: "" };
    this.#jobs.set(job.id, job);
    const completed = (async () => {
      let status: SkillInstallation["status"] = "completed", error: string | undefined;
      try { await operation(() => this.install(job, fingerprint)); }
      catch (cause) {
        status = "failed";
        const code = cause instanceof Error ? cause.message : "skill_requirements_install_failed";
        error = /^[a-z][a-z0-9_]+$/u.test(code) ? code : "skill_requirements_install_failed";
      }
      const finished: SkillInstallation = { ...job, status, phase: "finished", finishedAt: Date.now(), ...(error === undefined ? {} : { error }) };
      try { await this.saveJob(finished); }
      catch { finished.status = "failed"; finished.error = "skill_installation_record_failed"; }
      Object.assign(job, finished);
    })();
    return { job: { ...job }, completed };
  }

  async installation(id: string): Promise<SkillInstallation> {
    if (!/^[a-f0-9-]{36}$/u.test(id)) throw new LocalRuntimeConfigurationStoreError(404, "skill_installation_not_found");
    const active = this.#jobs.get(id); if (active) return { ...active };
    const job = await readFile(join(this.root, "installations", `${id}.json`), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") throw new LocalRuntimeConfigurationStoreError(404, "skill_installation_not_found"); throw error; });
    const parsed: SkillInstallation = JSON.parse(job);
    return parsed.status === "running" ? { ...parsed, status: "failed", phase: "finished", error: "skill_installation_interrupted" } : parsed;
  }

  private async saveJob(job: SkillInstallation) {
    const root = join(this.root, "installations"); await mkdir(root, { recursive: true });
    const target = join(root, `${job.id}.json`), temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(job), { mode: 0o600 }); await rename(temporary, target);
  }

  private async install(job: SkillInstallation, fingerprint: string) {
    await this.saveJob(job);
    const plan = await this.installationPlan(job.packageId);
    if (fingerprint !== plan.fingerprint) throw new Error("skill_requirements_plan_stale");
    if (!plan.canInstall) throw new Error("skill_requirements_install_not_available");
    const ids = plan.skills.map(skill => skill.packageId), packages = plan.packages;
    const runtimeRoot = this.deviceRoot(), directory = `env-${randomUUID()}`, environmentRoot = join(runtimeRoot, directory);
    await mkdir(runtimeRoot, { recursive: true });
    let activated = false;
    const onOutput = (text: string) => { job.log = (job.log + safeLog(text)).slice(-16_000); };
    try {
      const env = this.processEnvironment(this.hostEnvironment), python = this.hostEnvironment.RUNTIME_PYTHON ?? "python3";
      await this.run(python, ["-I", "-B", "-m", "venv", "--system-site-packages", environmentRoot], { env, timeoutMs: 60_000, onOutput });
      const bin = join(environmentRoot, process.platform === "win32" ? "Scripts" : "bin"), executable = join(bin, process.platform === "win32" ? "python.exe" : "python");
      const nextEnvironment = { ...this.hostEnvironment, RUNTIME_PYTHON: executable, VIRTUAL_ENV: environmentRoot, PATH: [bin, this.hostEnvironment.PATH ?? process.env.PATH ?? ""].join(delimiter) };
      const requirements = join(environmentRoot, "agentloop-requirements.txt");
      await writeFile(requirements, packages.join("\n") + "\n", { mode: 0o600 });
      job.phase = "installing";
      await this.run(executable, ["-I", "-B", "-m", "pip", "--isolated", "install", "--disable-pip-version-check", "--no-input", "--only-binary=:all:", "--no-cache-dir", "-r", requirements], {
        env: this.processEnvironment(nextEnvironment), timeoutMs: 300_000, onOutput,
      });
      job.phase = "checking";
      const checked = await Promise.all(ids.map(id => this.diagnose(id, nextEnvironment)));
      if (checked.some(item => item.checks.some(check => check.kind === "python" && !["satisfied", "skipped"].includes(check.status)))) throw new Error("skill_requirements_verification_failed");
      job.phase = "activating";
      const temporary = join(runtimeRoot, `active-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify({ directory, installedAt: Date.now(), packages, skills: checked.map(item => ({ packageId: item.packageId, packageHash: item.packageHash, metadataRevision: item.metadataRevision })) }), { mode: 0o600 });
      await rename(temporary, join(runtimeRoot, "active.json")); activated = true;
      this.#cached.clear();
      const { installation: _installation, ...diagnosis } = await this.diagnose(job.packageId);
      job.diagnosis = diagnosis;
      this.#cached.set(job.packageId, diagnosis);
    } finally { if (!activated) await rm(environmentRoot, { recursive: true, force: true }); }
  }
}
