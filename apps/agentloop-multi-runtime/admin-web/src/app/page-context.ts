import { hasPermission, type Page } from "./navigation.ts";
import type { UiState } from "./ui-state.ts";

export type PagePermission = Parameters<typeof hasPermission>[1];

export interface PageRenderContext {
  readonly state: UiState;
  readonly can: (permission: PagePermission) => boolean;
}

export interface PageRenderer {
  readonly id: Page;
  readonly render: (context: PageRenderContext) => string;
}
