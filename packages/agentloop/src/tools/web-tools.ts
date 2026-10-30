import { createHash } from "node:crypto";
import { AppError, badRequest, forbidden } from "../shared/errors.ts";
import { ComputerExecutor } from "../computer/computer-executor.ts";
import { contentStructure, type ContentReference } from "../runtime/content-reference.ts";
import { requireRecord, requireString } from "../shared/validation.ts";
import type { RuntimeTool } from "./tool-registry.ts";

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
  readonly qualitySignals?: readonly string[];
  readonly discoveryOnly?: boolean;
}

interface WebSearchResult {
  readonly schema: "agentloop.webSearch/v1";
  readonly query: string;
  readonly backend: WebSearchBackend;
  readonly returned: number;
  readonly results: readonly SearchResult[];
  readonly evidenceReceipt: WebToolEvidenceReceipt;
}

interface WebFetchResult {
  readonly schema: "agentloop.webFetch/v1";
  readonly url: string;
  readonly title: string | undefined;
  readonly content: string;
  readonly contentLocation?: ContentReference;
  readonly contentSummary?: Record<string, unknown>;
  readonly bytes: number;
  readonly contentType?: string;
  readonly binary?: boolean;
  readonly decoding?: WebTextDecoding;
  readonly sha256?: string;
  readonly truncated: boolean;
  readonly evidenceReceipt: WebToolEvidenceReceipt;
}

interface WebTextDecoding {
  readonly encoding: string;
  readonly source: "bom" | "http_header" | "document" | "default";
  readonly replacementCharacters: number;
  readonly lossy: boolean;
}

interface WebToolEvidenceReceipt {
  readonly schema: "agentloop.toolEvidenceReceipt/v1";
  readonly sourceType: "web_search" | "web_page";
  readonly backend?: WebSearchBackend;
  readonly receiptId: string;
  readonly sourceRefs: readonly Record<string, unknown>[];
  readonly facts: readonly Record<string, unknown>[];
  readonly caveats: readonly string[];
  readonly evidenceKinds: {
    readonly satisfied: readonly string[];
    readonly caveated: readonly string[];
    readonly failed: readonly string[];
  };
}

type WebSearchBackend = "bocha" | "custom_endpoint" | "baidu" | "bing";

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
   * Search backend for websearch. "baidu" (default) queries Baidu directly,
   * "bing" uses the Bing RSS feed, and "bocha" uses the Bocha API contract.
   * When searchEndpoint is set, the endpoint remains authoritative; provider
   * selects its request/response contract and is otherwise inferred from the
   * api.bochaai.com hostname.
   */
  readonly searchProvider?: "bocha" | "baidu" | "bing";
  /**
   * Optional search API endpoint. When set, websearch POSTs
   * { query, count, numResults } as JSON (Authorization: Bearer searchApiKey
   * when provided) and normalizes the response. Bocha endpoints instead use
   * { query, count, freshness, summary }. Accepts Tavily-style
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
      "Fetch a web page by URL and return readable content plus a canonical evidenceReceipt.",
      "Follows redirects including JavaScript and meta-refresh redirects; returns { schema, url, title, content, bytes, truncated, evidenceReceipt }.",
      "Prefer this over computer_run_command + curl for reading articles, documentation, or search result pages.",
      "Readable content is saved as an immutable contentLocation with sha256 and a structural summary; read that reference for omitted details instead of fetching again.",
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
    execute: async (context, value) => {
      const root = context.grant.workspaceRoot;
      if (root === undefined) throw forbidden("webfetch requires a Run workspace for durable content references");
      const result = await fetchWebPage(value.url, value.format, options, timeoutMs);
      if (result.binary) return result;
      const contentLocation = await new ComputerExecutor(root).storeContentReference(result.content);
      return { ...result, contentLocation, contentSummary: contentStructure(result.content) };
    },
  };
}

function createSearchTool(
  options: WebToolsOptions,
  timeoutMs: number,
): RuntimeTool<{ query: string; numResults: number }> {
  return {
    name: "websearch",
    description: [
      "Search the web and return structured results plus a canonical evidenceReceipt.",
      "Returns { schema, query, returned, results: [{ title, url, snippet }], evidenceReceipt }.",
      "Decompose multi-fact research into claim-specific queries containing the exact entities, relationship terms, dates, or source roles needed for that claim; for relationship claims add provenance cues such as interview, autobiography, profile, or independent report. Never search a placeholder such as 'keywords' or a single token extracted from a result title.",
      "Search once with a complete query phrase reflecting the user's intent; do not re-search by splitting single words or characters out of result titles.",
      "The snippet is enough to judge relevance; for broader coverage raise numResults (up to 10) in one search instead of repeating it.",
      "Results marked discoveryOnly or carrying qualitySignals such as qa_or_aggregator are leads only; prefer readable primary, institutional, or reputable media pages for factual claims and do not treat a search snippet as source_summary.",
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
): Promise<WebFetchResult> {
  let current = url;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    const fetched = await httpGet(current, options, timeoutMs);
    if (fetched.binary) {
      const result = {
        schema: "agentloop.webFetch/v1" as const,
        url: fetched.url,
        title: undefined,
        content: [
          `[Binary web resource omitted from readable fetch output; url=${fetched.url};`,
          `contentType=${fetched.contentType ?? "unknown"}; bytes=${fetched.bytes};`,
          `sha256=${fetched.sha256}; truncated=${fetched.truncated}]`,
        ].join(" "),
        bytes: fetched.bytes,
        ...(fetched.contentType === undefined ? {} : { contentType: fetched.contentType }),
        binary: true,
        sha256: fetched.sha256,
        truncated: fetched.truncated,
      };
      return { ...result, evidenceReceipt: webFetchReceipt(result) };
    }
    const isHtml = /\b(?:text\/html|application\/xhtml\+xml)\b/i.test(fetched.contentType ?? "");
    const redirectTarget = isHtml ? extractRedirectTarget(fetched.html) : undefined;
    if (redirectTarget !== undefined) {
      current = new URL(redirectTarget, fetched.url).toString();
      continue;
    }
    // JSON and plain text are already readable. HTML conversion would corrupt
    // literal tags/entities inside structured values before snapshotting them.
    const content = isHtml
      ? format === "markdown" ? htmlToMarkdown(fetched.html) : htmlToText(fetched.html)
      : fetched.html;
    const result = {
      schema: "agentloop.webFetch/v1" as const,
      url: fetched.url,
      title: extractTitle(fetched.html),
      content,
      bytes: fetched.bytes,
      ...(fetched.contentType === undefined ? {} : { contentType: fetched.contentType }),
      binary: false,
      decoding: fetched.decoding,
      sha256: fetched.sha256,
      truncated: fetched.truncated,
    };
    return { ...result, evidenceReceipt: webFetchReceipt(result) };
  }
  throw badRequest(`Too many redirects while fetching ${url}`);
}

async function executeSearch(
  runId: string,
  query: string,
  numResults: number,
  options: WebToolsOptions,
  timeoutMs: number,
): Promise<WebSearchResult> {
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
  const backend = searchBackend(options);
  const cached = runCache.get(key);
  if (cached !== undefined) return webSearchResult(trimmed, cached, backend);
  const results = annotateSearchResults(await searchWeb(trimmed, numResults, options, timeoutMs));
  if (runCache.size >= SEARCH_CACHE_MAX_PER_RUN) {
    const oldestQuery = runCache.keys().next().value as string;
    runCache.delete(oldestQuery);
  }
  runCache.set(key, results);
  return webSearchResult(trimmed, results, backend);
}

function annotateSearchResults(results: readonly SearchResult[]): SearchResult[] {
  return results.map((result) => {
    const haystack = `${result.url} ${result.title} ${result.snippet}`.toLocaleLowerCase();
    const qualitySignals = [
      /(?:wenwen|iask|zhidao|know|question|ask\.|qa[./])/u.test(haystack) ? "qa_or_aggregator" : undefined,
      /(?:baike|encyclopedia|词典|百科)/u.test(haystack) ? "reference_or_dictionary" : undefined,
      /(?:copy|转载|聚合|摘编|小编)/u.test(haystack) ? "copied_or_aggregated" : undefined,
    ].filter((value): value is string => value !== undefined);
    if (qualitySignals.length === 0) return result;
    return { ...result, qualitySignals, discoveryOnly: true };
  });
}

function searchBackend(options: WebToolsOptions): WebSearchBackend {
  if (options.searchEndpoint !== undefined) {
    return options.searchProvider === "bocha" || isBochaEndpoint(options.searchEndpoint)
      ? "bocha"
      : "custom_endpoint";
  }
  return options.searchProvider === "bing" ? "bing" : "baidu";
}

function isBochaEndpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint).hostname.toLowerCase() === "api.bochaai.com";
  } catch {
    return false;
  }
}

function webSearchResult(query: string, results: readonly SearchResult[], backend: WebSearchBackend): WebSearchResult {
  return {
    schema: "agentloop.webSearch/v1",
    query,
    backend,
    returned: results.length,
    results,
    evidenceReceipt: webSearchReceipt(query, results, backend),
  };
}

function webSearchReceipt(query: string, results: readonly SearchResult[], backend: WebSearchBackend): WebToolEvidenceReceipt {
  const sourceRefs = results.map((result) => webSourceRef(result.url, {
    title: result.title,
    snippetCharacters: result.snippet.length,
    ...(result.qualitySignals === undefined ? {} : { qualitySignals: result.qualitySignals }),
    ...(result.discoveryOnly === undefined ? {} : { discoveryOnly: result.discoveryOnly }),
  }));
  const failed = results.length === 0 ? ["source_urls"] : [];
  return buildWebToolEvidenceReceipt({
    sourceType: "web_search",
    backend,
    sourceRefs,
    facts: [{
      kind: "source_urls",
      query,
      returned: results.length,
      discoveryOnlyCount: results.filter((result) => result.discoveryOnly === true).length,
      urls: results.map((result) => ({ title: result.title, url: result.url })),
    }],
    caveats: [
      "Search results are discovery metadata; fetch source URLs before treating snippets as verified source facts.",
    ],
    satisfied: results.length === 0 ? [] : ["source_urls"],
    failed,
  });
}

function webFetchReceipt(result: Omit<WebFetchResult, "evidenceReceipt">): WebToolEvidenceReceipt {
  const contentSha256 = result.sha256 ?? createHash("sha256").update(result.content).digest("hex");
  const readable = result.binary !== true && result.decoding?.lossy !== true;
  return buildWebToolEvidenceReceipt({
    sourceType: "web_page",
    sourceRefs: [webSourceRef(result.url, {
      title: result.title,
      bytes: result.bytes,
      characters: result.content.length,
      contentType: result.contentType,
      binary: result.binary,
      sha256: contentSha256,
      truncated: result.truncated,
      decoding: result.decoding,
    })],
    facts: [{
      kind: "source_summary",
      url: result.url,
      title: result.title,
      characters: result.content.length,
      bytes: result.bytes,
      contentType: result.contentType,
      binary: result.binary,
      sha256: contentSha256,
      truncated: result.truncated,
      decoding: result.decoding,
      textPreview: result.content.slice(0, 800),
    }],
    caveats: [
      "Full Tool result remains in canonical events; model context may receive only this structured receipt.",
      ...(result.binary === true ? ["Fetched resource is binary or non-text; readable page content was not extracted."] : []),
      ...(result.decoding?.lossy === true ? ["Text decoding encountered invalid byte sequences. The extracted text is incomplete evidence; do not infer facts from corrupted characters. Use another readable source."] : []),
      ...(result.truncated ? ["Web page read was truncated; fetch a narrower source before citing omitted text."] : []),
    ],
    satisfied: readable ? ["source_read", "source_summary", "source_urls"] : ["source_urls"],
    failed: readable ? [] : ["source_summary"],
  });
}

function webSourceRef(url: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    sourceRefId: `web:${createHash("sha256").update(url).digest("hex")}`,
    url,
    path: url,
    ...omitUndefined(extra),
  };
}

function buildWebToolEvidenceReceipt(input: {
  readonly sourceType: "web_search" | "web_page";
  readonly backend?: WebSearchBackend;
  readonly sourceRefs: readonly Record<string, unknown>[];
  readonly facts: readonly Record<string, unknown>[];
  readonly caveats: readonly string[];
  readonly satisfied: readonly string[];
  readonly failed?: readonly string[];
}): WebToolEvidenceReceipt {
  const material = JSON.stringify({
    sourceType: input.sourceType,
    backend: input.backend,
    sourceRefs: input.sourceRefs,
    facts: input.facts,
    caveats: input.caveats,
    failed: input.failed ?? [],
  });
  return {
    schema: "agentloop.toolEvidenceReceipt/v1",
    sourceType: input.sourceType,
    ...(input.backend === undefined ? {} : { backend: input.backend }),
    receiptId: createHash("sha256").update(material).digest("hex"),
    sourceRefs: input.sourceRefs,
    facts: input.facts,
    caveats: input.caveats,
    evidenceKinds: {
      satisfied: input.satisfied,
      caveated: input.caveats.length === 0 ? [] : ["explicit_caveats"],
      failed: input.failed ?? [],
    },
  };
}

function omitUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
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
    assertReadableSearchResponse(baiduFetched);
    const baiduResults = parseBaiduResults(baiduFetched.html);
    if (!isBaiduVerification(baiduFetched.html) && baiduResults.length > 0) {
      return baiduResults.slice(0, numResults);
    }
  }
  const bingUrl =
    `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}&setlang=zh-CN&cc=CN&mkt=zh-CN`;
  const bingFetched = await httpGet(bingUrl, options, timeoutMs);
  assertReadableSearchResponse(bingFetched);
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
    const bocha = options.searchProvider === "bocha" || isBochaEndpoint(options.searchEndpoint as string);
    const response = await fetch(options.searchEndpoint as string, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.searchApiKey === undefined ? {} : { Authorization: `Bearer ${options.searchApiKey}` }),
      },
      body: JSON.stringify(bocha
        ? { query, count: numResults, freshness: "noLimit", summary: true }
        : { query, count: numResults, numResults, num_results: numResults, max_results: numResults }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw badRequest(`Search endpoint returned HTTP ${response.status}`);
    }
    const { bytes, truncated } = await readBoundedBytes(response, MAX_FETCH_BYTES);
    if (truncated) throw new AppError("TOOL_EXECUTION_ERROR", "Search response exceeded the readable byte limit", 422);
    const decoded = decodeWebText(bytes, response.headers.get("content-type") ?? undefined);
    assertReadableSearchResponse({ binary: false, decoding: decoded.decoding });
    const payload: unknown = JSON.parse(decoded.text);
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

function assertReadableSearchResponse(response: { binary: boolean; decoding?: WebTextDecoding }): void {
  if (response.binary || response.decoding?.lossy === true) {
    throw new AppError("TOOL_EXECUTION_ERROR", "Search response could not be decoded as readable text", 422);
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
): Promise<{
  html: string;
  url: string;
  bytes: number;
  contentType?: string;
  binary: boolean;
  decoding?: WebTextDecoding;
  sha256: string;
  truncated: boolean;
}> {
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
    const contentType = response.headers.get("content-type") ?? undefined;
    const { bytes, truncated } = await readBoundedBytes(response, MAX_FETCH_BYTES);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const binary = isBinaryResponse(contentType, bytes);
    const decoded = binary ? undefined : decodeWebText(bytes, contentType);
    return { html: decoded?.text ?? "", url: response.url, bytes: bytes.byteLength, contentType, binary, sha256, truncated,
      ...(decoded === undefined ? {} : { decoding: decoded.decoding }) };
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

/** Decode bytes before HTML extraction; never guess a second encoding after data loss. */
function decodeWebText(bytes: Uint8Array, contentType: string | undefined): { text: string; decoding: WebTextDecoding } {
  let encoding: string | undefined;
  let source: WebTextDecoding["source"] = "default";
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) encoding = "utf-8";
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  if (encoding !== undefined) source = "bom";
  else {
    encoding = declaredCharset(contentType ?? "");
    if (encoding !== undefined) source = "http_header";
    else if (/\b(?:html|xml)\b/i.test(contentType ?? "")) {
      // Encoding labels are ASCII even when the document body is not UTF-8.
      const prefix = new TextDecoder("windows-1252").decode(bytes.slice(0, 1024));
      for (const tag of prefix.match(/<meta\b[^>]*>/gi) ?? []) {
        encoding = declaredCharset(tag);
        if (encoding !== undefined) break;
      }
      encoding ??= /<\?xml\b[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(prefix)?.[1];
      if (encoding !== undefined) source = "document";
    }
  }
  encoding ??= "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(encoding, { fatal: true });
  } catch {
    throw new AppError("TOOL_EXECUTION_ERROR", `Unsupported web text encoding: ${encoding} (${source})`, 422);
  }
  let text: string;
  let lossy = false;
  try {
    text = decoder.decode(bytes);
  } catch {
    lossy = true;
    text = new TextDecoder(encoding).decode(bytes);
  }
  return { text, decoding: { encoding: decoder.encoding, source, lossy,
    replacementCharacters: text.match(/\ufffd/gu)?.length ?? 0 } };
}

function declaredCharset(value: string): string | undefined {
  return /\bcharset\s*=\s*["']?\s*([^\s;"'/>]+)/i.exec(value)?.[1];
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      bytes: bytes.byteLength <= maxBytes ? bytes : bytes.slice(0, maxBytes),
      truncated: bytes.byteLength > maxBytes,
    };
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
  return { bytes: combined, truncated: received >= maxBytes };
}

function isBinaryResponse(contentType: string | undefined, bytes: Uint8Array): boolean {
  const normalized = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (normalized.length > 0) {
    if (
      normalized.startsWith("text/")
      || normalized === "application/json"
      || normalized.endsWith("+json")
      || normalized === "application/xml"
      || normalized.endsWith("+xml")
      || normalized === "application/xhtml+xml"
      || normalized === "application/javascript"
      || normalized === "application/x-javascript"
    ) {
      return false;
    }
    if (
      normalized.startsWith("image/")
      || normalized.startsWith("audio/")
      || normalized.startsWith("video/")
      || normalized.startsWith("font/")
      || normalized === "application/pdf"
      || normalized === "application/msword"
      || normalized === "application/octet-stream"
      || normalized.startsWith("application/vnd.")
    ) {
      return true;
    }
  }
  const sample = bytes.slice(0, Math.min(bytes.byteLength, 512));
  if (sample.byteLength === 0) return false;
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control += 1;
  }
  return control / sample.byteLength > 0.08;
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
  // Only inspect executable script blocks. Scanning the whole HTML makes a
  // normal click handler such as `onclick="window.location.href='next.html'"`
  // look like an automatic page-load redirect.
  const scriptPattern = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let scriptMatch: RegExpExecArray | null;
  while ((scriptMatch = scriptPattern.exec(html)) !== null) {
    const script = scriptMatch[1];
    // A location assignment inside an event handler is user-initiated, not a
    // redirect of the fetched document. Keep the static detector conservative
    // rather than following arbitrary page interactions.
    if (/\b(?:function|addEventListener|onclick|onload|setTimeout|setInterval)\b/i.test(script)) continue;
    const jsReplace = /window\.location\.(?:replace|assign)\(\s*["']([^"']+)["']\s*\)/i.exec(script);
    if (jsReplace !== null) return jsReplace[1];
    const jsHref = /window\.location\.href\s*=\s*["']([^"']+)["']/i.exec(script);
    if (jsHref !== null) return jsHref[1];
  }
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
