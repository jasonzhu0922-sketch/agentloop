import type { ModelRetryReporter, ModelStreamRawCaptureWriter } from "./contracts.ts";
import type { RuntimeContextPlacement } from "./prompt-protocol.ts";

export interface OpenAICompatibleModelOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  /**
   * Some reasoning-mode OpenAI-compatible Providers reject named function
   * `tool_choice` values. `constrained-as-auto` keeps the legacy lowest common
   * denominator. `named-as-required` preserves single-tool structured phases by
   * requiring a tool call while leaving Runtime to validate the tool name.
   */
  readonly toolChoiceMode?: "native" | "constrained-as-auto" | "named-as-required";
  readonly runtimeContextPlacement?: RuntimeContextPlacement;
  /** Request a public reasoning summary from Responses-compatible models. */
  readonly reasoningSummary?: "auto" | "detailed";
  /** Keep provider-encrypted reasoning continuation in the Responses adapter only. */
  readonly reasoningEncryptedContent?: boolean;
  /** Internal registry-owned store; never part of the Runtime model contract. */
  readonly reasoningContinuationStore?: ResponsesReasoningContinuationStore;
  /** Internal profile scope for the registry-owned store. */
  readonly reasoningContinuationScope?: string;
  /** Optional upstream sampling controls; omitted values are not sent. */
  readonly temperature?: number;
  readonly topP?: number;
  /** Control Responses reasoning, or disable reasoning for tool-calling Chat Completions. */
  readonly reasoningEffort?: "none" | "low" | "medium" | "high";
  /** Control thinking for Chat Completions providers that expose DeepSeek's thinking extension. */
  readonly thinkingMode?: "enabled" | "disabled";
  /** Map the provider-neutral setting to Bailian's `enable_thinking` field. */
  readonly enableThinking?: boolean;
  /** Optional DeepSeek Chat Completions reasoning effort when thinking is enabled. */
  readonly thinkingEffort?: "low" | "medium" | "high";
  /** Whether provider reasoning may be projected into Runtime events. */
  readonly reasoningVisibility?: "visible" | "hidden";
  /** Override Chat Completions thinking for formal OutcomePlan requests only. */
  readonly planningThinkingMode?: "enabled" | "disabled";
  /** Server-configured OpenAI Chat Completions template extensions. */
  readonly chatTemplateKwargs?: Readonly<Record<string, unknown>>;
  /** Provider-owned JSON request parameters forwarded without interpretation. */
  readonly providerParameters?: Readonly<Record<string, unknown>>;
  /** Optional server-authored reporter invoked before each retry attempt. */
  readonly onRetry?: ModelRetryReporter;
  /** Deployment-owned persistence for anomalous raw upstream SSE bytes. */
  readonly streamRawCaptureWriter?: ModelStreamRawCaptureWriter;
}

export interface ResponsesReasoningContinuationStore {
  get(scope: string, runId: string): readonly Record<string, unknown>[];
  set(scope: string, runId: string, items: readonly Record<string, unknown>[]): void;
}

export class InMemoryResponsesReasoningContinuationStore implements ResponsesReasoningContinuationStore {
  private readonly values = new Map<string, { readonly items: readonly Record<string, unknown>[]; readonly expiresAt: number }>();
  private readonly maxEntries = 2_048;
  private readonly ttlMs = 24 * 60 * 60 * 1_000;

  get(scope: string, runId: string): readonly Record<string, unknown>[] {
    this.prune();
    return this.values.get(`${scope}\u0000${runId}`)?.items ?? [];
  }

  set(scope: string, runId: string, items: readonly Record<string, unknown>[]): void {
    const key = `${scope}\u0000${runId}`;
    this.prune();
    if (items.length === 0) this.values.delete(key);
    else {
      if (!this.values.has(key) && this.values.size >= this.maxEntries) {
        const oldest = this.values.keys().next().value;
        if (oldest !== undefined) this.values.delete(oldest);
      }
      this.values.delete(key);
      this.values.set(key, { items: items.map((item) => structuredClone(item)), expiresAt: Date.now() + this.ttlMs });
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.values) if (entry.expiresAt <= now) this.values.delete(key);
  }
}
