export type JsonSchema = Readonly<Record<string, unknown>>;

/**
 * Server-authored state that is relevant to the next model turn but is not a
 * user message. It is encoded into the provider's native protocol only at the
 * model boundary. The Runtime, not the model, owns its content and version.
 */
export interface RuntimeContextSnapshot {
  readonly id: string;
  readonly phase: "planning" | "execution" | "assessment" | "compaction";
  readonly content: string;
  readonly supersedesId?: string;
}

export interface RuntimeDeliveryCandidateEvidenceKinds {
  readonly satisfied: readonly string[];
  readonly caveated: readonly string[];
  readonly failed: readonly string[];
}

export interface RuntimeDeliveryReceipt {
  readonly schema: "agentloop.runtimeDeliveryReceipt/v1";
  readonly artifact: {
    readonly path: string;
    readonly bytes?: number;
    readonly sha256?: string;
    readonly kind?: string;
  };
  readonly verdict: "accepted" | "caveated";
  readonly caveats: readonly string[];
  readonly sourceToolCallId: string;
}

export interface RuntimeDeliveryCandidate {
  readonly schema: "agentloop.runtimeDeliveryCandidate/v1";
  readonly output: string;
  readonly caveats: readonly string[];
  readonly evidenceKinds: RuntimeDeliveryCandidateEvidenceKinds;
  readonly sourceToolCallIds: readonly string[];
  readonly deliveryReceipt?: RuntimeDeliveryReceipt;
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export type ModelMessage =
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls?: readonly ModelToolCall[];
      /** Provider reasoning content, also preserved when the provider needs it for continuation. */
      readonly reasoningContent?: string;
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly name: string;
      readonly content: string;
      readonly isError: boolean;
    };

export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

/**
 * Provider-neutral input to one model turn.
 *
 * `messages` is the canonical user/assistant/tool transcript. Runtime state
 * belongs in `runtimeContext`, never in a synthetic user turn. Provider
 * adapters decide how to encode that state for their supported wire protocol.
 */
export interface ModelInvocation {
  readonly runId: string;
  readonly systemPrompt: string;
  readonly phase: RuntimeContextSnapshot["phase"];
  readonly runtimeContext?: RuntimeContextSnapshot;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly toolChoice?: "auto" | "required" | Readonly<{ name: string }>;
  readonly maxOutputTokens?: number;
}

export interface ModelResponse {
  readonly content: string;
  readonly toolCalls: readonly ModelToolCall[];
  readonly finishReason: "stop" | "tool_calls" | "length" | "error";
  /** Provider reasoning content, retained for continuation and exposed in the run event stream. */
  readonly reasoningContent?: string;
  /** Provider-supplied cause for a non-completed response, when available. */
  readonly finishReasonDetail?: string;
  readonly usage?: Readonly<{
    inputTokens?: number;
    outputTokens?: number;
  }>;
}

export interface ModelRequestLogContext {
  readonly protocol: "chat-completions" | "responses";
  readonly model: string;
  readonly phase: RuntimeContextSnapshot["phase"] | "unknown";
  readonly stream: boolean;
  readonly canonicalMessageCount: number;
  readonly providerMessageCount?: number;
  readonly providerInputItemCount?: number;
  readonly insertedEmptyInputSentinel?: boolean;
  readonly toolCount: number;
  readonly toolChoice: string;
  readonly runtimeContextPlacement: string;
}

/**
 * Incremental, provider-neutral deltas emitted while one model turn streams.
 * These are transient progress signals, not durable checkpoints; the Runtime
 * still records the aggregated ModelResponse through its normal commit path.
 */
export type ModelStreamEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "reasoning_delta"; readonly text: string }
  | {
      readonly type: "tool_call_delta";
      readonly index: number;
      readonly id?: string;
      readonly name?: string;
      readonly argumentsDelta: string;
    }
  | {
      /**
       * One tool call's arguments are complete. Adapters emit this as soon as
       * the provider signals a per-item completion (Responses API
       * `function_call_arguments.done`) or, for Chat Completions streaming
       * where only the terminal chunk is authoritative, once the stream ends.
       * The Runtime may dispatch the tool immediately on this event.
       */
      readonly type: "tool_call_ready";
      readonly index: number;
      readonly id: string;
      readonly name: string;
      readonly arguments: unknown;
    };

export type ModelStreamSink = (event: ModelStreamEvent) => void | Promise<void>;

/**
 * Server-authored progress signal emitted when a model request is retried
 * inside the adapter. The Runtime persists it as a durable `model.retry` event
 * so the UI can surface a bounded retry instead of a silent hang or failure.
 */
export interface ModelRetryInfo {
  /** The 1-based attempt number that just failed. */
  readonly attempt: number;
  /** Total attempts allowed for one model request. */
  readonly maxAttempts: number;
  /** HTTP status that triggered the retry, when the failure was an HTTP response. */
  readonly status?: number;
  /** Backoff delay in milliseconds before the next attempt. */
  readonly delayMs: number;
  /** Sanitized provider-bound request shape, without prompt, tool results, or secrets. */
  readonly request?: ModelRequestLogContext;
}

export type ModelRetryReporter = (info: ModelRetryInfo) => void | Promise<void>;

export interface ModelAdapter {
  readonly limits: Readonly<{
    contextWindowTokens: number;
    maxOutputTokens: number;
  }>;
  /** Upper bound for one provider request, used by the Runtime Action deadline. */
  readonly operationTimeoutMs?: number;
  /**
   * Optional Provider-native prompt estimate. Context assembly uses it when
   * available so the same encoder that creates the wire request also informs
   * the budget. Adapters without one retain the Runtime's conservative,
   * provider-neutral estimate.
   */
  estimateInputTokens?(invocation: ModelInvocation): number | undefined;
  /** Sanitized provider-bound request shape for Runtime observability. */
  requestLogContext?(invocation: ModelInvocation, stream: boolean): ModelRequestLogContext | undefined;
  complete(invocation: ModelInvocation, signal?: AbortSignal): Promise<ModelResponse>;
  /**
   * Streaming variant of complete(). Emits incremental text and tool-call
   * argument deltas through `sink` as they arrive, then resolves to the same
   * aggregated ModelResponse. Adapters without native streaming omit this and
   * the Runtime falls back to complete().
   */
  streamComplete?(
    invocation: ModelInvocation,
    sink: ModelStreamSink,
    signal?: AbortSignal,
  ): Promise<ModelResponse>;
}

export interface CapabilityGrant {
  readonly actorUserId: string;
  readonly runId: string;
  readonly conversationId?: string;
  readonly depth: number;
  readonly workspaceRoot?: string;
  readonly visibleDirectories: readonly VisibleDirectoryGrant[];
  readonly uploadedSources: readonly UploadedSourceSummary[];
  readonly skillExecutionRoots: readonly SkillExecutionRootGrant[];
  readonly allowedToolNames: ReadonlySet<string>;
  readonly allowedSkillIds: ReadonlySet<string>;
}

export interface VisibleDirectoryGrant {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

export type UploadedSourceStatus =
  | "uploaded"
  | "ready"
  | "unsupported"
  | "oversized"
  | "unreadable"
  | "extract_failed"
  | "deleted";

export interface UploadedSourceSummary {
  readonly id: string;
  readonly originalName: string;
  readonly mimeType: string;
  readonly extension: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly status: UploadedSourceStatus;
  readonly summary?: string;
  readonly chunkCount: number;
  readonly truncated: boolean;
}

export interface SkillExecutionRootGrant {
  readonly id: string;
  readonly skillId: string;
  readonly name: string;
  readonly cwd: string;
  readonly path: string;
}

export interface RuntimeEvent {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export type RuntimeEventSink = (event: RuntimeEvent) => Promise<void> | void;

export interface AgentLoopResult {
  readonly output: string;
  readonly deliveryCandidate?: RuntimeDeliveryCandidate;
  readonly messages: readonly ModelMessage[];
  readonly steps: number;
  readonly toolEvidence: readonly AgentLoopToolEvidence[];
  readonly activatedSkillNames: readonly string[];
  readonly deferredValidation?: boolean;
  readonly completionCaveat?: RuntimeCompletionCaveat;
}

export interface RuntimeCompletionCaveat {
  readonly reason: "deferred_validation" | "process_caveat" | "repair_limit" | "evidence_boundary";
  readonly feedback: string;
}

export interface AgentLoopToolEvidence {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result: string;
  readonly isError: boolean;
  readonly failurePhase?: "prepare" | "execute" | "runtime";
}

export interface CandidateCompletionContext {
  readonly output: string;
  readonly deliveryCandidate?: RuntimeDeliveryCandidate;
  readonly stepSemanticFrame?: Readonly<{
    readonly completionBoundary: readonly string[];
    readonly evidenceMode: string;
    readonly phaseRole: string;
  }>;
  readonly messages: readonly ModelMessage[];
  readonly modelSteps: number;
  readonly toolEvidence: readonly AgentLoopToolEvidence[];
  readonly projectedToolEvidence: readonly AgentLoopToolEvidence[];
  readonly activatedSkillNames: readonly string[];
  readonly contextSummary?: string;
}

export interface CandidateCompletionEvaluation {
  readonly approved: boolean;
  readonly feedback: string;
  readonly deferredValidation?: boolean;
  readonly evidenceBoundary?: boolean;
  readonly allowRepairLimitCompletion?: boolean;
  readonly failedBoundary?: Readonly<{
    readonly stepId: string;
    readonly missingEvidenceKinds: readonly string[];
    readonly violatedSkillRequirements: readonly string[];
    readonly reusableEvidenceRefs: readonly string[];
    readonly suggestedRepairShape: "repair_leaf" | "revise_plan" | "ask_user" | "fail";
  }>;
  readonly assessmentReused?: boolean;
}
