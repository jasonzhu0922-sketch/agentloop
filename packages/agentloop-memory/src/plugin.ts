import { createHash } from "node:crypto";
import type {
  AgentLoopMemoryPlugin,
  ExplicitMemoryCommitResult,
  MemoryIntentCandidate,
  MemoryApplicationTarget,
  MemoryProjection,
} from "@zhujun/agentloop";
import type { SqlConnection } from "@zhujun/agentloop";
import { evaluateCandidate } from "./policy.ts";
import { SqliteMemoryStore } from "./sqlite-store.ts";
import type {
  MemoryCandidate,
  MemoryPluginOptions,
  MemoryRevision,
  MemoryRunScope,
  MemoryStore,
} from "./types.ts";

function hash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function candidateId(scope: MemoryRunScope, messageId: string, userText: string): string {
  return `memcand_${hash({ tenantId: scope.tenantId, ownerUserId: scope.ownerUserId, messageId, userText }).slice(0, 24)}`;
}

function defaultCandidate(input: Parameters<NonNullable<MemoryPluginOptions["resolveExplicitCandidate"]>>[0]): MemoryCandidate | undefined {
  if (input.memoryIntents !== undefined && input.memoryIntents.length > 0) {
    for (const intent of input.memoryIntents) {
      const candidate = candidateFromIntent(intent, input);
      if (candidate !== undefined) return candidate;
    }
    return undefined;
  }
  const address = input.userText.match(/以后(?:都)?叫我[“"「]?([^”"」,，。！？!?\n]{1,32})[”"」]?/u)?.[1]?.trim();
  if (address !== undefined && address.length > 0) {
    return {
      schema: "agentloop.userMemoryCandidate/v1",
      id: input.candidateId,
      tenantId: input.scope.tenantId,
      ownerUserId: input.scope.ownerUserId,
      proposedKind: "preference",
      proposedSubtype: "interaction.address",
      proposedCanonicalKey: "interaction.address",
      proposedValue: { preferredAddress: address },
      proposedContentMarkdown: "用户希望在适合称呼时使用其指定称呼。",
      persistenceIntent: "explicit",
      authority: "explicit_user",
      sensitivity: "normal",
      proposedPreferenceEffect: "default",
      activation: { mode: "always" },
      applicationTargets: ["response", "human_loop"],
      sourceRefs: [{ type: "user_message", runId: input.scope.runId, messageId: input.messageId }],
      confidence: 1,
      reason: "explicit_user_preference",
      decision: "pending",
    };
  }

  if (/(以后|从现在开始).*(直接|专业|客套|赞美|篇幅|简洁|详细)/u.test(input.userText)) {
    const avoid = [
      ...(input.userText.includes("客套") ? ["unnecessary_politeness"] : []),
      ...(input.userText.includes("赞美") ? ["excessive_praise"] : []),
    ];
    const tone: Record<string, unknown> = {
      ...(input.userText.includes("直接") ? { directness: "high" } : {}),
      ...(input.userText.includes("专业") ? { formality: "professional" } : {}),
      ...(avoid.length === 0 ? {} : { avoid }),
    };
    return {
      schema: "agentloop.userMemoryCandidate/v1",
      id: input.candidateId,
      tenantId: input.scope.tenantId,
      ownerUserId: input.scope.ownerUserId,
      proposedKind: "preference",
      proposedSubtype: "interaction.tone",
      proposedCanonicalKey: "interaction.tone",
      proposedValue: tone,
      proposedContentMarkdown: "用户偏好直接、专业、克制的交互风格。",
      persistenceIntent: "explicit",
      authority: "explicit_user",
      sensitivity: "normal",
      proposedPreferenceEffect: "default",
      activation: { mode: "always" },
      applicationTargets: ["response", "human_loop", "planner"],
      sourceRefs: [{ type: "user_message", runId: input.scope.runId, messageId: input.messageId }],
      confidence: 1,
      reason: "explicit_user_preference",
      decision: "pending",
    };
  }
  return undefined;
}

function candidateFromIntent(
  intent: MemoryIntentCandidate,
  input: Parameters<NonNullable<MemoryPluginOptions["resolveExplicitCandidate"]>>[0],
): MemoryCandidate | undefined {
  if (intent.kind !== "preference" || intent.subtype !== intent.canonicalKey) return undefined;
  const scalarKeys: Record<string, string> = {
    "interaction.address": "preferredAddress",
    "interaction.language": "language",
    "interaction.verbosity": "verbosity",
  };
  const scalarKey = scalarKeys[intent.canonicalKey];
  const scalarValue = scalarKey === undefined ? undefined : intent.value[scalarKey];
  const recordKeys = new Set(["interaction.tone", "interaction.formatting"]);
  if (scalarKey !== undefined && (typeof scalarValue !== "string" || scalarValue.trim().length === 0 || scalarValue.trim().length > 128)) return undefined;
  if (recordKeys.has(intent.canonicalKey) && (intent.value[intent.canonicalKey.split(".")[1] ?? ""] === undefined || typeof intent.value[intent.canonicalKey.split(".")[1] ?? ""] !== "object")) return undefined;
  if (scalarKey === undefined && !recordKeys.has(intent.canonicalKey)
    && intent.sensitivity !== "restricted" && intent.sensitivity !== "private") return undefined;
  const proposedValue = scalarKey === undefined
    ? intent.value
    : { [scalarKey]: (scalarValue as string).trim() };
  if (JSON.stringify(proposedValue).length > 2_000) return undefined;
  return {
    schema: "agentloop.userMemoryCandidate/v1",
    id: input.candidateId,
    tenantId: input.scope.tenantId,
    ownerUserId: input.scope.ownerUserId,
    proposedKind: "preference",
    proposedSubtype: intent.subtype,
    proposedCanonicalKey: intent.canonicalKey,
    proposedValue,
    proposedContentMarkdown: intent.contentMarkdown ?? "用户希望在适合称呼时使用其指定称呼。",
    persistenceIntent: intent.persistenceIntent,
    authority: intent.persistenceIntent === "inferred" ? "inferred" : "explicit_user",
    sensitivity: intent.sensitivity,
    proposedPreferenceEffect: "default",
    activation: { mode: "always" },
    applicationTargets: intent.applicationTargets,
    sourceRefs: [{ type: "user_message", runId: input.scope.runId, messageId: input.messageId }],
    confidence: intent.confidence,
    reason: "structured_user_memory_intent",
    decision: "pending",
  };
}

export function createMemoryPlugin(options: MemoryPluginOptions): AgentLoopMemoryPlugin & { readonly store: MemoryStore } {
  const store = options.store;
  const now = options.now ?? (() => Date.now());
  const projectionTtlMs = options.projectionTtlMs ?? 5 * 60_000;
  const resolveCandidate = options.resolveExplicitCandidate ?? defaultCandidate;

  const plugin: AgentLoopMemoryPlugin = {
    name: "agentloop-memory",

    recall: async (input): Promise<MemoryProjection | undefined> => {
      const scope = await options.resolveRunScope(input.runId);
      if (scope === undefined) return undefined;
      const epoch = await store.currentEpoch(scope);
      const active = await store.active(scope);
      const currentNow = now();
      const matching = active
        .filter(({ revision }) => revision.applicationTargets.includes(input.target))
        .filter(({ item, revision }) => input.target !== "planner" || item.kind !== "experience" || revision.experienceMaturity === "procedure")
        .filter(({ item, revision }) => item.kind !== "experience" || revision.value.settlementPromptSchemaVersion === "agentloop.semanticSettlement/v2")
        .filter(({ revision }) => activationApplies(revision, input.taskFingerprint, currentNow))
        .slice(0, Math.max(0, input.budget.maxItems));
      if (matching.length === 0) return undefined;
      const bounded = boundEntries(matching, input.budget.maxTokens);
      const projection = compileProjection({
        runId: input.runId,
        target: input.target,
        memoryEpoch: epoch,
        entries: bounded,
        taskFingerprint: input.taskFingerprint,
        stepContext: input.stepContext,
        now: currentNow,
        expiresAt: currentNow + projectionTtlMs,
      });
      await store.recordProjection(scope, projection);
      return projection;
    },

    commitExplicit: async (input): Promise<ExplicitMemoryCommitResult> => {
      const scope = await options.resolveRunScope(input.runId);
      if (scope === undefined) return { kind: "not_applicable" };
      const candidate = resolveCandidate({
        scope,
        messageId: input.messageId,
        userText: input.userText,
        candidateId: candidateId(scope, input.messageId, input.userText),
        ...(input.memoryIntents === undefined ? {} : { memoryIntents: input.memoryIntents }),
      });
      if (candidate === undefined) return { kind: "not_applicable" };
      const decision = evaluateCandidate(candidate);
      if (decision.kind === "reject") return { kind: "not_applicable" };
      if (decision.kind === "confirmation_required") {
        return {
          kind: "confirmation_required",
          candidateId: candidate.id,
          prompt: "这条信息涉及需要确认的长期记忆，确认后我才会保存。",
        };
      }
      const committed = await store.commit(scope, { ...candidate, decision: "accepted" }, now());
      return {
        kind: "committed",
        receipt: {
          id: `memreceipt_${hash(committed.revision.id).slice(0, 24)}`,
          memoryEpoch: committed.memoryEpoch,
          affectedTargets: committed.revision.applicationTargets,
        },
      };
    },

    enqueueSettlement: async (input) => {
      const scope = await options.resolveRunScope(input.runId);
      if (scope === undefined) throw new Error(`trusted_run_scope_not_found:${input.runId}`);
      return store.enqueueSettlement({ scope, runId: scope.runId, terminalCommitRef: input.terminalCommitRef, now: now() });
    },
  };
  return Object.assign(plugin, { store });
}

export async function createLocalMemoryPlugin(
  options: Omit<MemoryPluginOptions, "store"> & { readonly database: SqlConnection },
): Promise<AgentLoopMemoryPlugin & { readonly store: SqliteMemoryStore }> {
  const store = new SqliteMemoryStore(options.database);
  await store.ready();
  return createMemoryPlugin({ ...options, store }) as AgentLoopMemoryPlugin & { readonly store: SqliteMemoryStore };
}

function activationApplies(
  revision: MemoryRevision,
  taskFingerprint: Readonly<Record<string, unknown>> | undefined,
  currentNow: number,
): boolean {
  if (revision.expiresAt !== undefined && revision.expiresAt <= currentNow) return false;
  if (revision.activation.mode === "always") return true;
  if (revision.activation.mode === "explicit_only") return false;
  if (taskFingerprint === undefined) return false;
  return matchesAny(revision.activation.taskKinds, taskFingerprint.taskKind) &&
    matchesAny(revision.activation.domains, taskFingerprint.domain) &&
    matchesAny(revision.activation.artifactKinds, taskFingerprint.artifactKind) &&
    matchesAny(revision.activation.sourceKinds, taskFingerprint.sourceKind);
}

function matchesAny(values: readonly string[] | undefined, actual: unknown): boolean {
  return values === undefined || (typeof actual === "string" && values.includes(actual));
}

function boundEntries<T extends { readonly revision: MemoryRevision }>(entries: readonly T[], maxTokens: number): readonly T[] {
  if (maxTokens <= 0) return [];
  const result: T[] = [];
  let used = 0;
  for (const entry of entries) {
    const estimate = Math.max(1, Math.ceil(entry.revision.contentMarkdown.length / 4));
    if (used + estimate > maxTokens) break;
    result.push(entry);
    used += estimate;
  }
  return result;
}

function compileProjection(input: {
  readonly runId: string;
  readonly target: MemoryApplicationTarget;
  readonly memoryEpoch: number;
  readonly entries: readonly { readonly item: { readonly kind: string; readonly subtype: string }; readonly revision: MemoryRevision }[];
  readonly taskFingerprint?: Readonly<Record<string, unknown>>;
  readonly stepContext?: Readonly<Record<string, unknown>>;
  readonly now: number;
  readonly expiresAt: number;
}): MemoryProjection {
  const base = {
    schema: "agentloop.memoryProjection/v1" as const,
    id: "",
    runId: input.runId,
    target: input.target,
    memoryEpoch: input.memoryEpoch,
    memoryRevisionIds: input.entries.map(({ revision }) => revision.id),
    retrievalReasons: input.entries.map(({ item }) => `${item.kind}:${item.subtype}`),
    projectionContextHash: hash({ taskFingerprint: input.taskFingerprint, stepContext: input.stepContext }),
    createdAt: input.now,
    expiresAt: input.expiresAt,
  };
  let projection: any;
  if (input.target === "response" || input.target === "human_loop") {
    const preferences = input.entries.filter(({ item }) => item.kind === "preference").map(({ revision }) => revision);
    const guidance = {
      preferredAddress: stringValue(preferences, "preferredAddress"),
      language: stringValue(preferences, "language"),
      tone: recordValue(preferences, "tone"),
      verbosity: stringValue(preferences, "verbosity"),
      formatting: recordValue(preferences, "formatting"),
    };
    const promptMarkdown = [
      guidance.preferredAddress === undefined ? undefined : `称呼偏好：${guidance.preferredAddress}`,
      guidance.language === undefined ? undefined : `语言偏好：${guidance.language}`,
      guidance.tone === undefined ? undefined : "按用户已确认的语气偏好回复。",
      guidance.verbosity === undefined ? undefined : `篇幅偏好：${guidance.verbosity}`,
    ].filter((value): value is string => value !== undefined).join("\n");
    projection = { ...base, target: input.target, guidance, promptMarkdown, id: "" };
  } else if (input.target === "planner") {
    const facts = input.entries.filter(({ item }) => item.kind === "fact").map(({ item, revision }) => ({
      memoryRevisionId: revision.id,
      subtype: item.subtype,
      value: revision.value,
      stale: revision.expiresAt !== undefined && revision.expiresAt <= input.now,
    }));
    const preferenceConstraints = input.entries
      .filter(({ item, revision }) => item.kind === "preference" && revision.preferenceEffect === "constraint")
      .map(({ revision }) => revision.value);
    const planningPriors = input.entries
      // An episode is an auditable Run record, not a reusable experience.
      // Only a multi-episode procedure may influence a future Planner.
      .filter(({ item, revision }) => item.kind === "experience" && revision.experienceMaturity === "procedure")
      // Legacy procedure revisions created before the structured classicPath
      // contract are retained for audit but cannot influence a new Planner.
      .filter(({ revision }) => {
        const pattern = recordValueAt(revision.value, "settlementPattern");
        // Conflicted revisions stay available for audit, but cannot influence
        // a new Planner until a later revision resolves the conflict.
        return Array.isArray(pattern?.classicPath)
          && (!Array.isArray(pattern?.conflicts) || pattern.conflicts.length === 0);
      })
      .map(({ revision }) => {
        const pattern = recordValueAt(revision.value, "settlementPattern");
        const keySteps = Array.isArray(pattern?.classicPath)
          ? pattern.classicPath.filter(isRecord).slice(0, 24)
          : Array.isArray(pattern?.keySteps) ? pattern.keySteps.filter(isRecord).slice(0, 24) : [];
        const toolUsage = Array.isArray(pattern?.toolUsage) ? pattern.toolUsage.filter(isRecord).slice(0, 24) : [];
        const evidenceExpectations = [...new Set(keySteps.flatMap((step) => [
          ...stringArrayAt(step, "requiredEvidenceKinds"),
          ...stringArrayAt(step, "producedEvidenceKinds"),
        ]))].slice(0, 24);
        const reusableKnowledge = Array.isArray(pattern?.reusableKnowledge)
          ? pattern.reusableKnowledge.filter(isRecord).map((item) => stringAt(item, "rule")).filter((item): item is string => item !== undefined).slice(0, 16)
          : [];
        const failureWarnings = Array.isArray(pattern?.failureLessons)
          ? pattern.failureLessons.filter(isRecord).map((item) => stringAt(item, "lesson")).filter((item): item is string => item !== undefined).slice(0, 12)
          : [];
        const cautions = Array.isArray(pattern?.cautions)
          ? pattern.cautions.filter((item): item is string => typeof item === "string").slice(0, 16)
          : [];
        const classicPathText = keySteps.map((step) => stringAt(step, "objective")).filter((item): item is string => item !== undefined);
        const toolText = toolUsage.map((tool) => stringAt(tool, "toolName")).filter((item): item is string => item !== undefined);
        const skillSuggestions = [...new Set(keySteps.flatMap((step) => stringArrayAt(step, "skillIds")))].slice(0, 24);
        const capabilitySuggestions = [...new Set(keySteps.flatMap((step) => stringArrayAt(step, "capabilityIds")))].slice(0, 24);
        return {
          schema: "agentloop.planningPrior/v1" as const,
          id: `prior_${revision.id}`,
          source: "experience_procedure" as const,
          applicability: revision.applicability.conditions.join(", "),
          strategy: [
            classicPathText.length === 0 ? undefined : `经典路径：${classicPathText.join(" → ")}`,
            toolText.length === 0 ? undefined : `工具建议：${toolText.join("、")}`,
            reusableKnowledge.length === 0 ? undefined : `可复用规则：${reusableKnowledge.join("；")}`,
          ].filter((item): item is string => item !== undefined).join("\n"),
          suggestedSteps: keySteps,
          classicPath: keySteps,
          toolUsage,
          skillSuggestions,
          capabilitySuggestions,
          evidenceExpectations,
          cautions,
          warnings: [...revision.applicability.exclusions, ...cautions, ...failureWarnings].slice(0, 16),
          confidence: revision.confidence,
          sourceRefs: [revision.id],
        };
      });
    projection = { ...base, target: "planner", relevantFacts: facts, preferenceConstraints, planningPriors, id: "" };
  } else {
    projection = {
      ...base,
      target: input.target,
      augmentations: input.entries.map(({ item, revision }) => ({ id: revision.id, contentMarkdown: revision.contentMarkdown, reason: `${item.kind}:${item.subtype}` })),
      id: "",
    };
  }
  const contentHash = hash(projection);
  return { ...projection, id: `memproj_${contentHash.slice(0, 24)}`, contentHash } as MemoryProjection;
}

function stringValue(revisions: readonly MemoryRevision[], key: string): string | undefined {
  for (const revision of revisions) {
    const value = revision.value[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordValueAt(value: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value[key]) ? value[key] : undefined;
}

function stringAt(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] as string : undefined;
}

function stringArrayAt(value: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  return Array.isArray(value[key]) ? value[key].filter((item): item is string => typeof item === "string") : [];
}

function recordValue(revisions: readonly MemoryRevision[], key: string): Readonly<Record<string, unknown>> | undefined {
  for (const revision of revisions) {
    const value = revision.value[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>;
  }
  return undefined;
}
