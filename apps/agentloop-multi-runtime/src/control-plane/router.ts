import { randomUUID } from "node:crypto";
import type {
  RuntimeAssignment,
  RuntimeDispatchEnvelope,
  RuntimeEndpoint,
  RuntimeInstance,
  RuntimeProfile,
  RuntimeRunStatus,
  SubmitConversationTask,
} from "../domain/contracts.ts";
import type { ProcessArtifact } from "@zhujun/agentloop";

interface RegisteredRuntime {
  readonly instance: RuntimeInstance;
  readonly endpoint: RuntimeEndpoint;
  reservedRuns: number;
}

/**
 * Control-plane router. It selects one complete AgentLoop Runtime for one
 * conversation task; it deliberately has no Plan, Step, Tool, or Evidence API.
 * The in-memory state is a reference implementation for the first application
 * slice; production replaces it with a transactional Assignment store.
 */
export class MultiRuntimeRouter {
  private readonly runtimes = new Map<string, RegisteredRuntime>();
  private readonly assignmentsByMessage = new Map<string, Promise<RuntimeAssignment>>();
  private readonly assignmentsById = new Map<string, Promise<RuntimeAssignment>>();

  register(instance: RuntimeInstance, endpoint: RuntimeEndpoint): void {
    if (instance.maxConcurrentRuns < 1) throw new TypeError("maxConcurrentRuns must be positive");
    this.runtimes.set(instance.id, { instance, endpoint, reservedRuns: 0 });
  }

  submit(task: SubmitConversationTask): Promise<RuntimeAssignment> {
    rejectVisibleDirectoryInput(task);
    const key = [task.tenantId, task.ownerUserId, task.conversationId, task.clientMessageId].join("\u0000");
    const existing = this.assignmentsByMessage.get(key);
    if (existing !== undefined) return existing;
    const assignment = this.dispatch(task).catch((error: unknown) => {
      if (this.assignmentsByMessage.get(key) === assignment) this.assignmentsByMessage.delete(key);
      throw error;
    });
    this.assignmentsByMessage.set(key, assignment);
    void assignment.then((resolved) => this.assignmentsById.set(resolved.id, Promise.resolve(resolved)), () => undefined);
    return assignment;
  }

  getAssignment(id: string): Promise<RuntimeAssignment> | undefined {
    return this.assignmentsById.get(id);
  }

  async getAssignmentProjection(id: string): Promise<{ readonly assignment: RuntimeAssignment; readonly run?: RuntimeRunStatus }> {
    const stored = this.assignmentsById.get(id);
    if (stored === undefined) throw new RangeError("assignment not found");
    const assignment = await stored;
    const endpoint = this.runtimes.get(assignment.runtimeId)?.endpoint;
    if (endpoint?.getRun === undefined) return { assignment };
    return { assignment, run: await endpoint.getRun(assignment.remoteRunId) };
  }

  async assignment(id: string): Promise<{ readonly assignment: RuntimeAssignment; readonly run?: RuntimeRunStatus } | undefined> {
    if (this.assignmentsById.get(id) === undefined) return undefined;
    return await this.getAssignmentProjection(id);
  }

  async artifacts(id: string): Promise<{ readonly assignment: RuntimeAssignment; readonly artifacts: readonly ProcessArtifact[] } | undefined> {
    const projection = await this.assignment(id);
    if (projection === undefined) return undefined;
    const endpoint = this.runtimes.get(projection.assignment.runtimeId)?.endpoint;
    return { assignment: projection.assignment, artifacts: await endpoint?.artifacts?.(projection.assignment.remoteRunId) ?? projection.run?.artifacts ?? [] };
  }

  async readArtifact(id: string, artifactId: string): Promise<{ readonly assignment: RuntimeAssignment; readonly artifact: ProcessArtifact; readonly content: Uint8Array } | undefined> {
    const projection = await this.assignment(id);
    if (projection === undefined) return undefined;
    const endpoint = this.runtimes.get(projection.assignment.runtimeId)?.endpoint;
    const result = await endpoint?.readArtifact?.(projection.assignment.remoteRunId, artifactId);
    return result === undefined ? undefined : { assignment: projection.assignment, ...result };
  }

  async previewArtifact(id: string, artifactId: string): Promise<{ readonly assignment: RuntimeAssignment; readonly preview: unknown } | undefined> {
    const projection = await this.assignment(id);
    if (projection === undefined) return undefined;
    const endpoint = this.runtimes.get(projection.assignment.runtimeId)?.endpoint;
    const preview = await endpoint?.previewArtifact?.(projection.assignment.remoteRunId, artifactId);
    return preview === undefined ? undefined : { assignment: projection.assignment, preview };
  }

  private async dispatch(task: SubmitConversationTask): Promise<RuntimeAssignment> {
    const selected = this.selectRuntime(task.requestedRuntimeId, task.requestedProfile, task.requiredCapabilities ?? []);
    selected.reservedRuns += 1;
    const assignmentId = `assignment_${randomUUID()}`;
    const dispatchKey = `dispatch_${randomUUID()}`;
    const envelope: RuntimeDispatchEnvelope = {
      schema: "agentloop.runtimeDispatch/v1",
      assignmentId,
      dispatchKey,
      subject: { tenantId: task.tenantId, userId: task.ownerUserId },
      conversationId: task.conversationId,
      input: task.input,
      ...(task.requestedRuntimeId === undefined ? {} : { requestedRuntimeId: task.requestedRuntimeId }),
      ...(task.requestedProfile === undefined ? {} : { requestedProfile: task.requestedProfile }),
      ...(task.requestedModelKey === undefined ? {} : { requestedModelKey: task.requestedModelKey }),
      allowDangerousTools: task.allowDangerousTools !== false,
      resourceRefs: task.resourceRefs ?? [],
    };
    try {
      const accepted = await selected.endpoint.dispatch(envelope);
      return {
        id: assignmentId,
        runtimeId: selected.instance.id,
        dispatchKey,
        remoteRunId: accepted.remoteRunId,
        tenantId: task.tenantId,
        conversationId: task.conversationId,
        ownerUserId: task.ownerUserId,
      };
    } catch (error) {
      selected.reservedRuns -= 1;
      throw error;
    }
  }

  private selectRuntime(requestedRuntimeId: string | undefined, profile: RuntimeProfile | undefined, required: readonly string[]): RegisteredRuntime {
    if (requestedRuntimeId !== undefined && !this.runtimes.has(requestedRuntimeId)) {
      throw new TypeError(`Runtime \"${requestedRuntimeId}\" is not registered`);
    }
    const candidates = [...this.runtimes.values()]
      .filter(({ instance, reservedRuns }) =>
        instance.status === "ready"
        && (requestedRuntimeId === undefined || instance.id === requestedRuntimeId)
        && (profile === undefined || instance.profile === profile)
        && required.every((capability) => instance.capabilities.includes(capability))
        && instance.activeRunCount + reservedRuns < instance.maxConcurrentRuns,
      )
      .sort((left, right) =>
        (left.instance.activeRunCount + left.reservedRuns) / left.instance.maxConcurrentRuns
        - (right.instance.activeRunCount + right.reservedRuns) / right.instance.maxConcurrentRuns
        || left.instance.id.localeCompare(right.instance.id),
      );
    const selected = candidates[0];
    if (selected === undefined && requestedRuntimeId !== undefined) throw new RuntimeCapacityError(`Runtime \"${requestedRuntimeId}\" is not ready or has no reservable capacity slot`);
    if (selected === undefined) throw new RuntimeCapacityError("No ready Runtime satisfies this task's profile, capabilities, and capacity");
    return selected;
  }
}

export class RuntimeCapacityError extends Error {}

function rejectVisibleDirectoryInput(input: unknown): void {
  if (input === null || typeof input !== "object") return;
  if (Object.hasOwn(input, "visibleDirectories")) {
    throw new TypeError("visibleDirectories are disabled for the cloud multi-runtime application");
  }
}
