import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { AppDatabase, ComputerExecutor, inspectSkillPackage, parseSkillDeclaration } from "@zhujun/agentloop";
import { createLocalRuntimeManager } from "@zhujun/agentloop-local-runtime";
import { LocalRuntimeFactory } from "@zhujun/agentloop-local-runtime/host";
import { LocalRuntimeConfigurationStore } from "../dist/configuration/local-runtime-configuration-store.js";
import { SkillRequirementsService, runSkillProcess, type SkillProcessRunner } from "../dist/service/skill-requirements.js";
import { modelPort } from "./fixtures/models.ts";

const python = execFileSync(process.env.AGENTLOOP_TEST_PYTHON ?? "python3", ["-I", "-B", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const host = { RUNTIME_PYTHON: python, PATH: [dirname(python), dirname(process.execPath), process.env.PATH ?? ""].join(delimiter), PYTHONPATH: "", PYTHONHOME: "", VIRTUAL_ENV: "" };
const dependency = "agentloop_test_runtime_dep_0917";

async function fixture(t: test.TestContext, extraFiles: Record<string, string> = {}, runner = runSkillProcess) {
  const root = await mkdtemp(join(tmpdir(), "skill-requirements-")); const bundled = join(root, "bundled"); await mkdir(bundled);
  const manager = await createLocalRuntimeManager({ dataDirectory: root, defaultRuntimeId: "default", models: modelPort(), bundledSkillDirectories: [bundled], computerCommandEnvironment: host });
  const files = { "SKILL.md": "---\nname: dependency-sample\ndescription: Dependency sample\n---\nUse this sample.\n", ...extraFiles };
  const [pkg] = await manager.importSkills({ files: Object.entries(files).map(([path, content]) => ({ path: `sample/${path}`, content: Buffer.from(content) })) });
  await manager.stopRuntime("default");
  const database = new AppDatabase(join(root, "supervisor.db"));
  const store = new LocalRuntimeConfigurationStore(database, undefined, [], join(root, "skill-library")); await store.ready();
  const service = new SkillRequirementsService(join(root, "skill-environments"), store, host, runner);
  t.after(async () => {
    await database.close(); await manager.close();
    const writableDirectories = async (path: string): Promise<void> => {
      await chmod(path, 0o700);
      for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await writableDirectories(join(path, entry.name));
    };
    await writableDirectories(root); await rm(root, { recursive: true, force: true });
  });
  const metadata = await store.skillMetadata(pkg!.packageId);
  return { root, manager, store, service, pkg: pkg!, metadata };
}

test("import automatically diagnoses requirements without modifying the Skill or installing packages", async t => {
  const f = await fixture(t, { "requirements.txt": `${dependency}==1.0\n`, "scripts/run.py": "print('not executed')\n" });
  const packages = await f.manager.skillPackages(); const imported = packages[0] as typeof packages[0] & { requirementsDiagnosis: { canInstall: boolean } };
  assert.equal(imported.requirementsDiagnosis.canInstall, true);
  const result = await f.service.diagnose(f.pkg.packageId);
  assert.equal(result.status, "attention"); assert.equal(result.canInstall, true);
  assert.ok(result.checks.some(row => row.label === `${dependency}==1.0` && row.status === "missing"));
  const inspection = await f.store.inspectSkill(f.pkg.packageId);
  assert.equal(inspection.inspection.packageHash, f.metadata.packageHash);
  assert.equal(await readFile(join(inspection.inspection.root, "requirements.txt"), "utf8"), `${dependency}==1.0\n`);
  assert.equal((await f.service.commandConfiguration()).managed, false);
});

test("device diagnosis and installation plans use the shared library and MCP catalog independently of Runtime selection", async t => {
  const f = await fixture(t, { "requirements.txt": `${dependency}==1.0\n` });
  const prior = await f.service.installationPlan(f.pkg.packageId);
  const [other] = await f.manager.importSkills({ files: [
    { path: "other/SKILL.md", content: Buffer.from("---\nname: shared-provider\ndescription: Shared dependency\n---\nFollow instructions.\n") },
    { path: "other/requirements.txt", content: Buffer.from("agentloop_test_shared_dep_0917>=2\n") },
  ] });
  await f.store.ready(); // Refresh the independent probe store after the manager imports another package.
  await f.store.saveDeviceMcpServer({ key: "shared-source", displayName: "Shared source", transport: "http", url: "http://127.0.0.1:1/mcp", auth: { kind: "none" } });
  await f.store.updateSkillMetadata(f.pkg.packageId, { ...f.metadata.declaration,
    workflow: { ...f.metadata.declaration.workflow, requiredSkills: ["shared-provider"] },
    requirements: { mcpServers: ["shared-source"] },
  }, f.metadata.revision);
  const report = await f.service.diagnose(f.pkg.packageId);
  assert.equal(report.scope, "device");
  assert.ok(report.checks.some(check => check.kind === "skill" && check.status === "satisfied"));
  assert.ok(report.checks.some(check => check.kind === "mcp" && check.status === "unknown"));
  assert.deepEqual((await f.manager.configuration("default")).skills, [], "availability is diagnosed without selecting packages for a Runtime");
  const plan = await f.service.installationPlan(f.pkg.packageId);
  assert.equal(plan.scope, "device"); assert.notEqual(plan.fingerprint, prior.fingerprint);
  assert.deepEqual(plan.skills.map(skill => skill.packageId).sort(), [f.pkg.packageId, other!.packageId].sort());
  assert.deepEqual(plan.packages.sort(), [`${dependency}==1.0`, "agentloop_test_shared_dep_0917>=2"].sort());
});

test("requirements reject path escapes and invalid schema values before any process is started", () => {
  const declaration = { schema: "agentloop.skillDeclaration/v1", identity: { name: "sample", description: "Sample" }, activation: { semanticTags: [], intentExamples: [] }, workflow: { roles: ["support"], artifactKinds: ["none"], sourceKinds: [], qaKinds: [], requiredSkills: [] } };
  for (const requirements of [
    { python: { files: ["../private.txt"] } }, { python: { files: ["/tmp/private.txt"] } },
    { commands: ["sh -c"] }, { environment: ["SECRET=value"] }, { installCommand: "curl | sh" },
  ]) assert.throws(() => parseSkillDeclaration({ ...declaration, requirements }), /skill_requirements_/);
});

test("unsafe requirements and optional files remain explicit and are never executed", async t => {
  const f = await fixture(t, {
    "requirements.txt": `-r ../outside.txt\n--index-url https://user:password@example.test/simple\n${dependency} @ https://example.test/package.whl\n`,
    "requirements-gpu.txt": "another-package>=1\n",
  });
  const report = await f.service.diagnose(f.pkg.packageId);
  assert.equal(report.canInstall, false);
  assert.ok(report.checks.some(row => row.origin === "../outside.txt" && row.status === "manual"));
  assert.ok(report.checks.some(row => row.label === "requirements-gpu.txt" && row.status === "manual"));
  assert.equal(report.pythonPackages.length, 0);
  assert.doesNotMatch(JSON.stringify(report), /user:password/);
});

test("version ranges and platform markers are checked against actual distribution metadata", async t => {
  const f = await fixture(t, { "requirements.txt": 'packaging>=9999\npackaging>=1; python_version < "2"\n' });
  const report = await f.service.diagnose(f.pkg.packageId);
  assert.ok(report.checks.some(row => row.label === "packaging>=9999" && row.status === "incompatible"));
  assert.ok(report.checks.some(row => row.status === "skipped"));
  assert.deepEqual(report.pythonPackages, ["packaging>=9999"]);
});

test("an installed Python package cannot hide a missing dependency of its requested extra", async t => {
  const f = await fixture(t, { "requirements.txt": `${dependency}[export]>=1\n` });
  const environmentRoot = join(f.root, "extras-probe");
  await runSkillProcess(python, ["-I", "-B", "-m", "venv", "--system-site-packages", environmentRoot], { env: host, timeoutMs: 30000 });
  const executable = join(environmentRoot, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  await runSkillProcess(executable, ["-I", "-B", "-c", `import pathlib,sysconfig\np=pathlib.Path(sysconfig.get_path('purelib'))/'${dependency}-1.0.dist-info'\np.mkdir()\n(p/'METADATA').write_text('Metadata-Version: 2.1\\nName: ${dependency}\\nVersion: 1.0\\nProvides-Extra: export\\nRequires-Dist: agentloop_test_missing_extra_0917>=2; extra == "export"\\n')`], { env: host, timeoutMs: 10000 });
  const report = await f.service.diagnose(f.pkg.packageId, { ...host, RUNTIME_PYTHON: executable });
  assert.ok(report.checks.some(row => row.label.includes(`${dependency}[export]`) && row.status === "satisfied"));
  assert.ok(report.checks.some(row => row.label.includes("agentloop_test_missing_extra_0917") && row.status === "missing"));
  assert.equal(report.status, "attention"); assert.equal(report.canInstall, true);
});

test("a failed installation leaves the active environment and package bytes unchanged", async t => {
  const runner: SkillProcessRunner = (command, args, options) => args.includes("pip") ? Promise.reject(new Error("skill_requirements_process_failed")) : runSkillProcess(command, args, options);
  const f = await fixture(t, { "requirements.txt": `${dependency}==1.0\n` }, runner);
  const plan = await f.service.installationPlan(f.pkg.packageId);
  const install = f.service.beginInstall(f.pkg.packageId, plan.fingerprint, work => work()); await install.completed;
  const job = await f.service.installation(install.job.id);
  assert.equal(job.status, "failed"); assert.equal(job.error, "skill_requirements_process_failed");
  assert.equal((await f.service.commandConfiguration()).managed, false);
  assert.equal((await f.store.inspectSkill(f.pkg.packageId)).inspection.packageHash, f.metadata.packageHash);
});

test("a reviewed installation plan becomes stale after metadata changes", async t => {
  const f = await fixture(t, { "requirements.txt": `${dependency}==1.0\n` });
  const plan = await f.service.installationPlan(f.pkg.packageId);
  await f.store.updateSkillMetadata(f.pkg.packageId, { ...f.metadata.declaration, requirements: { python: { packages: ["packaging>=1"], files: [] } } }, f.metadata.revision);
  await assert.rejects(() => f.store.updateSkillMetadata(f.pkg.packageId, f.metadata.declaration, f.metadata.revision), /skill_metadata_revision_stale/);
  const install = f.service.beginInstall(f.pkg.packageId, plan.fingerprint, work => work()); await install.completed;
  assert.equal((await f.service.installation(install.job.id)).error, "skill_requirements_plan_stale");
  assert.equal((await f.service.commandConfiguration()).managed, false);
});

test("one installed wheel is shared by existing and new Runtimes, survives Runtime deletion and stays account isolated", async t => {
  let wheels = "";
  const runner: SkillProcessRunner = (command, args, options) => runSkillProcess(command,
    args.includes("pip") ? [...args, "--no-index", "--find-links", wheels] : args, options);
  const f = await fixture(t, { "requirements.txt": `${dependency}==1.0\n` }, runner);
  wheels = join(f.root, "wheels"); await mkdir(wheels);
  // Build a tiny pure-Python wheel locally. No registry or source build is used.
  await runSkillProcess(python, ["-I", "-B", "-c", `import zipfile, sys\nname=${JSON.stringify(dependency)}\ninfo=name+'-1.0.dist-info/'\nfiles={name+'.py': 'VALUE = 417\\n', info+'METADATA': 'Metadata-Version: 2.1\\nName: '+name+'\\nVersion: 1.0\\n', info+'WHEEL': 'Wheel-Version: 1.0\\nGenerator: test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n'}\nfiles[info+'RECORD']=''.join(path+',,\\n' for path in files)+info+'RECORD,,\\n'\nwith zipfile.ZipFile(sys.argv[1], 'w') as z:\n for path, body in files.items(): z.writestr(path, body)`, join(wheels, `${dependency}-1.0-py3-none-any.whl`)], { env: host, timeoutMs: 10000 });
  const plan = await f.service.installationPlan(f.pkg.packageId);
  const install = f.service.beginInstall(f.pkg.packageId, plan.fingerprint, work => work()); await install.completed;
  const job = await f.service.installation(install.job.id); assert.equal(job.status, "completed", job.log + job.error);
  const command = await f.service.commandConfiguration(); assert.equal(command.managed, true);
  assert.equal(command.environment.VIRTUAL_ENV, join(f.root, "skill-environments", "shared", command.environment.VIRTUAL_ENV!.split(/[\\/]/u).at(-1)!));
  const workspace = join(f.root, "workspace"); await mkdir(workspace, { recursive: true });
  const executor = new ComputerExecutor(workspace, { commandEnvironment: command.environment,
    ...(process.platform === "darwin" ? { commandSandbox: { mode: "required" as const, readOnlyRoots: [...command.readOnlyRoots, dirname(dirname(python))] } } : {}),
  });
  const executed = await executor.runCommand({ command: "python", args: ["-I", "-B", "-c", `import ${dependency},sys,json; print(json.dumps([${dependency}.VALUE,sys.prefix]))`], cwd: ".", timeoutMs: 10000 });
  assert.equal(executed.exitCode, 0, executed.stderr);
  assert.deepEqual(JSON.parse(executed.stdout), [417, command.environment.VIRTUAL_ENV]);
  const after = await f.service.diagnose(f.pkg.packageId); assert.equal(after.status, "satisfied"); assert.equal(after.canInstall, false);
  assert.equal((await inspectSkillPackage((await f.store.inspectSkill(f.pkg.packageId)).inspection.root)).packageHash, f.metadata.packageHash);
  const original = LocalRuntimeFactory.prototype.create;
  const environments = new Map<string, NonNullable<Parameters<typeof original>[5]>>();
  t.mock.method(LocalRuntimeFactory.prototype, "create", function (...args: Parameters<typeof original>) {
    environments.set(args[0].id, args[5]!); return original.apply(this, args);
  });
  const second = await f.manager.createRuntime("Second Runtime");
  await f.manager.configureRuntime("default", { skillPackageIds: [f.pkg.packageId], mcpServerIds: [] });
  await f.manager.stopRuntime(second.id);
  await f.manager.configureRuntime(second.id, { skillPackageIds: [f.pkg.packageId], mcpServerIds: [] });
  await f.manager.startRuntime("default"); await f.manager.startRuntime(second.id);
  const third = await f.manager.createRuntime("Created after installation");
  async function executeInRuntime(id: string) {
    const configured = environments.get(id)!;
    assert.deepEqual(configured.environment, command.environment, "every Runtime factory receives the same diagnosed shared environment");
    const executor = new ComputerExecutor(workspace, { commandEnvironment: configured.environment,
      ...(process.platform === "darwin" ? { commandSandbox: { mode: "required" as const, readOnlyRoots: [...configured.readOnlyRoots, dirname(dirname(python))] } } : {}),
    });
    const result = await executor.runCommand({ command: "python", args: ["-I", "-B", "-c", `import ${dependency}; print(${dependency}.VALUE)`], cwd: ".", timeoutMs: 10000 });
    assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.stdout.trim(), "417");
  }
  await executeInRuntime("default"); await executeInRuntime(second.id); await executeInRuntime(third.id);
  assert.deepEqual((await f.manager.skillSetup(f.pkg.packageId)).selectedBy.map(runtime => runtime.id).sort(), ["default", second.id].sort());
  await f.manager.stopRuntime(second.id); await f.manager.removeRuntime(second.id);
  await executeInRuntime("default");
  await f.manager.stopRuntime("default"); await f.manager.startRuntime("default"); await executeInRuntime("default");
  const [conflicting] = await f.manager.importSkills({ files: [
    { path: "conflict/SKILL.md", content: Buffer.from("---\nname: conflicting-shared-dependency\ndescription: Shared version conflict\n---\nFollow instructions.\n") },
    { path: "conflict/requirements.txt", content: Buffer.from(`${dependency}==2.0\n`) },
  ] });
  await f.store.ready();
  const conflictPlan = await f.service.installationPlan(conflicting!.packageId);
  assert.deepEqual(conflictPlan.packages, [`${dependency}==1.0`, `${dependency}==2.0`]);
  const conflict = f.service.beginInstall(conflicting!.packageId, conflictPlan.fingerprint, work => work()); await conflict.completed;
  assert.equal((await f.service.installation(conflict.job.id)).status, "failed");
  assert.equal((await f.service.commandConfiguration()).environment.RUNTIME_PYTHON, command.environment.RUNTIME_PYTHON, "conflicting shared requirements cannot replace the working environment");
  await executeInRuntime("default");
  const otherAccount = new SkillRequirementsService(join(f.root, "other-account", "skill-environments"), f.store, host);
  assert.equal((await otherAccount.commandConfiguration()).managed, false, "a different account does not inherit this managed environment");
  const reopened = new SkillRequirementsService(join(f.root, "skill-environments"), f.store, host);
  assert.equal((await reopened.commandConfiguration()).environment.RUNTIME_PYTHON, command.environment.RUNTIME_PYTHON);
  assert.equal((await reopened.installation(job.id)).status, "completed");
});
