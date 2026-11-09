import { WebSocket } from "ws";
import { createHash } from "node:crypto";
import type { RuntimeArtifact, RuntimeDispatchEnvelope, RuntimeRunStatus } from "../../../src/shared/contracts.ts";
import { LocalRuntimeSupervisor, type LocalRuntimeControl } from "../service/runtime-supervisor.ts";
import { LocalRunAdmissionService } from "@zhujun/agentloop-local-runtime/host";

export interface DeviceCredential {
  readonly id: string;
  readonly agentToken: string;
}

export type LocalAgentControl = (method: string, payload: Record<string, unknown>) => Promise<unknown>;

/** Agent-side outbound control connection. Reconnects without changing Runtime identity. */
export class RuntimeConnectionClient {
  private socket?: WebSocket;
  private reconnect?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private stopped = false;
  private connected = false;
  private credential?: DeviceCredential;
  private readonly admissions = new WeakMap<LocalRuntimeControl, LocalRunAdmissionService>();
  private readonly connectionWaiters = new Set<{ readonly resolve: (connected: boolean) => void; readonly timer: NodeJS.Timeout }>();
  private routerUrl?: string;
  private readonly supervisor: LocalRuntimeSupervisor;
  private readonly unsubscribe: () => void;
  private readonly agentControl?: LocalAgentControl;

  constructor(routerUrl: string | undefined, supervisor: LocalRuntimeSupervisor, agentControl?: LocalAgentControl) {
    this.routerUrl = routerUrl;
    this.supervisor = supervisor;
    this.agentControl = agentControl;
    this.unsubscribe = supervisor.subscribe(() => this.publishCatalog());
  }

  async ready(): Promise<void> {
    // Runtime-local dispatch ledgers are initialized by the Supervisor factory.
  }

  setDevice(credential: DeviceCredential): void {
    this.credential = credential;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.connected = false;
    if (this.reconnect !== undefined) clearTimeout(this.reconnect);
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    this.unsubscribe();
    this.socket?.close();
    this.resolveConnectionWaiters(false);
  }

  isConnected(): boolean { return this.connected; }

  async reconnectNow(timeoutMs = 5_000): Promise<boolean> {
    this.connected = false;
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    this.socket?.close();
    this.socket = undefined;
    this.connect();
    return await this.waitUntilConnected(timeoutMs);
  }

  /** Wait for the authenticated hello/ack handshake, not merely socket creation. */
  async waitUntilConnected(timeoutMs = 5_000): Promise<boolean> {
    if (this.connected) return true;
    if (this.stopped || this.credential === undefined || this.routerUrl === undefined) return false;
    let waiter: { readonly resolve: (connected: boolean) => void; readonly timer: NodeJS.Timeout };
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.connectionWaiters.delete(waiter);
        resolve(false);
      }, timeoutMs);
      waiter = { resolve, timer };
      this.connectionWaiters.add(waiter);
    });
  }

  setRouterUrl(routerUrl: string): void {
    this.routerUrl = new URL(routerUrl).toString();
    this.reconnectNow();
  }

  private connect(): void {
    const routerUrl = this.routerUrl;
    if (this.stopped || this.credential === undefined || routerUrl === undefined || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    const url = new URL("/v1/runtime-connections", routerUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${this.credential.agentToken}` } });
    this.socket = socket;
    socket.on("message", (raw) => void this.message(socket, raw.toString()));
    socket.on("close", () => this.retry(socket));
    socket.on("error", () => undefined);
  }

  private retry(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.connected = false;
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    if (!this.stopped) this.reconnect = setTimeout(() => this.connect(), 1_000);
  }

  private async message(socket: WebSocket, raw: string): Promise<void> {
    if (this.socket !== socket) return;
    let message: Record<string, unknown>;
    try { message = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (message.type === "connection.ready") {
      this.publishCatalog();
      return;
    }
    if (message.type === "agent.hello.ack") {
      this.connected = true;
      this.resolveConnectionWaiters(true);
      this.sendHeartbeat(socket);
      if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.sendHeartbeat(socket), 5_000);
      return;
    }
    if (message.type !== "rpc.request" || typeof message.messageId !== "string" || typeof message.method !== "string") return;
    try {
      const result = await this.invoke(typeof message.runtimeId === "string" ? message.runtimeId : undefined, message.method, record(message.payload));
      socket.send(JSON.stringify({ type: "rpc.response", messageId: message.messageId, ok: true, result }));
    } catch (error) {
      socket.send(JSON.stringify({ type: "rpc.response", messageId: message.messageId, ok: false, error: error instanceof Error ? error.message : String(error), statusCode: error !== null && typeof error === "object" && "status" in error ? error.status : undefined }));
    }
  }

  private sendHeartbeat(socket: WebSocket): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    for (const advertised of this.supervisor.advertisements()) {
      const runtime = this.supervisor.runtime(advertised.runtimeId);
      socket.send(JSON.stringify({
        type: "runtime.heartbeat",
        runtimeId: runtime.id,
        status: advertised.status,
        activeRunCount: runtime.activeRunIds.size,
        queuedRunCount: 0,
        maxConcurrentRuns: advertised.maxConcurrentRuns,
      }));
    }
  }

  private publishCatalog(): void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN || this.credential === undefined) return;
    socket.send(JSON.stringify({ type: "agent.hello", deviceId: this.credential.id, runtimes: this.supervisor.advertisements() }));
  }

  private resolveConnectionWaiters(connected: boolean): void {
    for (const waiter of this.connectionWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(connected);
    }
    this.connectionWaiters.clear();
  }

  private async invoke(runtimeId: string | undefined, method: string, payload: Record<string, unknown>): Promise<unknown> {
    if (runtimeId === undefined) {
      if (!method.startsWith("agent.") || this.agentControl === undefined) throw new Error("local_agent_method_unsupported");
      return await this.agentControl(method, payload);
    }
    // Historical artifact reads are a device data-plane operation, not a
    // Runtime admission operation. The Runtime may be stopped and therefore
    // absent from the ready catalog while its durable Run/workspace remains
    // readable by the Local Agent.
    if ((method === "artifacts" || method === "readArtifact" || method === "previewArtifact") && this.agentControl !== undefined) {
      return await this.agentControl(`runtime.${method}`, { ...payload, runtimeId });
    }
    return this.supervisor.withRuntimeUse(runtimeId, async runtime => {
      if (method === "dispatch") return await this.dispatch(runtime, payload as unknown as RuntimeDispatchEnvelope);
      if (method === "models") return runtime.modelKeys.map((key) => ({ key, displayName: key }));
      const remoteRunId = stringValue(payload.remoteRunId, "remoteRunId");
      const ownerUserId = await this.ownerForRun(runtime, remoteRunId);
      if (method === "getRun") {
        const run = await runtime.runs.get(ownerUserId, remoteRunId);
        if (run.status !== "running") await this.supervisor.runSettled(runtime.id, remoteRunId);
        return toStatus(run);
      }
      if (method === "events") {
        const afterSeq = Number.isSafeInteger(payload.afterSeq) ? Number(payload.afterSeq) : 0;
        return (await runtime.runs.events(ownerUserId, remoteRunId)).filter((event) => event.seq > afterSeq);
      }
      if (method === "latestEvent") {
        return await runtime.runs.latestEvent(ownerUserId, remoteRunId);
      }
      if (method === "cancelRun") {
        const run = await runtime.runs.cancel(ownerUserId, remoteRunId);
        await this.supervisor.runSettled(runtime.id, remoteRunId);
        return toStatus(run);
      }
      if (method === "artifacts") {
        return (await runtime.runs.processArtifacts(ownerUserId, remoteRunId)).map((artifact) => ({
          ...artifact,
          path: `local-artifact:${artifact.id}`,
        }));
      }
      if (method === "readArtifact") {
        const result = await runtime.runs.readProcessArtifact(ownerUserId, remoteRunId, stringValue(payload.artifactId, "artifactId"));
        return {
          artifact: localArtifact(result.artifact),
          // RPC is JSON-framed. The Router decodes this transient value and
          // streams it to the authenticated browser; it is never persisted by
          // the cloud artifact catalog for a local Runtime.
          contentBase64: result.content.toString("base64"),
        };
      }
      if (method === "previewArtifact") {
        return await runtime.runs.previewProcessArtifact(ownerUserId, remoteRunId, stringValue(payload.artifactId, "artifactId"));
      }
      if (method === "rounds") return await runtime.runs.roundHistory(ownerUserId, remoteRunId);
      if (method === "inputMessages") return await runtime.runs.inputMessages(ownerUserId, remoteRunId);
      if (method === "submitInput") {
        const input = record(payload.input);
        return await runtime.runs.submitInput(ownerUserId, remoteRunId, { requestId: stringValue(input.requestId, "requestId"), text: stringValue(input.text, "text") });
      }
      if (method === "currentHumanLoop") return await runtime.runs.currentHumanLoop(ownerUserId, remoteRunId);
      if (method === "respondHumanLoop") {
        const input = record(payload.input);
        return await runtime.runs.respondHumanLoop(ownerUserId, remoteRunId, stringValue(payload.requestId, "requestId"), input.value, input.expectedRevision);
      }
      throw new Error(`local_runtime_method_unsupported:${method}`);
    });
  }

  private async dispatch(runtime: LocalRuntimeControl, envelope: RuntimeDispatchEnvelope): Promise<{ readonly remoteRunId: string }> {
    if (envelope.schema !== "agentloop.runtimeDispatch/v1") throw new TypeError("runtime_dispatch_schema_invalid");
    if (envelope.executionTarget?.kind !== "local_device" || envelope.executionTarget.runtimeId !== runtime.id) {
      throw new TypeError("runtime_dispatch_target_mismatch");
    }
    return this.supervisor.withRuntimeUse(runtime.id, async current => {
      let admissions = this.admissions.get(current);
      if (admissions === undefined) {
        admissions = new LocalRunAdmissionService(current, {
          validateModel: current.assertModelAvailable,
          admit: start => this.supervisor.admitRun(current.id, start),
          settled: id => this.supervisor.runSettled(current.id, id),
        });
        this.admissions.set(current, admissions);
      }
      const run = await admissions.start(envelope.subject.userId, {
        requestId: `rpc:${createHash("sha256").update(envelope.dispatchKey).digest("hex")}`, input: envelope.input, modelKey: envelope.requestedModelKey ?? "",
        conversationId: envelope.conversationId, directoryScopeIds: envelope.localDirectoryScopeIds ?? [],
        uploadedSourceIds: envelope.localUploadedSourceIds ?? [], connectorConnectionIds: envelope.connectorConnectionIds,
        allowDangerousTools: envelope.allowDangerousTools,
      }, { dispatchKey: envelope.dispatchKey, assignmentId: envelope.assignmentId });
      return { remoteRunId: run.id };
    });
  }

  private async ownerForRun(runtime: LocalRuntimeControl, remoteRunId: string): Promise<string> {
    const row = await runtime.database.prepare("SELECT owner_user_id FROM local_runtime_dispatches WHERE remote_run_id = ?")
      .get(remoteRunId) as { owner_user_id: string } | undefined;
    if (row === undefined) throw new RangeError("local_run_not_found");
    return row.owner_user_id;
  }
}

function toStatus(run: { readonly id: string; readonly status: "running" | "completed" | "failed" | "cancelled"; readonly modelKey?: string; readonly output?: string; readonly errorCode?: string; readonly finishedAt?: number }): RuntimeRunStatus {
  return {
    remoteRunId: run.id,
    status: run.status,
    ...(run.modelKey === undefined ? {} : { modelKey: run.modelKey }),
    ...(run.output === undefined ? {} : { output: run.output }),
    ...(run.errorCode === undefined ? {} : { errorCode: run.errorCode }),
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
  };
}

/** Convert the Runtime-owned filesystem path into the shared transport identity. */
function localArtifact(artifact: RuntimeArtifact): RuntimeArtifact {
  return { ...artifact, path: `local-artifact:${artifact.id}` };
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("rpc_payload_invalid");
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label}_invalid`);
  return value;
}
