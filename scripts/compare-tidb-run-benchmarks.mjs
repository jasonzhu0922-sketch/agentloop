import { readFile, writeFile } from "node:fs/promises";

const [beforePath, afterPath, outputPath = "tidb-run-benchmark-summary.md"] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error("Usage: compare-tidb-run-benchmarks.mjs <before.json> <after.json> [summary.md]");

const before = JSON.parse(await readFile(beforePath, "utf8"));
const after = JSON.parse(await readFile(afterPath, "utf8"));
const metrics = [
  ["Total task duration", "totalDurationMs", "ms"],
  ["Event SQL duration", "eventSqlDurationMs", "ms"],
  ["All SQL duration", "allSqlDurationMs", "ms"],
  ["Streaming events", "streamingEventCount", ""],
  ["Event SQL statements", "eventSqlStatementCount", ""],
  ["Streaming payload", "streamingPayloadBytes", "bytes"],
  ["All persisted payload", "persistedPayloadBytes", "bytes"],
];

const format = (value, unit) => unit === "ms"
  ? value.toFixed(1) + " ms"
  : Math.round(value).toLocaleString("en-US") + (unit ? " " + unit : "");
const change = (beforeValue, afterValue) => beforeValue === 0
  ? "n/a"
  : (((afterValue - beforeValue) / beforeValue) * 100).toFixed(1) + "%";
const lines = [
  "# TiDB Run persistence A/B benchmark",
  "",
  "Before: " + before.commit + "  ",
  "After: " + after.commit,
  "",
  "| Metric | Before | After | Change |",
  "|---|---:|---:|---:|",
  ...metrics.map(([label, key, unit]) => "| " + label + " | " + format(before[key], unit) + " | " + format(after[key], unit) + " | " + change(before[key], after[key]) + " |"),
  "",
  "Run status: before=" + before.runStatus + ", after=" + after.runStatus,
];
await writeFile(outputPath, lines.join("\n") + "\n");
console.log(lines.join("\n"));
