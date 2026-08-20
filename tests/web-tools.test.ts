import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { ToolRegistry } from "../src/runtime/tool-registry.ts";
import {
  createWebTools,
  extractRedirectTarget,
  htmlToMarkdown,
  isBaiduVerification,
  normalizeSearchPayload,
  parseBaiduResults,
  parseRssItems,
} from "../src/web/web-tools.ts";

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
      return prepared.tool.execute(grantContext(["websearch"]), prepared.input) as Promise<Array<{ title: string }>>;
    };
    await assert.rejects(
      () => execute("宝"),
      (error: unknown) => hasCode(error, "BAD_REQUEST") && error instanceof Error && /at least 2 characters/.test(error.message),
    );
    const first = await execute("中国宝武 数据底座");
    assert.equal(first.length, 1);
    assert.equal(hits, 1);
    await execute("中国宝武 数据底座");
    assert.equal(hits, 1, "a repeated identical query within the same run must hit the per-run cache");
  } finally {
    await close(server);
  }
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
      url: string;
      title: string | undefined;
      content: string;
      bytes: number;
      truncated: boolean;
    };
    assert.equal(result.title, "宝武发布");
    assert.ok(result.url.endsWith("/target"));
    assert.match(result.content, /数据底座与超级智能体/);
    assert.match(result.content, /8 月 30 日/);
    assert.equal(result.truncated, false);
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
