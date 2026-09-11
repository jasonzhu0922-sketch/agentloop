import type { HumanLoopRequest, HumanLoopResponse, ProcessArtifact, ProcessArtifactPreview, RecoveryDetail } from "@zhujun/agentloop";

export type RuntimeProfile = "general" | "artifact";
export type RuntimeStatus = "ready" | "draining" | "offline";

export interface RuntimeInstance {
  readonly id: string;
  readonly profile: RuntimeProfile;
  readonly capabilities: readonly string[];
  readonly maxConcurrentRuns: number;
  readonly activeRunCount: number;
  readonly status: RuntimeStatus;
}

export interface PortableResourceRef {
  readonly attachmentId: string;
  readonly uri: string;
  readonly sha256: string;
  readonly mediaType: string;
  readonly originalName: string;
  readonly byteSize: number;
}

export interface RuntimeDispatchEnvelope {
  readonly schema: "agentloop.runtimeDispatch/v1";
  readonly assignmentId: string;
  readonly dispatchKey: string;
  readonly subject: { readonly tenantId: string; readonly userId: string };
  readonly conversationId: string;
  readonly input: string;
  readonly requestedRuntimeId?: string;
  readonly requestedProfile?: RuntimeProfile;
  readonly requestedModelKey?: string;
  readonly allowDangerousTools: boolean;
  readonly resourceRefs: readonly PortableResourceRef[];
}

export interface RuntimeDispatchResult {
  readonly remoteRunId: string;
}

export interface RuntimeRunStatus {
  readonly remoteRunId: string;
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly output?: string;
  readonly errorCode?: string;
  /** User-observable terminal failure text projected from the Host Run event. */
  readonly errorMessage?: string;
  readonly finishedAt?: number;
  readonly artifacts?: readonly ProcessArtifact[];
}

export interface RuntimeRunEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

/** Public model metadata. Provider credentials and upstream model names stay on the Host. */
export interface RuntimeModelSummary {
  readonly key: string;
  readonly displayName: string;
}

export interface RuntimeEndpoint {
  dispatch(envelope: RuntimeDispatchEnvelope): Promise<RuntimeDispatchResult>;
  models?(): Promise<readonly RuntimeModelSummary[]>;
  getRun?(remoteRunId: string): Promise<RuntimeRunStatus>;
  artifacts?(remoteRunId: string): Promise<readonly ProcessArtifact[]>;
  readArtifact?(remoteRunId: string, artifactId: string): Promise<{ readonly artifact: ProcessArtifact; readonly content: Uint8Array }>;
  previewArtifact?(remoteRunId: string, artifactId: string): Promise<ProcessArtifactPreview>;
  cancelRun?(remoteRunId: string): Promise<RuntimeRunStatus>;
  events?(remoteRunId: string, afterSeq: number): Promise<readonly RuntimeRunEvent[]>;
  /** Advances the Host-owned recovery planner for a paused Run. */
  advanceRecovery?(remoteRunId: string): Promise<RecoveryDetail>;
  /** Resumes a Host-admitted, replay-safe recovery action. */
  resumeRecovery?(remoteRunId: string): Promise<RuntimeRunStatus>;
  currentHumanLoop?(remoteRunId: string): Promise<HumanLoopRequest | undefined>;
  respondHumanLoop?(remoteRunId: string, requestId: string, input: { readonly value: unknown; readonly expectedRevision: number }): Promise<HumanLoopResponse>;
}

/**
 * Application-side integration boundary. A Runtime Host may call this gateway
 * with trusted run context; the Router resolves user/tenant policy and returns
 * a neutral upstream result. It never grants the Host a local path or a
 * long-lived browser/business credential.
 */
export interface RouterIntegrationGateway {
  invoke(input: RouterIntegrationInvocation): Promise<RouterIntegrationResult>;
}

export interface RouterIntegrationInvocation {
  readonly tenantId: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly assignmentId: string;
  readonly remoteRunId: string;
  readonly integrationKey: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface RouterIntegrationResult {
  readonly schema: "agentloop.routerIntegrationResult/v1";
  readonly output: unknown;
  readonly expiresAt: string;
}

export interface SubmitConversationTask {
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly conversationId: string;
  readonly clientMessageId: string;
  readonly input: string;
  /** Optional explicit Host selection. Omit it to use Router load-balancing. */
  readonly requestedRuntimeId?: string;
  readonly requestedProfile?: RuntimeProfile;
  readonly requiredCapabilities?: readonly string[];
  readonly requestedModelKey?: string;
  readonly allowDangerousTools?: boolean;
  readonly resourceRefs?: readonly PortableResourceRef[];
}

export interface RuntimeAssignment {
  readonly id: string;
  readonly runtimeId: string;
  readonly dispatchKey: string;
  readonly remoteRunId: string;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly ownerUserId: string;
}
