import type { Page } from "./navigation.ts";
import type { PageRenderContext } from "./page-context.ts";
import { renderAuditPage } from "./pages/audit-page.ts";
import { renderModelsPage } from "./pages/models-page.ts";
import { renderOverviewPage } from "./pages/overview-page.ts";
import { renderRuntimePage } from "./pages/runtime-page.ts";
import { renderSkillsPage } from "./pages/skills-page.ts";
import { renderAdminUsersPage, renderBusinessUsersPage } from "./pages/users-page.ts";
import { renderTracesPage } from "./pages/traces-page.ts";

const pageRenderers: Readonly<Record<Page, (context: PageRenderContext) => string>> = {
  overview: renderOverviewPage,
  models: renderModelsPage,
  skills: renderSkillsPage,
  "admin-users": renderAdminUsersPage,
  "business-users": renderBusinessUsersPage,
  runtime: renderRuntimePage,
  traces: renderTracesPage,
  audit: renderAuditPage,
};

export function renderPageContent(page: Page, context: PageRenderContext): string { return pageRenderers[page](context); }
