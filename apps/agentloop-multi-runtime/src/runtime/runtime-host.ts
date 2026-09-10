import type { HumanLoopRequest, HumanLoopResponse, ProcessArtifact, ProcessArtifactPreview, RunService } from "@zhujun/agentloop";
import type { PortableResourceRef, RuntimeDispatchEnvelope, RuntimeDispatchResult, RuntimeEndpoint, RuntimeRunEvent, RuntimeRunStatus } from "../domain/contracts.ts";
import { HostDispatchStore, RuntimeDispatchInFlightError } from "./host-dispatch-store.ts";

export interface ResourceImporter {
  importForRun(input: {
    readonly subject: RuntimeDispatchEnvelope["subject"];
    readonly conversationId: string;
    readonly resources: readonly PortableResourceRef[];
  }): Promise<readonly string[]>;
}

export interface RuntimeCapacityGate {
  readonly maxConcurrentRuns: number;
  activeRunCount(): Promise<number>;
}

/** A Runtime Host owns local AgentLoop Runs and never accepts local directory grants. */
export class AgentLoopRuntimeHost implements RuntimeEndpoint {
  private readonly dispatches = new Map<string, Promise<RuntimeDispatchResult>>();
  private readonly ownersByRunId = new Map<string, string>();
  private readonly runs: Pick<RunService, "start" | "get" | "ensureConversation"> & Partial<Pick<RunService, "cancel" | "events" | "processArtifacts" | "readProcessArtifact" | "previewProcessArtifact" | "currentHumanLoop" | "respondHumanLoop">>;
  private readonly resourceImporter: ResourceImporter;
  private readonly capacity?: RuntimeCapacityGate;
  private readonly dispatchStore?: HostDispatchStore;
  private admissionTail: Promise<void> = Promise.resolve();

  constructor(
    runs: Pick<RunService, "start" | "get" | "ensureConversation"> & Partial<Pick<RunService, "cancel" | "events">>,
    resourceImporter: ResourceImporter,
    capacity?: RuntimeCapacityGate,
    dispatchStore?: HostDispatchStore,
  ) {
    this.runs = runs;
    this.resourceImporter = resourceImporter;
    this.capacity = capacity;
    this.dispatchStore = dispatchStore;
  }

  async getRun(remoteRunId: string): Promise<RuntimeRunStatus> {
    const ownerUserId = this.ownersByRunId.get(remoteRunId) ?? await this.dispatchStore?.ownerForRun(remoteRunId);
    if (ownerUserId === undefined) throw new TypeError("runtime run not found");
    const run = await this.runs.get(ownerUserId, remoteRunId);
    return {
      remoteRunId: run.id,
      status: run.status,
      ...(run.output === undefined ? {} : { output: run.output }),
      ...(run.errorCode === undefined ? {} : { errorCode: run.errorCode }),
      ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
      ...(this.runs.processArtifacts === undefined ? {} : { artifacts: await this.runs.processArtifacts(ownerUserId, remoteRunId) }),
    };
  }

  async artifacts(remoteRunId: string): Promise<readonly ProcessArtifact[]> {
    const ownerUserId = this.ownersByRunId.get(remoteRunId) ?? await this.dispatchStore?.ownerForRun(remoteRunId);
    if (ownerUserId === undefined) throw new TypeError("runtime run not found");
    if (this.runs.processArtifacts === undefined) throw new TypeError("runtime artifact query is not configured");
    return await this.runs.processArtifacts(ownerUserId, remoteRunId);
  }

  async readArtifact(remoteRunId: string, artifactId: string): Promise<{ readonly artifact: ProcessArtifact; readonly content: Uint8Array }> {
    const ownerUserId = this.ownersByRunId.get(remoteRunId) ?? await this.dispatchStore?.ownerForRun(remoteRunId);
    if (ownerUserId === undefined) throw new TypeError("runtime run not found");
    if (this.runs.readProcessArtifact === undefined) throw new TypeError("runtime artifact read is not configured");
    return await this.runs.readProcessArtifact(ownerUserId, remoteRunId, artifactId);
  }

  async previewArtifact(remoteRunId: string, artifactId: string): Promise<ProcessArtifactPreview> {
    const ownerUserId = this.ownersByRunId.get(remoteRunId) ?? await this.dispatchStore?.ownerForRun(remoteRunId);
    if (ownerUserId === undefined) throw new TypeError("runtime run not found");
    if (this.runs.previewProcessArtifact === undefined) throw new TypeError("runtime artifact preview is not configured");
    return await this.runs.previewProcessArtifact(ownerUserId, remoteRunId, artifactId);
  }

  async cancelRun(remoteRunId: string): Promise<RuntimeRunStatus> {
    const ownerUserId = this.ownersByRunId.get(remoteRunId) ?? await this.dispatchStore?.ownerForRun(remoteRunId);
    if (ownerUserId === undefined) throw new TypeError("runtime run not found");
    if (this.runs.cancel === undefined) throw new TypeError("runtime cancellation is not configured");
    const run = await this.runs.cancel(ownerUserId, remoteRunId);
    return {
      remoteRunId: run.id,
      status: run.status,
      ...(run.output === undefined ? {} : { output: run.output }),
      ...(run.errorCode === undefined ? {} : { errorCode: run.errorCode }),
      ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    };
  }

  async events(remoteRunId: string, afterSeq: number): Promise<readonly RuntimeRunEvent[]> {
    const ownerUserId = this.ownersByRunId.get(remoteRunId) ?? await this.dispatchStore?.ownerForRun(remoteRunId);
    if (ownerUserId === undefined) throw new TypeError("runtime run not found");
    if (this.runs.events === undefined) throw new TypeError("runtime event query is not configured");
    return (await this.runs.events(ownerUserId, remoteRunId))
      .filter((event) => event.seq > afterSeq)
      .map((event) => ({ seq: event.seq, type: event.type, data: event.data, createdAt: event.createdAt }));
  }

  async currentHumanLoop(remoteRunId: string): Promise<HumanLoopRequest | undefined> {
    const ownerUserId = this.ownersByRunId.get(remoteRunId) ?? await this.dispatchStore?.ownerForRun(remoteRunId);
    if (ownerUserId === undefined || this.runs.currentHumanLoop === undefined) throw new TypeError("runtime Human-in-the-Loop query is not configured");
    return this.runs.currentHumanLoop(ownerUserId, remoteRunId);
  }

  async respondHumanLoop(remoteRunId: string, requestId: string, input: { readonly value: unknown; readonly expectedRevision: number }): Promise<HumanLoopResponse> {
    const ownerUserId = this.ownersByRunId.get(remoteRunId) ?? await this.dispatchStore?.ownerForRun(remoteRunId);
    if (ownerUserId === undefined || this.runs.respondHumanLoop === undefined) throw new TypeError("runtime Human-in-the-Loop response is not configured");
    return this.runs.respondHumanLoop(ownerUserId, remoteRunId, requestId, input.value, input.expectedRevision);
  }

  dispatch(envelope: RuntimeDispatchEnvelope): Promise<RuntimeDispatchResult> {
    assertRuntimeDispatchEnvelope(envelope);
    const existing = this.dispatches.get(envelope.dispatchKey);
    if (existing !== undefined) return existing;
    const started = this.start(envelope);
    this.dispatches.set(envelope.dispatchKey, started);
    return started;
  }

  private async start(envelope: RuntimeDispatchEnvelope): Promise<RuntimeDispatchResult> {
    if (this.dispatchStore !== undefined) {
      const claim = await this.dispatchStore.claim({
        dispatchKey: envelope.dispatchKey,
        assignmentId: envelope.assignmentId,
        ownerUserId: envelope.subject.userId,
        now: Date.now(),
        leaseMs: 30_000,
      });
      if (claim.kind === "accepted") {
        this.ownersByRunId.set(claim.remoteRunId, claim.ownerUserId);
        return { remoteRunId: claim.remoteRunId };
      }
      if (claim.kind === "in_flight") throw new RuntimeDispatchInFlightError("Runtime dispatch is already being admitted");
    }
    try {
      return await this.startClaimed(envelope);
    } catch (error) {
      await this.dispatchStore?.release(envelope.dispatchKey);
      throw error;
    }
  }

  private async startClaimed(envelope: RuntimeDispatchEnvelope): Promise<RuntimeDispatchResult> {
    const sourceIds = await this.resourceImporter.importForRun({
      subject: envelope.subject,
      conversationId: envelope.conversationId,
      resources: envelope.resourceRefs,
    });
    const run = await this.admit(async () => {
      await this.runs.ensureConversation(envelope.subject.userId, envelope.conversationId, envelope.input);
      return await this.runs.start(envelope.subject.userId, envelope.input, {
          conversationId: envelope.conversationId,
          sourceIds,
          allowDangerousTools: envelope.allowDangerousTools,
          ...(envelope.requestedModelKey === undefined ? {} : { modelKey: envelope.requestedModelKey }),
        });
    });
    await this.dispatchStore?.accept(envelope.dispatchKey, run.id);
    this.ownersByRunId.set(run.id, envelope.subject.userId);
    return { remoteRunId: run.id };
  }

  private async admit<T>(operation: () => Promise<T>): Promise<T> {
    if (this.capacity === undefined) return await operation();
    let release!: () => void;
    const previous = this.admissionTail;
    this.admissionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const active = await this.capacity.activeRunCount();
      if (active >= this.capacity.maxConcurrentRuns) throw new RuntimeHostCapacityError("Runtime Host has no remaining capacity");
      return await operation();
    } finally {
      release();
    }
  }
}

export class RuntimeHostCapacityError extends Error {}

export function assertRuntimeDispatchEnvelope(input: unknown): asserts input is RuntimeDispatchEnvelope {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("runtime dispatch must be an object");
  }
  if (Object.hasOwn(input, "visibleDirectories")) {
    throw new TypeError("visibleDirectories are disabled for cloud Runtime Hosts");
  }
  const value = input as Record<string, unknown>;
  if (value.schema !== "agentloop.runtimeDispatch/v1") throw new TypeError("unsupported runtime dispatch schema");
  for (const field of ["assignmentId", "dispatchKey", "conversationId", "input"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) throw new TypeError(`${field} must be a non-empty string`);
  }
  if (value.allowDangerousTools !== true && value.allowDangerousTools !== false) {
    throw new TypeError("allowDangerousTools must be a boolean");
  }
  if (!isRecord(value.subject) || nonEmptyString(value.subject.tenantId) === undefined || nonEmptyString(value.subject.userId) === undefined) {
    throw new TypeError("subject must contain tenantId and userId");
  }
  if (!Array.isArray(value.resourceRefs)) throw new TypeError("resourceRefs must be an array");
  for (const [index, resource] of value.resourceRefs.entries()) {
    if (!isRecord(resource)) throw new TypeError(`resourceRefs[${index}] must be an object`);
    for (const field of ["attachmentId", "uri", "sha256", "mediaType", "originalName"]) {
      if (nonEmptyString(resource[field]) === undefined) throw new TypeError(`resourceRefs[${index}].${field} must be a non-empty string`);
    }
    if (typeof resource.byteSize !== "number" || !Number.isSafeInteger(resource.byteSize) || resource.byteSize < 0) {
      throw new TypeError(`resourceRefs[${index}].byteSize must be a non-negative integer`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
