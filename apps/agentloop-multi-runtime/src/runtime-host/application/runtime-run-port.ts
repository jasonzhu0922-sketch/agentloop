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
import type { RuntimeConfigurationSnapshotReference } from "@zhujun/agentloop";

/**
 * The Host application's view of a local Runtime.
 *
 * This is deliberately smaller than the Runtime kernel's RunService: the
 * Host owns transport/admission, while planning, evidence, assessment and
 * terminal commitment stay behind this port in the Runtime implementation.
 */
export interface RuntimeHostRunPort {
  ensureConversation(actorUserId: string, conversationId: string, input: string): Promise<void>;
  startConversation(actorUserId: string, input: unknown, options?: {
    readonly conversationId?: string;
    readonly sourceIds?: readonly string[];
    readonly allowDangerousTools?: boolean;
    readonly modelKey?: string;
  }): Promise<RuntimeHostRun>;
  get(actorUserId: string, runId: string): Promise<RuntimeHostRun>;
  cancel?(actorUserId: string, runId: string): Promise<RuntimeHostRun>;
  events?(actorUserId: string, runId: string): Promise<readonly RuntimeRunEvent[]>;
  processArtifacts?(actorUserId: string, runId: string): Promise<readonly RuntimeArtifact[]>;
  readProcessArtifact?(actorUserId: string, runId: string, artifactId: string): Promise<{
    readonly artifact: RuntimeArtifact;
    readonly content: Uint8Array;
  }>;
  previewProcessArtifact?(actorUserId: string, runId: string, artifactId: string): Promise<RuntimeArtifactPreview>;
  readCommandOutput?(actorUserId: string, runId: string, toolCallId: string, stream: "stdout" | "stderr"): Promise<RuntimeCommandOutput>;
  readToolArguments?(actorUserId: string, runId: string, toolCallId: string): Promise<RuntimeToolArguments>;
  advanceRecovery?(actorUserId: string, runId: string): Promise<RuntimeRecoveryDetail>;
  resumeRecovery?(actorUserId: string, runId: string): Promise<RuntimeHostRun>;
  checkpointForRun?(actorUserId: string, runId: string): Promise<RuntimeRunCheckpoint | undefined>;
  startFromCheckpoint?(actorUserId: string, checkpointId: string): Promise<RuntimeHostRun>;
  currentHumanLoop?(actorUserId: string, runId: string): Promise<RuntimeHumanLoopRequest | undefined>;
  respondHumanLoop?(actorUserId: string, runId: string, requestId: string, value: unknown, expectedRevision: unknown): Promise<RuntimeHumanLoopResponse>;
  reconcileInterruptedRuns?(runIds?: readonly string[]): Promise<number>;
}

/** Host-only admission seam: selects a frozen Run port from a dispatch subject. */
export interface RuntimeAdmissionRunResolver {
  resolveForAdmission(subject: { readonly scopeId: string; readonly userId: string }): Promise<RuntimeHostRunPort>;
  resolveForRun(configurationSnapshot: RuntimeConfigurationSnapshotReference): Promise<RuntimeHostRunPort>;
}

export interface RuntimeHostRun {
  readonly id: string;
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly modelKey?: string;
  readonly output?: string;
  readonly errorCode?: string;
  readonly finishedAt?: number;
  /** Neutral admission provenance persisted by the Runtime kernel. */
  readonly configurationSnapshot?: RuntimeConfigurationSnapshotReference;
}

export interface RuntimeRunCheckpoint {
  readonly id: string;
  readonly reason: "execution_authority_lost";
  readonly childRunId?: string;
}
