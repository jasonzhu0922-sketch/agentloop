import { readRunEvents } from "../storage/run-event-store.ts";
import { ascending, runtimePersistence, type RuntimePersistence, type RuntimePersistenceInput } from "../storage/runtime-records.ts";
import { parseRuntimeResult, parseRuntimeResultBinding, parseRuntimeResultJson, parseRuntimeResultRef, type RuntimeResultRecord } from "./runtime-result.ts";
import type { RuntimeDeliveryReceipt } from "./contracts.ts";

interface ActionResultRow {
  readonly id: string;
  readonly metadata_json: string;
}

interface StepResultRow {
  readonly step_id: string;
  readonly evidence_json: string | null;
}

interface BoundStepResultRow extends StepResultRow {
  readonly plan_id: string;
  readonly run_id: string;
}

/**
 * Reads Runtime-owned results from their canonical producer records.
 *
 * Tool results live on the closed Runtime Action that committed them. A failed
 * operation is an observation, never an accepted Step or a successful effect;
 * Step results live on the completed Plan step that published them. This keeps
 * one result protocol without creating a second result database beside the
 * existing Action/Plan authorities.
 */
export class RuntimeResultRepository {
  private readonly database: RuntimePersistence;

  constructor(database: RuntimePersistenceInput) {
    this.database = runtimePersistence(database);
  }

  /** Enumerate canonical producer records, without granting any leaf a read. */
  async listPlanResults(input: { runId: string; planId: string; actorUserId?: string; resultId?: string }): Promise<readonly RuntimeResultRecord[]> {
    const plan = (await this.database.records.find("plans", { id: input.planId, run_id: input.runId }))[0];
    const run = (await this.database.records.find("runs", { id: input.runId }))[0];
    if (!plan || !run || (input.actorUserId !== undefined && run.owner_user_id !== input.actorUserId)) return [];
    const actions = (await this.database.records.find("runtime_actions", { run_id: input.runId, plan_id: input.planId }))
      .filter(row => (row.state === "succeeded" || row.state === "failed") && row.result_ref !== null && (input.resultId === undefined || row.result_ref === input.resultId))
      .sort(ascending("created_at", "id"));
    const results: RuntimeResultRecord[] = [];
    for (const action of actions) {
      const result = resultFromMetadata(action.metadata_json);
      if (result?.kind === "tool" && result.ref.resultId === action.result_ref && result.producer.actionId === action.id
        && result.producer.runId === input.runId && result.producer.planId === input.planId && result.producer.stepId === action.step_id) results.push(result);
    }
    if (input.resultId !== undefined && results.length > 0) return results;
    const steps = (await this.database.records.find("plan_steps", { plan_id: input.planId, status: "completed" })).sort(ascending("position"));
    for (const step of steps) {
      const result = resultFromEvidence(step.evidence_json);
      if (result?.kind === "step" && (input.resultId === undefined || result.ref.resultId === input.resultId)
        && result.producer.runId === input.runId && result.producer.planId === input.planId
        && result.producer.stepId === step.step_id) results.push(result);
    }
    return results;
  }

  /** Read a completed Run's delivery receipt through its canonical Result refs. */
  async readDeliveryReceiptForRun(runId: string): Promise<RuntimeDeliveryReceipt | undefined> {
    const outcome = (await this.database.records.find("run_outcomes", { run_id: runId, status: "completed" }))[0];
    const runResult = outcome?.result_json === null || outcome?.result_json === undefined
      ? undefined
      : parseRuntimeResultJson(outcome.result_json);
    if (
      runResult?.kind !== "run"
      || runResult.publication.status !== "published"
      || runResult.producer.runId !== runId
    ) return undefined;

    const inputResultIds = new Set(runResult.inputs.map((input) => input.resultId));
    const plans = await this.database.records.find("plans", { run_id: runId });
    const steps = (await Promise.all(plans.map(plan => this.database.records.find("plan_steps", { plan_id: plan.id, status: "completed" })))).flat().sort(ascending("position"));
    let receipt: RuntimeDeliveryReceipt | undefined;
    for (const step of steps) {
      const evidence = parseRecord(step.evidence_json);
      const publishedResult = parseRuntimeResult(evidence?.publishedResult);
      if (
        publishedResult?.kind !== "step"
        || !inputResultIds.has(publishedResult.ref.resultId)
        || publishedResult.producer.runId !== runId
      ) continue;
      const candidate = parseRecord(evidence?.deliveryCandidate);
      const parsedReceipt = parseDeliveryReceipt(candidate?.deliveryReceipt);
      if (parsedReceipt !== undefined) receipt = parsedReceipt;
    }
    return receipt;
  }

  /** On-demand view of the existing ledger. An anchor never broadens Step/Run access. */
  async readHistoryAuthorized(input: {
    readonly resultId: string; readonly runId: string; readonly planId: string; readonly stepId: string;
    readonly actorUserId?: string; readonly conversationId?: string; readonly toolCallId?: string; readonly assistantEventSeq?: number;
  }): Promise<Readonly<Record<string, unknown>> | undefined> {
    const anchor = await this.readAuthorized(input);
    if (anchor?.kind !== "tool" || anchor.producer.runId !== input.runId
      || anchor.producer.planId !== input.planId || anchor.producer.stepId !== input.stepId) return undefined;
    const events = await readRunEvents(this.database, input.runId);
    const entries: Record<string, unknown>[] = [];
    const exchanges: { id: string; seq: number; value: Record<string, unknown>; effect: unknown; modelStep: unknown }[] = [];
    const pending = new Map<string, (typeof exchanges)[number]>();
    let activePlan: unknown;
    let activeStep: unknown;
    // Streaming dispatch can commit a receipt before the final assistant
    // checkpoint. Only buffer it behind the earlier durable call checkpoint;
    // an unmatched receipt must never attach to a later reused call ID.
    const early = new Map<string, { step: unknown; name: unknown; arguments: unknown; argumentsRef: unknown; outcome?: Record<string, unknown> }>();
    const scope = () => activePlan === input.planId && activeStep === input.stepId;
    const applyOutcome = (entry: (typeof exchanges)[number], outcome: Record<string, unknown>) => {
      entry.value.outcome = outcome;
      const known = outcome.invocationStatus === "completed" && (outcome.operationStatus === "succeeded"
        || entry.effect === "read" && outcome.operationStatus === "failed");
      entry.value.gaps = known ? [] : ["A receipt exists but does not establish completed known effects. Consult the Action ledger before retrying."];
    };
    for (const event of events) {
      const data = parseRecord(event.payload_json);
      if (!data) continue;
      if (event.type === "plan.step.started") {
        activePlan = data.planId; activeStep = data.stepId;
        pending.clear(); early.clear();
      }
      if (event.type === "assistant.tool_call.committed" && typeof data.toolCallId === "string") {
        pending.delete(data.toolCallId); early.delete(data.toolCallId);
        if (scope() && typeof data.step === "number") early.set(data.toolCallId, { step: data.step, name: data.name, arguments: data.arguments, argumentsRef: data.argumentsRef });
      }
      if (["tool.completed", "tool.failed", "tool.rejected"].includes(event.type)
        && activePlan === input.planId && activeStep === input.stepId && typeof data.toolCallId === "string") {
        const outcome = { eventSeq: event.seq, type: event.type, toolCallId: data.toolCallId,
          toolName: data.toolName, result: data.result, resultRef: data.resultRef, error: data.error, reason: data.reason,
          isError: data.isError, invocationStatus: data.invocationStatus, operationStatus: data.operationStatus, exitCode: data.exitCode };
        const entry = pending.get(data.toolCallId);
        if (entry && entry.value.outcome === undefined
          && (entry.modelStep === undefined || data.step === undefined || entry.modelStep === data.step)
          && (entry.value.assistant as { toolCall: { name: string } }).toolCall.name === data.toolName) applyOutcome(entry, outcome);
        const staged = early.get(data.toolCallId);
        if (staged && staged.outcome === undefined && staged.step === data.step && staged.name === data.toolName) staged.outcome = outcome;
      }
      if (event.type !== "assistant.committed" || !Array.isArray(data.toolCalls)) continue;
      const identity = parseRecord(parseRecord(data.executionHistoryBasis)?.identity);
      activePlan = identity?.planId ?? activePlan;
      activeStep = identity?.stepId ?? activeStep;
      if ((identity?.planId ?? activePlan) !== input.planId || (identity?.stepId ?? activeStep) !== input.stepId) {
        pending.clear(); early.clear(); continue;
      }
      if (identity?.runId !== undefined && identity.runId !== input.runId) { pending.clear(); early.clear(); continue; }
      for (const raw of data.toolCalls) {
        const call = parseRecord(raw);
        if (typeof call?.id !== "string" || typeof call.name !== "string") continue;
        entries.push({ toolCallId: call.id, toolName: call.name, assistantEventSeq: event.seq });
        const entry = { id: call.id, seq: event.seq, modelStep: data.step, effect: parseRecord(parseRecord(data.executionHistoryBasis)?.toolEffects)?.[call.name],
          value: { source: { runId: input.runId, planId: input.planId, stepId: input.stepId, assistantEventSeq: event.seq },
          // Deliberately select public statement + call; never expose reasoning or unrelated fields.
          assistant: { content: typeof data.content === "string" ? data.content : "", toolCall: call },
          gaps: ["No committed outcome located; effects may be unknown. Do not replay on this basis."] } as Record<string, unknown> };
        const staged = early.get(call.id);
        if (staged && staged.step === data.step && staged.name === call.name
          && JSON.stringify(staged.arguments) === JSON.stringify(call.arguments)
          && JSON.stringify(staged.argumentsRef) === JSON.stringify(call.argumentsRef) && staged.outcome) applyOutcome(entry, staged.outcome);
        early.delete(call.id);
        exchanges.push(entry);
        pending.set(call.id, entry);
      }
    }
    if (input.toolCallId === undefined) return { schema: "agentloop.stepHistory/v1", entries };
    const candidates = exchanges.filter(entry => entry.id === input.toolCallId && (input.assistantEventSeq === undefined || entry.seq === input.assistantEventSeq));
    if (!candidates.length) return undefined;
    if (candidates.length > 1) return { schema: "agentloop.producerExchange/v1", gaps: ["Ambiguous ToolCall id; use assistantEventSeq from the history index."],
      candidates: candidates.map(entry => ({ toolCallId: entry.id, assistantEventSeq: entry.seq })) };
    return { schema: "agentloop.producerExchange/v1", ...candidates[0].value };
  }

  async readAuthorized(input: {
    readonly resultId: string;
    readonly runId: string;
    readonly planId: string;
    readonly stepId: string;
    readonly actorUserId?: string;
    readonly conversationId?: string;
  }): Promise<RuntimeResultRecord | undefined> {
    if (input.actorUserId !== undefined) {
      const owner = (await this.database.records.find("runs", { id: input.runId, owner_user_id: input.actorUserId }))[0];
      if (owner === undefined) return undefined;
    }
    const action = (await this.database.records.find("runtime_actions", { result_ref: input.resultId, run_id: input.runId, plan_id: input.planId, step_id: input.stepId }))
      .find(row => row.state === "succeeded" || row.state === "failed");
    const actionResult = resultFromMetadata(action?.metadata_json);
    if (actionResult?.ref.resultId === input.resultId && actionResult.kind === "tool"
      && actionResult.publication.status === "committed" && actionResult.producer.actionId === action?.id
      && actionResult.producer.runId === input.runId && actionResult.producer.planId === input.planId
      && actionResult.producer.stepId === input.stepId) return actionResult;

    const owningPlan = (await this.database.records.find("plans", { id: input.planId, run_id: input.runId }))[0];
    const currentStep = owningPlan ? (await this.database.records.find("plan_steps", { plan_id: input.planId, step_id: input.stepId }))[0] : undefined;
    if (currentStep === undefined) return undefined;
    const binding = parseRecord(currentStep.execution_binding_json);
    if (binding?.schema === "agentloop.stepExecutionBinding/v1" && Array.isArray(binding.inputResultRefs)
      && binding.inputResultRefs.some(ref => parseRuntimeResultRef(ref)?.resultId === input.resultId)) {
      const result = (await this.listPlanResults(input)).find(result => result.ref.resultId === input.resultId);
      if (result !== undefined) return result;
    }
    const dependencies = parseStringArray(currentStep.dependencies_json);
    if (dependencies.length > 0) {
      const candidates = await this.database.records.find("plan_steps", { plan_id: input.planId, status: "completed" });
      for (const candidate of candidates) {
        if (!dependencies.includes(candidate.step_id)) continue;
        const result = resultFromEvidence(candidate.evidence_json);
        if (
          result?.ref.resultId === input.resultId
          && result.kind === "step"
          && result.producer.runId === input.runId
          && result.producer.planId === input.planId
          && result.producer.stepId === candidate.step_id
        ) return result;
      }
    }
    const plan = owningPlan;
    if (!hasBoundResult(plan?.input_bindings_json, input.resultId)) return undefined;
    const retired = await this.database.records.find("plan_step_retirements", { plan_id: input.planId });
    const archived: StepResultRow[] = [];
    for (const retirement of retired) {
      if (!retirement.action_id || !(await this.database.records.find("runtime_actions", { id: retirement.action_id, run_id: input.runId })).length) continue;
      archived.push(...await this.database.records.find("plan_steps", { plan_id: input.planId, step_id: retirement.step_id, status: "completed" }));
    }
    for (const step of archived) {
      const result = resultFromEvidence(step.evidence_json);
      if (result?.kind === "step" && result.publication.status === "published" && result.publication.assessmentRef !== undefined
        && result.ref.resultId === input.resultId && result.producer.runId === input.runId
        && result.producer.planId === input.planId && result.producer.stepId === step.step_id) return result;
    }
    // A Round can consume an explicitly bound, assessed result from an earlier
    // Round of this very Run, even when the Run is not attached to a conversation.
    // The Round Result is the durable publication boundary, not merely the
    // presence of a completed step in an unrelated or unfinished Plan.
    const rounds = await this.database.records.find("run_rounds", { run_id: input.runId });
    const currentRound = rounds.find(row => row.plan_id === input.planId);
    const previousRounds: Array<{ plan_id: string; result_json: string; step_id: string; evidence_json: string | null }> = [];
    for (const round of rounds) {
      if (!currentRound || round.round_number >= currentRound.round_number || round.status !== "completed" || round.plan_id === null) continue;
      const result = (await this.database.records.find("run_round_results", { run_id: input.runId, round_number: round.round_number, plan_id: round.plan_id }))[0];
      if (!result) continue;
      for (const step of await this.database.records.find("plan_steps", { plan_id: round.plan_id, status: "completed" })) {
        previousRounds.push({ plan_id: round.plan_id, result_json: result.result_json, step_id: step.step_id, evidence_json: step.evidence_json });
      }
    }
    for (const candidate of previousRounds) {
      const round = parseRecord(candidate.result_json);
      const result = resultFromEvidence(candidate.evidence_json);
      if (
        round?.schema !== "agentloop.roundResult/v1" || round.runId !== input.runId || round.planId !== candidate.plan_id
        || !Array.isArray(round.steps)
        || !round.steps.some((entry: unknown) => {
          const item = parseRecord(entry);
          const ref = parseRecord(item?.result);
          return item?.stepId === candidate.step_id && ref?.resultId === input.resultId
            && typeof item.assessmentId === "string" && item.assessmentId === result?.publication.assessmentRef;
        })
        || result?.ref.resultId !== input.resultId || result.kind !== "step"
        || result.publication.status !== "published"
        || result.producer.runId !== input.runId || result.producer.planId !== candidate.plan_id
        || result.producer.stepId !== candidate.step_id
      ) continue;
      return result;
    }
    if (input.actorUserId === undefined || input.conversationId === undefined) return undefined;
    const conversationRuns = await this.database.records.find("runs", { owner_user_id: input.actorUserId, conversation_id: input.conversationId });
    const outcomes = await this.database.records.find("run_outcomes", { result_ref: input.resultId, status: "completed" });
    const outcome = outcomes.find(row => conversationRuns.some(run => run.id === row.run_id));
    const result = outcome?.result_json === null || outcome?.result_json === undefined
      ? undefined
      : parseRuntimeResultJson(outcome.result_json);
    if (result?.kind === "run") return result;

    const stepCandidates: BoundStepResultRow[] = [];
    for (const run of conversationRuns) {
      if (run.id === input.runId) continue;
      for (const plan of await this.database.records.find("plans", { run_id: run.id })) {
        for (const step of await this.database.records.find("plan_steps", { plan_id: plan.id, status: "completed" })) {
          stepCandidates.push({ ...step, run_id: run.id });
        }
      }
    }
    for (const candidate of stepCandidates) {
      const stepResult = resultFromEvidence(candidate.evidence_json);
      if (
        stepResult?.kind === "step"
        && stepResult.ref.resultId === input.resultId
        && stepResult.producer.runId === candidate.run_id
        && stepResult.producer.planId === candidate.plan_id
        && stepResult.producer.stepId === candidate.step_id
      ) return stepResult;
    }
    return undefined;
  }
}

function resultFromMetadata(value: string | undefined): RuntimeResultRecord | undefined {
  if (value === undefined) return undefined;
  const metadata = parseRecord(value);
  return parseRuntimeResult(metadata?.runtimeResult);
}

function resultFromEvidence(value: string | null): RuntimeResultRecord | undefined {
  if (value === null) return undefined;
  const evidence = parseRecord(value);
  return parseRuntimeResult(evidence?.publishedResult);
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function parseDeliveryReceipt(value: unknown): RuntimeDeliveryReceipt | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const artifact = record.artifact;
  if (
    record.schema !== "agentloop.runtimeDeliveryReceipt/v1"
    || (record.verdict !== "accepted" && record.verdict !== "caveated")
    || !Array.isArray(record.caveats)
    || !record.caveats.every((item) => typeof item === "string")
    || typeof record.sourceToolCallId !== "string"
    || artifact === null
    || typeof artifact !== "object"
    || Array.isArray(artifact)
  ) return undefined;
  const artifactRecord = artifact as Record<string, unknown>;
  if (
    typeof artifactRecord.path !== "string"
    || artifactRecord.path.trim().length === 0
    || (artifactRecord.bytes !== undefined && !(typeof artifactRecord.bytes === "number" && Number.isFinite(artifactRecord.bytes)))
    || (artifactRecord.sha256 !== undefined && typeof artifactRecord.sha256 !== "string")
    || (artifactRecord.kind !== undefined && typeof artifactRecord.kind !== "string")
  ) return undefined;
  return record as unknown as RuntimeDeliveryReceipt;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function hasBoundResult(value: string | undefined, resultId: string): boolean {
  if (value === undefined) return false;
  const parsed = parseJson(value);
  return Array.isArray(parsed) && parsed.some((binding) => {
    const parsedBinding = parseRuntimeResultBinding(binding);
    return parsedBinding !== undefined
      && parsedBinding.relation !== "dependency"
      && parsedBinding.result.resultId === resultId;
  });
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
