import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("sidebar identity and account actions share one horizontal layout group", async () => {
  const [html, overrides] = await Promise.all([
    readFile(new URL("../web/pages/app.html", import.meta.url), "utf8"),
    readFile(new URL("../web/styles/runtime-overrides.css", import.meta.url), "utf8"),
  ]);

  assert.match(html, /<div id="identity-label" class="identity"><\/div>\s*<div class="foot-actions">/);
  assert.match(overrides, /\.sidebar-foot\s*\{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\) auto;\s*align-items: center;\s*column-gap: 10px;/);
  assert.match(overrides, /\.sidebar-foot > \.local-capability \{ grid-column: 1 \/ -1; \}/);
  assert.match(overrides, /\.sidebar-foot > \.identity \{ min-width: 0; margin: 0; \}/);
  assert.match(overrides, /\.sidebar-foot > \.foot-actions \{ display: flex; grid-column: 2; gap: 6px; \}/);
  assert.match(overrides, /\.local-capability-title \{\s*display: flex;\s*align-items: center;\s*min-width: 0;/);
  assert.match(overrides, /\.local-capability-title \.local-agent-state \{\s*margin-left: 2ch;/);
});
