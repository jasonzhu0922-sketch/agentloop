import type { ModelCatalogContext } from "./model-catalog.js";

export interface ModelSelectionConversation {
  readonly id: string;
  readonly messages?: readonly {
    readonly id: string;
    readonly role: string;
    readonly requestedModelKey?: string;
    readonly modelKey?: string;
  }[];
}

export function createModelSelection(input?: {
  readonly storage?: Pick<Storage, "getItem" | "setItem">;
  readonly storageKey?: string;
}): {
  choose(key: string, context?: ModelCatalogContext): void;
  resolve(input: {
    readonly conversation?: ModelSelectionConversation;
    readonly context: ModelCatalogContext;
    readonly models: readonly { readonly key: string }[];
    readonly loading: boolean;
  }): string;
};
