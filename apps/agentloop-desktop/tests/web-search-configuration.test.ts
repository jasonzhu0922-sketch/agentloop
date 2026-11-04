import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { desktopRuntimeEnvironment } from "../src/accounts/account-managers.ts";
import { DESKTOP_DEVELOPMENT_ENV_DIRECTORY } from "../src/main.ts";

test("development reads the environment from the Desktop application directory", () => {
  assert.equal(DESKTOP_DEVELOPMENT_ENV_DIRECTORY, fileURLToPath(new URL("..", import.meta.url)));
});

test("Desktop search requires explicit opt-in and reads only search settings", async t => {
  const root = await mkdtemp(join(tmpdir(), "desktop-web-search-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await desktopRuntimeEnvironment(root), {});
  await writeFile(join(root, ".env"), "WEB_SEARCH_DISABLED=1\nWEB_SEARCH_API_KEY=secret\n");
  assert.deepEqual(await desktopRuntimeEnvironment(root), {});
  await writeFile(join(root, ".env"), "WEB_SEARCH_DISABLED=0\nWEB_SEARCH_PROVIDER=bocha\nWEB_SEARCH_ENDPOINT=https://search.example/v1\nWEB_SEARCH_API_KEY=secret\nPLANNING_MAX_TURNS=8\nSTEP_MAX_TURNS=64\nOTHER=ignored\n");
  assert.deepEqual(await desktopRuntimeEnvironment(root), { webSearch: { searchProvider: "bocha", searchEndpoint: "https://search.example/v1", searchApiKey: "secret" }, planningMaxTurns: 8, stepMaxTurns: 64 });
  await writeFile(join(root, ".env"), "PLANNING_MAX_TURNS=65\n");
  await assert.rejects(desktopRuntimeEnvironment(root), /planning_max_turns_invalid/);
  await writeFile(join(root, ".env"), "STEP_MAX_TURNS=0\n");
  await assert.rejects(desktopRuntimeEnvironment(root), /step_max_turns_invalid/);
});
