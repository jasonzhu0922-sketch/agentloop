import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/app/shell.ts", import.meta.url), "utf8");
const usersPage = readFileSync(new URL("../src/app/pages/users-page.ts", import.meta.url), "utf8");
const interactions = readFileSync(new URL("../src/app/interaction-bindings.ts", import.meta.url), "utf8");

test("Admin users render as a full-width table with one modal for create and edit", () => {
  assert.match(usersPage, /<section class="members-page">/);
  assert.match(usersPage, /state\.userModal/);
  assert.match(usersPage, /class="dialog admin-user-dialog"/);
  assert.match(interactions, /state\.userModal = true/);
  assert.match(styles, /\.members-page\{display:block\}\.members-page>\.wide\{width:100%\}/);
  assert.match(styles, /\.admin-user-dialog\{width:min\(760px,100%\)\}/);
  assert.match(usersPage, /class="pagination admin-user-pagination"/);
  assert.match(interactions, /data-action=admin-user-page-prev/);
  assert.match(interactions, /data-action=admin-user-page-next/);
  assert.match(styles, /\.panel-actions\{display:flex;align-items:center;gap:16px\}/);
});

test("Admin shell keeps the shared top bar free of manual refresh and session identity controls", () => {
  assert.doesNotMatch(shell, /data-action=\"refresh\"/);
  assert.doesNotMatch(shell, /class=\"identity\"/);
  assert.doesNotMatch(shell, /class=\"top-actions\"/);
});

test("Admin shell delegates sidebar and interaction wiring to focused modules", () => {
  assert.match(shell, /renderSidebarNavigation/);
  assert.match(shell, /bindAdminShell/);
  assert.doesNotMatch(shell, /function renderNavigation\(/);
  assert.doesNotMatch(shell, /root\.querySelectorAll<HTMLElement>\("\[data-page\]"\)/);
});
