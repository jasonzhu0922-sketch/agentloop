/**
 * Read-only inventory of direct SQL and transaction boundaries in the Kernel.
 * It is intentionally a source audit, not a SQL parser or a completeness claim.
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? new URL("..", import.meta.url).pathname);
const folders = ["src/runtime", "src/planning", "src/storage/repositories"];
const files = [];
for (const folder of folders) {
  for (const name of await readdir(resolve(root, folder))) {
    if (!name.endsWith(".ts")) continue;
    const path = `${folder}/${name}`;
    const content = await readFile(resolve(root, path), "utf8");
    const lines = content.split("\n");
    const sqlCallLines = lines.flatMap((line, index) =>
      /\.(?:prepare|exec|transaction)\(/.test(line) ? [index + 1] : []);
    if (!sqlCallLines.length) continue;
    const tables = [...content.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO|DELETE FROM)\s+([a-z_][a-z_0-9]*)/giu)]
      .map(match => match[1]).filter(name => name.toLowerCase() !== "set");
    files.push({
      path,
      sqlCalls: sqlCallLines.length,
      transactionCalls: (content.match(/\.transaction\(/g) ?? []).length,
      tables: [...new Set(tables)].sort(),
      sqlCallLines,
    });
  }
}

const hostPaths = [
  "packages/agentloop-local-runtime/src/service/local-runtime-factory.ts",
  "apps/agentloop-multi-runtime/src/runtime-host/main.ts",
];
const hosts = [];
for (const path of hostPaths) {
  const content = await readFile(resolve(root, "../..", path), "utf8");
  hosts.push({ path, newRunService: content.includes("new RunService("), eventBatchingConfigured: content.includes("eventBatching:") });
}

console.log(JSON.stringify({
  scope: "Kernel runtime/planning/repositories; dynamic SQL and host control-plane SQL are outside this heuristic",
  filesWithSql: files.length,
  sqlCalls: files.reduce((total, file) => total + file.sqlCalls, 0),
  transactionCalls: files.reduce((total, file) => total + file.transactionCalls, 0),
  files: files.sort((a, b) => b.sqlCalls - a.sqlCalls),
  hosts,
}, null, 2));
