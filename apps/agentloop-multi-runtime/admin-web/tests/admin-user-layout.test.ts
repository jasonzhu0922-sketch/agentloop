import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/app/shell.ts", import.meta.url), "utf8");

test("Admin users render as a full-width table with one modal for create and edit", () => {
  assert.match(shell, /<section class="members-page">/);
  assert.match(shell, /state\.userModal \? adminUserForm\(\) : \"\"/);
  assert.match(shell, /class="dialog admin-user-dialog"/);
  assert.match(shell, /state\.userModal = true/);
  assert.match(styles, /\.members-page\{display:block\}\.members-page>\.wide\{width:100%\}/);
  assert.match(styles, /\.admin-user-dialog\{width:min\(760px,100%\)\}/);
});

test("Admin shell keeps the shared top bar free of manual refresh and session identity controls", () => {
  assert.doesNotMatch(shell, /data-action=\"refresh\"/);
  assert.doesNotMatch(shell, /class=\"identity\"/);
  assert.doesNotMatch(shell, /class=\"top-actions\"/);
});
