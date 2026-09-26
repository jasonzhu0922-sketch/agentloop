export function localRuntimePreferenceKey(userId: unknown, deviceId: unknown): string | undefined;
export function loadLocalRuntimePreference(storage: Pick<Storage, "getItem">, userId: unknown, deviceId: unknown): boolean | undefined;
export function saveLocalRuntimePreference(storage: Pick<Storage, "setItem">, userId: unknown, deviceId: unknown, enabled: unknown): boolean;
