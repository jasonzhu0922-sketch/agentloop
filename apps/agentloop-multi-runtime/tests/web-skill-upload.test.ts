import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../web/client/app.js", import.meta.url), "utf8");
const uploadSource = source.slice(source.indexOf("async function uploadRuntimeSkill("), source.indexOf("function fileAsBase64("));
const html = await readFile(new URL("../web/pages/app.html", import.meta.url), "utf8");

for (const prefix of ["runtime-create", "runtime-config"]) {
  test(`${prefix} shows local upload progress, selects the installed Skill and keeps existing selections`, async () => {
    const input = { files: [{ name: "private-skill.zip" }], value: "private-skill.zip" };
    const button = { disabled: false };
    const status = { textContent: "", dataset: { tone: "" } };
    const elements = {
      [`${prefix}-skill-file`]: input, [`${prefix}-skill-upload`]: button,
      [`${prefix}-skill-upload-status`]: status,
      [`${prefix}-skills`]: { querySelectorAll: () => [{ value: "existing" }] },
    };
    let finish!: (value: Response) => void;
    let loaded: unknown[] = [];
    const upload = vm.runInNewContext(`${uploadSource}\nuploadRuntimeSkill`, {
      Error, $: (id: string) => elements[id as keyof typeof elements],
      fileAsBase64: async () => "encoded-zip",
      localAgentFetch: (path: string, init: RequestInit) => {
        assert.equal(path, "/v1/local-skill-package-uploads");
        assert.equal(JSON.parse(String(init.body)).originalName, "private-skill.zip");
        return new Promise<Response>((resolve) => { finish = resolve; });
      },
      loadRuntimeSkillOptions: async (id: string, selected: string[]) => { loaded = [id, ...selected]; },
    });
    assert.ok(html.includes(`id="${prefix}-skill-upload-status"`));
    assert.ok(html.includes(`id="${prefix}-skill-directory-upload"`));
    assert.ok(html.includes(`id="${prefix}-skill-directory"`));
    const pending = upload(prefix);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(button.disabled, true);
    assert.equal(status.dataset.tone, "running");
    assert.match(status.textContent, /正在上传到本机/);
    finish(Response.json({ skill: { packageId: "installed", displayName: "Private Skill" } }, { status: 201 }));
    await pending;
    assert.equal(button.disabled, false);
    assert.equal(input.value, "");
    assert.equal(status.dataset.tone, "ok");
    assert.match(status.textContent, /已安装到本机：Private Skill/);
    assert.match(status.textContent, prefix === "runtime-create" ? /创建后/ : /保存后/);
    assert.deepEqual(loaded, [`${prefix}-skills`, "existing", "installed"]);
  });

  test(`${prefix} shows actionable ZIP layout errors inside the dialog and permits retry`, async () => {
    const button = { disabled: false };
    const status = { textContent: "", dataset: { tone: "" } };
    const input = { files: [{ name: "multiple.zip" }], value: "multiple.zip" };
    const elements = { [`${prefix}-skill-file`]: input, [`${prefix}-skill-upload`]: button, [`${prefix}-skill-upload-status`]: status };
    const upload = vm.runInNewContext(`${uploadSource}\nuploadRuntimeSkill`, {
      Error, $: (id: string) => elements[id as keyof typeof elements],
      fileAsBase64: async () => "encoded-zip",
      localAgentFetch: async () => Response.json({ error: "skill_upload_package_layout_invalid" }, { status: 400 }),
    });
    await upload(prefix);
    assert.equal(status.dataset.tone, "error");
    assert.match(status.textContent, /压缩包布局无效/);
    assert.match(status.textContent, /每个文件只能属于一个 Skill/);
    assert.equal(button.disabled, false);
    assert.equal(input.value, "");
  });

  test(`${prefix} selects every Skill returned by a multi-Skill upload`, async () => {
    const input = { files: [{ name: "multiple.zip" }], value: "multiple.zip" };
    const button = { disabled: false };
    const status = { textContent: "", dataset: { tone: "" } };
    const elements = {
      [`${prefix}-skill-file`]: input, [`${prefix}-skill-upload`]: button,
      [`${prefix}-skill-upload-status`]: status,
      [`${prefix}-skills`]: { querySelectorAll: () => [{ value: "existing" }] },
    };
    let loaded: unknown[] = [];
    const upload = vm.runInNewContext(`${uploadSource}\nuploadRuntimeSkill`, {
      Error, $: (id: string) => elements[id as keyof typeof elements],
      fileAsBase64: async () => "encoded-zip",
      localAgentFetch: async () => Response.json({ skills: [
        { packageId: "first", displayName: "First Skill" },
        { packageId: "second", displayName: "Second Skill" },
      ] }, { status: 201 }),
      loadRuntimeSkillOptions: async (id: string, selected: string[]) => { loaded = [id, ...selected]; },
    });
    await upload(prefix);
    assert.deepEqual(loaded, [`${prefix}-skills`, "existing", "first", "second"]);
    assert.match(status.textContent, /已安装到本机（2 个）：First Skill、Second Skill/);
  });

  test(`${prefix} uploads a selected directory with relative paths`, async () => {
    const input = { files: [
      { name: "SKILL.md", webkitRelativePath: "directory-skill/SKILL.md" },
      { name: "run.py", webkitRelativePath: "directory-skill/scripts/run.py" },
    ], value: "directory-skill" };
    const button = { disabled: false };
    const status = { textContent: "", dataset: { tone: "" } };
    const elements = {
      [`${prefix}-skill-directory`]: input, [`${prefix}-skill-directory-upload`]: button,
      [`${prefix}-skill-upload-status`]: status,
      [`${prefix}-skills`]: { querySelectorAll: () => [] },
    };
    let request: Record<string, unknown> | undefined;
    const upload = vm.runInNewContext(`${uploadSource}\nuploadRuntimeSkill`, {
      Error, $: (id: string) => elements[id as keyof typeof elements],
      fileAsBase64: async (file: { name: string }) => `encoded-${file.name}`,
      localAgentFetch: async (_path: string, init: RequestInit) => {
        request = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json({ skill: { packageId: "directory", displayName: "Directory Skill" } }, { status: 201 });
      },
      loadRuntimeSkillOptions: async () => undefined,
    });
    await upload(prefix, "directory");
    assert.deepEqual(request, { files: [
      { path: "directory-skill/SKILL.md", contentBase64: "encoded-SKILL.md" },
      { path: "directory-skill/scripts/run.py", contentBase64: "encoded-run.py" },
    ] });
    assert.equal(status.dataset.tone, "ok");
    assert.equal(button.disabled, false);
  });
}
