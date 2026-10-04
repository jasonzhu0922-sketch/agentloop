import { ControlPlaneError } from "../../../control-plane/domain/index.ts";
import type { RuntimeInventoryEntry, RuntimeInventoryPage } from "../../../control-plane/contracts/index.ts";
import type { RuntimeInventoryPort } from "./admin-ports.ts";

/** Admin adapter for the Router's token-protected, authoritative Runtime directory. */
export class RouterRuntimeInventoryService implements RuntimeInventoryPort {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly request: typeof fetch;

  constructor(input: { readonly baseUrl: string; readonly token: string; readonly request?: typeof fetch }) {
    this.baseUrl = input.baseUrl.replace(/\/$/, "");
    this.token = input.token;
    this.request = input.request ?? fetch;
  }

  async list(input: { readonly scopeId?: string; readonly page: number; readonly pageSize: number }): Promise<RuntimeInventoryPage> {
    let response: Response;
    try {
      const query = new URLSearchParams({ page: String(input.page), pageSize: String(input.pageSize), ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }) });
      response = await this.request(new URL(`/v1/internal/admin/runtimes?${query.toString()}`, `${this.baseUrl}/`), { headers: { authorization: `Bearer ${this.token}` } });
    } catch {
      throw new ControlPlaneError("configuration_unavailable", "Router Runtime inventory is unavailable");
    }
    const body = await response.json().catch(() => undefined) as { error?: string; items?: unknown[]; page?: number; pageSize?: number; total?: number; pageCount?: number } | undefined;
    if (!response.ok) throw new ControlPlaneError("configuration_unavailable", body?.error ?? `Router returned HTTP ${response.status}`);
    if (!Array.isArray(body?.items) || typeof (body as { page?: unknown }).page !== "number") throw new ControlPlaneError("configuration_unavailable", "Router Runtime inventory response is invalid");
    return { page: body.page!, pageSize: body.pageSize!, total: body.total!, pageCount: body.pageCount!, items: body.items.map(runtimeInventoryEntry) };
  }
}

function runtimeInventoryEntry(value: unknown): RuntimeInventoryEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ControlPlaneError("configuration_unavailable", "Router Runtime inventory entry is invalid");
  const item = value as Record<string, unknown>;
  const requiredString = (name: string): string => {
    const field = item[name];
    if (typeof field !== "string" || field.trim() === "") throw new ControlPlaneError("configuration_unavailable", `Router Runtime inventory ${name} is invalid`);
    return field;
  };
  const status = requiredString("status");
  const plane = requiredString("kind");
  const profile = requiredString("profile");
  if ((status !== "ready" && status !== "draining" && status !== "offline") || (plane !== "cloud" && plane !== "local") || (profile !== "general" && profile !== "artifact")) {
    throw new ControlPlaneError("configuration_unavailable", "Router Runtime inventory enum is invalid");
  }
  const nonNegative = (name: string, fallback = 0): number => {
    const field = item[name];
    return field === undefined ? fallback : Number.isSafeInteger(field) && Number(field) >= 0 ? Number(field) : (() => { throw new ControlPlaneError("configuration_unavailable", `Router Runtime inventory ${name} is invalid`); })();
  };
  const capabilities = item.capabilities;
  if (capabilities !== undefined && (!Array.isArray(capabilities) || capabilities.some((entry) => typeof entry !== "string"))) throw new ControlPlaneError("configuration_unavailable", "Router Runtime inventory capabilities are invalid");
  return {
    id: requiredString("id"),
    ...(typeof item.displayName === "string" ? { displayName: item.displayName } : {}),
    plane: plane as RuntimeInventoryEntry["plane"],
    profile: profile as RuntimeInventoryEntry["profile"],
    ...(typeof item.deviceId === "string" ? { deviceId: item.deviceId } : {}),
    ...(typeof item.scopeId === "string" ? { scopeId: item.scopeId } : {}),
    status: status as RuntimeInventoryEntry["status"],
    capabilities: (capabilities ?? []) as string[],
    maxConcurrentRuns: nonNegative("maxConcurrentRuns", 1),
    activeRunCount: nonNegative("activeRunCount"),
    queuedRunCount: nonNegative("queuedRunCount"),
    ...(typeof item.catalogVersion === "string" ? { catalogVersion: item.catalogVersion } : {}),
    startedAt: nonNegative("startedAt"),
    ...(item.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: nonNegative("lastHeartbeatAt") }),
    ...(item.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: nonNegative("leaseExpiresAt") }),
  };
}
