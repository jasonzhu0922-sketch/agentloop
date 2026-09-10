const SESSION_STORAGE_KEY = "agentloop.multi-runtime.sessions.v1";
const STORAGE_TIERS = [
  { conversations: 20, messages: 24, events: 32, text: 1_200, messageText: 12_000 },
  { conversations: 12, messages: 12, events: 16, text: 600, messageText: 6_000 },
  { conversations: 6, messages: 6, events: 8, text: 300, messageText: 3_000 },
  { conversations: 1, messages: 4, events: 4, text: 160, messageText: 1_200 },
  { conversations: 1, messages: 2, events: 2, text: 80, messageText: 400 },
];

/**
 * Browser cache is only a bounded recovery aid; Host events remain
 * authoritative. A quota failure must never interrupt task submission.
 */
export function persistSessions(storage, sessions) {
  for (const tier of STORAGE_TIERS) {
    const payload = stringifySnapshot(sessions, tier);
    if (payload === undefined) continue;
    try {
      storage.setItem(SESSION_STORAGE_KEY, payload);
      return { persisted: true, tier };
    } catch {
      // Try a smaller recovery snapshot before abandoning local persistence.
    }
  }
  // A stale oversized legacy value can consume all quota. Reclaiming this one
  // cache key is safe: live state remains in memory and the Host owns history.
  try {
    storage.removeItem(SESSION_STORAGE_KEY);
    const payload = stringifySnapshot(sessions, STORAGE_TIERS.at(-1));
    if (payload !== undefined) storage.setItem(SESSION_STORAGE_KEY, payload);
    return { persisted: true, tier: STORAGE_TIERS.at(-1) };
  } catch {
    return { persisted: false };
  }
}

export function persistJson(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function stringifySnapshot(sessions, tier) {
  try {
    return JSON.stringify((Array.isArray(sessions) ? sessions : [])
      .slice(0, tier.conversations)
      .map((conversation) => compactConversation(conversation, tier)));
  } catch {
    return undefined;
  }
}

function compactConversation(conversation, tier) {
  const value = record(conversation);
  return {
    id: string(value.id, tier.text),
    title: string(value.title, tier.text),
    createdAt: number(value.createdAt),
    updatedAt: number(value.updatedAt),
    pendingAttachments: compactAttachments(value.pendingAttachments, tier),
    messages: (Array.isArray(value.messages) ? value.messages : [])
      .slice(-tier.messages)
      .map((message) => compactMessage(message, tier)),
  };
}

function compactMessage(message, tier) {
  const value = record(message);
  const role = value.role === "assistant" ? "assistant" : "user";
  const base = {
    id: string(value.id, tier.text),
    role,
    text: string(value.text, tier.messageText),
    createdAt: number(value.createdAt),
  };
  if (role === "user") return { ...base, attachments: compactAttachments(value.attachments, tier) };
  return {
    ...base,
    reasoning: string(value.reasoning, tier.messageText),
    status: string(value.status, tier.text),
    error: string(value.error, tier.messageText),
    assignmentId: string(value.assignmentId, tier.text),
    runtimeId: string(value.runtimeId, tier.text),
    completedAt: number(value.completedAt),
    planOpen: value.planOpen === true,
    plan: compactPlan(value.plan, tier),
    events: (Array.isArray(value.events) ? value.events : []).slice(-tier.events).map((event) => compactEvent(event, tier)),
    artifacts: compactArtifacts(value.artifacts, tier),
  };
}

function compactPlan(plan, tier) {
  return (Array.isArray(plan) ? plan : []).slice(0, 20).map((step) => {
    const value = record(step);
    return { id: string(value.id, tier.text), objective: string(value.objective, tier.text), status: string(value.status, tier.text) };
  });
}

function compactAttachments(attachments, tier) {
  return (Array.isArray(attachments) ? attachments : []).slice(0, 20).map((attachment) => {
    const value = record(attachment);
    return {
      id: string(value.id, tier.text),
      originalName: string(value.originalName, tier.text),
      mediaType: string(value.mediaType, tier.text),
      byteSize: number(value.byteSize),
    };
  });
}

function compactArtifacts(artifacts, tier) {
  return (Array.isArray(artifacts) ? artifacts : []).slice(0, 20).map((artifact) => {
    const value = record(artifact);
    return {
      id: string(value.id, tier.text),
      name: string(value.name, tier.text),
      path: string(value.path, tier.text),
      mimeType: string(value.mimeType, tier.text),
      bytes: number(value.bytes),
    };
  });
}

function compactEvent(event, tier) {
  const value = record(event);
  return {
    seq: number(value.seq),
    type: string(value.type, tier.text),
    createdAt: number(value.createdAt),
    data: compactValue(value.data, tier.text),
  };
}

function compactValue(value, textLimit, depth = 0) {
  if (typeof value === "string") return string(value, textLimit);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 4) return "…[浏览器缓存已压缩；完整证据保留在 Host]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => compactValue(item, textLimit, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, item]) => [key, compactValue(item, textLimit, depth + 1)]));
}

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function string(value, limit) { return typeof value === "string" ? value.length <= limit ? value : `${value.slice(0, limit)}\n…[浏览器缓存已截断；完整内容保留在 Host]` : undefined; }
function number(value) { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
