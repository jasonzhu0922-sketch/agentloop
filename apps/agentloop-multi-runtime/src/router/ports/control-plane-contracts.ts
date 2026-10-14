import type {
  ConversationAttachmentSnapshot,
  ExecutionLocation,
  PortableResourceRef,
  RuntimeAssignment,
  RuntimeArtifact,
  RuntimeArtifactPreview,
  RuntimeInstance,
  RuntimeKind,
  RuntimeProfile,
  RuntimeRunStatus,
  SubmitConversationTask,
} from "../../shared/contracts.ts";

/** Router-owned state transitions. Persistence adapters must not invent extra states. */
export type AssignmentStatus = "reserved" | "accepted" | "completed" | "failed" | "cancelled" | "unknown" | "expired";

export interface RuntimeHeartbeat {
  /** Ephemeral liveness/capacity observation; it is never part of durable Router state. */
  readonly runtimeId: string;
  readonly status: "ready" | "draining" | "offline";
  readonly activeRunCount: number;
  readonly queuedRunCount: number;
  /** The limit enforced by this Host's local admission gate. */
  readonly maxConcurrentRuns?: number;
  readonly observedAt: number;
}

export interface StoredAssignment extends RuntimeAssignment {
  readonly status: AssignmentStatus;
  readonly reservationExpiresAt?: number;
  readonly runtimeEndpoint: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

/** A Router-owned failure that occurred before a Runtime admitted a Run. */
export interface DispatchFailure {
  readonly code: string;
  /** Safe, user-observable text. Never pass an upstream exception here. */
  readonly message: string;
}

export interface StoredRuntimeEndpoint {
  readonly id: string;
  readonly endpoint: string;
}

export interface RuntimeCatalogEntry {
  readonly id: string;
  readonly displayName?: string;
  readonly profile: RuntimeProfile;
  readonly kind: RuntimeKind;
  readonly deviceId?: string;
  readonly status: "ready" | "draining" | "offline";
}

export interface StoredConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly runCount: number;
  readonly lastStatus: string;
  /** Runtime ownership begins only after a Host has accepted a Run. */
  readonly boundRuntimeId?: string;
  readonly executionLocation?: ExecutionLocation;
}

export interface StoredConversationPage {
  readonly conversations: readonly StoredConversationSummary[];
  readonly hasMore: boolean;
  readonly nextOffset?: number;
}

export interface StoredConversationTurn {
  readonly clientMessageId: string;
  readonly input: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly attachments: readonly ConversationAttachmentSnapshot[];
  readonly finalTurn?: {
    readonly status: "completed" | "failed" | "cancelled";
    readonly assistantOutput?: string;
    readonly errorCode?: string;
    /** The actual model resolved by the owning Runtime, never a request hint. */
    readonly modelKey?: string;
    readonly completedAt: number;
  };
  readonly assignment?: {
    readonly id: string;
    readonly runtimeId: string;
    readonly runtimeDisplayName?: string;
    readonly executionLocation: ExecutionLocation;
    readonly status: AssignmentStatus;
    readonly hasRun: boolean;
    readonly remoteRunId?: string;
    readonly errorCode?: string;
    readonly errorMessage?: string;
  };
}

/**
 * Router application port. It exposes control-plane operations rather than
 * SQL primitives, so scheduling remains independent of the database adapter.
 */
export interface ControlPlaneRepository {
  seedRuntimes(runtimes: readonly (RuntimeInstance & { readonly endpoint: string })[], now?: number): Promise<void>;
  registerLocalRuntime(input: {
    readonly runtimeId: string; readonly deviceId: string; readonly tenantId: string; readonly ownerUserId: string;
    readonly connectionId: string; readonly connectionEpoch: number; readonly profile: RuntimeProfile;
    readonly capabilities: readonly string[]; readonly maxConcurrentRuns: number; readonly status: "ready" | "draining";
    readonly catalogVersion: string; readonly leaseExpiresAt: number; readonly now?: number;
  }): Promise<void>;
  unregisterLocalRuntime(runtimeId: string, connectionId: string, now?: number): Promise<void>;
  disconnectLocalRuntimes(connectionId: string, now?: number): Promise<void>;
  heartbeat(heartbeat: RuntimeHeartbeat): Promise<void>;
  runtimeEndpoints(tenantId?: string, ownerUserId?: string): Promise<readonly StoredRuntimeEndpoint[]>;
  runtimeCatalog(tenantId?: string, ownerUserId?: string): Promise<readonly RuntimeCatalogEntry[]>;
  listConversations(tenantId: string, ownerUserId: string, page: { readonly limit: number; readonly offset: number }): Promise<StoredConversationPage>;
  conversation(tenantId: string, ownerUserId: string, conversationId: string): Promise<{ readonly turns: readonly StoredConversationTurn[] } | undefined>;
  deleteConversation(tenantId: string, ownerUserId: string, conversationId: string): Promise<void>;
  reserve(task: SubmitConversationTask, input: { readonly heartbeatTtlMs: number; readonly reservationTtlMs: number; readonly now?: number }): Promise<StoredAssignment>;
  markAccepted(assignmentId: string, remoteRunId: string, now?: number): Promise<void>;
  markDispatchFailure(assignmentId: string, failure: DispatchFailure, now?: number): Promise<void>;
  createContinuationAssignment(parentAssignmentId: string, remoteRunId: string, now?: number): Promise<StoredAssignment>;
  observeRun(assignmentId: string, run: RuntimeRunStatus, now?: number): Promise<void>;
  assignment(id: string): Promise<StoredAssignment | undefined>;
  unsettledAssignments(afterId: string, limit: number): Promise<readonly StoredAssignment[]>;
}

/** Router's verified artifact projection boundary. A Blob store can replace the shared-workspace adapter. */
export interface RouterArtifactCatalog {
  capture(input: {
    readonly assignmentId: string; readonly tenantId: string; readonly ownerUserId: string;
    readonly conversationId: string; readonly remoteRunId: string; readonly artifacts: readonly RuntimeArtifact[];
  }): Promise<readonly RuntimeArtifact[]>;
  list(assignmentId: string): Promise<readonly RuntimeArtifact[]>;
  read(assignmentId: string, artifactId: string): Promise<{ readonly artifact: RuntimeArtifact; readonly content: Uint8Array } | undefined>;
  preview(assignmentId: string, artifactId: string): Promise<RuntimeArtifactPreview | undefined>;
}

/** Admission is an application concern even when SQL implements the reservation. */
export class RuntimeCapacityError extends Error {
  readonly statusCode = 429;
  readonly code = "runtime_capacity_exhausted";
}

/** A conversation cannot silently move to a Runtime with a different state ledger. */
export class ConversationRuntimeBindingError extends Error {
  readonly statusCode = 409;
  readonly code: "conversation_runtime_conflict" | "conversation_runtime_unavailable";

  constructor(runtimeId: string, reason: "conflict" | "unavailable") {
    super(reason === "conflict"
      ? `当前会话已绑定 Runtime ${runtimeId}；请新建会话后再切换 Runtime。`
      : `当前会话绑定的 Runtime ${runtimeId} 暂不可用；为避免上下文丢失，系统不会自动迁移，请恢复该 Runtime 或新建会话。`);
    this.code = reason === "conflict" ? "conversation_runtime_conflict" : "conversation_runtime_unavailable";
  }
}

/** A second turn cannot race the dispatch that will establish Runtime ownership. */
export class ConversationDispatchInProgressError extends Error {
  readonly statusCode = 409;
  readonly code = "conversation_dispatch_in_progress";

  constructor() {
    super("当前会话仍在分配 Runtime；请等待本轮派发完成后再提交。");
  }
}

/**
 * A dispatch request may have reached the Host even though its acknowledgement
 * was lost. The Router must retain the reservation and retry its idempotent
 * dispatch key instead of incorrectly declaring the Assignment failed.
 */
export class RuntimeDispatchOutcomeUnknownError extends Error {}
