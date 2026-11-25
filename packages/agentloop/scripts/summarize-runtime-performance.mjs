import { readFile } from "node:fs/promises";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/summarize-runtime-performance.mjs <diagnostics.jsonl> [runId]");
  process.exitCode = 2;
} else {
  const selectedRunId = process.argv[3];
  const lines = (await readFile(file, "utf8")).split(/\r?\n/u).filter(Boolean);
  const records = lines.map(line => JSON.parse(line));
  const summaries = records.filter(record => record.kind === "run_summary" && (!selectedRunId || record.runId === selectedRunId));
  for (const summary of summaries) {
    console.log(JSON.stringify({
      runId: summary.runId, wallDurationMs: summary.durationMs,
      environment: {
        kernelVersion: summary.attributes?.kernelVersion, modelKey: summary.attributes?.modelKey,
        storageDialect: summary.attributes?.storageDialect, endpoint: summary.attributes?.endpoint, database: summary.attributes?.database,
        skillVersions: summary.attributes?.skillVersions,
      },
      diagnosticHealth: { droppedRecords: summary.attributes?.droppedRecords, sinkFailures: summary.attributes?.sinkFailures },
      accounting: summary.attributes?.accounting,
      inclusiveCategoryMs: summary.attributes?.categoryInclusiveMs,
      slowestOperations: summary.attributes?.slowestOperations,
    }, null, 2));
  }
}
