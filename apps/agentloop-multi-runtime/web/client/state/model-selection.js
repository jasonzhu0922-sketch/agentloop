/** Composer selection belongs to a conversation and its execution catalog. */
export function createModelSelection() {
  let scopeKey;
  let lastTurnKey;
  let selectedKey = "";
  return {
    choose(key) { selectedKey = key; },
    resolve({ conversation, context, models, loading }) {
      const scope = JSON.stringify([conversation?.id, context.key]);
      const lastTurn = (conversation?.messages || []).findLast((message) => message.role === "assistant");
      const requestedKey = lastTurn?.requestedModelKey || lastTurn?.modelKey;
      const turnKey = JSON.stringify([lastTurn?.id, requestedKey]);
      if (scope !== scopeKey || turnKey !== lastTurnKey) {
        scopeKey = scope;
        lastTurnKey = turnKey;
        selectedKey = requestedKey || "";
      }
      // Loading clears the visible options, but must retain selection intent.
      if (loading || models.length === 0) return "";
      if (!models.some((model) => model.key === selectedKey)) {
        const source = selectedKey ? modelSource(selectedKey) : context.local ? "local" : "cloud";
        selectedKey = models.find((model) => modelSource(model.key) === source)?.key
          || models.find((model) => modelSource(model.key) === "cloud")?.key
          || "";
      }
      return selectedKey;
    },
  };
}

function modelSource(key) { return key.startsWith("local:") ? "local" : "cloud"; }
