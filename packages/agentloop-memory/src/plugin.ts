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

// Compatibility intake for direct, non-conversational callers. Conversational
// turns use the resolver's complete candidate list, including an explicit [].
function legacyCandidate(input: Parameters<NonNullable<MemoryPluginOptions["resolveExplicitCandidate"]>>[0]): MemoryCandidate | undefined {
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

  // Keep explicit profile facts reliable even when the resolver model omits a
  // proposal. This is a narrow, schema-owned extraction rather than a generic
  // inference: the user must explicitly state that the address is their email.
  const email = input.userText.match(/(?:记住|保存|存下|我的)我的?邮箱(?:是|为|：|:)?\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/iu)?.[1]?.trim();
  if (email !== undefined) {
    return {
      schema: "agentloop.userMemoryCandidate/v1",
      id: input.candidateId,
      tenantId: input.scope.tenantId,
      ownerUserId: input.scope.ownerUserId,
      proposedKind: "fact",
      proposedSubtype: "contact.email",
      proposedCanonicalKey: "contact.email",
      proposedValue: { email },
      proposedContentMarkdown: "用户提供了联系邮箱。",
      persistenceIntent: "explicit",
      authority: "explicit_user",
      sensitivity: "private",
      activation: { mode: "always" },
      applicationTargets: ["response", "human_loop"],
      sourceRefs: [{ type: "user_message", runId: input.scope.runId, messageId: input.messageId }],
      confidence: 1,
      reason: "explicit_user_fact",
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
  if ((intent.kind !== "preference" && intent.kind !== "fact") || intent.subtype !== intent.canonicalKey) return undefined;
  // Keys organize revisions, not the set of concepts the user may remember.
  // Validate syntax, size and evidence instead of enumerating preference types.
  if (intent.canonicalKey.length > 120 || !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u.test(intent.canonicalKey)) return undefined;
  if (!boundedMemoryValue(intent.value)) return undefined;
  if (intent.sourceQuote !== undefined && (intent.sourceQuote.trim().length === 0 || intent.sourceQuote.length > 1_000 || !input.userText.includes(intent.sourceQuote))) return undefined;
  // Facts retain their existing privacy/schema contract; the open-ended
  // contract in this change belongs to explicit preferences.
  if (intent.kind === "fact" && (intent.canonicalKey !== "contact.email"
    || typeof intent.value.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(intent.value.email.trim()))) return undefined;
  const proposedValue = intent.value;
  return {
    schema: "agentloop.userMemoryCandidate/v1",
    id: `${input.candidateId}_${hash({ key: intent.canonicalKey, value: proposedValue }).slice(0, 12)}`,
    tenantId: input.scope.tenantId,
    ownerUserId: input.scope.ownerUserId,
    proposedKind: intent.kind,
    proposedSubtype: intent.subtype,
    proposedCanonicalKey: intent.canonicalKey,
    proposedValue,
    proposedContentMarkdown: intent.contentMarkdown
      ?? (intent.kind === "fact" && intent.canonicalKey === "contact.email" ? "用户提供了联系邮箱。" : "用户明确指定了交互偏好。"),
    persistenceIntent: intent.persistenceIntent,
    authority: intent.persistenceIntent === "inferred" ? "inferred" : "explicit_user",
    sensitivity: intent.sensitivity,
    ...(intent.kind === "preference" ? { proposedPreferenceEffect: "default" as const } : {}),
    activation: { mode: "always" },
    applicationTargets: intent.applicationTargets,
    sourceRefs: [{ type: "user_message", runId: input.scope.runId, messageId: input.messageId,
      ...(intent.sourceQuote === undefined ? {} : { quotedText: intent.sourceQuote }) }],
    confidence: intent.confidence,
    reason: "structured_user_memory_intent",
    decision: "pending",
  };
}

/** Bounded JSON values are the shape contract, independent of user semantics. */
function boundedMemoryValue(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value) || Object.keys(value).length === 0) return false;
  let nodes = 0;
  const valid = (item: unknown, depth: number): boolean => {
    if (++nodes > 128 || depth > 4) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "string") return item.length <= 1_000;
    if (typeof item === "number") return Number.isFinite(item);
    if (Array.isArray(item)) return item.length <= 24 && item.every((entry) => valid(entry, depth + 1));
    if (!isRecord(item)) return false;
    const entries = Object.entries(item);
    return entries.length <= 24 && entries.every(([key, entry]) =>
      key.length > 0 && key.length <= 80 && !["__proto__", "constructor", "prototype"].includes(key) && valid(entry, depth + 1));
  };
  return valid(value, 0) && JSON.stringify(value).length <= 2_000;
}

export function createMemoryPlugin(options: MemoryPluginOptions): AgentLoopMemoryPlugin & { readonly store: MemoryStore } {
  const store = options.store;
  const now = options.now ?? (() => Date.now());
  const projectionTtlMs = options.projectionTtlMs ?? 5 * 60_000;

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
      if (bounded.length === 0) return undefined;
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
      const candidateInput = {
        scope,
        messageId: input.messageId,
        userText: input.userText,
        candidateId: candidateId(scope, input.messageId, input.userText),
        ...(input.memoryIntents === undefined ? {} : { memoryIntents: input.memoryIntents }),
      };
      const candidates = options.resolveExplicitCandidate !== undefined
        ? [options.resolveExplicitCandidate(candidateInput)]
        : input.memoryIntents === undefined
          ? [legacyCandidate(candidateInput)]
          : input.memoryIntents.map((intent) => candidateFromIntent(intent, candidateInput));
      const commits: Awaited<ReturnType<MemoryStore["commit"]>>[] = [];
      const pendingConfirmations: { readonly candidateId: string; readonly prompt: string }[] = [];
      // One message may establish several independent preferences. Apply the
      // policy to every candidate; a rejected or restricted sibling must not
      // erase the accepted candidates or be silently persisted with them.
      for (const candidate of candidates) {
        if (candidate === undefined) continue;
        const decision = evaluateCandidate(candidate);
        if (decision.kind === "reject") continue;
        if (decision.kind === "confirmation_required") {
          pendingConfirmations.push({ candidateId: candidate.id, prompt: "这条信息涉及需要确认的长期记忆，确认后我才会保存。" });
          continue;
        }
        commits.push(await store.commit(scope, { ...candidate, decision: "accepted" }, now()));
      }
      const committed = commits.at(-1);
      if (committed === undefined) return pendingConfirmations[0] === undefined
        ? { kind: "not_applicable" }
        : { kind: "confirmation_required", ...pendingConfirmations[0] };
      return {
        kind: "committed",
        receipt: {
          id: `memreceipt_${hash(commits.map(({ revision }) => revision.id)).slice(0, 24)}`,
          memoryEpoch: committed.memoryEpoch,
          affectedTargets: [...new Set(commits.flatMap(({ revision }) => revision.applicationTargets))],
          committedCount: commits.length,
        },
        ...(pendingConfirmations.length === 0 ? {} : { pendingConfirmations }),
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
    // Values are projected too. Counting only a generic content label could
    // admit many large preference values under a deceptively small budget.
    const estimate = Math.max(1, Math.ceil((entry.revision.contentMarkdown.length + JSON.stringify(entry.revision.value).length) / 4));
    if (used + estimate > maxTokens) continue;
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
    preferences: input.entries
      .filter(({ item }) => item.kind === "preference" && item.subtype !== "contact.email")
      .map(({ item, revision }) => ({ memoryRevisionId: revision.id, subtype: item.subtype, value: revision.value, contentMarkdown: revision.contentMarkdown })),
  };
  let projection: any;
  if (input.target === "response" || input.target === "human_loop") {
    const preferenceEntries = input.entries.filter(({ item }) => item.kind === "preference" && item.subtype !== "contact.email");
    const projectedPreferences = base.preferences;
    // Legacy v0.5 stored contact.email as a preference. Treat it as a fact at
    // the projection boundary so existing local databases remain usable while
    // the migration converts the persisted item kind.
    const facts = input.entries
      .filter(({ item }) => item.kind === "fact" || (item.kind === "preference" && item.subtype === "contact.email"))
      .map(({ item, revision }) => ({
        memoryRevisionId: revision.id,
        subtype: item.subtype,
        value: revision.value,
        stale: revision.expiresAt !== undefined && revision.expiresAt <= input.now,
      }));
    const revisionsFor = (subtype: string) => preferenceEntries.filter(({ item }) => item.subtype === subtype).map(({ revision }) => revision);
    const guidance = {
      preferredAddress: stringValue(revisionsFor("interaction.address"), "preferredAddress"),
      language: stringValue(revisionsFor("interaction.language"), "language"),
      tone: recordValue(revisionsFor("interaction.tone"), "tone"),
      verbosity: stringValue(revisionsFor("interaction.verbosity"), "verbosity"),
      formatting: recordValue(revisionsFor("interaction.formatting"), "formatting"),
    };
    const factLines = facts.map((fact) => `已确认事实（${fact.subtype}）：${JSON.stringify(fact.value)}`);
    // Project all accepted preferences, including future concepts and all
    // values inside tone/formatting. The compatibility guidance is not a gate.
    const preferenceLines = projectedPreferences.map((preference) =>
      `已确认偏好：${JSON.stringify({ subtype: preference.subtype, value: preference.value, description: preference.contentMarkdown })}`);
    const promptMarkdown = [
      ...preferenceLines,
      ...factLines,
    ].filter((value): value is string => value !== undefined).join("\n");
    projection = { ...base, target: input.target, guidance, preferences: projectedPreferences, facts, promptMarkdown, id: "" };
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
      augmentations: input.entries.map(({ item, revision }) => ({
        id: revision.id,
        contentMarkdown: item.kind === "preference" ? `${revision.contentMarkdown}\n${JSON.stringify(revision.value)}` : revision.contentMarkdown,
        reason: `${item.kind}:${item.subtype}`,
      })),
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
