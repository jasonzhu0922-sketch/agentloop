/**
 * Composer selection belongs to a conversation and its execution catalog.
 * The last explicit choice is also remembered per execution source so that
 * switching between local and cloud execution does not lose the user's
 * preference. Persistence is injected to keep this state module testable.
 */
export function createModelSelection({ storage, storageKey = "agentloop.multi-runtime.model-selection.v1" } = {}) {
  let scopeKey;
  let lastTurnKey;
  let selectedKey = "";
  let activeContext;
  const remembered = new Map();

  function sourceFor(context) { return context?.local ? "local" : "cloud"; }
  function userStorageKey(context) {
    const userId = typeof context?.userId === "string" && context.userId.trim() ? context.userId.trim() : "anonymous";
    return `${storageKey}.${encodeURIComponent(userId)}`;
  }
  function readRemembered(context) {
    const source = sourceFor(context);
    const identity = `${userStorageKey(context)}:${source}`;
    if (remembered.has(identity)) return remembered.get(identity);
    let value = "";
    try {
      const stored = storage?.getItem(userStorageKey(context));
      const parsed = stored ? JSON.parse(stored) : undefined;
      if (typeof parsed?.[source] === "string") value = parsed[source];
    } catch {
      // Private browsing and malformed legacy values are treated as empty.
    }
    remembered.set(identity, value);
    return value;
  }
  function remember(context, key) {
    if (!context || typeof key !== "string" || !key) return;
    const source = sourceFor(context);
    const storageKeyForUser = userStorageKey(context);
    const identity = `${storageKeyForUser}:${source}`;
    remembered.set(identity, key);
    try {
      const stored = storage?.getItem(storageKeyForUser);
      const parsed = stored ? JSON.parse(stored) : {};
      storage?.setItem(storageKeyForUser, JSON.stringify({
        ...(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}),
        [source]: key,
      }));
    } catch {
      // Storage failures must not block changing the model.
    }
  }

  return {
    choose(key, context = activeContext) {
      selectedKey = key;
      remember(context, key);
    },
    resolve({ conversation, context, models, loading }) {
      activeContext = context;
      const scope = JSON.stringify([conversation?.id, context.key]);
      const lastTurn = (conversation?.messages || []).findLast((message) => message.role === "assistant");
      const requestedKey = lastTurn?.requestedModelKey || lastTurn?.modelKey;
      const turnKey = JSON.stringify([lastTurn?.id, requestedKey]);
      if (scope !== scopeKey || turnKey !== lastTurnKey) {
        scopeKey = scope;
        lastTurnKey = turnKey;
        selectedKey = requestedKey || readRemembered(context) || "";
      }
      // Loading clears the visible options, but must retain selection intent.
      if (loading || models.length === 0) return "";
      if (!models.some((model) => model.key === selectedKey)) {
        const source = sourceFor(context);
        selectedKey = models.find((model) => modelSource(model.key) === source)?.key
          || models[0]?.key
          || "";
      }
      return selectedKey;
    },
  };
}

function modelSource(key) { return key.startsWith("local:") ? "local" : "cloud"; }
