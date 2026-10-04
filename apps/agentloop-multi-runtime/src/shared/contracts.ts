export type RuntimeProfile = "general" | "artifact";
export type RuntimeStatus = "ready" | "draining" | "offline";
export type RuntimeKind = "cloud" | "local";

export type ExecutionTarget =
  | { readonly kind: "cloud_pool"; readonly profile?: RuntimeProfile; readonly region?: string }
  | { readonly kind: "local_device"; readonly deviceId: string; readonly runtimeId: string };

export type DataPolicy =
  | { readonly mode: "cloud" }
  | { readonly mode: "local" }
  | { readonly mode: "strict_local" };

/** The data plane that actually executed a conversation turn. */
export type ExecutionLocation = DataPolicy["mode"];

export interface RuntimeInstance {
  readonly id: string;
  /** Human-readable Runtime identity for user-facing provenance. */
  readonly displayName?: string;
  readonly kind?: RuntimeKind;
  readonly deviceId?: string;
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

/**
 * User-visible attachment metadata retained with a conversation turn.  It is
 * deliberately limited to presentation metadata: no file content, URI, hash,
 * or local filesystem path crosses this boundary.
 */
export interface ConversationAttachmentSnapshot {
  readonly id: string;
  readonly originalName: string;
  readonly mediaType: string;
  readonly byteSize: number;
}

export interface RuntimeDispatchEnvelope {
  readonly schema: "agentloop.runtimeDispatch/v1";
  readonly assignmentId: string;
  readonly dispatchKey: string;
  readonly subject: { readonly tenantId: string; readonly userId: string };
  readonly conversationId: string;
  readonly input: string;
  readonly executionTarget?: ExecutionTarget;
  readonly dataPolicy?: DataPolicy;
  readonly requestedRuntimeId?: string;
  readonly requestedProfile?: RuntimeProfile;
  readonly requestedModelKey?: string;
  readonly allowDangerousTools: boolean;
  readonly resourceRefs: readonly PortableResourceRef[];
  /** Opaque Local Agent capabilities. Absolute paths never cross this boundary. */
  readonly localDirectoryScopeIds?: readonly string[];
  /** Opaque IDs of uploaded sources owned by this exact Local Runtime. File bytes never cross the Router. */
  readonly localUploadedSourceIds?: readonly string[];
}

export interface FinalTurnSummary {
  readonly assignmentId: string;
  readonly remoteRunId: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly assistantOutput?: string;
  readonly errorCode?: string;
  readonly completedAt: number;
  readonly artifactRefs: readonly {
    readonly id: string;
    readonly name: string;
    readonly mimeType: string;
    readonly byteSize: number;
  }[];
}

export interface RuntimeDispatchResult {
  readonly remoteRunId: string;
}

/**
 * Stable Router-to-Host artifact projection. Runtime-only filesystem helpers
 * and acceptance implementation types never cross the process boundary.
 */
export interface RuntimeArtifact {
  readonly runId: string;
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
  readonly mimeType: string;
  readonly role: "final" | "process";
  readonly sourceTool: "computer_write_file" | "computer_patch_file" | "computer_run_command" | "convert_artifact" | "verify_artifact_acceptance";
  readonly previewable: boolean;
}

/** Preview bodies are rendered by the browser artifact component; Router does not interpret their format-specific structure. */
export type RuntimeArtifactPreview = unknown;

/** Stable command-output reference projection. */
export interface RuntimeCommandOutput {
  readonly toolCallId: string;
  readonly stream: "stdout" | "stderr";
  readonly content: string;
  readonly path?: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly characters?: number;
}

/** Stable tool-argument reference projection. The arguments remain JSON data rather than Runtime objects. */
export interface RuntimeToolArguments {
  readonly toolCallId: string;
  readonly arguments: unknown;
  readonly content: string;
  readonly path?: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly characters?: number;
}

/** Router may address an open HIL request but never evaluates its Runtime-owned response schema. */
export interface RuntimeHumanLoopRequest {
  readonly schema: "agentloop.humanLoopRequest/v1";
  readonly id: string;
  readonly runId: string;
  readonly planId?: string;
  readonly stepId?: string;
  readonly actionId?: string;
  readonly origin: string;
  readonly kind: string;
  readonly title: string;
  readonly prompt: string;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
  readonly responseSchema: unknown;
  readonly resume: unknown;
  readonly status: string;
  readonly revision: number;
  readonly createdAt: number;
  readonly resolvedAt?: number;
}

export interface RuntimeHumanLoopResponse {
  readonly schema: "agentloop.humanLoopResponse/v1";
  readonly id: string;
  readonly requestId: string;
  readonly runId: string;
  readonly requestRevision: number;
  readonly value: unknown;
  readonly actorUserId: string;
  readonly createdAt: number;
}

/** Recovery policy is Host-owned. Router transports this opaque, JSON-compatible observation without interpreting it. */
export interface RuntimeRecoveryDetail {
  readonly state?: unknown;
  readonly action?: unknown;
  readonly decisions: readonly unknown[];
  readonly planRevisionAssessments: readonly unknown[];
  readonly userResponses: readonly unknown[];
}

export interface RuntimeRunStatus {
  readonly remoteRunId: string;
  readonly status: "running" | "completed" | "failed" | "cancelled";
  /**
   * The model key resolved by the owning Runtime for this Run.  This is
   * execution provenance, rather than the browser's requested model choice.
   */
  readonly modelKey?: string;
  readonly output?: string;
  /**
   * A Host-approved explanation for a failed Run. This is deliberately
   * separate from `output`, whose meaning is otherwise runtime-internal.
   */
  readonly partialOutput?: string;
  readonly errorCode?: string;
  /** User-observable terminal failure text projected from the Host Run event. */
  readonly errorMessage?: string;
  readonly finishedAt?: number;
  readonly artifacts?: readonly RuntimeArtifact[];
  readonly checkpoint?: {
    readonly id: string;
    readonly reason: "execution_authority_lost";
    readonly childRunId?: string;
  };
}

export interface RuntimeRunEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

/** Read-only Host projection used by operations surfaces. Outcome is canonical; artifacts never imply success. */
export interface RuntimeRunOperationsProjection {
  readonly schema: "agentloop.hostRun/v1";
  readonly run: {
    readonly id: string;
    readonly status: "running" | "completed" | "failed" | "cancelled";
    readonly input?: string;
    readonly modelKey?: string;
    readonly output?: string;
    readonly errorCode?: string;
    readonly finishedAt?: number;
    readonly createdAt: number;
    readonly conversationId?: string;
  };
  readonly outcome?: {
    readonly schema: "agentloop.hostOutcome/v1";
    readonly status: string;
    readonly reasonCode: string;
    readonly planId?: string;
    readonly output?: string;
    readonly committedAt: number;
  };
  readonly plan: {
    readonly state: "pending" | "available" | "unavailable";
    readonly id: string;
    readonly version: number;
    readonly status: string;
    readonly goal: string;
    readonly selectedSkillIds: readonly string[];
    readonly steps: readonly {
      readonly id: string;
      readonly status: string;
      readonly objective: string;
      readonly dependencies: readonly string[];
      readonly skillIds: readonly string[];
      readonly requiredCapabilities: readonly string[];
      readonly output?: string;
      readonly error?: string;
    }[];
    readonly assessmentCount: number;
    readonly approvedAssessmentCount: number;
  };
  readonly artifacts: readonly RuntimeArtifact[];
  readonly eventCursor: { readonly lastSeq: number };
}

/** Router-owned task summary enriched with the latest assignment and persisted turn projection. */
export interface RouterRunSummary {
  readonly id: string;
  readonly input?: string;
  readonly status: "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown";
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly assignmentId?: string;
  readonly remoteRunId?: string;
  readonly runtimeId?: string;
  readonly runtimeName?: string;
  readonly modelKey?: string;
  readonly output?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly artifactCount?: number;
  readonly planState?: RuntimeRunOperationsProjection["plan"]["state"];
  readonly planStepCount?: number;
}

export interface RouterRunPage {
  readonly items: readonly RouterRunSummary[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly pageCount: number;
}

export interface RouterRunDetail extends RouterRunSummary {
  readonly plan?: RuntimeRunOperationsProjection["plan"];
  readonly outcome?: RuntimeRunOperationsProjection["outcome"];
  readonly artifacts: readonly RuntimeArtifact[];
  readonly eventCursor?: { readonly lastSeq: number };
  readonly missingBoundaries: readonly ("router" | "runtime")[];
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
  hostRun?(remoteRunId: string): Promise<RuntimeRunOperationsProjection>;
  artifacts?(remoteRunId: string): Promise<readonly RuntimeArtifact[]>;
  readArtifact?(remoteRunId: string, artifactId: string): Promise<{ readonly artifact: RuntimeArtifact; readonly content: Uint8Array }>;
  previewArtifact?(remoteRunId: string, artifactId: string): Promise<RuntimeArtifactPreview>;
  cancelRun?(remoteRunId: string): Promise<RuntimeRunStatus>;
  events?(remoteRunId: string, afterSeq: number): Promise<readonly RuntimeRunEvent[]>;
  commandOutput?(remoteRunId: string, toolCallId: string, stream: "stdout" | "stderr"): Promise<RuntimeCommandOutput>;
  toolArguments?(remoteRunId: string, toolCallId: string): Promise<RuntimeToolArguments>;
  /** Advances the Host-owned recovery planner for a paused Run. */
  advanceRecovery?(remoteRunId: string): Promise<RuntimeRecoveryDetail>;
  /** Resumes a Host-admitted, replay-safe recovery action. */
  resumeRecovery?(remoteRunId: string): Promise<RuntimeRunStatus>;
  /** Starts a new child Run from the failed Run's persisted checkpoint. */
  startFromCheckpoint?(remoteRunId: string): Promise<RuntimeRunStatus>;
  currentHumanLoop?(remoteRunId: string): Promise<RuntimeHumanLoopRequest | undefined>;
  respondHumanLoop?(remoteRunId: string, requestId: string, input: { readonly value: unknown; readonly expectedRevision: number }): Promise<RuntimeHumanLoopResponse>;
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
  readonly executionTarget?: ExecutionTarget;
  readonly dataPolicy?: DataPolicy;
  readonly localDirectoryScopeIds?: readonly string[];
  /** Local Runtime-owned uploaded-source IDs. Valid only with a local_device target. */
  readonly localUploadedSourceIds?: readonly string[];
  /**
   * Replay-safe presentation metadata for Local Runtime uploads. Cloud
   * attachment snapshots are derived from Router-owned resource references.
   */
  readonly messageAttachments?: readonly ConversationAttachmentSnapshot[];
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
