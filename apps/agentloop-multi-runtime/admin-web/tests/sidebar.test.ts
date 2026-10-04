import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { navigationItems } from "../src/app/navigation.ts";
import { renderSidebarNavigation, toggleSidebarGroup } from "../src/app/sidebar.ts";

test("Admin sidebar renders grouped navigation with an explicit collapse control", () => {
  const html = renderSidebarNavigation(navigationItems, "overview");
  assert.match(html, /data-nav-group="系统管理"/);
  assert.match(html, /data-nav-group="业务运营"/);
  assert.match(html, /nav-group-chevron/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /管理端用户/);
  assert.match(html, /业务端用户/);
});

test("Admin sidebar group state hides only the group's children", () => {
  toggleSidebarGroup("系统管理");
  const collapsed = renderSidebarNavigation(navigationItems, "overview");
  assert.match(collapsed, /data-nav-group="系统管理"[^>]*aria-expanded="false"/);
  assert.match(collapsed, /nav-group collapsed/);
  assert.match(collapsed, /data-nav-group="业务运营"[^>]*aria-expanded="true"/);
  toggleSidebarGroup("系统管理");
});

test("Admin sidebar keeps the icon column fixed while labels use the remaining width", async () => {
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.nav-item>span:first-child\{[^}]*flex:0 0 18px/);
  assert.match(styles, /\.nav-item>\.nav-item-label\{[^}]*width:auto/);
});
