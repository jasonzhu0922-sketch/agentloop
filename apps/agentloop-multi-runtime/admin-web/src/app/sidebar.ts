import type { NavigationItem, Page } from "./navigation.ts";

const collapsedGroups = new Set<string>();

/**
 * Renders the sidebar navigation as a real two-level menu. Group state is
 * kept in the view layer so page navigation does not change the hierarchy.
 */
export function renderSidebarNavigation(items: readonly NavigationItem[], currentPage: Page): string {
  const groups = new Map<string, NavigationItem[]>();
  const ungrouped: NavigationItem[] = [];
  for (const item of items) {
    if (item.group === undefined) ungrouped.push(item);
    else groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  }
  const renderItem = (item: NavigationItem): string => `<button class="nav-item ${currentPage === item.id ? "active" : ""}" data-page="${item.id}"><span>${item.icon}</span><span class="nav-item-label">${escapeHtml(item.label)}</span></button>`;
  const renderGroup = (group: string, children: readonly NavigationItem[]): string => {
    const collapsed = collapsedGroups.has(group);
    return `<section class="nav-group ${collapsed ? "collapsed" : ""}"><button class="nav-group-toggle" type="button" data-nav-group="${escapeHtml(group)}" aria-expanded="${collapsed ? "false" : "true"}"><span>${escapeHtml(group)}</span><span class="nav-group-chevron" aria-hidden="true">⌄</span></button><div class="nav-group-items">${children.map(renderItem).join("")}</div></section>`;
  };
  return `${ungrouped.map(renderItem).join("")}${[...groups.entries()].map(([group, children]) => renderGroup(group, children)).join("")}`;
}

export function toggleSidebarGroup(group: string): void {
  if (collapsedGroups.has(group)) collapsedGroups.delete(group);
  else collapsedGroups.add(group);
}

// Kept local to the sidebar boundary so navigation labels are always escaped
// even when the shell is eventually split into independent page modules.
function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}
