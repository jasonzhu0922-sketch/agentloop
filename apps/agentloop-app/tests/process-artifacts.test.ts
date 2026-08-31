import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { AuthService } from "../src/auth/auth-service.ts"
import { BatchService } from "@zhujun/agentloop";
import { createAgentLoopServer } from "../src/http/server.ts"
import { collectProcessArtifacts, artifactId, previewProcessArtifact } from "@zhujun/agentloop";
import { RunService } from "@zhujun/agentloop";
import { SkillService } from "@zhujun/agentloop";
import { AppDatabase } from "@zhujun/agentloop";

test("process artifacts require successful tool evidence and stay inside the workspace", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-artifacts-"));
  try {
    const createdAt = Date.now();
    await fs.writeFile(join(workspace, "poster.pdf"), "pdf bytes");
    await fs.writeFile(join(workspace, "unmentioned.png"), "png bytes");
    await fs.writeFile(join(workspace, "old.txt"), "old bytes");
    const oldTime = new Date(createdAt - 10_000);
    await fs.utimes(join(workspace, "old.txt"), oldTime, oldTime);

    const events = [{
      seq: 1,
      type: "tool.completed",
      createdAt,
      data: {
        toolName: "computer_run_command",
        result: JSON.stringify({ exitCode: 0, stdout: "saved poster.pdf\n" }),
      },
    }, {
      seq: 2,
      type: "tool.completed",
      createdAt,
      data: {
        toolName: "computer_run_command",
        result: JSON.stringify({ exitCode: 1, stdout: "saved unmentioned.png\n" }),
      },
    }, {
      seq: 3,
      type: "tool.completed",
      createdAt,
      data: {
        toolName: "computer_run_command",
        result: JSON.stringify({ exitCode: 0, stdout: "saved old.txt\n" }),
      },
    }];

    const artifacts = await collectProcessArtifacts({
      runId: "run-artifact-test",
      workspaceRoot: workspace,
      runCreatedAt: createdAt,
      events,
    });
    assert.deepEqual(artifacts.map((artifact) => artifact.path), ["poster.pdf"]);
    assert.equal(artifacts[0].runId, "run-artifact-test");
    assert.equal(artifacts[0].mimeType, "application/pdf");
    assert.equal(artifacts[0].id, artifactId("run-artifact-test", "poster.pdf"));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("process artifacts include successful command file changes when stdout omits filenames", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-command-file-changes-"));
  try {
    const createdAt = Date.now();
    await fs.writeFile(join(workspace, "poster.png"), "png bytes");
    await fs.writeFile(join(workspace, "poster.pdf"), "pdf bytes");
    await fs.writeFile(join(workspace, "scratch.txt"), "deleted bytes");

    const artifacts = await collectProcessArtifacts({
      runId: "run-file-change-artifacts",
      workspaceRoot: workspace,
      runCreatedAt: createdAt,
      events: [{
        seq: 1,
        type: "tool.completed",
        createdAt,
        data: {
          toolName: "computer_run_command",
          result: JSON.stringify({
            exitCode: 0,
            stdout: "saved (1600, 2400) 3197084 282746\n",
            fileChanges: [
              { path: "poster.pdf", changeType: "created", bytes: 9 },
              { path: "poster.png", changeType: "created", bytes: 9 },
              { path: "scratch.txt", changeType: "deleted", bytes: 13 },
            ],
            fileChangesTruncated: false,
          }),
        },
      }],
    });

    assert.deepEqual(artifacts.map((artifact) => artifact.path), ["poster.pdf", "poster.png"]);
    assert.deepEqual(artifacts.map((artifact) => artifact.sourceTool), ["computer_run_command", "computer_run_command"]);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("process artifacts deduplicate candidates that resolve to the same workspace file", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-duplicate-artifacts-"));
  try {
    const createdAt = Date.now();
    await fs.mkdir(join(workspace, "artifacts"), { recursive: true });
    const reportPath = join(workspace, "artifacts", "宝武数据中台_差旅API参数信息报告.md");
    const jsonPath = join(workspace, "api_query_result.json");
    await fs.writeFile(reportPath, "# report\n");
    await fs.writeFile(jsonPath, "{\"ok\":true}\n");

    const artifacts = await collectProcessArtifacts({
      runId: "run-duplicate-artifacts",
      workspaceRoot: workspace,
      runCreatedAt: createdAt,
      events: [{
        seq: 1,
        type: "tool.completed",
        createdAt,
        data: {
          toolName: "computer_run_command",
          result: JSON.stringify({
            exitCode: 0,
            stdout: [
              `wrote ${reportPath}`,
              "wrote artifacts/宝武数据中台_差旅API参数信息报告.md",
              `wrote ${jsonPath}`,
              "wrote api_query_result.json",
            ].join("\n"),
            fileChanges: [
              { path: "artifacts/宝武数据中台_差旅API参数信息报告.md", changeType: "created", bytes: 9 },
              { path: "api_query_result.json", changeType: "created", bytes: 12 },
            ],
          }),
        },
      }],
    });

    assert.deepEqual(artifacts.map((artifact) => artifact.path), [
      "api_query_result.json",
      "artifacts/宝武数据中台_差旅API参数信息报告.md",
    ]);
    assert.equal(new Set(artifacts.map((artifact) => artifact.id)).size, artifacts.length);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("process artifacts include paginated HTML materializer output", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-materializer-artifacts-"));
  try {
    const createdAt = Date.now();
    await fs.mkdir(join(workspace, "deliverables"), { recursive: true });
    await fs.writeFile(join(workspace, "deliverables", "deck.html"), "<!doctype html><section class=\"slide\">One</section>");

    const artifacts = await collectProcessArtifacts({
      runId: "run-materializer-artifacts",
      workspaceRoot: workspace,
      runCreatedAt: createdAt,
      events: [{
        seq: 1,
        type: "tool.completed",
        createdAt,
        data: {
          toolName: "materialize_paginated_html",
          result: JSON.stringify({
            schema: "agentloop.paginatedHtmlMaterialization/v1",
            artifactKind: "html",
            renderMode: "slides",
            acceptanceProfile: "html_ppt",
            path: "deliverables/deck.html",
            pageCount: 1,
          }),
        },
      }],
    });

    assert.deepEqual(artifacts.map((artifact) => artifact.path), ["deliverables/deck.html"]);
    assert.equal(artifacts[0].sourceTool, "materialize_paginated_html");
    assert.equal(artifacts[0].mimeType, "text/html; charset=utf-8");
    assert.equal(artifacts[0].previewable, true);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("process artifacts include conversation workspace files mentioned by absolute path", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-conversation-artifacts-"));
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("conversation-artifact-owner@example.com", "conversation artifact secure password");
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => { throw new Error("model is not used"); },
    });
    const conversationId = randomUUID();
    const runId = randomUUID();
    const createdAt = Date.now() - 1_000;
    const artifactDir = join(workspace, "conversations", conversationId, "artifacts");
    await fs.mkdir(artifactDir, { recursive: true });
    const reportPath = join(artifactDir, "场景分析报告.md");
    const extractionPath = join(artifactDir, "scenario_extraction.json");
    await fs.writeFile(reportPath, "# 场景分析报告\n");
    await fs.writeFile(extractionPath, "{\"records\":60}\n");
    database.prepare(`
      INSERT INTO conversations(id, owner_user_id, title, created_at, updated_at)
      VALUES (?, ?, 'spreadsheet report', ?, ?)
    `).run(conversationId, owner.user.id, createdAt, createdAt);
    database.prepare(`
      INSERT INTO runs(id, owner_user_id, conversation_id, depth, allow_dangerous_tools, status, input, created_at)
      VALUES (?, ?, ?, 0, 0, 'completed', ?, ?)
    `).run(runId, owner.user.id, conversationId, "分析 1.xlsx 并生成报告", createdAt);
    database.prepare(`
      INSERT INTO run_events(run_id, seq, type, payload_json, created_at)
      VALUES (?, 1, 'tool.completed', ?, ?)
    `).run(runId, JSON.stringify({
      toolName: "computer_run_command",
      result: JSON.stringify({ exitCode: 0, stdout: `wrote ${extractionPath}\nwrote ${reportPath}\n` }),
    }), createdAt);

    const artifacts = await runs.processArtifacts(owner.user.id, runId);

    assert.deepEqual(artifacts.map((artifact) => artifact.path), [
      "artifacts/scenario_extraction.json",
      "artifacts/场景分析报告.md",
    ]);
    assert.equal(artifacts[1]?.name, "场景分析报告.md");
    const opened = await runs.readProcessArtifact(owner.user.id, runId, artifacts[1]!.id);
    assert.equal(opened.content.toString("utf8"), "# 场景分析报告\n");
  } finally {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("process artifact API serves owner evidence and denies another user", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-artifact-api-"));
  const database = new AppDatabase(":memory:");
  const auth = new AuthService(database);
  const skills = new SkillService(database);
  const owner = await auth.register("artifact-owner@example.com", "artifact owner secure password");
  const stranger = await auth.register("artifact-stranger@example.com", "artifact stranger secure password");
  const runs = new RunService({
    database,
    skills,
    workspaceRoot: workspace,
    modelFactory: () => { throw new Error("model is not used"); },
  });
  const runId = randomUUID();
  const toolCallId = "command-large-stdout";
  const createdAt = Date.now();
  await fs.writeFile(join(workspace, "poster.pdf"), "PDF PROCESS ARTIFACT");
  await fs.mkdir(join(workspace, ".agentloop", "tool-results", "aa"), { recursive: true });
  await fs.writeFile(join(workspace, ".agentloop", "tool-results", "aa", "large.stdout.txt"), "complete stdout\nline 2\n");
  database.prepare(`
    INSERT INTO runs(id, owner_user_id, depth, allow_dangerous_tools, status, input, created_at)
    VALUES (?, ?, 0, 0, 'failed', ?, ?)
  `).run(runId, owner.user.id, "generate a poster", createdAt);
  database.prepare(`
    INSERT INTO run_events(run_id, seq, type, payload_json, created_at)
    VALUES (?, 1, 'tool.completed', ?, ?)
  `).run(runId, JSON.stringify({
    toolCallId,
    toolName: "computer_run_command",
    result: JSON.stringify({
      exitCode: 0,
      stdout: "saved poster.pdf\n[full stdout stored separately]",
      stdoutRef: {
        path: ".agentloop/tool-results/aa/large.stdout.txt",
        sha256: "aa",
        bytes: Buffer.byteLength("complete stdout\nline 2\n"),
        characters: "complete stdout\nline 2\n".length,
      },
    }),
  }), createdAt);
  const batches = new BatchService(database, runs);
  const server = createAgentLoopServer({ auth, skills, runs, batches });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const list = await fetch(`${baseUrl}/v1/runs/${runId}/artifacts`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(list.status, 200);
    const body = await list.json() as { artifacts: Array<{ id: string; name: string }> };
    assert.equal(body.artifacts.length, 1);
    assert.equal(body.artifacts[0].name, "poster.pdf");

    const content = await fetch(`${baseUrl}/v1/runs/${runId}/artifacts/${body.artifacts[0].id}`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(content.status, 200);
    assert.equal(content.headers.get("content-type"), "application/pdf");
    assert.equal(await content.text(), "PDF PROCESS ARTIFACT");

    const preview = await fetch(`${baseUrl}/v1/runs/${runId}/artifacts/${body.artifacts[0].id}/preview`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(preview.status, 200);
    const previewBody = await preview.json() as { preview: { kind: string; mimeType: string } };
    assert.equal(previewBody.preview.kind, "binary");
    assert.equal(previewBody.preview.mimeType, "application/pdf");

    const output = await fetch(`${baseUrl}/v1/runs/${runId}/commands/${toolCallId}/stdout`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(output.status, 200);
    const outputBody = await output.json() as { output: { content: string; path?: string } };
    assert.equal(outputBody.output.content, "complete stdout\nline 2\n");
    assert.equal(outputBody.output.path, ".agentloop/tool-results/aa/large.stdout.txt");

    const hidden = await fetch(`${baseUrl}/v1/runs/${runId}/artifacts`, {
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    assert.equal(hidden.status, 404);
    const hiddenOutput = await fetch(`${baseUrl}/v1/runs/${runId}/commands/${toolCallId}/stdout`, {
      headers: { authorization: `Bearer ${stranger.token}` },
    });
    assert.equal(hiddenOutput.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("process artifact API serves UTF-8 filenames in the download header", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-artifact-utf8-api-"));
  const database = new AppDatabase(":memory:");
  const auth = new AuthService(database);
  const skills = new SkillService(database);
  const owner = await auth.register("artifact-utf8-owner@example.com", "artifact utf8 secure password");
  const runs = new RunService({
    database,
    skills,
    workspaceRoot: workspace,
    modelFactory: () => { throw new Error("model is not used"); },
  });
  const conversationId = randomUUID();
  const runId = randomUUID();
  const createdAt = Date.now();
  const artifactDir = join(workspace, "conversations", conversationId, "artifacts");
  await fs.mkdir(artifactDir, { recursive: true });
  const reportPath = join(artifactDir, "场景分析报告.md");
  await fs.writeFile(reportPath, "# 场景分析报告\n");
  database.prepare(`
    INSERT INTO conversations(id, owner_user_id, title, created_at, updated_at)
    VALUES (?, ?, 'utf8 artifact', ?, ?)
  `).run(conversationId, owner.user.id, createdAt, createdAt);
  database.prepare(`
    INSERT INTO runs(id, owner_user_id, conversation_id, depth, allow_dangerous_tools, status, input, created_at)
    VALUES (?, ?, ?, 0, 0, 'completed', ?, ?)
  `).run(runId, owner.user.id, conversationId, "生成中文报告", createdAt);
  database.prepare(`
    INSERT INTO run_events(run_id, seq, type, payload_json, created_at)
    VALUES (?, 1, 'tool.completed', ?, ?)
  `).run(runId, JSON.stringify({
    toolName: "computer_run_command",
    result: JSON.stringify({ exitCode: 0, stdout: `wrote ${reportPath}\n` }),
  }), createdAt);
  const batches = new BatchService(database, runs);
  const server = createAgentLoopServer({ auth, skills, runs, batches });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const list = await fetch(`${baseUrl}/v1/runs/${runId}/artifacts`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(list.status, 200);
    const body = await list.json() as { artifacts: Array<{ id: string; name: string }> };
    assert.equal(body.artifacts[0]?.name, "场景分析报告.md");

    const content = await fetch(`${baseUrl}/v1/runs/${runId}/artifacts/${body.artifacts[0]!.id}`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(content.status, 200);
    assert.equal(await content.text(), "# 场景分析报告\n");
    const disposition = content.headers.get("content-disposition") ?? "";
    assert.match(disposition, /filename="\S+"/);
    assert.match(disposition, /filename\*=UTF-8''%E5%9C%BA%E6%99%AF%E5%88%86%E6%9E%90%E6%8A%A5%E5%91%8A\.md/);

    const preview = await fetch(`${baseUrl}/v1/runs/${runId}/artifacts/${body.artifacts[0]!.id}/preview`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(preview.status, 200);
    const previewBody = await preview.json() as { preview: { kind: string; text: string } };
    assert.equal(previewBody.preview.kind, "text");
    assert.equal(previewBody.preview.text, "# 场景分析报告\n");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("process artifact preview extracts docx paragraphs, xlsx rows, and pptx slides", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-artifact-preview-"));
  try {
    const docxPath = join(workspace, "weekly.docx");
    const xlsxPath = join(workspace, "plan.xlsx");
    const pptxPath = join(workspace, "deck.pptx");
    await fs.writeFile(docxPath, zipStore({
      "word/document.xml": [
        "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>",
        "<w:p><w:r><w:t>项目周报</w:t></w:r></w:p>",
        "<w:p><w:r><w:t>进度正常</w:t></w:r></w:p>",
        "</w:body></w:document>",
      ].join(""),
    }));
    await fs.writeFile(xlsxPath, zipStore({
      "xl/workbook.xml": "<workbook><sheets><sheet name=\"计划\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>",
      "xl/sharedStrings.xml": "<sst><si><t>事项</t></si><si><t>完成率</t></si><si><t>登录优化</t></si></sst>",
      "xl/worksheets/sheet1.xml": [
        "<worksheet><sheetData>",
        "<row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"B1\" t=\"s\"><v>1</v></c><c r=\"C1\" t=\"inlineStr\"><is><t>&#24207;&#21495;</t></is></c></row>",
        "<row r=\"2\"><c r=\"A2\" t=\"s\"><v>2</v></c><c r=\"B2\"><v>100%</v></c></row>",
        "</sheetData></worksheet>",
      ].join(""),
    }));
    await fs.writeFile(pptxPath, zipStore({
      "ppt/presentation.xml": [
        "<p:presentation xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" ",
        "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><p:sldSz cx=\"12192000\" cy=\"6858000\"/><p:sldIdLst>",
        "<p:sldId id=\"256\" r:id=\"rId2\"/>",
        "<p:sldId id=\"257\" r:id=\"rId1\"/>",
        "</p:sldIdLst></p:presentation>",
      ].join(""),
      "ppt/_rels/presentation.xml.rels": [
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
        "<Relationship Id=\"rId1\" Type=\"slide\" Target=\"slides/slide2.xml\"/>",
        "<Relationship Id=\"rId2\" Type=\"slide\" Target=\"slides/slide1.xml\"/>",
        "</Relationships>",
      ].join(""),
      "ppt/slides/slide1.xml": [
        "<p:sld xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" ",
        "xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><p:bg><p:bgPr>",
        "<a:solidFill><a:srgbClr val=\"0F2A43\"/></a:solidFill></p:bgPr></p:bg><p:cSld><p:spTree>",
        "<p:sp><p:spPr><a:xfrm><a:off x=\"-457200\" y=\"-228600\"/><a:ext cx=\"914400\" cy=\"914400\"/></a:xfrm>",
        "<a:prstGeom prst=\"ellipse\"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val=\"1D3E58\"><a:alpha val=\"60000\"/></a:srgbClr></a:solidFill>",
        "<a:ln w=\"12700\"><a:solidFill><a:srgbClr val=\"8FC7B6\"/></a:solidFill></a:ln></p:spPr></p:sp>",
        "<p:sp><p:spPr><a:xfrm><a:off x=\"914400\" y=\"685800\"/><a:ext cx=\"9144000\" cy=\"1371600\"/></a:xfrm>",
        "<a:prstGeom prst=\"chevron\"><a:avLst/></a:prstGeom>",
        "<a:solidFill><a:srgbClr val=\"F8FAFC\"/></a:solidFill></p:spPr><p:txBody>",
        "<a:p><a:r><a:rPr sz=\"3200\"><a:solidFill><a:srgbClr val=\"334155\"/></a:solidFill></a:rPr><a:t>封面</a:t></a:r>",
        "<a:r><a:rPr sz=\"3200\"><a:solidFill><a:srgbClr val=\"8FC7B6\"/></a:solidFill></a:rPr><a:t>标题</a:t></a:r></a:p>",
        "<a:p><a:r><a:t>第一段 &amp; 重点</a:t></a:r></a:p></p:txBody></p:sp>",
        "</p:spTree></p:cSld></p:sld>",
      ].join(""),
      "ppt/slides/slide2.xml": [
        "<p:sld xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" ",
        "xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><p:cSld><p:spTree>",
        "<p:sp><p:txBody><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:txBody></p:sp>",
        "</p:spTree></p:cSld></p:sld>",
      ].join(""),
    }));

    const docxPreview = await previewProcessArtifact({
      workspaceRoot: workspace,
      artifact: {
        runId: "preview-docx-run",
        id: "docx",
        path: "weekly.docx",
        name: "weekly.docx",
        bytes: (await fs.stat(docxPath)).size,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sourceTool: "computer_write_file",
        previewable: true,
      },
    });
    const xlsxPreview = await previewProcessArtifact({
      workspaceRoot: workspace,
      artifact: {
        runId: "preview-xlsx-run",
        id: "xlsx",
        path: "plan.xlsx",
        name: "plan.xlsx",
        bytes: (await fs.stat(xlsxPath)).size,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sourceTool: "computer_write_file",
        previewable: true,
      },
    });
    const pptxPreview = await previewProcessArtifact({
      workspaceRoot: workspace,
      artifact: {
        runId: "preview-pptx-run",
        id: "pptx",
        path: "deck.pptx",
        name: "deck.pptx",
        bytes: (await fs.stat(pptxPath)).size,
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        sourceTool: "computer_write_file",
        previewable: true,
      },
    });

    assert.equal(docxPreview.kind, "docx");
    if (docxPreview.kind === "docx") {
      assert.deepEqual(docxPreview.paragraphs, ["项目周报", "进度正常"]);
    }
    assert.equal(xlsxPreview.kind, "xlsx");
    if (xlsxPreview.kind === "xlsx") {
      assert.equal(xlsxPreview.sheets[0]?.name, "计划");
      assert.deepEqual(xlsxPreview.sheets[0]?.rows, [
        ["事项", "完成率", "序号"],
        ["登录优化", "100%"],
      ]);
    }
    assert.equal(pptxPreview.kind, "pptx");
    if (pptxPreview.kind === "pptx") {
      assert.equal(pptxPreview.slideCount, 2);
      assert.equal(pptxPreview.width, 12_192_000);
      assert.equal(pptxPreview.height, 6_858_000);
      assert.equal(pptxPreview.slides[0]?.background, "#0F2A43");
      assert.deepEqual(pptxPreview.slides.map((slide) => slide.title), ["封面标题", "第二页"]);
      assert.deepEqual(pptxPreview.slides[0]?.paragraphs, ["封面标题", "第一段 & 重点"]);
      assert.deepEqual(pptxPreview.slides[0]?.elements[0], {
        kind: "shape",
        preset: "ellipse",
        x: -457_200,
        y: -228_600,
        width: 914_400,
        height: 914_400,
        fill: "#1D3E58",
        opacity: 0.6,
        stroke: "#8FC7B6",
        strokeWidth: 12_700,
      });
      assert.deepEqual(pptxPreview.slides[0]?.elements[1], {
        kind: "shape",
        preset: "chevron",
        x: 914_400,
        y: 685_800,
        width: 9_144_000,
        height: 1_371_600,
        fill: "#F8FAFC",
      });
      assert.deepEqual(pptxPreview.slides[0]?.elements[2], {
        kind: "text",
        x: 914_400,
        y: 685_800,
        width: 9_144_000,
        height: 1_371_600,
        text: "封面标题\n第一段 & 重点",
        fontSize: 32,
        color: "#334155",
        fill: "#F8FAFC",
        lines: [
          [
            { text: "封面", fontSize: 32, color: "#334155" },
            { text: "标题", fontSize: 32, color: "#8FC7B6" },
          ],
          [{ text: "第一段 & 重点" }],
        ],
      });
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

function zipStore(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const localFiles = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localFiles.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localFiles, centralDirectory, eocd]);
}
