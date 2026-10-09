import type { RunService } from "@zhujun/agentloop";
import type {
  RuntimeArtifact,
  RuntimeArtifactPreview,
  RuntimeCommandOutput,
  RuntimeHumanLoopRequest,
  RuntimeHumanLoopResponse,
  RuntimeRecoveryDetail,
  RuntimeRunEvent,
  RuntimeToolArguments,
} from "../../shared/contracts.ts";
import type { RuntimeHostRun, RuntimeHostRunPort, RuntimeRunCheckpoint } from "../ports/runtime-run-port.ts";

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
}
