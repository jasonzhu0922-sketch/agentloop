import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after } from "node:test";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import {
  createWebTools,
  extractRedirectTarget,
  htmlToMarkdown,
  isBaiduVerification,
  normalizeSearchPayload,
  parseBaiduResults,
  parseRssItems,
} from "../src/tools/web-tools.ts";

const workspaceRoot = mkdtempSync(join(tmpdir(), "web-tools-refs-"));
after(() => rmSync(workspaceRoot, { recursive: true, force: true }));

test("web tools are registered and materialized as parallel replay-safe tools", () => {
  const registry = new ToolRegistry(createWebTools());
  const allowed = registry.materialize(grant(["webfetch", "websearch"]));
  const byName = new Map(allowed.definitions.map((tool) => [tool.name, tool]));
  const webfetch = byName.get("webfetch");
  const websearch = byName.get("websearch");
  assert.ok(webfetch !== undefined);
  assert.ok(websearch !== undefined);
  assert.equal(webfetch?.inputSchema.additionalProperties, false);
  assert.equal(websearch?.inputSchema.additionalProperties, false);
  const prepared = allowed.prepare({ id: "wf", name: "webfetch", arguments: { url: "https://example.com" } });
  assert.deepEqual(prepared.input, { url: "https://example.com", format: "markdown" });
});

test("webfetch parse rejects malformed, non-http, credentialed, and private targets", () => {
  const registry = new ToolRegistry(createWebTools());
  const allowed = registry.materialize(grant(["webfetch"]));
  const reject = (url: string) => {
    assert.throws(
      () => allowed.prepare({ id: "fetch-reject", name: "webfetch", arguments: { url } }),
      (error: unknown) => hasCode(error, "BAD_REQUEST"),
    );
  };
  reject("not-a-url");
  reject("ftp://example.com/file");
  reject("http://user:pass@example.com/");
  reject("http://localhost/");
  reject("http://127.0.0.1/");
  reject("http://169.254.169.254/meta");
  reject("http://10.0.0.1/");
  reject("http://192.168.1.1/");
  reject("http://172.16.0.1/");
  assert.throws(
    () => allowed.prepare({ id: "bad-format", name: "webfetch", arguments: { url: "https://example.com", format: "pdf" } }),
    (error: unknown) => error instanceof Error && /format/.test(error.message),
  );
});

test("webfetch accepts http(s) targets and validates format", () => {
  const registry = new ToolRegistry(createWebTools({ allowPrivateTargets: true }));
  const allowed = registry.materialize(grant(["webfetch"]));
  const text = allowed.prepare({ id: "fetch-text", name: "webfetch", arguments: { url: "http://127.0.0.1:8787/x", format: "text" } });
  assert.deepEqual(text.input, { url: "http://127.0.0.1:8787/x", format: "text" });
});

test("websearch parse bounds the result count", () => {
  const registry = new ToolRegistry(createWebTools());
  const allowed = registry.materialize(grant(["websearch"]));
  assert.deepEqual(
    allowed.prepare({ id: "search-default", name: "websearch", arguments: { query: "hello" } }).input,
    { query: "hello", numResults: 5 },
  );
  assert.deepEqual(
    allowed.prepare({ id: "search-three", name: "websearch", arguments: { query: "hello", numResults: 3 } }).input,
    { query: "hello", numResults: 3 },
  );
  assert.throws(
    () => allowed.prepare({ id: "search-zero", name: "websearch", arguments: { query: "hello", numResults: 0 } }),
    (error: unknown) => error instanceof Error && /numResults/.test(error.message),
  );
  assert.throws(
    () => allowed.prepare({ id: "search-many", name: "websearch", arguments: { query: "hello", numResults: 11 } }),
    (error: unknown) => error instanceof Error && /numResults/.test(error.message),
  );
});

test("websearch rejects degenerate queries and caches repeated identical searches within a run", async () => {
  let hits = 0;
  const server = createServer(async (_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ results: [{ title: "t", url: "https://t/1", content: "c1" }] }));
  });
  await listen(server);
  const port = (server.address() as AddressInfo).port;
  try {
    const registry = new ToolRegistry(createWebTools({ searchEndpoint: `http://127.0.0.1:${port}/search` }));
    const allowed = registry.materialize(grant(["websearch"]));
    const execute = async (query: string) => {
      const prepared = allowed.prepare({ id: "search-exec", name: "websearch", arguments: { query } });
      return prepared.tool.execute(grantContext(["websearch"]), prepared.input) as Promise<{
        schema: string;
        returned: number;
        results: Array<{ title: string }>;
        evidenceReceipt: {
          schema: string;
          evidenceKinds: { satisfied: string[]; caveated: string[]; failed: string[] };
        };
      }>;
    };
    await assert.rejects(
      () => execute("宝"),
      (error: unknown) => hasCode(error, "BAD_REQUEST") && error instanceof Error && /at least 2 characters/.test(error.message),
    );
    const first = await execute("中国宝武 数据底座");
    assert.equal(first.schema, "agentloop.webSearch/v1");
    assert.equal(first.returned, 1);
    assert.equal(first.results.length, 1);
    assert.equal(first.evidenceReceipt.schema, "agentloop.toolEvidenceReceipt/v1");
    assert.deepEqual(first.evidenceReceipt.evidenceKinds.satisfied, ["source_urls"]);
    assert.deepEqual(first.evidenceReceipt.evidenceKinds.caveated, ["explicit_caveats"]);
    assert.equal(hits, 1);
    await execute("中国宝武 数据底座");
    assert.equal(hits, 1, "a repeated identical query within the same run must hit the per-run cache");
  } finally {
    await close(server);
  }
});

test("search API responses share charset decoding and reject corrupt text instead of caching it", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "application/json; charset=gb18030" });
    res.end(Buffer.concat([
      Buffer.from('{"results":[{"title":"'),
      hits === 1 ? Buffer.from([0xff]) : Buffer.from("d6d0cec4b9abb8e6", "hex"),
      Buffer.from('","url":"https://example.test/announcement","content":"verified discovery"}]}'),
    ]));
  });
  await listen(server);
  try {
    const port = (server.address() as AddressInfo).port;
    const allowed = new ToolRegistry(createWebTools({ searchEndpoint: `http://127.0.0.1:${port}/encoded` })).materialize(grant(["websearch"]));
    const prepared = allowed.prepare({ id: "encoded-search", name: "websearch", arguments: { query: "encoding regression" } });
    const execute = () => prepared.tool.execute(grantContext(["websearch"]), prepared.input);
    await assert.rejects(execute(), /could not be decoded/);
    const result = await execute() as { results: Array<{ title: string }> };
    assert.equal(result.results[0]?.title, "中文公告");
    assert.equal(hits, 2);
  } finally { await close(server); }
});

test("extractRedirectTarget detects JavaScript and meta-refresh redirects", () => {
  assert.equal(
    extractRedirectTarget(`<script>window.location.replace("https://www.cehome.com/news/1.shtml")</script>`),
    "https://www.cehome.com/news/1.shtml",
  );
  assert.equal(
    extractRedirectTarget(`<script>window.location.assign('https://example.com/target')</script>`),
    "https://example.com/target",
  );
  assert.equal(
    extractRedirectTarget(`<noscript><META http-equiv="refresh" content="0;URL='http://www.sasac.gov.cn/page'"></noscript>`),
    "http://www.sasac.gov.cn/page",
  );
  assert.equal(
    extractRedirectTarget(`<meta http-equiv="refresh" content="5; url=https://example.com/next">`),
    "https://example.com/next",
  );
  assert.equal(extractRedirectTarget(`<html><body>no redirect here</body></html>`), undefined);
});

test("htmlToMarkdown extracts readable content and drops noise", () => {
  const html = `<!doctype html><html><head><title>宝武发布</title><style>.x{color:red}</style></head>
<body><header>网站头部菜单</header><nav>导航</nav><h1>数据底座与超级智能体</h1>
<p>8 月 30 日对集团内发布，详见 <a href="https://example.com/detail">官方公告</a>。</p>
<form><input name="q">搜索框</form><figure><figcaption>配图</figcaption></figure>
<script>track()</script><img alt="数据底座架构" src="arch.png"></body></html>`;
  const markdown = htmlToMarkdown(html);
  assert.match(markdown, /# 数据底座与超级智能体/);
  assert.match(markdown, /8 月 30 日对集团内发布/);
  assert.match(markdown, /\[官方公告\]\(https:\/\/example\.com\/detail\)/);
  assert.match(markdown, /!\[数据底座架构\]\(\)/);
  assert.doesNotMatch(markdown, /网站头部菜单|导航|track\(\)|\.x\{color:red\}|搜索框|配图/);
});

test("isBaiduVerification detects the anti-bot page and tiny stubs", () => {
  assert.equal(isBaiduVerification(`<html><head><title>百度安全验证</title></head><body>请完成验证</body></html>`), true);
  assert.equal(isBaiduVerification(`<html><body>安全验证</body></html>`), true);
  assert.equal(isBaiduVerification(`<div id="content_left"><h3 class="t"><a href="http://x">a</a></h3></div>`), true);
  const large = `<html><body>${"x".repeat(20_000)}<h3 class="t"><a href="http://x">a</a></h3></body></html>`;
  assert.equal(isBaiduVerification(large), false);
});

test("parseRssItems extracts title, link, and description from Bing RSS", () => {
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>bing</title>
<item><title>中国宝武 数据底座</title><link>https://www.bing.com/link?url=abc</link>
<description><![CDATA[宝武集团即将发布<strong>数据底座</strong>与超级智能体。]]></description></item>
<item><title>宝武官网</title><link>https://www.baowugroup.com/</link>
<description>集团首页</description></item>
</channel></rss>`;
  const items = parseRssItems(rss);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "中国宝武 数据底座");
  assert.equal(items[0].link, "https://www.bing.com/link?url=abc");
  assert.equal(items[0].description, "宝武集团即将发布 数据底座 与超级智能体。");
  assert.equal(items[1].title, "宝武官网");
});

test("parseBaiduResults extracts titles, redirect links, and snippets", () => {
  const html = `<html><body><div id="content_left">
<script>window.__json_data = {"clamp":3};</script>
<h3 class="t"><a href="http://www.baidu.com/link?url=abc">数据底座与超级智能体</a></h3>
<div class="c-abstract">宝武集团 8 月 30 日对集团内发布数据底座与超级智能体。</div>
<h3 class="t"><a href="https://www.baowugroup.com/">中国宝武钢铁集团有限公司</a></h3>
<div class="c-abstract">宝武集团官方网站。</div>
</div></body></html>`;
  const results = parseBaiduResults(html);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, "数据底座与超级智能体");
  assert.equal(results[0].url, "http://www.baidu.com/link?url=abc");
  assert.match(results[0].snippet, /8 月 30 日/);
  assert.doesNotMatch(results[0].snippet, /__json_data|clamp/);
  assert.equal(results[1].title, "中国宝武钢铁集团有限公司");
  assert.equal(results[1].url, "https://www.baowugroup.com/");
});

test("normalizeSearchPayload accepts Tavily, Brave, and Google result shapes", () => {
  const tavily = { results: [{ title: "t", url: "https://t/1", content: "c1" }] };
  assert.deepEqual(normalizeSearchPayload(tavily, 5), [{ title: "t", url: "https://t/1", snippet: "c1" }]);
  const brave = { web: { results: [{ title: "b", url: "https://b/1", snippet: "s1" }] } };
  assert.deepEqual(normalizeSearchPayload(brave, 5), [{ title: "b", url: "https://b/1", snippet: "s1" }]);
  const google = { organic_results: [{ title: "g", link: "https://g/1", snippet: "s2" }] };
  assert.deepEqual(normalizeSearchPayload(google, 5), [{ title: "g", url: "https://g/1", snippet: "s2" }]);
  assert.deepEqual(normalizeSearchPayload({ results: [] }, 5), []);
  assert.deepEqual(normalizeSearchPayload(null, 5), []);
});

test("webfetch follows a meta-refresh redirect and extracts readable content end to end", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><meta http-equiv="refresh" content="0;URL='/target'"></head><body>redirecting</body></html>`);
      return;
    }
    if (req.url === "/target") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>宝武发布</title></head><body><h1>数据底座与超级智能体</h1><p>8 月 30 日对集团内发布。</p></body></html>`);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await listen(server);
  const port = (server.address() as AddressInfo).port;
  try {
    const registry = new ToolRegistry(createWebTools({ allowPrivateTargets: true }));
    const allowed = registry.materialize(grant(["webfetch"]));
    const prepared = allowed.prepare({
      id: "fetch-integration",
      name: "webfetch",
      arguments: { url: `http://127.0.0.1:${port}/redirect`, format: "markdown" },
    });
    const result = await prepared.tool.execute(grantContext(["webfetch"]), prepared.input) as {
      schema: string;
      url: string;
      title: string | undefined;
      content: string;
      bytes: number;
      truncated: boolean;
      evidenceReceipt: {
        schema: string;
        sourceRefs: unknown[];
        facts: Array<{ kind?: string }>;
        evidenceKinds: { satisfied: string[]; caveated: string[]; failed: string[] };
      };
    };
    assert.equal(result.schema, "agentloop.webFetch/v1");
    assert.equal(result.title, "宝武发布");
    assert.ok(result.url.endsWith("/target"));
    assert.match(result.content, /数据底座与超级智能体/);
    assert.match(result.content, /8 月 30 日/);
    assert.equal(result.truncated, false);
    assert.equal(result.evidenceReceipt.schema, "agentloop.toolEvidenceReceipt/v1");
    assert.equal(result.evidenceReceipt.sourceRefs.length, 1);
    assert.equal(result.evidenceReceipt.facts.some((fact) => fact.kind === "source_summary"), true);
    assert.deepEqual(result.evidenceReceipt.evidenceKinds.satisfied, ["source_read", "source_summary", "source_urls"]);
    assert.deepEqual(result.evidenceReceipt.evidenceKinds.caveated, ["explicit_caveats"]);
  } finally {
    await close(server);
  }
});

test("webfetch decodes declared encodings before conversion and persists the same readable text", async () => {
  const cases = [
    { label: "gb2312 header", type: 'text/html; charset="gb2312"', meta: "", hex: "d6d0cec4b9abb8e6", expected: "中文公告", encoding: "gbk", source: "http_header" },
    { label: "gb18030 meta", type: "text/html", meta: '<meta charset="gb18030">', hex: "d6d0cec4b9abb8e6", expected: "中文公告", encoding: "gb18030", source: "document" },
    { label: "gb18030 four-byte character", type: "text/html; charset=gb18030", meta: "", hex: "95328236", expected: "𠀀", encoding: "gb18030", source: "http_header" },
    { label: "legacy meta", type: "text/html", meta: '<meta content="text/html; charset=gbk" http-equiv="Content-Type">', hex: "d6d0cec4b9abb8e6", expected: "中文公告", encoding: "gbk", source: "document" },
    { label: "big5 header", type: "text/html; charset=big5", meta: "", hex: "c163c5e9a4bda769", expected: "繁體公告", encoding: "big5", source: "http_header" },
    { label: "shift-jis header", type: "text/html; charset=shift_jis", meta: "", hex: "93fa967b8cea", expected: "日本語", encoding: "shift_jis", source: "http_header" },
    { label: "header precedes meta", type: "text/html; charset=gb2312", meta: '<meta charset="utf-8">', hex: "d6d0cec4b9abb8e6", expected: "中文公告", encoding: "gbk", source: "http_header" },
  ];
  const server = createServer((req, res) => {
    const item = cases[Number(req.url!.slice(1))]!;
    res.writeHead(200, { "content-type": item.type });
    res.end(Buffer.concat([Buffer.from(`<html><head>${item.meta}</head><body><p>`), Buffer.from(item.hex, "hex"), Buffer.from("</p></body></html>")]));
  });
  await listen(server);
  try {
    const port = (server.address() as AddressInfo).port;
    const allowed = new ToolRegistry(createWebTools({ allowPrivateTargets: true })).materialize(grant(["webfetch"]));
    for (const [index, item] of cases.entries()) {
      const prepared = allowed.prepare({ id: `encoding-${index}`, name: "webfetch", arguments: { url: `http://127.0.0.1:${port}/${index}` } });
      const result = await prepared.tool.execute(grantContext(["webfetch"]), prepared.input) as {
        content: string; contentLocation: { path: string; sha256: string };
        decoding: { encoding: string; source: string; lossy: boolean; replacementCharacters: number };
      };
      assert.equal(result.content, item.expected, item.label);
      assert.deepEqual(result.decoding, { encoding: item.encoding, source: item.source, lossy: false, replacementCharacters: 0 });
      assert.equal(result.contentLocation.sha256, createHash("sha256").update(item.expected).digest("hex"));
    }
  } finally { await close(server); }
});

test("webfetch honors BOMs, defaults to UTF-8, and reports lossy or unsupported decoding explicitly", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/bom") {
      res.writeHead(200, { "content-type": "text/html; charset=gbk" });
      res.end(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<p>中文公告</p>", "utf16le")]));
    } else if (req.url === "/bom-be") {
      res.writeHead(200, { "content-type": "text/html; charset=gbk" });
      res.end(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("<p>中文公告</p>", "utf16le").swap16()]));
    } else if (req.url === "/xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(Buffer.concat([Buffer.from('<?xml version="1.0" encoding="gbk"?><item>'), Buffer.from("d6d0cec4b9abb8e6", "hex"), Buffer.from("</item>")]));
    } else if (req.url === "/invalid") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0x3c, 0x2f, 0x70, 0x3e]));
    } else if (req.url === "/unsupported") {
      res.writeHead(200, { "content-type": "text/html; charset=unknown-encoding" }); res.end("<p>text</p>");
    } else {
      res.writeHead(200, { "content-type": "text/html" }); res.end("<p>中文公告</p>");
    }
  });
  await listen(server);
  try {
    const port = (server.address() as AddressInfo).port;
    const allowed = new ToolRegistry(createWebTools({ allowPrivateTargets: true })).materialize(grant(["webfetch"]));
    const read = async (path: string) => {
      const prepared = allowed.prepare({ id: path, name: "webfetch", arguments: { url: `http://127.0.0.1:${port}${path}` } });
      return await prepared.tool.execute(grantContext(["webfetch"]), prepared.input) as {
        content: string; decoding: { encoding: string; source: string; lossy: boolean };
        evidenceReceipt: { evidenceKinds: { satisfied: string[]; failed: string[] }; caveats: string[] };
      };
    };
    const bom = await read("/bom");
    assert.equal(bom.content, "中文公告"); assert.equal(bom.decoding.source, "bom"); assert.equal(bom.decoding.encoding, "utf-16le");
    const bomBE = await read("/bom-be");
    assert.equal(bomBE.content, "中文公告"); assert.equal(bomBE.decoding.encoding, "utf-16be");
    const xml = await read("/xml");
    assert.match(xml.content, /<item>中文公告<\/item>/); assert.equal(xml.decoding.source, "document");
    const utf8 = await read("/default");
    assert.equal(utf8.content, "中文公告"); assert.equal(utf8.decoding.source, "default");
    const invalid = await read("/invalid");
    assert.equal(invalid.decoding.lossy, true);
    assert.equal(invalid.evidenceReceipt.evidenceKinds.satisfied.includes("source_summary"), false);
    assert.deepEqual(invalid.evidenceReceipt.evidenceKinds.failed, ["source_summary"]);
    assert.match(invalid.evidenceReceipt.caveats.join(" "), /invalid byte sequences/);
    await assert.rejects(read("/unsupported"), /Unsupported web text encoding/);
  } finally { await close(server); }
});

test("webfetch omits binary resources from readable output and records compact evidence", async () => {
  const payload = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00, 0x00, 0x00]);
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/msword" });
    res.end(payload);
  });
  await listen(server);
  const port = (server.address() as AddressInfo).port;
  try {
    const registry = new ToolRegistry(createWebTools({ allowPrivateTargets: true }));
    const allowed = registry.materialize(grant(["webfetch"]));
    const prepared = allowed.prepare({
      id: "fetch-binary",
      name: "webfetch",
      arguments: { url: `http://127.0.0.1:${port}/brief.doc`, format: "markdown" },
    });
    const result = await prepared.tool.execute(grantContext(["webfetch"]), prepared.input) as {
      schema: string;
      content: string;
      bytes: number;
      contentType?: string;
      binary?: boolean;
      sha256?: string;
      truncated: boolean;
      evidenceReceipt: {
        sourceRefs: Array<{ binary?: boolean; contentType?: string; sha256?: string }>;
        evidenceKinds: { satisfied: string[]; caveated: string[]; failed: string[] };
        caveats: string[];
      };
    };

    assert.equal(result.schema, "agentloop.webFetch/v1");
    assert.equal(result.binary, true);
    assert.equal(result.bytes, payload.length);
    assert.equal(result.contentType, "application/msword");
    assert.match(result.content, /Binary web resource omitted/);
    assert.doesNotMatch(result.content, /\u0000|\ufffd\ufffd/);
    assert.equal(result.sha256, createHash("sha256").update(payload).digest("hex"));
    assert.equal(result.truncated, false);
    assert.deepEqual(result.evidenceReceipt.evidenceKinds.satisfied, ["source_urls"]);
    assert.deepEqual(result.evidenceReceipt.evidenceKinds.failed, ["source_summary"]);
    assert.equal(result.evidenceReceipt.sourceRefs[0]?.binary, true);
    assert.equal(result.evidenceReceipt.sourceRefs[0]?.sha256, result.sha256);
    assert.ok(result.evidenceReceipt.caveats.some((caveat) => /binary or non-text/.test(caveat)));
  } finally {
    await close(server);
  }
});

test("webfetch surfaces HTTP errors as a failed tool result", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await listen(server);
  const port = (server.address() as AddressInfo).port;
  try {
    const registry = new ToolRegistry(createWebTools({ allowPrivateTargets: true }));
    const allowed = registry.materialize(grant(["webfetch"]));
    const prepared = allowed.prepare({
      id: "fetch-404",
      name: "webfetch",
      arguments: { url: `http://127.0.0.1:${port}/missing` },
    });
    await assert.rejects(
      () => prepared.tool.execute(grantContext(["webfetch"]), prepared.input),
      (error: unknown) => hasCode(error, "BAD_REQUEST") && error instanceof Error && /HTTP 404/.test(error.message),
    );
  } finally {
    await close(server);
  }
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function grant(toolNames: readonly string[]) {
  return createCapabilityGrant({
    actorUserId: "user", runId: "run", depth: 0,
    workspaceRoot,
    allowedToolNames: toolNames, allowedSkillIds: [],
  });
}

function grantContext(toolNames: readonly string[]) {
  return { grant: grant(toolNames) };
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error
    && (error as { code: unknown }).code === code;
}
