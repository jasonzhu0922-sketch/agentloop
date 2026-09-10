import type { RuntimeDispatchEnvelope, RuntimeEndpoint, RuntimeModelSummary, RuntimeRunEvent, RuntimeRunStatus, SubmitConversationTask } from "../domain/contracts.ts";
import type { ProcessArtifact } from "@zhujun/agentloop";
import { ControlPlaneStore, RuntimeCapacityError, type RuntimeCatalogEntry, type StoredAssignment } from "./control-plane-store.ts";

export class PersistentMultiRuntimeRouter {
  private readonly store: ControlPlaneStore;
  private readonly endpointFactory: (endpoint: string) => RuntimeEndpoint;
  private readonly heartbeatTtlMs: number;
  private readonly reservationTtlMs: number;
  private readonly now: () => number;

  constructor(input: {
    readonly store: ControlPlaneStore;
    readonly endpointFactory: (endpoint: string) => RuntimeEndpoint;
    readonly heartbeatTtlMs?: number;
    readonly reservationTtlMs?: number;
    readonly now?: () => number;
  }) {
    this.store = input.store;
    this.endpointFactory = input.endpointFactory;
    this.heartbeatTtlMs = input.heartbeatTtlMs ?? 15_000;
    this.reservationTtlMs = input.reservationTtlMs ?? 30_000;
    this.now = input.now ?? Date.now;
  }

  async submit(task: SubmitConversationTask): Promise<StoredAssignment> {
    rejectVisibleDirectoryInput(task);
    let assignment = await this.store.reserve(task, {
      heartbeatTtlMs: this.heartbeatTtlMs,
      reservationTtlMs: this.reservationTtlMs,
      now: this.now(),
    });
    if (assignment.status !== "reserved") return assignment;
    const endpoint = this.endpointFactory(assignment.runtimeEndpoint);
    try {
      const result = await endpoint.dispatch(toEnvelope(task, assignment));
      await this.store.markAccepted(assignment.id, result.remoteRunId, this.now());
      assignment = (await this.store.assignment(assignment.id)) ?? assignment;
      return assignment;
    } catch (error) {
      await this.store.markDispatchFailure(assignment.id, this.now());
      throw error;
    }
  }

  async models(): Promise<readonly RuntimeModelSummary[]> {
    const seen = new Map<string, RuntimeModelSummary>();
    const catalogs = await Promise.all((await this.store.runtimeEndpoints()).map(async (runtime) => {
      try { return await this.endpointFactory(runtime.endpoint).models?.() ?? []; } catch { return []; }
    }));
    for (const models of catalogs) for (const model of models) if (!seen.has(model.key)) seen.set(model.key, model);
    return [...seen.values()].sort((left, right) => left.key.localeCompare(right.key));
  }

  async runtimes(): Promise<readonly RuntimeCatalogEntry[]> {
    return await this.store.runtimeCatalog();
  }

  async assignment(id: string): Promise<{ readonly assignment: StoredAssignment; readonly run?: RuntimeRunStatus } | undefined> {
    const assignment = await this.store.assignment(id);
    if (assignment === undefined) return undefined;
    if (assignment.remoteRunId.length === 0) return { assignment };
    try {
      const run = await this.endpointFactory(assignment.runtimeEndpoint).getRun?.(assignment.remoteRunId);
      if (run !== undefined) await this.store.observeRun(assignment.id, run, this.now());
      const refreshed = await this.store.assignment(id);
      return {
        assignment: refreshed ?? assignment,
        ...(run === undefined ? {} : { run: mergeObservedFailure(run, refreshed ?? assignment) }),
      };
    } catch {
      return { assignment: { ...assignment, status: "unknown" } };
    }
  }

  async artifacts(id: string): Promise<{ readonly assignment: StoredAssignment; readonly artifacts: readonly ProcessArtifact[] } | undefined> {
    const assignment = await this.store.assignment(id);
    if (assignment === undefined) return undefined;
    if (assignment.remoteRunId.length === 0) return { assignment, artifacts: [] };
    const artifacts = await this.endpointFactory(assignment.runtimeEndpoint).artifacts?.(assignment.remoteRunId) ?? [];
    return { assignment, artifacts };
  }

  async readArtifact(id: string, artifactId: string): Promise<{ readonly assignment: StoredAssignment; readonly artifact: ProcessArtifact; readonly content: Uint8Array } | undefined> {
    const assignment = await this.store.assignment(id);
    if (assignment === undefined || assignment.remoteRunId.length === 0) return undefined;
    const result = await this.endpointFactory(assignment.runtimeEndpoint).readArtifact?.(assignment.remoteRunId, artifactId);
    return result === undefined ? undefined : { assignment, ...result };
  }

  async previewArtifact(id: string, artifactId: string): Promise<{ readonly assignment: StoredAssignment; readonly preview: unknown } | undefined> {
    const assignment = await this.store.assignment(id);
    if (assignment === undefined || assignment.remoteRunId.length === 0) return undefined;
    const preview = await this.endpointFactory(assignment.runtimeEndpoint).previewArtifact?.(assignment.remoteRunId, artifactId);
    return preview === undefined ? undefined : { assignment, preview };
  }

  async cancel(id: string): Promise<{ readonly assignment: StoredAssignment; readonly run: RuntimeRunStatus }> {
    const assignment = await this.store.assignment(id);
    if (assignment === undefined || assignment.remoteRunId.length === 0) throw new RangeError("assignment is not cancellable");
    const endpoint = this.endpointFactory(assignment.runtimeEndpoint);
    if (endpoint.cancelRun === undefined) throw new TypeError("Runtime endpoint does not support cancellation");
    const run = await endpoint.cancelRun(assignment.remoteRunId);
    await this.store.observeRun(assignment.id, run, this.now());
    return { assignment: (await this.store.assignment(id)) ?? assignment, run };
  }

  async events(id: string, afterSeq: number): Promise<{ readonly assignment: StoredAssignment; readonly events: readonly RuntimeRunEvent[] } | undefined> {
    const assignment = await this.store.assignment(id);
    if (assignment === undefined) return undefined;
    if (assignment.remoteRunId.length === 0) return { assignment, events: [] };
    const events = await this.endpointFactory(assignment.runtimeEndpoint).events?.(assignment.remoteRunId, afterSeq) ?? [];
    const terminalRun = terminalRunFromEvents(events, assignment.remoteRunId);
    if (terminalRun === undefined) return { assignment, events };

    // Event streaming is the normal browser-facing observation path.  Keep
    // the Router-owned Assignment projection in sync when it observes the
    // Host's terminal Run event, rather than requiring a separate assignment
    // status read to repair it later.
    await this.store.observeRun(id, terminalRun, this.now());
    return { assignment: (await this.store.assignment(id)) ?? assignment, events };
  }

  async currentHumanLoop(id: string) {
    const assignment = await this.store.assignment(id);
    if (assignment === undefined || assignment.remoteRunId.length === 0) return undefined;
    const request = await this.endpointFactory(assignment.runtimeEndpoint).currentHumanLoop?.(assignment.remoteRunId);
    return { assignment, request };
  }

  async respondHumanLoop(id: string, requestId: string, input: { readonly value: unknown; readonly expectedRevision: number }) {
    const assignment = await this.store.assignment(id);
    if (assignment === undefined || assignment.remoteRunId.length === 0) return undefined;
    const response = await this.endpointFactory(assignment.runtimeEndpoint).respondHumanLoop?.(assignment.remoteRunId, requestId, input);
    return response === undefined ? undefined : { assignment, response };
  }

  async heartbeat(input: Parameters<ControlPlaneStore["heartbeat"]>[0]): Promise<void> {
    await this.store.heartbeat(input);
  }

}

export { RuntimeCapacityError };

function terminalRunFromEvents(events: readonly RuntimeRunEvent[], remoteRunId: string): RuntimeRunStatus | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.type === "run.completed") return { remoteRunId, status: "completed" };
    if (event.type === "run.cancelled") return { remoteRunId, status: "cancelled" };
    if (event.type === "run.failed") {
      return {
        remoteRunId,
        status: "failed",
        ...(stringValue(event.data.code) === undefined ? {} : { errorCode: stringValue(event.data.code) }),
        ...(stringValue(event.data.message) === undefined ? {} : { errorMessage: stringValue(event.data.message) }),
      };
    }
  }
  return undefined;
}

function mergeObservedFailure(run: RuntimeRunStatus, assignment: StoredAssignment): RuntimeRunStatus {
  if (run.status !== "failed") return run;
  return {
    ...run,
    ...(run.errorCode === undefined && assignment.errorCode !== undefined ? { errorCode: assignment.errorCode } : {}),
    ...(run.errorMessage === undefined && assignment.errorMessage !== undefined ? { errorMessage: assignment.errorMessage } : {}),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function toEnvelope(task: SubmitConversationTask, assignment: StoredAssignment): RuntimeDispatchEnvelope {
  return {
    schema: "agentloop.runtimeDispatch/v1",
    assignmentId: assignment.id,
    dispatchKey: assignment.dispatchKey,
    subject: { tenantId: task.tenantId, userId: task.ownerUserId },
    conversationId: task.conversationId,
    input: task.input,
    ...(task.requestedRuntimeId === undefined ? {} : { requestedRuntimeId: task.requestedRuntimeId }),
    ...(task.requestedProfile === undefined ? {} : { requestedProfile: task.requestedProfile }),
    ...(task.requestedModelKey === undefined ? {} : { requestedModelKey: task.requestedModelKey }),
    allowDangerousTools: task.allowDangerousTools !== false,
    resourceRefs: task.resourceRefs ?? [],
  };
}

function rejectVisibleDirectoryInput(input: unknown): void {
  if (input !== null && typeof input === "object" && Object.hasOwn(input, "visibleDirectories")) {
    throw new TypeError("visibleDirectories are disabled for the cloud multi-runtime application");
  }
}
