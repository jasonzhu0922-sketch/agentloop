import { randomUUID } from "node:crypto";
import type { RuntimeTarget } from "../../../../control-plane/contracts/index.ts";
import { RuntimeConfigurationClient, RuntimeConfigurationClientError } from "./runtime-configuration-client.ts";
import { reconcileRuntimeConfigurationShadow, type RuntimeFileConfigurationBaseline } from "./runtime-configuration-shadow.ts";

const deliveryUrlVariable = "CONTROL_PLANE_DELIVERY_URL";
const workloadTokenVariable = "CONTROL_PLANE_WORKLOAD_TOKEN";
const tenantIdVariable = "CONTROL_PLANE_SHADOW_TENANT_ID";

export interface RuntimeConfigurationShadowOrchestrator {
  /** Starts non-blocking shadow reconciliation after the Host has started listening. */
  start(): void;
  stop(): void;
  /** Exposed for composition tests; production composition invokes this asynchronously. */
  reconcile(): Promise<void>;
}

export interface RuntimeConfigurationShadowLogEntry {
  readonly event: "runtime_configuration_shadow";
  readonly status: "equivalent" | "different" | "incomplete" | "failed";
  readonly target: RuntimeTarget;
  readonly differences?: readonly string[];
  readonly code?: "configuration_unavailable";
}

/**
 * Builds an observational Cloud-only delivery loop. All three identity inputs
 * are deliberately required: a Host has no implicit tenant identity, and an
 * incomplete opt-in must leave file-backed execution untouched.
 */
export function createRuntimeConfigurationShadowOrchestrator(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly runtimeId: string;
  readonly baseline: RuntimeFileConfigurationBaseline;
  readonly log: (entry: RuntimeConfigurationShadowLogEntry) => void;
  readonly request?: typeof fetch;
  readonly now?: () => number;
  readonly createReceiptId?: () => string;
}): RuntimeConfigurationShadowOrchestrator | undefined {
  const deliveryUrl = requiredShadowSetting(input.environment, deliveryUrlVariable);
  const workloadToken = requiredShadowSetting(input.environment, workloadTokenVariable);
  const tenantId = requiredShadowSetting(input.environment, tenantIdVariable);
  if (deliveryUrl === undefined || workloadToken === undefined || tenantId === undefined) return undefined;
  const target: RuntimeTarget = {
    plane: "cloud",
    tenantId,
    runtimeId: nonEmpty("RUNTIME_ID", input.runtimeId),
    ...optionalRuntimeClass(input.environment.CONTROL_PLANE_SHADOW_RUNTIME_CLASS),
  };
  const client = new RuntimeConfigurationClient({ deliveryUrl, workloadToken, target, ...(input.request === undefined ? {} : { request: input.request }), ...(input.now === undefined ? {} : { now: input.now }) });
  const intervalMs = optionalInterval(input.environment.CONTROL_PLANE_SHADOW_INTERVAL_MS);
  const receiptId = input.createReceiptId ?? randomUUID;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reconciliationInFlight = false;

  const reconcile = async (): Promise<void> => {
    if (reconciliationInFlight) return;
    reconciliationInFlight = true;
    try {
      const result = await reconcileRuntimeConfigurationShadow({ client, baseline: input.baseline, receiptIdFor: (releaseId) => `shadow:${target.runtimeId}:${releaseId}:${receiptId()}` });
      input.log({ event: "runtime_configuration_shadow", status: result.status, target, ...(result.differences.length === 0 ? {} : { differences: result.differences }) });
    } catch (error) {
      // Never include an exception message: URL/token-bearing transport errors must not enter Host logs.
      input.log({ event: "runtime_configuration_shadow", status: "failed", target, code: error instanceof RuntimeConfigurationClientError ? error.code : "configuration_unavailable" });
    } finally {
      reconciliationInFlight = false;
    }
  };
  return {
    start: (): void => {
      void reconcile();
      if (intervalMs !== undefined && timer === undefined) timer = setInterval(() => { void reconcile(); }, intervalMs);
    },
    stop: (): void => { if (timer !== undefined) clearInterval(timer); timer = undefined; },
    reconcile,
  };
}

function requiredShadowSetting(environment: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = environment[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function nonEmpty(name: string, value: string): string {
  if (value.trim() === "") throw new TypeError(`${name} must be configured`);
  return value;
}

function optionalRuntimeClass(value: string | undefined): { readonly runtimeClass?: string } {
  const runtimeClass = value?.trim();
  return runtimeClass === undefined || runtimeClass === "" ? {} : { runtimeClass };
}

function optionalInterval(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 86_400_000) throw new TypeError("CONTROL_PLANE_SHADOW_INTERVAL_MS must be a positive millisecond duration");
  return parsed;
}
