/** A selection is valid only in the execution context that supplied its catalog. */
export function createModelCatalog({ fetchModels, onChange }) {
  let contextKey;
  let revision = 0;
  let pending;
  let state = { models: [], loading: false };
  return {
    load(context, { force = false } = {}) {
      if (!force && context.key === contextKey) return pending;
      const changed = context.key !== contextKey;
      contextKey = context.key;
      const requestRevision = ++revision;
      state = { models: changed ? [] : state.models, loading: true };
      onChange(state);
      pending = Promise.resolve().then(() => fetchModels(context)).then((models) => {
        if (requestRevision !== revision) return;
        state = { models, loading: false };
        onChange(state);
      }).catch((error) => {
        if (requestRevision !== revision) return;
        state = { models: [], loading: false, error };
        onChange(state);
      });
      return pending;
    },
    accepts(context, key) {
      return context.key === contextKey && !state.loading && state.models.some((model) => model.key === key);
    },
  };
}
