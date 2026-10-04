import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { RuntimeDispatchOutcomeUnknownError, type ControlPlaneRepository } from "../application/control-plane-contracts.ts";
import type { RuntimeArtifact, RuntimeArtifactPreview, RuntimeEndpoint, RuntimeProfile } from "../../shared/contracts.ts";
import type { AuthenticatedDeviceAgent, DeviceRepository } from "./device-service.ts";

interface RuntimeAdvertisement {
  readonly runtimeId: string;
  readonly displayName?: string;
  readonly profile: RuntimeProfile;
  readonly capabilities: readonly string[];
  readonly maxConcurrentRuns: number;
  readonly status: "ready" | "draining";
  readonly catalogVersion: string;
}

interface ConnectionState {
  readonly id: string;
  readonly epoch: number;
  readonly socket: WebSocket;
  readonly device: AuthenticatedDeviceAgent;
  readonly runtimeIds: Set<string>;
  readonly pending: Map<string, { readonly method: string; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>;
}

/** Router-side registry for outbound Local Runtime Agent connections. */
export class DeviceRuntimeConnectionRegistry {
  private readonly connections = new Map<string, ConnectionState>();
  private readonly runtimeConnections = new Map<string, ConnectionState>();
  private readonly server = new WebSocketServer({ noServer: true });
  private readonly leaseMs: number;
  private readonly devices: Pick<DeviceRepository, "authenticateAgent">;
  private readonly store: ControlPlaneRepository;

  constructor(
    devices: Pick<DeviceRepository, "authenticateAgent">,
    store: ControlPlaneRepository,
    input: { readonly leaseMs?: number } = {},
  ) {
    this.devices = devices;
    this.store = store;
    this.leaseMs = input.leaseMs ?? 20_000;
  }

  attach(server: Server): void {
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://router.local");
      if (url.pathname !== "/v1/runtime-connections") return socket.destroy();
      void this.acceptUpgrade(request, socket, head);
    });
  }

  endpoint(runtimeId: string): RuntimeEndpoint {
    const rpc = <T>(method: string, payload: unknown): Promise<T> => this.rpc<T>(runtimeId, method, payload);
    return {
      dispatch: (envelope) => rpc("dispatch", envelope),
      models: () => rpc("models", {}),
      getRun: (remoteRunId) => rpc("getRun", { remoteRunId }),
      hostRun: (remoteRunId) => rpc("hostRun", { remoteRunId }),
      events: (remoteRunId, afterSeq) => rpc("events", { remoteRunId, afterSeq }),
      cancelRun: (remoteRunId) => rpc("cancelRun", { remoteRunId }),
      artifacts: (remoteRunId) => rpc("artifacts", { remoteRunId }),
      readArtifact: async (remoteRunId, artifactId) => {
        const result = await rpc<{ readonly artifact: RuntimeArtifact; readonly contentBase64: string }>("readArtifact", { remoteRunId, artifactId });
        if (result === null || typeof result !== "object" || typeof result.contentBase64 !== "string" || result.artifact === undefined) {
          throw new TypeError("local_runtime_artifact_response_invalid");
        }
        return { artifact: result.artifact, content: new Uint8Array(Buffer.from(result.contentBase64, "base64")) };
      },
      previewArtifact: (remoteRunId, artifactId) => rpc<RuntimeArtifactPreview>("previewArtifact", { remoteRunId, artifactId }),
      commandOutput: (remoteRunId, toolCallId, stream) => rpc("commandOutput", { remoteRunId, toolCallId, stream }),
      toolArguments: (remoteRunId, toolCallId) => rpc("toolArguments", { remoteRunId, toolCallId }),
      currentHumanLoop: (remoteRunId) => rpc("currentHumanLoop", { remoteRunId }),
      respondHumanLoop: (remoteRunId, requestId, input) => rpc("respondHumanLoop", { remoteRunId, requestId, input }),
    };
  }

  /** Authenticated Router-to-Agent device control.  This never opens a LAN connection. */
  agentControl<T>(input: { readonly tenantId: string; readonly ownerUserId: string; readonly deviceId: string; readonly method: string; readonly payload?: Record<string, unknown> }): Promise<T> {
    const state = [...this.connections.values()].find((candidate) => candidate.device.deviceId === input.deviceId
      && candidate.device.tenantId === input.tenantId && candidate.device.ownerUserId === input.ownerUserId);
    if (state === undefined || state.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("device_unavailable"));
    return this.rpcOnConnection<T>(state, undefined, input.method, input.payload ?? {});
  }

  private async acceptUpgrade(request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): Promise<void> {
    try {
      const authorization = Array.isArray(request.headers.authorization) ? request.headers.authorization[0] : request.headers.authorization;
      const device = await this.devices.authenticateAgent(authorization?.replace(/^Bearer\s+/i, ""));
      this.server.handleUpgrade(request, socket, head, (webSocket) => this.open(webSocket, device));
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  }

  private open(socket: WebSocket, device: AuthenticatedDeviceAgent): void {
    const state: ConnectionState = {
      id: `connection_${randomUUID()}`,
      epoch: Date.now(),
      socket,
      device,
      runtimeIds: new Set(),
      pending: new Map(),
    };
    this.connections.set(state.id, state);
    socket.on("message", (raw) => void this.message(state, raw.toString()).catch(() => socket.close(1011, "runtime_connection_error")));
    socket.on("close", () => void this.close(state).catch(() => undefined));
    socket.on("error", () => undefined);
    socket.send(JSON.stringify({ type: "connection.ready", connectionId: state.id, connectionEpoch: state.epoch }));
  }

  private async message(state: ConnectionState, raw: string): Promise<void> {
    let message: Record<string, unknown>;
    try { message = JSON.parse(raw) as Record<string, unknown>; } catch { return state.socket.close(1003, "invalid_json"); }
    if (message.type === "rpc.response") {
      const pending = typeof message.messageId === "string" ? state.pending.get(message.messageId) : undefined;
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      state.pending.delete(message.messageId as string);
      if (message.ok === true) pending.resolve(message.result);
      else pending.reject(new Error(typeof message.error === "string" ? message.error : "local_runtime_rpc_failed"));
      return;
    }
    if (message.type === "agent.hello") {
      if (message.deviceId !== state.device.deviceId || !Array.isArray(message.runtimes)) return state.socket.close(1008, "device_mismatch");
      await this.registerAdvertisements(state, message.runtimes as RuntimeAdvertisement[]);
      state.socket.send(JSON.stringify({ type: "agent.hello.ack", connectionId: state.id, connectionEpoch: state.epoch }));
      return;
    }
    if (message.type === "runtime.heartbeat" && typeof message.runtimeId === "string" && state.runtimeIds.has(message.runtimeId)) {
      await this.store.heartbeat({
        runtimeId: message.runtimeId,
        status: message.status === "draining" ? "draining" : "ready",
        activeRunCount: integer(message.activeRunCount, 0),
        queuedRunCount: integer(message.queuedRunCount, 0),
        ...(message.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: integer(message.maxConcurrentRuns, 1) }),
        observedAt: Date.now(),
      });
    }
  }

  private async registerAdvertisements(state: ConnectionState, values: RuntimeAdvertisement[]): Promise<void> {
    const advertisedIds = new Set(values.map((value) => value.runtimeId));
    for (const runtimeId of [...state.runtimeIds]) {
      if (advertisedIds.has(runtimeId)) continue;
      state.runtimeIds.delete(runtimeId);
      if (this.runtimeConnections.get(runtimeId) === state) this.runtimeConnections.delete(runtimeId);
      await this.store.unregisterLocalRuntime(runtimeId, state.id);
    }
    for (const value of values) {
      if (!validAdvertisement(value)) throw new TypeError("invalid_runtime_advertisement");
      const previous = this.runtimeConnections.get(value.runtimeId);
      if (previous !== undefined && previous !== state && previous.epoch > state.epoch) continue;
      await this.store.registerLocalRuntime({
        ...value,
        deviceId: state.device.deviceId,
        tenantId: state.device.tenantId,
        ownerUserId: state.device.ownerUserId,
        connectionId: state.id,
        connectionEpoch: state.epoch,
        leaseExpiresAt: Date.now() + this.leaseMs,
      });
      if (previous !== undefined && previous !== state) previous.socket.close(4001, "connection_replaced");
      this.runtimeConnections.set(value.runtimeId, state);
      state.runtimeIds.add(value.runtimeId);
    }
  }

  private async close(state: ConnectionState): Promise<void> {
    this.connections.delete(state.id);
    for (const runtimeId of state.runtimeIds) {
      if (this.runtimeConnections.get(runtimeId) === state) this.runtimeConnections.delete(runtimeId);
    }
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(pending.method === "dispatch"
        ? new RuntimeDispatchOutcomeUnknownError("local_runtime_dispatch_ack_lost")
        : new Error("device_unavailable"));
    }
    state.pending.clear();
    await this.store.disconnectLocalRuntimes(state.id);
  }

  private rpc<T>(runtimeId: string, method: string, payload: unknown): Promise<T> {
    const state = this.runtimeConnections.get(runtimeId);
    if (state === undefined || state.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("device_unavailable"));
    return this.rpcOnConnection<T>(state, runtimeId, method, payload);
  }

  private rpcOnConnection<T>(state: ConnectionState, runtimeId: string | undefined, method: string, payload: unknown): Promise<T> {
    const messageId = `rpc_${randomUUID()}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(messageId);
        reject(method === "dispatch"
          ? new RuntimeDispatchOutcomeUnknownError("local_runtime_dispatch_ack_lost")
          : new Error("local_runtime_rpc_timeout"));
      }, 30_000);
      state.pending.set(messageId, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        state.socket.send(JSON.stringify({ type: "rpc.request", messageId, connectionEpoch: state.epoch, ...(runtimeId === undefined ? {} : { runtimeId }), method, payload }));
      } catch {
        clearTimeout(timer);
        state.pending.delete(messageId);
        reject(method === "dispatch"
          ? new RuntimeDispatchOutcomeUnknownError("local_runtime_dispatch_ack_lost")
          : new Error("device_unavailable"));
      }
    });
  }
}

function validAdvertisement(value: RuntimeAdvertisement): boolean {
  return value !== null && typeof value === "object"
    && typeof value.runtimeId === "string" && value.runtimeId.length > 0
    && (value.displayName === undefined || (typeof value.displayName === "string" && value.displayName.trim().length > 0 && value.displayName.length <= 100))
    && (value.profile === "general" || value.profile === "artifact")
    && Array.isArray(value.capabilities) && value.capabilities.every((item) => typeof item === "string")
    && Number.isSafeInteger(value.maxConcurrentRuns) && value.maxConcurrentRuns > 0
    && (value.status === "ready" || value.status === "draining")
    && typeof value.catalogVersion === "string";
}

function integer(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}
