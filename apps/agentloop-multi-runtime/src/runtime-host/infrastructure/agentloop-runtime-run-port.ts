import type { HostRunProjection, RunService } from "@zhujun/agentloop";
import type {
  RuntimeArtifact,
  RuntimeArtifactPreview,
  RuntimeCommandOutput,
  RuntimeHumanLoopRequest,
  RuntimeHumanLoopResponse,
  RuntimeRecoveryDetail,
  RuntimeRunEvent,
  RuntimeRunOperationsProjection,
  RuntimeToolArguments,
} from "../../shared/contracts.ts";
import type { RuntimeHostRun, RuntimeHostRunPort, RuntimeRunCheckpoint } from "../application/runtime-run-port.ts";

/** Infrastructure adapter from the AgentLoop kernel to the Host application port. */
export class AgentLoopRuntimeRunPort implements RuntimeHostRunPort {
  private readonly runs: RunService;

  constructor(runs: RunService) {
    this.runs = runs;
  }

  async ensureConversation(actorUserId: string, conversationId: string, input: string): Promise<void> {
    await this.runs.ensureConversation(actorUserId, conversationId, input);
  }

  async startConversation(actorUserId: string, input: unknown, options?: {
    readonly conversationId?: string;
    readonly sourceIds?: readonly string[];
    readonly allowDangerousTools?: boolean;
    readonly modelKey?: string;
  }): Promise<RuntimeHostRun> {
    return await this.runs.startConversation(actorUserId, input, options);
  }

  async get(actorUserId: string, runId: string): Promise<RuntimeHostRun> {
    return await this.runs.get(actorUserId, runId);
  }

  async hostRun(actorUserId: string, runId: string): Promise<RuntimeRunOperationsProjection> {
    return projectHostRun(await this.runs.hostRun(actorUserId, runId));
  }

  async cancel(actorUserId: string, runId: string): Promise<RuntimeHostRun> {
    return await this.runs.cancel(actorUserId, runId);
  }

  async events(actorUserId: string, runId: string): Promise<readonly RuntimeRunEvent[]> {
    return await this.runs.events(actorUserId, runId);
  }

  async processArtifacts(actorUserId: string, runId: string): Promise<readonly RuntimeArtifact[]> {
    return await this.runs.processArtifacts(actorUserId, runId);
  }

  async readProcessArtifact(actorUserId: string, runId: string, artifactId: string): Promise<{ readonly artifact: RuntimeArtifact; readonly content: Uint8Array }> {
    return await this.runs.readProcessArtifact(actorUserId, runId, artifactId);
  }

  async previewProcessArtifact(actorUserId: string, runId: string, artifactId: string): Promise<RuntimeArtifactPreview> {
    return await this.runs.previewProcessArtifact(actorUserId, runId, artifactId);
  }

  async readCommandOutput(actorUserId: string, runId: string, toolCallId: string, stream: "stdout" | "stderr"): Promise<RuntimeCommandOutput> {
    return await this.runs.readCommandOutput(actorUserId, runId, toolCallId, stream);
  }

  async readToolArguments(actorUserId: string, runId: string, toolCallId: string): Promise<RuntimeToolArguments> {
    return await this.runs.readToolArguments(actorUserId, runId, toolCallId);
  }

  async advanceRecovery(actorUserId: string, runId: string): Promise<RuntimeRecoveryDetail> {
    return await this.runs.advanceRecovery(actorUserId, runId);
  }

  async resumeRecovery(actorUserId: string, runId: string): Promise<RuntimeHostRun> {
    return await this.runs.resumeRecovery(actorUserId, runId);
  }

  async checkpointForRun(actorUserId: string, runId: string): Promise<RuntimeRunCheckpoint | undefined> {
    return await this.runs.checkpointForRun(actorUserId, runId);
  }

  async startFromCheckpoint(actorUserId: string, checkpointId: string): Promise<RuntimeHostRun> {
    return await this.runs.startFromCheckpoint(actorUserId, checkpointId);
  }

  async currentHumanLoop(actorUserId: string, runId: string): Promise<RuntimeHumanLoopRequest | undefined> {
    return await this.runs.currentHumanLoop(actorUserId, runId);
  }

  async respondHumanLoop(actorUserId: string, runId: string, requestId: string, value: unknown, expectedRevision: unknown): Promise<RuntimeHumanLoopResponse> {
    return await this.runs.respondHumanLoop(actorUserId, runId, requestId, value, expectedRevision);
  }

  async reconcileInterruptedRuns(runIds?: readonly string[]): Promise<number> {
    return await this.runs.reconcileInterruptedRuns(runIds);
  }
}

function projectHostRun(projection: HostRunProjection): RuntimeRunOperationsProjection {
  const run = projection.run;
  return {
    schema: "agentloop.hostRun/v1",
    run: {
      id: run.id,
      status: run.status,
      ...(run.input.trim() === "" ? {} : { input: run.input }),
      ...(run.modelKey === undefined ? {} : { modelKey: run.modelKey }),
      ...(run.output === undefined ? {} : { output: run.output }),
      ...(run.errorCode === undefined ? {} : { errorCode: run.errorCode }),
      ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
      createdAt: run.createdAt,
      ...(run.conversationId === undefined ? {} : { conversationId: run.conversationId }),
    },
    ...(projection.outcome === undefined ? {} : { outcome: projection.outcome }),
    plan: {
      state: projection.plan.state,
      id: projection.plan.id,
      version: projection.plan.version,
      status: projection.plan.status,
      goal: projection.plan.goal,
      selectedSkillIds: projection.plan.selectedSkillIds,
      steps: projection.plan.steps.map((step) => ({
        id: step.id,
        status: step.status,
        objective: step.objective,
        dependencies: step.dependencies,
        skillIds: step.skillIds,
        requiredCapabilities: step.requiredCapabilities,
        ...(step.output === undefined ? {} : { output: step.output }),
        ...(step.error === undefined ? {} : { error: step.error }),
      })),
      assessmentCount: projection.plan.assessmentCount,
      approvedAssessmentCount: projection.plan.approvedAssessmentCount,
    },
    artifacts: projection.artifacts.map((artifact) => ({
      runId: artifact.runId,
      id: artifact.id,
      path: artifact.path,
      name: artifact.name,
      bytes: artifact.bytes,
      mimeType: artifact.mimeType,
      role: artifact.role,
      sourceTool: artifact.sourceTool,
      previewable: artifact.previewable,
    })),
    eventCursor: projection.eventCursor,
  };
}
