import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const applicationRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(applicationRoot, "../..");
const sourceExtensions = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".tsx"]);

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry): Promise<string[]> => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return sourceExtensions.has(path.slice(path.lastIndexOf("."))) ? [path] : [];
  }));
  return nested.flat();
}

async function importedSpecifiers(root: string): Promise<readonly { file: string; specifier: string }[]> {
  const files = await sourceFiles(root);
  const imports = await Promise.all(files.map(async (file) => {
    const source = await readFile(file, "utf8");
    return [...source.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g)].map((match) => ({ file, specifier: match[1] ?? "" }));
  }));
  return imports.flat();
}

async function assertNoImports(root: string, forbidden: readonly string[]): Promise<void> {
  const imports = await importedSpecifiers(root);
  const violations = imports.filter(({ specifier }) => forbidden.some((fragment) => specifier.includes(fragment)));
  assert.deepEqual(violations.map(({ file, specifier }) => `${relative(repositoryRoot, file)} -> ${specifier}`), []);
}

test("control-plane dependency closure preserves Admin, Runtime, and Kernel boundaries", async () => {
  await assertNoImports(join(applicationRoot, "admin-web", "src"), ["/admin-api/", "/src/router/", "/src/runtime-host/", "/local-agent-runtime/", "@zhujun/agentloop", "mysql2", "pg"]);
  await assertNoImports(join(applicationRoot, "admin-api", "src"), ["/web/", "/src/router/", "/src/runtime-host/", "/local-agent-runtime/", "@zhujun/agentloop", "mysql2", "pg"]);
  await assertNoImports(join(applicationRoot, "src", "router"), ["/admin-api/", "/control-plane/domain/"]);
  await assertNoImports(join(applicationRoot, "src", "runtime-host"), ["/admin-api/", "/control-plane/domain/"]);
  await assertNoImports(join(applicationRoot, "local-agent-runtime", "src"), ["/admin-api/", "/control-plane/domain/"]);
  await assertNoImports(join(repositoryRoot, "packages", "agentloop", "src"), ["control-plane/", "admin-api/", "admin-web/"]);
  await assertNoImports(join(applicationRoot, "control-plane", "contracts"), ["node:fs", "node:http", "react", "mysql2", "pg", "@zhujun/agentloop"]);
  await assertNoImports(join(applicationRoot, "control-plane", "domain"), ["node:fs", "node:http", "react", "mysql2", "pg", "@zhujun/agentloop", "/admin-api/"]);
  await assertNoImports(join(applicationRoot, "admin-api", "src", "transport"), ["/persistence/", "/infrastructure/"]);
});
