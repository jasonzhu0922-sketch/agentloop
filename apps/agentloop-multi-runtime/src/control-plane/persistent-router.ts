import type { RuntimeDispatchEnvelope, RuntimeEndpoint, RuntimeModelSummary, RuntimeRunEvent, RuntimeRunStatus, SubmitConversationTask } from "../domain/contracts.ts";
import type { CommandOutputContent, ProcessArtifact, RecoveryDetail, ToolArgumentsContent } from "@zhujun/agentloop";
import { RuntimeCapacityError, type ControlPlaneRepository, type RuntimeCatalogEntry, type StoredAssignment } from "./control-plane-store.ts";
import { SharedWorkspaceArtifactCatalog } from "../artifacts/shared-workspace-artifact-catalog.ts";

export class PersistentMultiRuntimeRouter {
  private readonly store: ControlPlaneRepository;
  private readonly endpointFactory: (endpoint: string) => RuntimeEndpoint;
  private readonly heartbeatTtlMs: number;
  private readonly reservationTtlMs: number;
  private readonly now: () => number;
  private readonly artifactsCatalog?: SharedWorkspaceArtifactCatalog;
  private observationCursor = "";
  private reconciliation?: Promise<void>;

  constructor(input: {
    readonly store: ControlPlaneRepository;
    readonly endpointFactory: (endpoint: string) => RuntimeEndpoint;
    readonly heartbeatTtlMs?: number;
    readonly reservationTtlMs?: number;
    readonly now?: () => number;
    readonly artifactsCatalog?: SharedWorkspaceArtifactCatalog;
  }) {
    this.store = input.store;
    this.endpointFactory = input.endpointFactory;
    this.heartbeatTtlMs = input.heartbeatTtlMs ?? 15_000;
    this.reservationTtlMs = input.reservationTtlMs ?? 30_000;
    this.now = input.now ?? Date.now;
    this.artifactsCatalog = input.artifactsCatalog;
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

  async models(tenantId?: string, ownerUserId?: string): Promise<readonly RuntimeModelSummary[]> {
    const seen = new Map<string, RuntimeModelSummary>();
    const catalogs = await Promise.all((await this.store.runtimeEndpoints(tenantId, ownerUserId)).map(async (runtime) => {
      try { return await this.endpointFactory(runtime.endpoint).models?.() ?? []; } catch { return []; }
    }));
    for (const models of catalogs) for (const model of models) if (!seen.has(model.key)) seen.set(model.key, model);
    return [...seen.values()].sort((left, right) => left.key.localeCompare(right.key));
  }

  /** Reconcile projection only. Never dispatch, resume, cancel, or infer failure from transport errors. */
  reconcileAssignments(limit = 100): Promise<void> {
    if (this.reconciliation !== undefined) return this.reconciliation;
    this.reconciliation = this.reconcileAssignmentBatch(limit).finally(() => { this.reconciliation = undefined; });
    return this.reconciliation;
  }

  private async reconcileAssignmentBatch(limit: number): Promise<void> {
    let assignments = await this.store.unsettledAssignments(this.observationCursor, limit);
    if (assignments.length === 0 && this.observationCursor !== "") {
      this.observationCursor = "";
      assignments = await this.store.unsettledAssignments("", limit);
    }
    for (let offset = 0; offset < assignments.length; offset += 4) {
      await Promise.all(assignments.slice(offset, offset + 4).map(async (assignment) => {
        let run: RuntimeRunStatus | undefined;
        try {
          run = await this.endpointFactory(assignment.runtimeEndpoint).getRun?.(assignment.remoteRunId);
          if (run !== undefined && run.remoteRunId === assignment.remoteRunId) await this.observeHostRun(assignment, run);
        }
        catch { return; } // Keep the last observed state; retry on a later pass.
      }));
    }
    this.observationCursor = assignments.at(-1)?.id ?? "";
  }

  async runtimes(tenantId?: string, ownerUserId?: string): Promise<readonly RuntimeCatalogEntry[]> {
    return await this.store.runtimeCatalog(tenantId, ownerUserId);
  }

  async conversations(
    tenantId: string,
    ownerUserId: string,
    page: { readonly limit: number; readonly offset: number },
  ) {
    return await this.store.listConversations(tenantId, ownerUserId, page);
  }

  async conversation(tenantId: string, ownerUserId: string, conversationId: string) {
    return await this.store.conversation(tenantId, ownerUserId, conversationId);
  }

  async deleteConversation(tenantId: string, ownerUserId: string, conversationId: string): Promise<void> {
    await this.store.deleteConversation(tenantId, ownerUserId, conversationId);
  }

  async assignment(id: string): Promise<{ readonly assignment: StoredAssignment; readonly run?: RuntimeRunStatus } | undefined> {
    const assignment = await this.store.assignment(id);
    if (assignment === undefined) return undefined;
    if (assignment.remoteRunId.length === 0) return { assignment };
    try {
      const run = await this.endpointFactory(assignment.runtimeEndpoint).getRun?.(assignment.remoteRunId);
      if (run !== undefined && run.remoteRunId === assignment.remoteRunId) await this.observeHostRun(assignment, run);
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
    const catalogued = await this.artifactsCatalog?.list(assignment.id) ?? [];
    if (catalogued.length > 0) return { assignment, artifacts: catalogued };
    const artifacts = await this.endpointFactory(assignment.runtimeEndpoint).artifacts?.(assignment.remoteRunId) ?? [];
    if (assignment.runtimeEndpoint.startsWith("local-runtime://")) return { assignment, artifacts };
    return { assignment, artifacts: await this.captureArtifacts(assignment, artifacts) };
  }

  async readArtifact(id: string, artifactId: string): Promise<{ readonly assignment: StoredAssignment; readonly artifact: ProcessArtifact; readonly content: Uint8Array } | undefined> {
    const assignment = await this.store.assignment(id);
    if (assignment === undefined || assignment.remoteRunId.length === 0) return undefined;
    const catalogued = await this.artifactsCatalog?.read(assignment.id, artifactId);
    if (catalogued !== undefined) return { assignment, ...catalogued };
    const result = await this.endpointFactory(assignment.runtimeEndpoint).readArtifact?.(assignment.remoteRunId, artifactId);
    return result === undefined ? undefined : { assignment, ...result };
  }

  async previewArtifact(id: string, artifactId: string): Promise<{ readonly assignment: StoredAssignment; readonly preview: unknown } | undefined> {
    const assignment = await this.store.assignment(id);
    if (assignment === undefined || assignment.remoteRunId.length === 0) return undefined;
    const catalogued = await this.artifactsCatalog?.preview(assignment.id, artifactId);
    if (catalogued !== undefined) return { assignment, preview: catalogued };
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
    const terminalEventRun = terminalRunFromEvents(events, assignment.remoteRunId);
    if (terminalEventRun === undefined) return { assignment, events };

    // A terminal event is only a lightweight notification. Hydrate it from
    // the Host before emitting it to the browser, so the persisted turn and
    // shared artifact catalog are already coherent when the UI handles the
    // event and requests its final products.
    const terminalRun = await this.hydrateTerminalEventRun(assignment, terminalEventRun);
    await this.store.observeRun(id, terminalRun, this.now());
    return { assignment: (await this.store.assignment(id)) ?? assignment, events };
  }

  async commandOutput(id: string, toolCallId: string, stream: "stdout" | "stderr"): Promise<{ readonly assignment: StoredAssignment; readonly output: CommandOutputContent } | undefined> {
    const assignment = await this.store.assignment(id);
    if (assignment === undefined || assignment.remoteRunId.length === 0) return undefined;
    const output = await this.endpointFactory(assignment.runtimeEndpoint).commandOutput?.(assignment.remoteRunId, toolCallId, stream);
    return output === undefined ? undefined : { assignment, output };
  }

  async toolArguments(id: string, toolCallId: string): Promise<{ readonly assignment: StoredAssignment; readonly arguments: ToolArgumentsContent } | undefined> {
    const assignment = await this.store.assignment(id);
    if (assignment === undefined || assignment.remoteRunId.length === 0) return undefined;
    const argumentsContent = await this.endpointFactory(assignment.runtimeEndpoint).toolArguments?.(assignment.remoteRunId, toolCallId);
    return argumentsContent === undefined ? undefined : { assignment, arguments: argumentsContent };
  }

  async advanceRecovery(id: string): Promise<{ readonly assignment: StoredAssignment; readonly recovery: RecoveryDetail } | undefined> {
    const assignment = await this.store.assignment(id);
    if (assignment === undefined || assignment.remoteRunId.length === 0) return undefined;
    const advanceRecovery = this.endpointFactory(assignment.runtimeEndpoint).advanceRecovery;
    if (advanceRecovery === undefined) throw new TypeError("Runtime endpoint does not support recovery advance");
    return { assignment, recovery: await advanceRecovery(assignment.remoteRunId) };
  }

  async resumeRecovery(id: string): Promise<{ readonly assignment: StoredAssignment; readonly run: RuntimeRunStatus } | undefined> {
    const assignment = await this.store.assignment(id);
    if (assignment === undefined || assignment.remoteRunId.length === 0) return undefined;
    const resumeRecovery = this.endpointFactory(assignment.runtimeEndpoint).resumeRecovery;
    if (resumeRecovery === undefined) throw new TypeError("Runtime endpoint does not support recovery resume");
    const run = await resumeRecovery(assignment.remoteRunId);
    await this.store.observeRun(assignment.id, run, this.now());
    return { assignment: (await this.store.assignment(id)) ?? assignment, run };
  }

  async startFromCheckpoint(id: string): Promise<{ readonly assignment: StoredAssignment; readonly run: RuntimeRunStatus } | undefined> {
    const assignment = await this.store.assignment(id);
    if (assignment === undefined || assignment.remoteRunId.length === 0) return undefined;
    const start = this.endpointFactory(assignment.runtimeEndpoint).startFromCheckpoint;
    if (start === undefined) throw new TypeError("Runtime endpoint does not support checkpoint continuation");
    const run = await start(assignment.remoteRunId);
    const continuation = await this.store.createContinuationAssignment(assignment.id, run.remoteRunId, this.now());
    return { assignment: continuation, run };
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

  async heartbeat(input: Parameters<ControlPlaneRepository["heartbeat"]>[0]): Promise<void> {
    await this.store.heartbeat(input);
  }

  private async captureArtifacts(assignment: StoredAssignment, artifacts: readonly ProcessArtifact[]): Promise<readonly ProcessArtifact[]> {
    if (this.artifactsCatalog === undefined || artifacts.length === 0) return artifacts;
    return await this.artifactsCatalog.capture({
      assignmentId: assignment.id, tenantId: assignment.tenantId, ownerUserId: assignment.ownerUserId,
      conversationId: assignment.conversationId, remoteRunId: assignment.remoteRunId, artifacts,
    });
  }

  private async hydrateTerminalEventRun(assignment: StoredAssignment, eventRun: RuntimeRunStatus): Promise<RuntimeRunStatus> {
    const endpoint = this.endpointFactory(assignment.runtimeEndpoint);
    if (endpoint.getRun === undefined) return eventRun;
    const hostRun = await endpoint.getRun(assignment.remoteRunId);
    if (hostRun.remoteRunId !== assignment.remoteRunId) throw new TypeError("terminal_event_run_identity_mismatch");
    if (!isTerminalRunStatus(hostRun.status)) throw new TypeError("terminal_event_host_status_not_terminal");
    if (hostRun.artifacts !== undefined && hostRun.artifacts.length > 0) await this.captureArtifacts(assignment, hostRun.artifacts);
    // The terminal event is the source of the exact completion instant; some
    // Host status APIs omit finishedAt even though their event stream records it.
    return {
      ...hostRun,
      ...(hostRun.output === undefined && eventRun.output !== undefined ? { output: eventRun.output } : {}),
      ...(hostRun.partialOutput === undefined && eventRun.partialOutput !== undefined ? { partialOutput: eventRun.partialOutput } : {}),
      ...(hostRun.errorCode === undefined && eventRun.errorCode !== undefined ? { errorCode: eventRun.errorCode } : {}),
      ...(hostRun.errorMessage === undefined && eventRun.errorMessage !== undefined ? { errorMessage: eventRun.errorMessage } : {}),
      ...(eventRun.finishedAt === undefined ? {} : { finishedAt: eventRun.finishedAt }),
    };
  }

  /**
   * Host status polling is the terminal-state authority.  Persist its artifact
   * receipts before projecting a terminal status, so the Router does not
   * advertise a completed assignment whose shared-workspace artifacts have
   * never been captured.  On a transient shared-workspace error the caller
   * keeps the assignment unsettled and retries the complete observation.
   */
  private async observeHostRun(assignment: StoredAssignment, run: RuntimeRunStatus): Promise<void> {
    if (run.artifacts !== undefined && run.artifacts.length > 0) await this.captureArtifacts(assignment, run.artifacts);
    await this.store.observeRun(assignment.id, run, this.now());
  }

}

export { RuntimeCapacityError };

function terminalRunFromEvents(events: readonly RuntimeRunEvent[], remoteRunId: string): RuntimeRunStatus | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.type === "run.completed") return { remoteRunId, status: "completed", finishedAt: event.createdAt };
    if (event.type === "run.cancelled") return { remoteRunId, status: "cancelled", finishedAt: event.createdAt };
    if (event.type === "run.failed") {
      return {
        remoteRunId,
        status: "failed",
        finishedAt: event.createdAt,
        ...(stringValue(event.data.code) === undefined ? {} : { errorCode: stringValue(event.data.code) }),
        ...(stringValue(event.data.message) === undefined ? {} : { errorMessage: stringValue(event.data.message) }),
      };
    }
  }
  return undefined;
}

function isTerminalRunStatus(status: RuntimeRunStatus["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
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
    executionTarget: task.executionTarget ?? { kind: "cloud_pool", ...(task.requestedProfile === undefined ? {} : { profile: task.requestedProfile }) },
    dataPolicy: task.dataPolicy ?? { mode: "cloud" },
    ...(task.requestedRuntimeId === undefined ? {} : { requestedRuntimeId: task.requestedRuntimeId }),
    ...(task.requestedProfile === undefined ? {} : { requestedProfile: task.requestedProfile }),
    ...(task.requestedModelKey === undefined ? {} : { requestedModelKey: task.requestedModelKey }),
    allowDangerousTools: task.allowDangerousTools !== false,
    resourceRefs: task.resourceRefs ?? [],
    ...(task.localDirectoryScopeIds === undefined ? {} : { localDirectoryScopeIds: task.localDirectoryScopeIds }),
    ...(task.localUploadedSourceIds === undefined ? {} : { localUploadedSourceIds: task.localUploadedSourceIds }),
  };
}

function rejectVisibleDirectoryInput(input: unknown): void {
  if (input !== null && typeof input === "object" && Object.hasOwn(input, "visibleDirectories")) {
    throw new TypeError("visibleDirectories are disabled for the cloud multi-runtime application");
  }
}
