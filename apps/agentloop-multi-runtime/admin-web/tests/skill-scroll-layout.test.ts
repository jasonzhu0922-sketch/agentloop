import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/app/shell.ts", import.meta.url), "utf8");

test("Skill workspace keeps list and detail panes as independent scroll owners", () => {
  assert.ok(shell.includes('<main class="content content-${state.page}">'));
  assert.match(styles, /\.content-skills\{display:flex;flex-direction:column;overflow:hidden\}/);
  assert.match(styles, /\.content-skills \.skill-list-panel,\.content-skills \.skill-detail-panel\{min-height:0;overflow-y:auto/);
  assert.match(styles, /\.content-skills \.skill-layout\{[^}]*grid-template-rows:minmax\(0,1fr\)/);
});
