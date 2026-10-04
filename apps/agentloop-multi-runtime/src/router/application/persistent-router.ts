import type { RouterRunDetail, RouterRunPage, RouterRunSummary, RuntimeArtifact, RuntimeCommandOutput, RuntimeDispatchEnvelope, RuntimeEndpoint, RuntimeModelSummary, RuntimeRecoveryDetail, RuntimeRunEvent, RuntimeRunOperationsProjection, RuntimeRunStatus, RuntimeToolArguments, SubmitConversationTask } from "../../shared/contracts.ts";
import {
  RuntimeCapacityError,
  RuntimeDispatchOutcomeUnknownError,
  type ControlPlaneRepository,
  type PersistedRunOperations,
  type DispatchFailure,
  type RouterArtifactCatalog,
  type RuntimeCatalogEntry,
  type RuntimeCatalogPage,
  type StoredAssignment,
} from "./control-plane-contracts.ts";
import { RouterModelCatalog, type RouterModelCatalogView, type RouterModelConfiguration, type UpsertRouterModelInput, type UpsertRouterProviderInput } from "../model-catalog/model-catalog.ts";

export interface RouterDispatchFailureLog {
  readonly assignmentId: string;
  readonly runtimeId: string;
  readonly conversationId: string;
  readonly dispatchKey: string;
  readonly code: string;
  /** Redacted operational diagnostic. It is never stored in the control plane. */
  readonly diagnostic: string;
}

export class PersistentMultiRuntimeRouter {
  private readonly store: ControlPlaneRepository;
  private readonly endpointFactory: (endpoint: string) => RuntimeEndpoint;
  private readonly heartbeatTtlMs: number;
  private readonly reservationTtlMs: number;
  private readonly now: () => number;
  private readonly artifactsCatalog?: RouterArtifactCatalog;
  private readonly onDispatchFailure?: (event: RouterDispatchFailureLog) => void;
  private readonly modelCatalogStore?: RouterModelCatalog;
  private observationCursor = "";
  private reconciliation?: Promise<void>;

  constructor(input: {
    readonly store: ControlPlaneRepository;
    readonly endpointFactory: (endpoint: string) => RuntimeEndpoint;
    readonly heartbeatTtlMs?: number;
    readonly reservationTtlMs?: number;
    readonly now?: () => number;
    readonly artifactsCatalog?: RouterArtifactCatalog;
    readonly onDispatchFailure?: (event: RouterDispatchFailureLog) => void;
    readonly modelCatalog?: RouterModelCatalog;
  }) {
    this.store = input.store;
    this.endpointFactory = input.endpointFactory;
    this.heartbeatTtlMs = input.heartbeatTtlMs ?? 15_000;
    this.reservationTtlMs = input.reservationTtlMs ?? 30_000;
    this.now = input.now ?? Date.now;
    this.artifactsCatalog = input.artifactsCatalog;
    this.onDispatchFailure = input.onDispatchFailure;
    this.modelCatalogStore = input.modelCatalog;
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
      if (error instanceof RuntimeDispatchOutcomeUnknownError) throw error;
      const failure = dispatchFailureFor(error);
      await this.store.markDispatchFailure(assignment.id, failure, this.now());
      this.emitDispatchFailure({
        assignmentId: assignment.id,
        runtimeId: assignment.runtimeId,
        conversationId: assignment.conversationId,
        dispatchKey: assignment.dispatchKey,
        code: failure.code,
        diagnostic: diagnosticFor(error),
      });
      if (isRuntimeCapacityFailure(error)) throw new RuntimeCapacityError("runtime_capacity_exhausted");
      const failed = await this.store.assignment(assignment.id);
      if (failed?.status === "failed") return failed;
      throw error;
    }
  }

  async models(tenantId?: string, ownerUserId?: string): Promise<readonly RuntimeModelSummary[]> {
    if (this.modelCatalogStore !== undefined) {
      const catalog = await this.modelCatalogStore.view();
      return catalog.providers.flatMap((provider) => provider.models.map((model) => ({ key: model.key, displayName: model.displayName }))).sort((left, right) => left.key.localeCompare(right.key));
    }
    const seen = new Map<string, RuntimeModelSummary>();
    const catalogs = await Promise.all((await this.store.runtimeEndpoints(tenantId, ownerUserId)).map(async (runtime) => {
      try { return await this.endpointFactory(runtime.endpoint).models?.() ?? []; } catch { return []; }
    }));
    for (const models of catalogs) for (const model of models) if (!seen.has(model.key)) seen.set(model.key, model);
    return [...seen.values()].sort((left, right) => left.key.localeCompare(right.key));
  }

  async modelCatalog(): Promise<RouterModelCatalogView> {
    if (this.modelCatalogStore === undefined) throw new Error("Router model catalog is not configured");
    return await this.modelCatalogStore.view();
  }

  async modelConfiguration(): Promise<RouterModelConfiguration> {
    if (this.modelCatalogStore === undefined) throw new Error("Router model catalog is not configured");
    return await this.modelCatalogStore.configuration();
  }

  async upsertModelProvider(input: UpsertRouterProviderInput): Promise<RouterModelCatalogView> {
    if (this.modelCatalogStore === undefined) throw new Error("Router model catalog is not configured");
    return await this.modelCatalogStore.upsertProvider(input);
  }

  async upsertModel(input: UpsertRouterModelInput): Promise<RouterModelCatalogView> {
    if (this.modelCatalogStore === undefined) throw new Error("Router model catalog is not configured");
    return await this.modelCatalogStore.upsertModel(input);
  }

  async removeModel(modelKey: string): Promise<RouterModelCatalogView> {
    if (this.modelCatalogStore === undefined) throw new Error("Router model catalog is not configured");
    return await this.modelCatalogStore.removeModel(modelKey);
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

  /** Privileged Admin projection; caller authorization is enforced by Router HTTP. */
  async adminRuntimes(input: { readonly scopeId?: string; readonly limit: number; readonly offset: number }): Promise<RuntimeCatalogPage> {
    return await this.store.adminRuntimeCatalog(input);
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

  /** Admin-only read model. Router facts are always returned even when Host hydration is unavailable. */
  async adminRuns(page: { readonly limit: number; readonly offset: number }): Promise<RouterRunPage> {
    const result = await this.store.listAdminRuns(page);
    const items = await Promise.all(result.items.map(async (summary) => {
      const projection = await this.hostProjection(summary).catch(() => undefined);
      if (projection === undefined) {
        const artifacts = await this.cataloguedArtifacts(summary);
        return artifacts.length === 0 ? summary : { ...summary, artifactCount: artifacts.length };
      }
      return {
        ...summary,
        status: projection.run.status,
        ...(projection.run.modelKey === undefined ? {} : { modelKey: projection.run.modelKey }),
        ...(projection.outcome?.output ?? projection.run.output) === undefined ? {} : { output: projection.outcome?.output ?? projection.run.output },
        ...(projection.run.errorCode === undefined ? {} : { errorCode: projection.run.errorCode }),
        planState: projection.plan.state,
        planStepCount: projection.plan.steps.length,
        artifactCount: projection.artifacts.length,
      };
    }));
    return { ...result, items };
  }

  async adminRun(id: string): Promise<RouterRunDetail | undefined> {
    const summary = await this.store.adminRun(id);
    if (summary === undefined) return undefined;
    const missingBoundaries: Array<"router" | "runtime"> = [];
    const projection = await this.hostProjection(summary).catch(() => undefined);
    if (projection !== undefined && summary.assignmentId !== undefined) await this.store.persistRunOperations(summary.assignmentId, projection);
    let persistedOperations = summary.assignmentId === undefined ? undefined : await this.store.readRunOperations(summary.assignmentId);
    if (persistedOperations === undefined && projection === undefined && summary.assignmentId !== undefined) {
      const replay = await this.events(summary.assignmentId, 0).catch(() => undefined);
      const replayedOperations = replay === undefined ? undefined : operationsFromEvents(replay.events);
      if (replayedOperations !== undefined) {
        await this.store.persistRunOperations(summary.assignmentId, { plan: replayedOperations.plan, ...(replayedOperations.outcome === undefined ? {} : { outcome: replayedOperations.outcome }), schema: "agentloop.hostRun/v1", run: { id: summary.id, status: summary.status, createdAt: summary.createdAt } } as RuntimeRunOperationsProjection);
        persistedOperations = replayedOperations;
      }
    }
    if (summary.remoteRunId !== undefined && projection === undefined && persistedOperations === undefined) missingBoundaries.push("runtime");
    if (summary.remoteRunId === undefined && persistedOperations === undefined) missingBoundaries.push("runtime");
    return {
      ...summary,
      ...(projection === undefined ? (persistedOperations === undefined ? {} : {
        plan: persistedOperations.plan,
        ...(persistedOperations.outcome === undefined ? {} : { outcome: persistedOperations.outcome }),
        planState: persistedOperations.plan.state,
        planStepCount: persistedOperations.plan.steps.length,
      }) : {
        status: projection.run.status,
        ...(projection.run.modelKey === undefined ? {} : { modelKey: projection.run.modelKey }),
        ...(projection.outcome?.output ?? projection.run.output) === undefined ? {} : { output: projection.outcome?.output ?? projection.run.output },
        ...(projection.run.errorCode === undefined ? {} : { errorCode: projection.run.errorCode }),
        plan: projection.plan,
        outcome: projection.outcome,
        artifacts: projection.artifacts,
        eventCursor: projection.eventCursor,
        planState: projection.plan.state,
        planStepCount: projection.plan.steps.length,
        artifactCount: projection.artifacts.length,
      }),
      artifacts: projection?.artifacts ?? await this.cataloguedArtifacts(summary),
      missingBoundaries,
    };
  }

  private async hostProjection(summary: RouterRunSummary) {
    if (summary.assignmentId === undefined || summary.remoteRunId === undefined) return undefined;
    const assignment = await this.store.assignment(summary.assignmentId);
    if (assignment === undefined || assignment.remoteRunId !== summary.remoteRunId) return undefined;
    const hostRun = this.endpointFactory(assignment.runtimeEndpoint).hostRun;
    if (hostRun === undefined) return undefined;
    return await hostRun(summary.remoteRunId);
  }

  private async cataloguedArtifacts(summary: RouterRunSummary): Promise<readonly RuntimeArtifact[]> {
    if (summary.assignmentId === undefined || this.artifactsCatalog === undefined) return [];
    try { return await this.artifactsCatalog.list(summary.assignmentId); } catch { return []; }
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

  async artifacts(id: string): Promise<{ readonly assignment: StoredAssignment; readonly artifacts: readonly RuntimeArtifact[] } | undefined> {
    const assignment = await this.store.assignment(id);
    if (assignment === undefined) return undefined;
    if (assignment.remoteRunId.length === 0) return { assignment, artifacts: [] };
    const catalogued = await this.artifactsCatalog?.list(assignment.id) ?? [];
    if (catalogued.length > 0) return { assignment, artifacts: catalogued };
    const artifacts = await this.endpointFactory(assignment.runtimeEndpoint).artifacts?.(assignment.remoteRunId) ?? [];
    if (assignment.runtimeEndpoint.startsWith("local-runtime://")) return { assignment, artifacts };
    return { assignment, artifacts: await this.captureArtifacts(assignment, artifacts) };
  }

  async readArtifact(id: string, artifactId: string): Promise<{ readonly assignment: StoredAssignment; readonly artifact: RuntimeArtifact; readonly content: Uint8Array } | undefined> {
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

  async commandOutput(id: string, toolCallId: string, stream: "stdout" | "stderr"): Promise<{ readonly assignment: StoredAssignment; readonly output: RuntimeCommandOutput } | undefined> {
    const assignment = await this.store.assignment(id);
    if (assignment === undefined || assignment.remoteRunId.length === 0) return undefined;
    const output = await this.endpointFactory(assignment.runtimeEndpoint).commandOutput?.(assignment.remoteRunId, toolCallId, stream);
    return output === undefined ? undefined : { assignment, output };
  }

  async toolArguments(id: string, toolCallId: string): Promise<{ readonly assignment: StoredAssignment; readonly arguments: RuntimeToolArguments } | undefined> {
    const assignment = await this.store.assignment(id);
    if (assignment === undefined || assignment.remoteRunId.length === 0) return undefined;
    const argumentsContent = await this.endpointFactory(assignment.runtimeEndpoint).toolArguments?.(assignment.remoteRunId, toolCallId);
    return argumentsContent === undefined ? undefined : { assignment, arguments: argumentsContent };
  }

  async advanceRecovery(id: string): Promise<{ readonly assignment: StoredAssignment; readonly recovery: RuntimeRecoveryDetail } | undefined> {
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

  private async captureArtifacts(assignment: StoredAssignment, artifacts: readonly RuntimeArtifact[]): Promise<readonly RuntimeArtifact[]> {
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
    const endpoint = this.endpointFactory(assignment.runtimeEndpoint);
    const operations = endpoint.hostRun === undefined ? undefined : await endpoint.hostRun(assignment.remoteRunId).catch(() => undefined);
    if (operations !== undefined) await this.store.persistRunOperations(assignment.id, operations);
  }

  private emitDispatchFailure(event: RouterDispatchFailureLog): void {
    try { this.onDispatchFailure?.(event); } catch {
      // Logging cannot change the result of an already persisted dispatch failure.
    }
  }

}

function operationsFromEvents(events: readonly RuntimeRunEvent[]): PersistedRunOperations | undefined {
  const planEvent = [...events].reverse().find((event) => event.type === "plan.admitted" || event.type === "plan.proposed");
  const data = planEvent?.data ?? {};
  if (!Array.isArray(data.steps)) return undefined;
  const stepEvents = new Map<string, string>();
  for (const event of events) {
    const stepId = typeof event.data.stepId === "string" ? event.data.stepId : undefined;
    if (stepId === undefined) continue;
    const status = event.type === "plan.step.started" ? "running" : event.type === "plan.step.completed" ? "completed" : event.type === "plan.step.failed" ? "failed" : undefined;
    if (status !== undefined) stepEvents.set(stepId, status);
  }
  const steps = data.steps.map((step, index) => {
    const item = step !== null && typeof step === "object" ? step as Record<string, unknown> : {};
    const id = typeof item.id === "string" ? item.id : `step_${index + 1}`;
    return { id, status: stepEvents.get(id) ?? (typeof item.status === "string" ? item.status : "pending"), objective: typeof item.objective === "string" ? item.objective : "", dependencies: Array.isArray(item.dependencies) ? item.dependencies.filter((value): value is string => typeof value === "string") : [], skillIds: Array.isArray(item.skillIds) ? item.skillIds.filter((value): value is string => typeof value === "string") : [], requiredCapabilities: Array.isArray(item.requiredCapabilities) ? item.requiredCapabilities.filter((value): value is string => typeof value === "string") : [] };
  });
  const terminal = [...events].reverse().find((event) => event.type === "terminal.delivery_committed" || event.type === "run.failed" || event.type === "run.cancelled");
  const terminalData = terminal?.data ?? {};
  const outcome = terminal === undefined ? undefined : { schema: "agentloop.hostOutcome/v1" as const, status: terminal.type === "terminal.delivery_committed" ? "completed" : terminal.type === "run.cancelled" ? "cancelled" : "failed", reasonCode: typeof terminalData.reasonCode === "string" ? terminalData.reasonCode : typeof terminalData.code === "string" ? terminalData.code : terminal.type, ...(typeof terminalData.planId === "string" ? { planId: terminalData.planId } : {}), ...(typeof terminalData.output === "string" ? { output: terminalData.output } : {}), committedAt: terminal.createdAt };
  return { plan: { state: "available", id: typeof data.id === "string" ? data.id : typeof data.planId === "string" ? data.planId : "replayed-plan", version: typeof data.version === "number" ? data.version : 1, status: terminal?.type === "terminal.delivery_committed" ? "completed" : "available", goal: typeof data.goal === "string" ? data.goal : "", selectedSkillIds: Array.isArray(data.selectedSkillIds) ? data.selectedSkillIds.filter((value): value is string => typeof value === "string") : [], steps, assessmentCount: 0, approvedAssessmentCount: 0 }, ...(outcome === undefined ? {} : { outcome }) };
}

export { RuntimeCapacityError } from "./control-plane-contracts.ts";

function isRuntimeCapacityFailure(error: unknown): boolean {
  return error instanceof Error && error.message === "runtime_capacity_exhausted";
}

function dispatchFailureFor(error: unknown): DispatchFailure {
  if (isRuntimeCapacityFailure(error)) {
    return { code: "runtime_capacity_exhausted", message: "Runtime 当前没有可用容量，请稍后重试。" };
  }
  return { code: "runtime_dispatch_failed", message: "Runtime 未能接收本次任务，请稍后重试。" };
}

function diagnosticFor(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const redacted = raw
    .replace(/\bauthorization\b["']?\s*[:=]\s*Bearer\s+[^\s,;]+/gi, "authorization=[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(authorization|token|api[_-]?key|secret|password|cookie|session)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length <= 512 ? redacted : `${redacted.slice(0, 511)}…`;
}

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
