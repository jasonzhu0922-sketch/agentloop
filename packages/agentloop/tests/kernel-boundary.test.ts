import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

/**
 * Architecture guards for the monorepo layout:
 *
 * The kernel package ("@zhujun/agentloop", packages/agentloop) is a
 * headless library. It must not contain or import application-layer code
 * (HTTP server, authentication), and its public entry and delivery assets
 * must remain usable by external package consumers.
 */

test("kernel source tree contains no application layer", () => {
  const srcRoot = resolve(import.meta.dirname, "../src");
  const forbidden = ["server", "auth", "http"];
  const violations: string[] = [];
  for (const name of forbidden) {
    try {
      statSync(join(srcRoot, name));
      violations.push(`packages/agentloop/src/${name}/ must live in an application package`);
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

test("the kernel package exports and ships only the published library", () => {
  const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")) as {
    exports?: { "."?: { types?: string; default?: string } };
    files?: string[];
  };
  assert.equal(packageJson.exports?.["."]?.types, "./dist/index.d.ts");
  assert.equal(packageJson.exports?.["."]?.default, "./dist/index.js");
  assert.deepEqual(packageJson.files, ["dist", "README.md", "THIRD_PARTY_NOTICES.md"]);
  assert.ok(!packageJson.files.some((entry) => entry.includes("skills")));
});
