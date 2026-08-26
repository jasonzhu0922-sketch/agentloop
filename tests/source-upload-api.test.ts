import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthService } from "../src/auth/auth-service.ts";
import { BatchService } from "../src/batch/batch-service.ts";
import { createAgentLoopServer } from "../src/http/server.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { SourceRepository } from "../src/storage/repositories/source-repository.ts";

test("HTTP upload creates an owned uploaded source without exposing file paths", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-source-upload-api-"));
  const database = new AppDatabase(":memory:");
  const auth = new AuthService(database);
  const skills = new SkillService(database);
  const runs = new RunService({
    database,
    skills,
    workspaceRoot: workspace,
    modelFactory: () => { throw new Error("model is not used"); },
  });
  const server = createAgentLoopServer({ auth, skills, runs, batches: new BatchService(database, runs) });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const registered = await postJson<{ token: string }>(baseUrl, "/v1/auth/register", undefined, {
      email: "source-upload@example.com",
      password: "source upload secure password",
    });

    const form = new FormData();
    form.append("file", new Blob(["name,value\nNorth,120\n"], { type: "text/csv" }), "营收明细.csv");
    const uploaded = await fetch(`${baseUrl}/v1/uploads`, {
      method: "POST",
      headers: { authorization: `Bearer ${registered.token}` },
      body: form,
    });
    const uploadText = await uploaded.text();
    assert.equal(uploaded.status, 201, uploadText);
    const body = JSON.parse(uploadText) as {
      source: {
        id: string;
        originalName: string;
        status: string;
        chunkCount: number;
        summary?: string;
        storagePath?: string;
      };
    };
    assert.match(body.source.id, /^src_[a-f0-9]{32}$/);
    assert.equal(body.source.originalName, "营收明细.csv");
    assert.equal(body.source.status, "ready");
    assert.equal(body.source.chunkCount, 1);
    assert.equal("storagePath" in body.source, false);

    const fetched = await getJson<{ source: typeof body.source }>(baseUrl, `/v1/sources/${body.source.id}`, registered.token);
    assert.equal(fetched.source.originalName, "营收明细.csv");
    assert.match(fetched.source.summary ?? "", /North,120/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("source intake extracts HTML, PDF, DOCX, XLSX, and PPTX uploads into readable chunks", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-source-intake-formats-"));
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const sourceRepository = new SourceRepository(database);
    const owner = await auth.register("source-formats@example.com", "source formats secure password");
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => { throw new Error("model is not used"); },
    });

    const cases = [
      {
        name: "brief.html",
        bytes: Buffer.from(`<!doctype html>
          <html>
            <head><style>body{color:red}.hidden{display:none}</style><script>console.log("ignore me")</script></head>
            <body><h1>HTML intake evidence</h1><p>Visible &amp; useful content.</p></body>
          </html>`, "utf8"),
        expected: /HTML intake evidence.*Visible & useful content/s,
        rejected: /color:red|console\.log|display:none/,
      },
      { name: "brief.pdf", bytes: minimalPdf("PDF intake evidence") },
      { name: "brief.docx", bytes: minimalDocx("DOCX intake evidence") },
      { name: "brief.xlsx", bytes: minimalXlsx("Region", "North", "120") },
      { name: "brief.pptx", bytes: minimalPptx("PPTX intake evidence") },
    ];

    for (const item of cases) {
      const source = await runs.uploadSource(owner.user.id, {
        originalName: item.name,
        content: item.bytes,
      });
      assert.equal(source.status, "ready", item.name);
      assert.equal(source.chunkCount, 1, item.name);
      const summary = runs.source(owner.user.id, source.id);
      assert.match(summary.summary ?? "", "expected" in item ? item.expected : /intake evidence|Region|North|120/, item.name);
      if ("rejected" in item) assert.doesNotMatch(summary.summary ?? "", item.rejected, item.name);
      const chunkText = sourceRepository.chunks(source.id).map((chunk) => chunk.content).join("\n");
      assert.match(chunkText, "expected" in item ? item.expected : /intake evidence|Region|North|120/, item.name);
      if ("rejected" in item) assert.doesNotMatch(chunkText, item.rejected, item.name);
    }
  } finally {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

async function postJson<T>(
  baseUrl: string,
  path: string,
  token: string | undefined,
  body: unknown,
): Promise<T> {
  const response = await fetch(baseUrl + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return JSON.parse(text) as T;
}

function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${pdfEscape(text)}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  pdf += `trailer << /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function minimalDocx(text: string): Buffer {
  return createZip({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      </Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
      </Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body><w:p><w:r><w:t>${xmlEscape(text)}</w:t></w:r></w:p></w:body>
      </w:document>`,
  });
}

function minimalXlsx(header: string, name: string, value: string): Buffer {
  return createZip({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
      </Types>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?>
      <workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets>
      </workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
      </Relationships>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?>
      <worksheet><sheetData>
        <row r="1"><c r="A1" t="inlineStr"><is><t>${xmlEscape(header)}</t></is></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c></row>
        <row r="2"><c r="A2" t="inlineStr"><is><t>${xmlEscape(name)}</t></is></c><c r="B2"><v>${xmlEscape(value)}</v></c></row>
      </sheetData></worksheet>`,
  });
}

function minimalPptx(text: string): Buffer {
  return createZip({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
      </Types>`,
    "ppt/presentation.xml": `<?xml version="1.0" encoding="UTF-8"?>
      <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
      </p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
      </Relationships>`,
    "ppt/slides/slide1.xml": `<?xml version="1.0" encoding="UTF-8"?>
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
        xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${xmlEscape(text)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
      </p:sld>`,
  });
}

function createZip(entries: Record<string, string>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, "utf8");
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
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, data);

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
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function pdfEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

async function getJson<T>(baseUrl: string, path: string, token: string): Promise<T> {
  const response = await fetch(baseUrl + path, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return JSON.parse(text) as T;
}
