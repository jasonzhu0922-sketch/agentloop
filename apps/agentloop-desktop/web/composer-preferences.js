// Composer preferences contain identifiers only; execution authorization still
// comes from the explicitly selected connections sent with each Run.
export function createComposerPreferences(storage, accountId) {
  const key = `agentloop-desktop-composer:${encodeURIComponent(accountId)}`;
  let state = {};
  try {
    const parsed = JSON.parse(storage.getItem(key) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) state = parsed;
  } catch { /* Storage may be unavailable or contain invalid data. */ }
  function save() { try { storage.setItem(key, JSON.stringify(state)); } catch { /* Keep the current page usable. */ } }
  function scope(runtimeId, conversationId) { return JSON.stringify([runtimeId, conversationId]); }
  return {
    model() { return typeof state.model === 'string' ? state.model : ''; },
    setModel(model) { state.model = model; save(); },
    connectors(runtimeId, conversationId) {
      const value = state.conversations?.[scope(runtimeId, conversationId)];
      return Array.isArray(value) ? value.filter(id => typeof id === 'string') : [];
    },
    setConnectors(runtimeId, conversationId, ids) {
      if (!conversationId) return;
      if (!state.conversations || typeof state.conversations !== 'object' || Array.isArray(state.conversations)) state.conversations = {};
      state.conversations[scope(runtimeId, conversationId)] = ids;
      save();
    },
    removeConversation(runtimeId, conversationId) {
      if (state.conversations && typeof state.conversations === 'object') delete state.conversations[scope(runtimeId, conversationId)];
      save();
    },
  };
}
