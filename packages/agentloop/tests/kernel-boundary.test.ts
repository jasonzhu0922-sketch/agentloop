import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";

/**
 * Architecture guards for the monorepo layout:
 *
 * 1. The kernel package ("@zhujun/agentloop", packages/agentloop) is a
 *    headless library. It must not contain or import any application-layer
 *    code (HTTP server, authentication).
 * 2. The reference application (apps/agentloop-app) consumes the kernel only
 *    through the published package specifier "@zhujun/agentloop". Reaching
 *    into kernel internals via relative paths would bypass the public API
 *    surface and break npm-package consumption.
 */

test("kernel source tree contains no application layer", () => {
  const srcRoot = resolve(import.meta.dirname, "../src");
  const forbidden = ["server", "auth", "http"];
  const violations: string[] = [];
  for (const name of forbidden) {
    try {
      statSync(join(srcRoot, name));
      violations.push(`packages/agentloop/src/${name}/ must live in apps/agentloop-app`);
    } catch {
      // absent, as required
    }
  }
  assert.deepEqual(violations, []);
});

test("kernel index exports no application symbols", () => {
  const entry = readFileSync(resolve(import.meta.dirname, "../src/index.ts"), "utf8");
  for (const symbol of ["AuthService", "AuthRepository", "createAgentLoopServer", "./server"]) {
    assert.ok(!entry.includes(symbol), `kernel entry must not reference ${symbol}`);
  }
});

test("application sources import the kernel only via the package specifier", () => {
  const appSrcRoot = resolve(import.meta.dirname, "../../../apps/agentloop-app/src");
  const kernelSrcRoot = resolve(import.meta.dirname, "../src");
  const violations: string[] = [];

  for (const file of tsFiles(appSrcRoot)) {
    const source = readFileSync(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier);
      if (target.startsWith(kernelSrcRoot)) {
        violations.push(`${relative(appSrcRoot, file)} -> ${specifier} (use "@zhujun/agentloop")`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("the reference application resolves the published kernel package entry", () => {
  const appTsconfig = readFileSync(resolve(import.meta.dirname, "../../../apps/agentloop-app/tsconfig.json"), "utf8");
  assert.doesNotMatch(appTsconfig, /["']paths["']\s*:/);
  assert.doesNotMatch(appTsconfig, /packages[\\/]agentloop[\\/]src/);

  const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")) as {
    exports?: { "."?: { types?: string; default?: string } };
  };
  assert.equal(packageJson.exports?.["."]?.types, "./dist/index.d.ts");
  assert.equal(packageJson.exports?.["."]?.default, "./dist/index.js");
});

test("the kernel package delivery excludes the reference application", () => {
  const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")) as {
    files?: string[];
  };
  assert.deepEqual(packageJson.files, ["dist", "README.md", "THIRD_PARTY_NOTICES.md"]);
  assert.ok(!packageJson.files.some((entry) => entry.includes("apps/agentloop-app")));
  assert.ok(!packageJson.files.some((entry) => entry.includes("skills")));
});

test("the reference application imports bundled skills from the dedicated package", () => {
  const appMain = readFileSync(resolve(import.meta.dirname, "../../../apps/agentloop-app/src/main.ts"), "utf8");
  assert.doesNotMatch(appMain, /packages\/agentloop\/skills/);
  assert.match(appMain, /@zhujun\/agentloop-skills/);
});

test("the reference application has no implicit custom skill directory", () => {
  const appMain = readFileSync(resolve(import.meta.dirname, "../../../apps/agentloop-app/src/main.ts"), "utf8");
  assert.doesNotMatch(appMain, /custom-skills/);
  assert.match(appMain, /runtimePaths\.customSkillDirectories/);
});

function tsFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (entry.endsWith(".ts")) files.push(full);
    }
  };
  visit(root);
  return files;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/from\s+"([^"]+)"/g)) specifiers.push(match[1]!);
  for (const match of source.matchAll(/^\s*import\s+"([^"]+)"/gm)) specifiers.push(match[1]!);
  return specifiers;
}
