#!/usr/bin/env node
// AIHOT Skill-owned query boundary.  It translates only the public v1 items
// contract into an auditable Runtime receipt; it does not infer news content.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const API_ORIGIN = "https://aihot.news";
const MONTHLY_URL = "https://aihot.news/monthly";
const VALID_WINDOWS = new Set(["24h", "7d"]);
const VALID_MODES = new Set(["selected", "all"]);
const ACTOR_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function fail(message, details = undefined) {
  process.stderr.write(`${message}${details === undefined ? "" : `: ${JSON.stringify(details)}`}\n`);
  process.exitCode = 1;
}

function parseOptions(values) {
  const options = { mode: "selected", window: undefined, limit: 10, q: undefined, category: undefined, by: "timeline" };
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (value === undefined || !flag?.startsWith("--")) throw new TypeError(`Expected --name value, got ${flag ?? "<end>"}`);
    if (flag === "--mode") options.mode = value;
    else if (flag === "--window") options.window = value;
    else if (flag === "--limit") options.limit = Number(value);
    else if (flag === "--q") options.q = value;
    else if (flag === "--category") options.category = value;
    else if (flag === "--by") options.by = value;
    else throw new TypeError(`Unknown option: ${flag}`);
  }
  if (!VALID_MODES.has(options.mode)) throw new TypeError("--mode must be selected or all");
  if (!VALID_WINDOWS.has(options.window)) throw new TypeError("--window must be 24h or 7d; a month must use month-boundary");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50) throw new TypeError("--limit must be an integer from 1 to 50");
  if (options.by !== "timeline" && options.by !== "published") throw new TypeError("--by must be timeline or published");
  return options;
}

function sourceReference(item) {
  const aihot = item?.links?.aihot;
  return typeof aihot === "string" && aihot.startsWith(`${API_ORIGIN}/`)
    ? { uri: aihot, title: typeof item.title === "string" ? item.title : "AIHOT item" }
    : undefined;
}

async function userAgent() {
  const root = process.env.AGENTLOOP_SKILL_ROOT_AIHOT ?? process.cwd();
  const actor = await readFile(resolve(root, ".aihot-actor-id"), "utf8")
    .then((value) => value.trim())
    .catch(() => undefined);
  const suffix = actor !== undefined && ACTOR_ID_PATTERN.test(actor) ? ` aihot-actor/${actor.toLowerCase()}` : "";
  return `aihot-skill/1.7.0 (+https://aihot.news/aihot-skill/)${suffix}`;
}

async function items(values) {
  const options = parseOptions(values);
  const url = new URL("/api/v1/items", API_ORIGIN);
  url.searchParams.set("mode", options.mode);
  url.searchParams.set("window", options.window);
  url.searchParams.set("limit", String(options.limit));
  url.searchParams.set("by", options.by);
  if (options.q !== undefined) url.searchParams.set("q", options.q);
  if (options.category !== undefined) url.searchParams.set("category", options.category);
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": await userAgent() } });
  const body = await response.json().catch(() => undefined);
  if (!response.ok || (body !== null && typeof body === "object" && Number.isInteger(body.status) && body.status >= 400)) {
    throw new Error(`AIHOT API request failed with ${response.status}: ${JSON.stringify(body)}`);
  }
  if (body === null || typeof body !== "object" || !Array.isArray(body.items)) throw new Error("AIHOT API response does not contain an items array");
  const resultItems = body.items.slice(0, options.limit);
  const sourceRefs = [
    { uri: url.toString(), title: `AIHOT ${options.window} ${options.mode} query` },
    ...resultItems.map(sourceReference).filter((item) => item !== undefined),
  ];
  process.stdout.write(`${JSON.stringify({
    schema: "aihot.itemsQuery/v1",
    requestedWindow: options.window,
    queryUrl: url.toString(),
    items: resultItems,
    evidenceReceipt: {
      schema: "agentloop.toolEvidenceReceipt/v1",
      temporalCoverage: { schema: "agentloop.temporalCoverage/v1", kind: "rolling_window", durationDays: options.window === "24h" ? 1 : 7 },
      sourceRefs,
      caveats: ["AIHOT v1 items uses the requested rolling time window and returns selected or public-pool entries, not a complete historical archive."],
      evidenceKinds: { satisfied: ["source_summary", "source_urls"], caveated: ["explicit_caveats"], failed: [] },
    },
  })}\n`);
}

function monthBoundary() {
  process.stdout.write(`${JSON.stringify({
    schema: "aihot.timeWindowBoundary/v1",
    requestedWindow: "30d",
    fulfillment: "unavailable",
    evidenceReceipt: {
      schema: "agentloop.toolEvidenceReceipt/v1",
      temporalCoverage: { schema: "agentloop.temporalCoverage/v1", kind: "rolling_window", requestedDurationDays: 30, fulfillment: "unavailable" },
      sourceRefs: [{ uri: MONTHLY_URL, title: "AIHOT monthly page" }],
      caveats: ["AIHOT v1 items only supports 24h and 7d. The monthly page is not an API or Skill endpoint for extracting a rolling 30-day list of items."],
      evidenceKinds: { satisfied: ["source_summary", "source_urls"], caveated: ["explicit_caveats"], failed: [] },
    },
  })}\n`);
}

const [command, ...values] = process.argv.slice(2);
try {
  if (command === "items") await items(values);
  else if (command === "month-boundary" && values.length === 0) monthBoundary();
  else throw new TypeError("Usage: query-aihot.mjs items --window <24h|7d> [--mode selected|all] [--limit 1..50] [--q text] [--category slug] [--by timeline|published] | month-boundary");
} catch (error) {
  fail(error instanceof Error ? error.message : "AIHOT query failed");
}
