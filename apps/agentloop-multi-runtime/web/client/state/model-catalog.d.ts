export interface ModelCatalogContext {
  readonly key: string;
  readonly local: boolean;
}

export interface ModelCatalogState<TModel extends { readonly key: string } = { readonly key: string }> {
  readonly models: readonly TModel[];
  readonly loading: boolean;
  readonly error?: unknown;
}

export interface ModelCatalog<TModel extends { readonly key: string } = { readonly key: string }> {
  load(context: ModelCatalogContext, options?: { readonly force?: boolean }): Promise<void> | undefined;
  accepts(context: ModelCatalogContext, key: string): boolean;
}

export function createModelCatalog<TModel extends { readonly key: string }>(input: {
  fetchModels(context: ModelCatalogContext): Promise<TModel[]>;
  onChange(state: ModelCatalogState<TModel>): void;
}): ModelCatalog<TModel>;
