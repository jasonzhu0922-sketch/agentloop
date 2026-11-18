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

/** Conditions are model-readable; context selectors are exact, source-bound
 * requirements. Missing context never satisfies a declared requirement. */
export interface MemoryApplicability {
  readonly conditions: readonly string[];
  readonly exclusions: readonly string[];
  readonly context?: Readonly<Record<string, readonly (string | number | boolean)[]>>;
  readonly excludedContext?: Readonly<Record<string, readonly (string | number | boolean)[]>>;
}

export const MEMORY_APPLICABILITY_SCHEMA = {
  type: "object", additionalProperties: false, required: ["conditions", "exclusions"],
  properties: {
    conditions: { type: "array", maxItems: 24, items: { type: "string", minLength: 1, maxLength: 1000 } },
    exclusions: { type: "array", maxItems: 24, items: { type: "string", minLength: 1, maxLength: 1000 } },
    context: { type: "object", maxProperties: 24, additionalProperties: { type: "array", minItems: 1, maxItems: 24, items: { anyOf: [{ type: "string", minLength: 1, maxLength: 200 }, { type: "number" }, { type: "boolean" }] } } },
    excludedContext: { type: "object", maxProperties: 24, additionalProperties: { type: "array", minItems: 1, maxItems: 24, items: { anyOf: [{ type: "string", minLength: 1, maxLength: 200 }, { type: "number" }, { type: "boolean" }] } } },
  },
} as const;

export function isMemoryApplicability(value: unknown): value is MemoryApplicability {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !["conditions", "exclusions", "context", "excludedContext"].includes(key))) return false;
  for (const key of ["conditions", "exclusions"]) {
    const list = row[key];
    if (!Array.isArray(list) || list.length > 24 || list.some(item => typeof item !== "string" || !item.trim() || item.length > 1000)) return false;
  }
  for (const key of ["context", "excludedContext"]) {
    const selectors = row[key];
    if (selectors === undefined) continue;
    if (!selectors || typeof selectors !== "object" || Array.isArray(selectors) || Object.keys(selectors).length > 24) return false;
    for (const [field, values] of Object.entries(selectors)) {
      if (!/^[a-zA-Z][\w.:-]{0,119}$/u.test(field) || ["constructor", "prototype", "__proto__"].includes(field)) return false;
      if (!Array.isArray(values) || !values.length || values.length > 24 || values.some(item =>
        !(typeof item === "boolean" || typeof item === "number" && Number.isFinite(item) || typeof item === "string" && item.trim().length > 0 && item.length <= 200))) return false;
    }
  }
  return true;
}

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
  readonly applicability?: MemoryApplicability;
  readonly validFrom?: number;
  readonly expiresAt?: number;
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
  /** Open-ended confirmed preferences and facts, bounded for this application target. */
  readonly preferences?: readonly {
    readonly memoryRevisionId: string;
    readonly subtype: string;
    readonly value: Readonly<Record<string, unknown>>;
    readonly contentMarkdown: string;
    readonly applicability?: MemoryApplicability;
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
    readonly applicability?: MemoryApplicability;
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
    readonly applicability?: MemoryApplicability;
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
    readonly scope?: MemoryApplicability;
    readonly requiresVerification?: boolean;
    /** Bind from the current task; historical case answers are never projected. */
    readonly reuse?: {
      readonly parameters: readonly { readonly name: string; readonly description: string }[];
      readonly verifiedScope: readonly string[];
      readonly unverifiedScope: readonly string[];
    };
    readonly reusableKnowledge?: readonly Readonly<Record<string, unknown>>[];
    readonly failureLessons?: readonly Readonly<Record<string, unknown>>[];
  }[];
}

export interface RuntimeGuidanceMemoryProjection extends MemoryProjectionBase {
  readonly target: "execution" | "artifact";
  readonly augmentations: readonly {
    readonly id: string;
    readonly contentMarkdown: string;
    readonly reason: string;
    readonly applicability?: MemoryApplicability;
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
