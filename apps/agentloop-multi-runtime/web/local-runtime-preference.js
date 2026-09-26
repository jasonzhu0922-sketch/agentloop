import { persistJson } from "./session-persistence.js";

const LOCAL_RUNTIME_PREFERENCE_KEY = "agentloop.multi-runtime.local-execution-preference.v1";

/**
 * This cache is a browser-only UI preference, never an execution credential.
 * Scope it to the authenticated user and paired device so a shared browser
 * cannot carry a local-execution preference across authority boundaries.
 */
export function localRuntimePreferenceKey(userId, deviceId) {
  if (typeof userId !== "string" || !userId || typeof deviceId !== "string" || !deviceId) return undefined;
  return `${LOCAL_RUNTIME_PREFERENCE_KEY}.${encodeURIComponent(userId)}.${encodeURIComponent(deviceId)}`;
}

export function loadLocalRuntimePreference(storage, userId, deviceId) {
  const key = localRuntimePreferenceKey(userId, deviceId);
  if (!key) return undefined;
  try {
    const value = JSON.parse(storage.getItem(key) || "null");
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function saveLocalRuntimePreference(storage, userId, deviceId, enabled) {
  const key = localRuntimePreferenceKey(userId, deviceId);
  return key ? persistJson(storage, key, enabled === true) : false;
}
