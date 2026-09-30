import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import { unlink } from "node:fs/promises";
import type { CommandInvocationContext } from "@zhujun/agentloop";
import type {
  CredentialGrant, CredentialGrantRequest, IntegrationInvocationResponse, RuntimeConfigurationSnapshot, RuntimeTarget,
} from "../../../../control-plane/contracts/index.ts";

const PERMIT_TTL_MS = 30_000;

export class IntegrationBrokerError extends Error {
  public readonly code: "integration_not_authorized" | "credential_grant_expired" | "integration_upstream_failed" | "integration_response_invalid";

  public constructor(code: "integration_not_authorized" | "credential_grant_expired" | "integration_upstream_failed" | "integration_response_invalid") {
    super(code);
    this.name = "IntegrationBrokerError";
    this.code = code;
  }
}

export interface IntegrationDeliveryPort {
  requestGrant(request: CredentialGrantRequest): Promise<CredentialGrant>;
  invoke(grant: CredentialGrant, request: CredentialGrantRequest, args: Readonly<Record<string, unknown>>): Promise<IntegrationInvocationResponse>;
}

interface Permit {
  readonly invocationId: string;
  readonly context: CommandInvocationContext;
  readonly bindingId: string;
  readonly releaseId: string;
  readonly contentHash: string;
  readonly actions: readonly string[];
  readonly expiresAt: number;
}

/**
 * Cloud Host-owned bridge from a Skill process to the protected delivery API.
 * Its socket carries a single-use permit, never a credential or upstream URL.
 */
export class CloudIntegrationSecretBroker {
  private readonly target: RuntimeTarget;
  private readonly snapshot: RuntimeConfigurationSnapshot;
  private readonly delivery: IntegrationDeliveryPort;
  private readonly socketPath: string;
  private readonly now: () => number;
  private readonly permits = new Map<string, Permit>();
  private server?: Server;

  public constructor(input: { readonly target: RuntimeTarget; readonly snapshot: RuntimeConfigurationSnapshot; readonly delivery: IntegrationDeliveryPort; readonly socketPath: string; readonly now?: () => number }) {
    this.target = input.target;
    this.snapshot = input.snapshot;
    this.delivery = input.delivery;
    this.socketPath = input.socketPath;
    this.now = input.now ?? Date.now;
  }

  public async start(): Promise<void> {
    if (this.server !== undefined) return;
    await unlink(this.socketPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    // The client half-closes after sending its JSON request; keep the server
    // side writable until the asynchronous delivery call has produced a reply.
    this.server = createServer({ allowHalfOpen: true }, (socket) => {
      let source = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => { source += chunk; });
      socket.on("end", () => { void this.respond(socket, source); });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => { this.server!.off("error", reject); resolve(); });
    });
  }

  public async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.permits.clear();
    if (server !== undefined) await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    await unlink(this.socketPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }

  /** Called only by the Host's command-environment factory. */
  public commandEnvironment(context: CommandInvocationContext): Readonly<Record<string, string>> {
    const binding = this.snapshot.integrations.find((item) => item.integration === "enterprise_info");
    // The opaque permit is issued only to the declared Skill entrypoint, not
    // to arbitrary commands that happen to run while that Skill is available.
    if (binding === undefined || !enterpriseInfoEntrypoint(context)) return {};
    const now = this.now();
    for (const [permitId, permit] of this.permits) if (permit.expiresAt <= now) this.permits.delete(permitId);
    const permit = randomUUID();
    this.permits.set(permit, {
      invocationId: randomUUID(), context, bindingId: binding.bindingId, releaseId: binding.releaseId,
      contentHash: binding.contentHash, actions: binding.allowedActions ?? [], expiresAt: now + PERMIT_TTL_MS,
    });
    return { AGENTLOOP_INTEGRATION_BROKER_SOCKET: this.socketPath, AGENTLOOP_INTEGRATION_PERMIT: permit };
  }

  private async respond(socket: import("node:net").Socket, source: string): Promise<void> {
    try {
      const request = parseRequest(source);
      const permit = this.permits.get(request.permit);
      this.permits.delete(request.permit);
      if (permit === undefined || permit.expiresAt <= this.now() || permit.context.runId.length === 0 || !permit.actions.includes(request.action)) throw new IntegrationBrokerError("integration_not_authorized");
      const invocation: CredentialGrantRequest = {
        contractVersion: "control-plane/v1", invocationId: permit.invocationId, runId: permit.context.runId,
        ...(permit.context.planId === undefined ? {} : { planId: permit.context.planId }),
        ...(permit.context.stepId === undefined ? {} : { stepId: permit.context.stepId }),
        integration: "enterprise_info", action: request.action, bindingId: permit.bindingId, releaseId: permit.releaseId,
        contentHash: permit.contentHash, skillNames: permit.context.skillNames, requestedAt: this.now(),
      };
      const grant = await this.delivery.requestGrant(invocation);
      if (grant.contractVersion !== "control-plane/v1" || grant.grantId.trim() === "" || grant.secretReferenceVersion.trim() === "" || grant.expiresAt <= this.now() || grant.invocationId !== invocation.invocationId || grant.bindingId !== invocation.bindingId || grant.releaseId !== invocation.releaseId || grant.contentHash !== invocation.contentHash) {
        throw new IntegrationBrokerError("credential_grant_expired");
      }
      const response = await this.delivery.invoke(grant, invocation, request.args);
      socket.end(JSON.stringify({ ok: true, result: response.result, receipt: response.receipt }));
    } catch (error) {
      const code = integrationErrorCode(error) ?? "integration_upstream_failed";
      socket.end(JSON.stringify({ ok: false, code }));
    }
  }
}

function enterpriseInfoEntrypoint(context: CommandInvocationContext): boolean {
  return context.skillNames.includes("enterprise-info")
    && (context.command === "python3" || context.command === "python")
    && context.args[0] === "scripts/enterprise_info.py";
}

function integrationErrorCode(error: unknown): IntegrationBrokerError["code"] | undefined {
  if (error instanceof IntegrationBrokerError) return error.code;
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "integration_not_authorized" || code === "credential_grant_expired" || code === "integration_response_invalid") return code;
  }
  return undefined;
}

function parseRequest(source: string): { readonly permit: string; readonly action: string; readonly args: Readonly<Record<string, unknown>> } {
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new IntegrationBrokerError("integration_response_invalid"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new IntegrationBrokerError("integration_response_invalid");
  const record = value as Record<string, unknown>;
  if (typeof record.permit !== "string" || typeof record.action !== "string" || record.args === null || typeof record.args !== "object" || Array.isArray(record.args)) {
    throw new IntegrationBrokerError("integration_response_invalid");
  }
  return { permit: record.permit, action: record.action, args: record.args as Readonly<Record<string, unknown>> };
}
