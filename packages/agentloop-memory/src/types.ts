import type {
  AgentLoopMemoryPlugin,
  MemoryApplicationTarget,
  MemoryAuthority,
  MemoryIntentCandidate,
  MemoryProjection,
  MemorySensitivity,
} from "@zhujun/agentloop";

export type MemoryKind = "preference" | "fact" | "experience";
export type MemoryTemporalClass = "stable" | "time_bound" | "ephemeral";
export type PreferenceEffect = "default" | "constraint";
export type ExperienceMaturity = "episode" | "pattern" | "procedure" | "template_candidate";
export type MemoryActivation =
  | { readonly mode: "always" }
  | {
      readonly mode: "task_match";
      readonly taskKinds?: readonly string[];
      readonly domains?: readonly string[];
      readonly artifactKinds?: readonly string[];
      readonly sourceKinds?: readonly string[];
    }
  | { readonly mode: "explicit_only" };

export interface MemorySourceRef {
  readonly type:
    | "user_message"
    | "user_setting"
    | "run"
    | "plan"
    | "assessment"
    | "outcome"
    | "action"
    | "event"
    | "user_feedback";
  readonly conversationId?: string;
  readonly messageId?: string;
  readonly runId?: string;
  readonly sourceHash?: string;
  readonly quotedText?: string;
  readonly sourceId?: string;
}

export interface MemoryScope {
  readonly tenantId: string;
  readonly ownerUserId: string;
}

export interface MemoryRunScope extends MemoryScope {
  readonly runId: string;
  readonly conversationId?: string;
  readonly parentRunId?: string;
}

export interface MemoryItem {
  readonly schema: "agentloop.userMemory/v1";
  readonly id: string;
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly kind: MemoryKind;
  readonly subtype: string;
  readonly canonicalKey?: string;
  readonly status: "active" | "superseded" | "deleted";
  readonly currentRevisionId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MemoryRevision {
  readonly schema: "agentloop.userMemoryRevision/v1";
  readonly id: string;
  readonly memoryId: string;
  readonly revision: number;
  readonly authority: MemoryAuthority;
  readonly sensitivity: Exclude<MemorySensitivity, "secret">;
  readonly temporalClass: MemoryTemporalClass;
  readonly preferenceEffect?: PreferenceEffect;
  readonly experienceMaturity?: ExperienceMaturity;
  readonly activation: MemoryActivation;
  readonly applicationTargets: readonly MemoryApplicationTarget[];
  readonly value: Readonly<Record<string, unknown>>;
  readonly contentMarkdown: string;
  readonly applicability: {
    readonly conditions: readonly string[];
    readonly exclusions: readonly string[];
  };
  readonly confidence: number;
  readonly validFrom: number;
  readonly expiresAt?: number;
  readonly supersedesRevisionId?: string;
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly changeReason: string;
  readonly createdAt: number;
}

export interface MemoryCandidate {
  readonly schema: "agentloop.userMemoryCandidate/v1";
  readonly id: string;
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly proposedKind: MemoryKind;
  readonly proposedSubtype: string;
  readonly proposedCanonicalKey?: string;
  readonly proposedValue: Readonly<Record<string, unknown>>;
  readonly proposedContentMarkdown: string;
  readonly persistenceIntent: "explicit" | "future_oriented" | "inferred";
  readonly authority: MemoryAuthority;
  readonly sensitivity: MemorySensitivity;
  readonly proposedPreferenceEffect?: PreferenceEffect;
  readonly proposedExperienceMaturity?: ExperienceMaturity;
  readonly activation: MemoryActivation;
  readonly applicationTargets: readonly MemoryApplicationTarget[];
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly confidence: number;
  readonly reason: string;
  readonly decision: "pending" | "accepted" | "confirmation_required" | "rejected";
  /** Optimistic concurrency guard used by semantic Task Group fusion. */
  readonly expectedCurrentRevisionId?: string;
}

export interface MemoryStore {
  settlementJobs(scope: MemoryScope, runId: string): Promise<readonly MemorySettlementJob[]>;
  recordSettlementAttempt(job: MemorySettlementJob, attempt: SettlementAttempt): Promise<void>;
  settlementAttempts(scope: MemoryScope, runId: string): Promise<readonly SettlementAttempt[]>;
  replaySettlement(scope: MemoryScope, runId: string, now: number): Promise<void>;
  currentEpoch(scope: MemoryScope): Promise<number>;
  active(scope: MemoryScope): Promise<readonly { readonly item: MemoryItem; readonly revision: MemoryRevision }[]>;
  commit(scope: MemoryScope, candidate: MemoryCandidate, now: number): Promise<{
    readonly item: MemoryItem;
    readonly revision: MemoryRevision;
    readonly memoryEpoch: number;
  }>;
  recordProjection(scope: MemoryScope, projection: MemoryProjection): Promise<void>;
  projections(scope: MemoryScope, runId: string): Promise<readonly MemoryProjection[]>;
  enqueueSettlement(input: { readonly scope: MemoryScope; readonly runId: string; readonly terminalCommitRef: string; readonly now: number }): Promise<{
    readonly kind: "enqueued" | "duplicate";
    readonly settlementJobId: string;
    readonly enqueuedAt: number;
  }>;
  settlementBatchCandidates(input: { readonly minimum: number; readonly maxAttempts: number }): Promise<readonly { readonly scope: MemoryScope; readonly count: number }[]>;
  claimSettlementBatch(input: { readonly scope: MemoryScope; readonly now: number; readonly maxAttempts: number; readonly limit: number; readonly allowedRunIds?: readonly string[]; readonly allowedSettlementJobIds?: readonly string[] }): Promise<readonly MemorySettlementJob[]>;
  claimSettlement(input: { readonly now: number; readonly maxAttempts: number; readonly allowedRunIds?: readonly string[]; readonly allowedSettlementJobIds?: readonly string[] }): Promise<MemorySettlementJob | undefined>;
  finishSettlement(input: {
    readonly job: MemorySettlementJob;
    readonly now: number;
    readonly maxAttempts: number;
    readonly outcome: "succeeded" | "failed";
    readonly error?: string;
  }): Promise<MemorySettlementJob>;
}

export interface SettlementAttempt {
  readonly stage: "extraction" | "fusion";
  readonly schema: string;
  readonly modelKey: string;
  readonly inputHash: string;
  readonly outputHash?: string;
  readonly candidateRevisionIds: readonly string[];
  readonly status: "accepted" | "invalid_output" | "model_unavailable";
  readonly errors: readonly { readonly path: string; readonly code: string }[];
  readonly elapsedMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export type MemorySettlementJobStatus = "queued" | "processing" | "succeeded" | "failed" | "dead_letter";

export interface MemorySettlementJob {
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly runId: string;
  readonly terminalCommitRef: string;
  readonly settlementJobId: string;
  readonly status: MemorySettlementJobStatus;
  readonly attempts: number;
  readonly lastError?: string;
  readonly nextAttemptAt: number;
  readonly enqueuedAt: number;
}

/**
 * The normalized shape used when a canonical Run is distilled into durable
 * experience. It intentionally mirrors the useful parts of Codex rollout
 * memory: outcome, key steps, reusable knowledge, failure corrections,
 * preference signals, and auditable references are separate fields.
 */
export type ExperienceSettlementPhase = "episode" | "procedure";
export type ExperienceSettlementOutcome = "verified_success" | "failure" | "mixed";

export interface ExperiencePreferenceSignal {
  readonly signal: string;
  readonly kind: "explicit_preference" | "correction" | "constraint";
  readonly sourceRefs: readonly MemorySourceRef[];
}

export interface ExperienceKeyStep {
  readonly order: number;
  readonly objective: string;
  readonly role?: string;
  /** Tools/Skills observed or recommended for this step; suggestions only. */
  readonly toolNames?: readonly string[];
  readonly skillIds?: readonly string[];
  readonly capabilityIds?: readonly string[];
  readonly requiredEvidenceKinds: readonly string[];
  readonly producedEvidenceKinds: readonly string[];
  readonly successCriteria?: readonly string[];
  readonly cautions?: readonly string[];
}

export interface ExperienceToolUsage {
  readonly toolName: string;
  readonly purpose?: string;
  readonly stepOrders: readonly number[];
  readonly sourceRefs: readonly MemorySourceRef[];
}

export interface ExperienceReusableKnowledge {
  readonly rule: string;
  readonly conditions: readonly string[];
  readonly exclusions: readonly string[];
  /** Structured fields required before this rule may become long-term knowledge. */
  readonly trigger?: string;
  readonly decision?: string;
  readonly rationale?: string;
  readonly action?: string;
  readonly expectedEvidence?: readonly string[];
  readonly sourceRefs: readonly MemorySourceRef[];
}

export interface ExperienceFailureLesson {
  readonly lesson: string;
  readonly doDifferently?: string;
  readonly trigger?: string;
  readonly symptom?: string;
  readonly rootCause?: string;
  readonly causeStatus?: "confirmed" | "inferred" | "unknown";
  readonly nextAction?: string;
  readonly verification?: string;
  readonly applicability?: readonly string[];
  readonly exclusions?: readonly string[];
  readonly sourceRefs: readonly MemorySourceRef[];
}

export interface ExperienceLearningValue {
  readonly status: "actionable" | "insufficient" | "unknown";
  readonly novelty: "new" | "reinforcement" | "none";
  readonly transferability: "task_family" | "run_specific" | "unknown";
  readonly actionChange?: string;
  readonly verification?: string;
}

export interface ExperienceSettlementPattern {
  readonly schema: "agentloop.experienceSettlement/v1";
  readonly phase: ExperienceSettlementPhase;
  readonly outcome: ExperienceSettlementOutcome;
  readonly outcomeReason: string;
  /** Codex-style Task Group fields; populated only after semantic settlement when available. */
  readonly title?: string;
  readonly goalSummary?: string;
  readonly keywords?: readonly string[];
  readonly reuseRule?: string;
  readonly recheckRules?: readonly string[];
  readonly conflicts?: readonly string[];
  readonly generalizationWarnings?: readonly string[];
  readonly applicability: {
    readonly taskFingerprint: Readonly<Record<string, unknown>>;
    readonly conditions: readonly string[];
    readonly exclusions: readonly string[];
  };
  readonly preferenceSignals: readonly ExperiencePreferenceSignal[];
  /** The generalized, ordered path that was repeatedly verified. */
  readonly classicPath: readonly ExperienceKeyStep[];
  readonly keySteps: readonly ExperienceKeyStep[];
  readonly toolUsage: readonly ExperienceToolUsage[];
  readonly cautions: readonly string[];
  readonly reusableKnowledge: readonly ExperienceReusableKnowledge[];
  readonly failureLessons: readonly ExperienceFailureLesson[];
  readonly learningValue?: ExperienceLearningValue;
  readonly verification: {
    readonly terminalCommitted: boolean;
    readonly assessmentApproved: boolean;
    readonly artifactVerified?: boolean;
    readonly laterCorrected: boolean;
    readonly laterDisputed: boolean;
    readonly evidenceCoverage?: number;
  };
  readonly references: readonly MemorySourceRef[];
}

export interface MemorySettlementEvidence {
  readonly scope: MemoryRunScope;
  readonly runId: string;
  readonly terminalCommitRef: string;
  readonly terminalStatus: "completed" | "failed" | "cancelled";
  readonly taskFingerprint: Readonly<Record<string, unknown>>;
  readonly strategy?: string;
  readonly observations?: readonly Readonly<{
    id: string;
    kind: "action" | "assessment" | "recovery" | "delivery";
    stepOrder?: number;
    toolName?: string;
    status: string;
    summary: string;
    sourceRefs: readonly MemorySourceRef[];
  }>[];
  readonly evidenceGaps?: readonly string[];
  readonly planSkeleton?: readonly Readonly<Record<string, unknown>>[];
  /** Optional structured facts supplied by a canonical local reader. */
  readonly keySteps?: readonly ExperienceKeyStep[];
  readonly toolUsage?: readonly ExperienceToolUsage[];
  readonly cautions?: readonly string[];
  readonly keyDecisions?: readonly string[];
  readonly successfulRecoveries?: readonly string[];
  readonly failureLessons?: readonly string[];
  readonly failureRemediations?: readonly Readonly<{
    readonly lesson: string;
    readonly doDifferently: string;
    readonly trigger?: string;
    readonly symptom?: string;
    readonly rootCause?: string;
    readonly causeStatus?: "confirmed" | "inferred" | "unknown";
    readonly nextAction?: string;
    readonly verification?: string;
    readonly applicability?: readonly string[];
    readonly exclusions?: readonly string[];
  }>[];
  readonly reusableKnowledge?: readonly Readonly<{
    readonly rule: string;
    readonly conditions?: readonly string[];
    readonly exclusions?: readonly string[];
    readonly trigger?: string;
    readonly decision?: string;
    readonly rationale?: string;
    readonly action?: string;
    readonly expectedEvidence?: readonly string[];
  }>[];
  readonly preferenceSignals?: readonly ExperiencePreferenceSignal[];
  readonly quality: {
    readonly terminalCommitted: boolean;
    readonly assessmentApproved: boolean;
    readonly artifactVerified?: boolean;
    readonly userFeedback?: "positive" | "negative";
    readonly laterCorrected: boolean;
    readonly laterDisputed: boolean;
    readonly evidenceCoverage?: number;
  };
  readonly efficiency?: {
    readonly durationMs: number;
    readonly modelCalls: number;
    readonly toolCalls: number;
    readonly retryCount: number;
  };
  readonly environment?: {
    readonly modelKey?: string;
    readonly skillIds?: readonly string[];
    readonly capabilityIds?: readonly string[];
    readonly runtimeProfile?: string;
  };
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly occurredAt: number;
}

export interface MemorySettlementReader {
  read(input: {
    readonly tenantId: string;
    readonly ownerUserId: string;
    readonly runId: string;
    readonly terminalCommitRef: string;
  }): Promise<MemorySettlementEvidence | undefined>;
}

export interface TaskGroupSearchInput {
  readonly taskFingerprint?: Readonly<Record<string, unknown>>;
  readonly query?: readonly string[];
  readonly limit?: number;
}

export interface TaskGroupSearchResult {
  readonly item: MemoryItem;
  readonly revision: MemoryRevision;
  readonly score: number;
  readonly matchedTerms: readonly string[];
}

/**
 * Local-only semantic compaction boundary. Implementations must route to a
 * device-local model; the Memory package never knows how that model is hosted.
 */
export interface MemorySettlementModel {
  readonly modelKey: string;
  complete(input: {
    readonly runId: string;
    readonly systemPrompt: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly content: string;
    readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  }>;
}

export interface MemoryPolicyDecision {
  readonly kind: "accept" | "confirmation_required" | "reject";
  readonly reason: string;
}

export interface MemoryPluginOptions {
  readonly resolveRunScope: (runId: string) => Promise<MemoryRunScope | undefined>;
  /** A durable local store in production; InMemoryMemoryStore is test-only. */
  readonly store: MemoryStore;
  readonly now?: () => number;
  readonly projectionTtlMs?: number;
  readonly resolveExplicitCandidate?: (input: {
    readonly scope: MemoryRunScope;
    readonly messageId: string;
    readonly userText: string;
    readonly candidateId: string;
    readonly memoryIntents?: readonly MemoryIntentCandidate[];
  }) => MemoryCandidate | undefined;
}

export interface UserInteractionProfile {
  readonly revision: number;
  readonly preferredAddress?: string;
  readonly language?: string;
  readonly tone?: Readonly<Record<string, unknown>>;
  readonly verbosity?: string;
  readonly formatting?: Readonly<Record<string, unknown>>;
}

export type { AgentLoopMemoryPlugin, MemoryApplicationTarget, MemoryProjection, MemoryAuthority, MemorySensitivity };
