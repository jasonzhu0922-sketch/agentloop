import { AppError, badRequest } from "../shared/errors.ts";
import { requireRecord, requireString } from "../shared/validation.ts";
import type { RuntimeTool } from "../runtime/tool-registry.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESULT_CHARACTERS = 120_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const MAX_FETCH_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 5;
const DEFAULT_SEARCH_RESULTS = 5;
const MAX_SEARCH_RESULTS = 10;
const MAX_TITLE_CHARACTERS = 120;
const MAX_SNIPPET_CHARACTERS = 300;
const QUERY_MIN_CHARACTERS = 2;
const SEARCH_CACHE_MAX_PER_RUN = 24;
const SEARCH_CACHE_MAX_RUNS = 128;

interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

/**
 * Bounded per-run cache keyed by trimmed query + numResults. Identical repeated
 * searches inside one run return the prior result instead of hitting the web
 * again, which caps the wasteful re-search loops the model can fall into.
 */
const searchCacheByRun = new Map<string, Map<string, SearchResult[]>>();

export interface WebToolsOptions {
  /** Upper bound for one web request; defaults to 30s. */
  readonly fetchTimeoutMs?: number;
  /** Result size cap for tool output; defaults to 120000 characters. */
  readonly maxResultCharacters?: number;
  /** User-Agent header sent with requests. */
  readonly userAgent?: string;
  /** Allow loopback/private/link-local targets (used by local tooling and tests). */
  readonly allowPrivateTargets?: boolean;
  /**
   * Search backend for websearch. "baidu" (default) queries Baidu directly and
   * is the right choice for deployments inside mainland China; "bing" uses the
   * Bing RSS feed. Ignored when searchEndpoint is set.
   */
  readonly searchProvider?: "baidu" | "bing";
  /**
   * Optional search API endpoint. When set, websearch POSTs
   * { query, count, numResults } as JSON (Authorization: Bearer searchApiKey
   * when provided) and normalizes the response. Accepts Tavily-style
   * { results: [{ title, url, content }] }, Brave-style { web: [...] },
   * Google-style { organic_results: [...] }, and Bocha-style
   * { data: { webPages: { value: [{ name, url, snippet, summary }] } } }.
   * Defaults to the searchProvider backend otherwise.
   */
  readonly searchEndpoint?: string;
  /** Bearer token sent to searchEndpoint. */
  readonly searchApiKey?: string;
}

export function createWebTools(options: WebToolsOptions = {}): RuntimeTool<unknown>[] {
  const timeoutMs = boundTimeout(options.fetchTimeoutMs);
  return [createFetchTool(options, timeoutMs), createSearchTool(options, timeoutMs)];
}

function createFetchTool(
  options: WebToolsOptions,
  timeoutMs: number,
): RuntimeTool<{ url: string; format: "markdown" | "text" }> {
  return {
    name: "webfetch",
    description: [
      "Fetch a web page by URL and return its readable content as markdown (default) or plain text.",
      "Follows redirects including JavaScript and meta-refresh redirects; returns { url, title, content, bytes, truncated }.",
      "Prefer this over computer_run_command + curl for reading articles, documentation, or search result pages.",
    ].join(" "),
    inputSchema: objectSchema(["url"], {
      url: { type: "string" },
      format: { type: "string", enum: ["markdown", "text"] },
    }),
    executionMode: "parallel",
    replaySafe: true,
    timeoutMs,
    maxResultCharacters: options.maxResultCharacters ?? DEFAULT_MAX_RESULT_CHARACTERS,
    parse: (value) => {
      const record = requireRecord(value, "webfetch arguments");
      const url = requireString(record.url, "url", { max: 8_000 });
      assertSafeTarget(url, options.allowPrivateTargets === true);
      const format = record.format === undefined ? "markdown" : record.format;
      if (format !== "markdown" && format !== "text") {
        throw badRequest('format must be either "markdown" or "text"');
      }
      return { url, format };
    },
    execute: async (_context, value) => fetchWebPage(value.url, value.format, options, timeoutMs),
  };
}

function createSearchTool(
  options: WebToolsOptions,
  timeoutMs: number,
): RuntimeTool<{ query: string; numResults: number }> {
  return {
    name: "websearch",
    description: [
      "Search the web and return structured results as an array of { title, url, snippet } objects.",
      "Search once with a complete query phrase reflecting the user's intent; do not re-search by splitting single words or characters out of result titles.",
      "The snippet is enough to judge relevance; for broader coverage raise numResults (up to 10) in one search instead of repeating it.",
      "Prefer webfetch on the returned URLs to read full article text, and avoid repeated searches on the same topic.",
      "Prefer this over computer_run_command + curl for research.",
    ].join(" "),
    inputSchema: objectSchema(["query"], {
      query: { type: "string", maxLength: 512 },
      numResults: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS },
    }),
    executionMode: "parallel",
    replaySafe: true,
    timeoutMs,
    parse: (value) => {
      const record = requireRecord(value, "websearch arguments");
      const query = requireString(record.query, "query", { max: 512 });
      const numResults = record.numResults === undefined ? DEFAULT_SEARCH_RESULTS : record.numResults;
      if (!Number.isSafeInteger(numResults) || (numResults as number) < 1 || (numResults as number) > MAX_SEARCH_RESULTS) {
        throw badRequest(`numResults must be an integer between 1 and ${MAX_SEARCH_RESULTS}`);
      }
      return { query, numResults: numResults as number };
    },
    execute: async (context, value) =>
      executeSearch(context.grant.runId, value.query, value.numResults, options, timeoutMs),
  };
}

async function fetchWebPage(
  url: string,
  format: "markdown" | "text",
  options: WebToolsOptions,
  timeoutMs: number,
): Promise<{ url: string; title: string | undefined; content: string; bytes: number; truncated: boolean }> {
  let current = url;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    const fetched = await httpGet(current, options, timeoutMs);
    const redirectTarget = extractRedirectTarget(fetched.html);
    if (redirectTarget !== undefined) {
      current = new URL(redirectTarget, fetched.url).toString();
      continue;
    }
    return {
      url: fetched.url,
      title: extractTitle(fetched.html),
      content: format === "markdown" ? htmlToMarkdown(fetched.html) : htmlToText(fetched.html),
      bytes: fetched.html.length,
      truncated: fetched.truncated,
    };
  }
  throw badRequest(`Too many redirects while fetching ${url}`);
}

async function executeSearch(
  runId: string,
  query: string,
  numResults: number,
  options: WebToolsOptions,
  timeoutMs: number,
): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < QUERY_MIN_CHARACTERS) {
    throw badRequest(
      `websearch query must contain at least ${QUERY_MIN_CHARACTERS} characters; write a complete query phrase reflecting the user's intent instead of a short fragment`,
    );
  }
  const key = `${trimmed}\u0000${numResults}`;
  let runCache = searchCacheByRun.get(runId);
  if (runCache === undefined) {
    if (searchCacheByRun.size >= SEARCH_CACHE_MAX_RUNS) {
      const oldestRun = searchCacheByRun.keys().next().value as string;
      searchCacheByRun.delete(oldestRun);
    }
    runCache = new Map();
    searchCacheByRun.set(runId, runCache);
  }
  const cached = runCache.get(key);
  if (cached !== undefined) return cached;
  const results = await searchWeb(trimmed, numResults, options, timeoutMs);
  if (runCache.size >= SEARCH_CACHE_MAX_PER_RUN) {
    const oldestQuery = runCache.keys().next().value as string;
    runCache.delete(oldestQuery);
  }
  runCache.set(key, results);
  return results;
}

async function searchWeb(
  query: string,
  numResults: number,
  options: WebToolsOptions,
  timeoutMs: number,
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  if (options.searchEndpoint !== undefined) {
    return searchViaEndpoint(query, numResults, options, timeoutMs);
  }
  if (options.searchProvider !== "bing") {
    const baiduUrl = `https://www.baidu.com/s?ie=utf-8&rn=${numResults}&wd=${encodeURIComponent(query)}`;
    const baiduFetched = await httpGet(baiduUrl, options, timeoutMs);
    const baiduResults = parseBaiduResults(baiduFetched.html);
    if (!isBaiduVerification(baiduFetched.html) && baiduResults.length > 0) {
      return baiduResults.slice(0, numResults);
    }
  }
  const bingUrl =
    `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}&setlang=zh-CN&cc=CN&mkt=zh-CN`;
  const bingFetched = await httpGet(bingUrl, options, timeoutMs);
  return parseRssItems(bingFetched.html)
    .filter((item) => item.link.length > 0)
    .slice(0, numResults)
    .map((item) => ({
      title: item.title.slice(0, MAX_TITLE_CHARACTERS),
      url: item.link,
      snippet: item.description.slice(0, MAX_SNIPPET_CHARACTERS),
    }));
}

export function isBaiduVerification(html: string): boolean {
  return /百度安全验证|百度安全|安全验证|验证码/.test(html) || html.length < 16_000;
}

async function searchViaEndpoint(
  query: string,
  numResults: number,
  options: WebToolsOptions,
  timeoutMs: number,
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(options.searchEndpoint as string, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.searchApiKey === undefined ? {} : { Authorization: `Bearer ${options.searchApiKey}` }),
      },
      body: JSON.stringify({ query, count: numResults, numResults, num_results: numResults, max_results: numResults }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw badRequest(`Search endpoint returned HTTP ${response.status}`);
    }
    const payload: unknown = await response.json();
    return normalizeSearchPayload(payload, numResults);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "TOOL_EXECUTION_ERROR",
      `Search request failed: ${error instanceof Error ? error.message : "unknown error"}`,
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeSearchPayload(
  payload: unknown,
  numResults: number,
): Array<{ title: string; url: string; snippet: string }> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  let source: unknown = record.results;
  if (source === undefined) {
    const web = record.web;
    if (web !== undefined && typeof web === "object" && !Array.isArray(web)) {
      source = (web as Record<string, unknown>).results;
    } else {
      source = web;
    }
  }
  if (source === undefined) source = record.organic_results;
  if (source === undefined && record.data !== null && typeof record.data === "object" && !Array.isArray(record.data)) {
    const data = record.data as Record<string, unknown>;
    source = data.web ?? data.webPages;
    if (source !== undefined && typeof source === "object" && !Array.isArray(source)) {
      source = (source as Record<string, unknown>).value;
    }
  }
  if (!Array.isArray(source)) return [];
  return source.slice(0, numResults).flatMap((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
    const result = item as Record<string, unknown>;
    const title = (asSearchString(result.title) ?? asSearchString(result.name) ?? "").slice(0, MAX_TITLE_CHARACTERS);
    const url = asSearchString(result.url) ?? asSearchString(result.link);
    if (url === undefined && title === undefined) return [];
    const snippet = ((asSearchString(result.snippet) ?? asSearchString(result.content) ?? asSearchString(result.summary) ?? "")).slice(0, MAX_SNIPPET_CHARACTERS);
    return [{ title, url: url ?? "", snippet }];
  });
}

function asSearchString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseBaiduResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  interface Block {
    start: number;
    end: number;
    title: string;
    url: string;
  }
  const blocks: Block[] = [];
  const heading = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  let match: RegExpExecArray | null;
  while ((match = heading.exec(html)) !== null) {
    const anchor = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(match[1]);
    if (anchor === null) continue;
    const title = cleanInner(anchor[2]);
    if (title.length === 0) continue;
    const url = decodeHtmlEntities(anchor[1]).trim();
    if (!/^https?:\/\//i.test(url)) continue;
    blocks.push({ start: match.index, end: heading.lastIndex, title, url });
  }
  return blocks.map((block, index) => {
    const nextStart = index + 1 < blocks.length ? blocks[index + 1].start : html.length;
    const between = html.slice(block.end, nextStart);
    return {
      title: block.title,
      url: block.url,
      snippet: trimBaiduNoise(cleanInner(between)).slice(0, 300),
    };
  });
}

function trimBaiduNoise(text: string): string {
  const match = /,?"(?:clamp|summarySpan|isSingleLine|isPc|pageStyleUpgrade|consistencyUpgrade|titleSummary|summaryGap|rate|rateText|rate-text)[",:]/.exec(text);
  return match === null ? text : text.slice(0, match.index);
}

async function httpGet(
  url: string,
  options: WebToolsOptions,
  timeoutMs: number,
): Promise<{ html: string; url: string; truncated: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw badRequest(`HTTP ${response.status} while fetching ${url}`);
    const { text, truncated } = await readBoundedText(response, MAX_FETCH_BYTES);
    return { html: text, url: response.url, truncated };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new AppError("TOOL_EXECUTION_ERROR", `Request to ${url} timed out after ${timeoutMs}ms`, 408);
    }
    throw new AppError(
      "TOOL_EXECUTION_ERROR",
      `Request to ${url} failed: ${error instanceof Error ? error.message : "unknown error"}`,
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const text = await response.text();
    return { text: text.slice(0, maxBytes), truncated: text.length > maxBytes };
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received < maxBytes) {
    const { done, value } = await reader.read();
    if (done || value === undefined) break;
    const slice = value.byteLength <= maxBytes - received ? value : value.slice(0, maxBytes - received);
    chunks.push(slice);
    received += slice.byteLength;
    if (received >= maxBytes) break;
  }
  await reader.cancel().catch(() => undefined);
  const combined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(combined), truncated: received >= maxBytes };
}

interface RssItem {
  title: string;
  link: string;
  description: string;
}

export function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemPattern.exec(xml)) !== null) {
    const body = match[1];
    const title = decodeHtmlEntities(stripTags(stripCData(extractTag(body, "title") ?? "")));
    const link = stripTags(stripCData(extractTag(body, "link") ?? "")).trim();
    const description = decodeHtmlEntities(stripTags(stripCData(extractTag(body, "description") ?? "")));
    if (title.length === 0 && link.length === 0) continue;
    items.push({ title, link, description });
  }
  return items;
}

function extractTag(body: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(body);
  return match === null ? undefined : match[1];
}

function stripCData(value: string): string {
  return value.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
}

function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (match === null) return undefined;
  const title = decodeHtmlEntities(stripTags(match[1]));
  return title.length === 0 ? undefined : title;
}

export function extractRedirectTarget(html: string): string | undefined {
  const jsReplace = /window\.location\.(?:replace|assign)\(\s*["']([^"']+)["']\s*\)/i.exec(html);
  if (jsReplace !== null) return jsReplace[1];
  const jsHref = /window\.location\.href\s*=\s*["']([^"']+)["']/i.exec(html);
  if (jsHref !== null) return jsHref[1];
  const metaPattern = /<meta\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = metaPattern.exec(html)) !== null) {
    const tag = match[0];
    if (!/refresh/i.test(tag)) continue;
    const content = /content=(["'])([\s\S]*?)\1/i.exec(tag);
    if (content === null) continue;
    const urlMatch = /(?:^|;)\s*url\s*=\s*["']?([^"'\s;]+)/i.exec(content[2]);
    if (urlMatch !== null) return urlMatch[1];
  }
  return undefined;
}

const NOISE_PATTERN =
  /<(?:script|style|noscript|template|iframe|svg|head|header|nav|footer|aside|form|figure|figcaption|caption|datalist|optgroup|option)[^>]*>[\s\S]*?<\/(?:script|style|noscript|template|iframe|svg|head|header|nav|footer|aside|form|figure|figcaption|caption|datalist|optgroup|option)>/gi;

export function htmlToMarkdown(html: string): string {
  let text = html;
  text = text.replace(NOISE_PATTERN, " ");
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, inner) => {
    const content = cleanInner(String(inner));
    return content.length === 0 ? "\n" : `${"#".repeat(Number(level))} ${content}\n`;
  });
  text = text.replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, inner) => {
    const content = cleanInner(String(inner));
    return content.length === 0 ? "" : `[${content}](${String(href).trim()})`;
  });
  text = text.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*>/gi, (_match, alt) => {
    const content = cleanInner(String(alt));
    return content.length === 0 ? "" : `![${content}]()`;
  });
  text = text.replace(/<(br|hr|\/p|\/div|\/h[1-6]|\/li|\/tr|\/blockquote|\/section|\/article|\/ul|\/ol|\/table|\/pre)[^>]*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeHtmlEntities(text);
  return normalizeLines(text);
}

function htmlToText(html: string): string {
  let text = html;
  text = text.replace(NOISE_PATTERN, " ");
  text = text.replace(/<(br|hr|\/p|\/div|\/h[1-6]|\/li|\/tr|\/blockquote|\/section|\/article|\/ul|\/ol|\/table|\/pre)[^>]*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeHtmlEntities(text);
  return normalizeLines(text);
}

function cleanInner(html: string): string {
  return decodeHtmlEntities(stripTags(html.replace(NOISE_PATTERN, " ")));
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": "\"",
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&copy;": "\u00a9",
  "&reg;": "\u00ae",
  "&trade;": "\u2122",
  "&hellip;": "\u2026",
  "&mdash;": "\u2014",
  "&ndash;": "\u2013",
  "&middot;": "\u00b7",
  "&bull;": "\u2022",
  "&times;": "\u00d7",
  "&divide;": "\u00f7",
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match) => {
    let code: number;
    if (match.startsWith("&#x") || match.startsWith("&#X")) {
      code = Number.parseInt(match.slice(3, -1), 16);
    } else if (match.startsWith("&#")) {
      code = Number.parseInt(match.slice(2, -1), 10);
    } else {
      return NAMED_ENTITIES[match] ?? match;
    }
    if (Number.isNaN(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return match;
    return String.fromCodePoint(code);
  });
}

function assertSafeTarget(value: string, allowPrivate: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw badRequest("url must be a valid absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw badRequest("url must use http or https");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw badRequest("url must not contain embedded credentials");
  }
  if (!allowPrivate && isPrivateAddress(parsed.hostname)) {
    throw badRequest("url must not target a loopback, private, or link-local address");
  }
}

function isPrivateAddress(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  if (lower.includes(":")) {
    if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
    if (lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    return false;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(lower)) {
    const [first, second] = lower.split(".").map((part) => Number(part));
    return first === 10 || first === 127 || (first === 169 && second === 254)
      || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31);
  }
  return false;
}

function boundTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new TypeError(`fetchTimeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

function objectSchema(required: readonly string[], properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", additionalProperties: false, required, properties };
}
