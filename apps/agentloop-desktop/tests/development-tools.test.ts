import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { ComputerExecutor } from "@zhujun/agentloop";
import { developmentToolEnvironment } from "../src/platform/development-tools.ts";

test("development resolves installed dependencies into isolated Skill and workspace commands", { skip: process.platform !== "darwin" }, async t => {
  const environment = await developmentToolEnvironment({ ...process.env, NODE_PATH: "/not-the-runtime",
    PYTHONPATH: "/not-the-python", SECRET_VALUE: "must-not-forward" });
  assert.equal(environment.SECRET_VALUE, undefined);
  assert.equal(environment.PYTHONPATH, "");
  assert.ok(!environment.RUNTIME_PYTHON.includes("/shims/"));
  const root = await realpath(await mkdtemp(join(tmpdir(), "desktop-tools-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "conversation"), skill = join(root, "copied-skill"), sibling = join(root, "other-account");
  await Promise.all([mkdir(workspace), mkdir(skill), mkdir(sibling)]);
  await writeFile(join(sibling, "private.txt"), "private");
  await writeFile(join(skill, "build.cjs"), `
const fs = require('node:fs'), path = require('node:path');
const PptxGenJS = require('pptxgenjs'), JSZip = require('jszip');
(async () => {
  require('docx');
  const root = process.env.AGENTLOOP_WORKSPACE_ROOT;
  const deck = new PptxGenJS(); deck.addSlide().addText('Desktop sandbox');
  const output = path.join(root, 'probe.pptx');
  await deck.writeFile({fileName: output});
  const zip = await JSZip.loadAsync(fs.readFileSync(output));
  if (!(await zip.file('ppt/slides/slide1.xml').async('string')).includes('Desktop sandbox')) throw Error('missing slide');
  let denied = false;
  try { fs.readFileSync(path.join(root, '..', 'other-account', 'private.txt')); } catch { denied = true; }
  if (!denied) throw Error('account boundary lost');
  console.log('pptx verified');
})().catch(e => { console.error(e); process.exitCode = 1; });
`);
  const executor = new ComputerExecutor(workspace, {
    commandEnvironment: environment,
    commandRoots: [{ id: "@skills/pptx", path: skill }],
    commandSandbox: { mode: "required", readOnlyRoots: [...environment.NODE_PATH.split(delimiter), dirname(dirname(environment.RUNTIME_PYTHON))] },
  });
  const generated = await executor.runCommand({ command: "node", args: ["build.cjs"], cwd: "@skills/pptx", timeoutMs: 30_000 });
  assert.equal(generated.exitCode, 0, generated.stderr);
  assert.match(generated.stdout, /pptx verified/);
  assert.ok((await readFile(join(workspace, "probe.pptx"))).length > 100);
  const python = await executor.runCommand({ command: "python3", args: ["-c", "import sys, json, zipfile; print(json.dumps(sys.executable))"], cwd: ".", timeoutMs: 10_000 });
  assert.equal(python.exitCode, 0, python.stderr);
  assert.equal(await realpath(JSON.parse(python.stdout)), environment.RUNTIME_PYTHON);
});

test("an explicitly selected missing Python fails instead of falling back to another installation", async () => {
  await assert.rejects(developmentToolEnvironment({ ...process.env, RUNTIME_PYTHON: "/nonexistent-desktop-python" }), { code: "ENOENT" });
});
