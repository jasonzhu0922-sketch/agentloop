/**
 * Kernel-owned protocol for user Memory.
 *
 * The kernel owns when this SPI is called and how failures affect a Run. The
 * Memory implementation owns persistence, policy, retrieval and projection
 * compilation. Inputs intentionally contain only a trusted runId; callers
 * cannot smuggle a tenant or user identity into a Memory request.
 */

export type MemoryApplicationTarget =
  | "response"
  | "planner"
  | "execution"
  | "artifact"
  | "human_loop";

export type MemoryAuthority =
  | "explicit_user"
  | "user_confirmed"
  | "verified_run"
  | "inferred";

export type MemorySensitivity = "normal" | "private" | "restricted" | "secret";

/**
 * Model-authored memory proposal. It is evidence only: the Memory plugin
 * still owns canonical subtype/value validation, privacy policy, and commit.
 */
export interface MemoryIntentCandidate {
  readonly schema: "agentloop.memoryIntentCandidate/v1";
  /** Model-authored durable user memory proposal. Facts and preferences have
   * different projection semantics and must not be collapsed into one kind. */
  readonly kind: "preference" | "fact";
  readonly subtype: string;
  readonly canonicalKey: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly contentMarkdown?: string;
  /** Verbatim evidence from the current user message, never assistant prose. */
  readonly sourceQuote?: string;
  readonly persistenceIntent: "explicit" | "future_oriented" | "inferred";
  readonly sensitivity: MemorySensitivity;
  readonly applicationTargets: readonly MemoryApplicationTarget[];
  readonly confidence: number;
}

export type MemoryProjection =
  | InteractionMemoryProjection
  | PlanningMemoryProjection
  | RuntimeGuidanceMemoryProjection;

export interface MemoryProjectionBase {
  readonly schema: "agentloop.memoryProjection/v1";
  readonly id: string;
  readonly runId: string;
  readonly target: MemoryApplicationTarget;
  readonly memoryEpoch: number;
  readonly profileRevision?: number;
  readonly memoryRevisionIds: readonly string[];
  readonly retrievalReasons: readonly string[];
  readonly projectionContextHash?: string;
  readonly contentHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Open-ended confirmed preferences, bounded for this application target. */
  readonly preferences?: readonly {
    readonly memoryRevisionId: string;
    readonly subtype: string;
    readonly value: Readonly<Record<string, unknown>>;
    readonly contentMarkdown: string;
  }[];
}

export interface InteractionMemoryProjection extends MemoryProjectionBase {
  readonly target: "response" | "human_loop";
  readonly guidance: {
    readonly preferredAddress?: string;
    readonly language?: string;
    readonly tone?: Readonly<Record<string, unknown>>;
    readonly verbosity?: string;
    readonly formatting?: Readonly<Record<string, unknown>>;
  };
  /** Explicit user facts authorized for response/human-loop use. */
  readonly facts?: readonly {
    readonly memoryRevisionId: string;
    readonly subtype: string;
    readonly value: Readonly<Record<string, unknown>>;
    readonly stale: boolean;
  }[];
  readonly promptMarkdown: string;
}

export interface PlanningMemoryProjection extends MemoryProjectionBase {
  readonly target: "planner";
  readonly relevantFacts: readonly {
    readonly memoryRevisionId: string;
    readonly subtype: string;
    readonly value: Readonly<Record<string, unknown>>;
    readonly stale: boolean;
  }[];
  readonly preferenceConstraints: readonly Readonly<Record<string, unknown>>[];
  readonly planningPriors: readonly {
    readonly schema: "agentloop.planningPrior/v1";
    readonly id: string;
    readonly source: "plan_template" | "experience_procedure" | "experience_episode";
    readonly applicability: string;
    readonly strategy: string;
    readonly suggestedSteps: readonly Readonly<Record<string, unknown>>[];
    readonly classicPath?: readonly Readonly<Record<string, unknown>>[];
    readonly toolUsage?: readonly Readonly<Record<string, unknown>>[];
    readonly skillSuggestions?: readonly string[];
    readonly capabilitySuggestions?: readonly string[];
    readonly evidenceExpectations: readonly string[];
    readonly cautions?: readonly string[];
    readonly warnings: readonly string[];
    readonly confidence: number;
    readonly sourceRefs: readonly string[];
  }[];
}

export interface RuntimeGuidanceMemoryProjection extends MemoryProjectionBase {
  readonly target: "execution" | "artifact";
  readonly augmentations: readonly {
    readonly id: string;
    readonly contentMarkdown: string;
    readonly reason: string;
  }[];
}

export interface MemoryProjectionBudget {
  readonly maxItems: number;
  readonly maxTokens: number;
}

export interface ExplicitMemoryCommitRequest {
  readonly runId: string;
  readonly messageId: string;
  readonly userText: string;
  readonly memoryIntents?: readonly MemoryIntentCandidate[];
}

export interface MemoryCommitReceipt {
  readonly id: string;
  readonly memoryEpoch: number;
  readonly affectedTargets: readonly MemoryApplicationTarget[];
  readonly committedCount?: number;
}

export type ExplicitMemoryCommitResult =
  | { readonly kind: "not_applicable" }
  | {
      readonly kind: "confirmation_required";
      readonly candidateId: string;
      readonly prompt: string;
    }
  | {
      readonly kind: "committed";
      readonly receipt: MemoryCommitReceipt;
      readonly pendingConfirmations?: readonly { readonly candidateId: string; readonly prompt: string }[];
    };

/**
 * Runtime-owned outcome for a durable-memory request in the current turn.
 * This is supplied to response generation and assessment so model prose
 * cannot turn an uncommitted proposal into a false persistence receipt.
 */
export interface CurrentTurnMemoryCommitState {
  readonly status:
    | "committed"
    | "partial"
    | "confirmation_required"
    | "not_saved"
    | "failed"
    | "unavailable";
  readonly candidateCount: number;
  readonly committedCount?: number;
  readonly confirmationPrompts?: readonly string[];
}

export interface MemorySettlementEnqueueReceipt {
  readonly kind: "enqueued" | "duplicate";
  readonly settlementJobId: string;
  readonly enqueuedAt: number;
}

export interface AgentLoopMemoryPlugin {
  readonly name: string;

  recall(input: {
    readonly runId: string;
    readonly target: MemoryApplicationTarget;
    readonly taskFingerprint?: Readonly<Record<string, unknown>>;
    readonly stepContext?: Readonly<Record<string, unknown>>;
    readonly budget: MemoryProjectionBudget;
  }): Promise<MemoryProjection | undefined>;

  commitExplicit(input: ExplicitMemoryCommitRequest): Promise<ExplicitMemoryCommitResult>;

  enqueueSettlement(input: {
    readonly runId: string;
    readonly terminalCommitRef: string;
  }): Promise<MemorySettlementEnqueueReceipt>;

  close?(): Promise<void>;
}
