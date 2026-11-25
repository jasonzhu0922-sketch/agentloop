import { RuntimeResultRepository, runtimePersistence, ascending, type RuntimePersistence, type RuntimePersistenceInput } from "@zhujun/agentloop";
import { memoryFeedbackEffect } from "./local-memory-feedback-semantics.ts";
import { createHash } from "node:crypto";
import { memorySafeText, memoryEntities, type MemorySettlementEvidence, type MemorySettlementReader, type MemoryRunScope, type MemorySourceRef } from "@zhujun/agentloop-memory";

interface OutcomeRow {
  readonly owner_user_id: string;
  readonly conversation_id: string | null;
  readonly status: "completed" | "failed" | "cancelled";
  readonly reason_code: string;
  readonly plan_id: string | null;
  readonly result_ref: string | null;
  readonly committed_at: number;
  readonly plan_goal: string | null;
  readonly selected_skill_ids_json: string | null;
  readonly state_json: string | null;
  readonly delivery_receipt_json: string | null;
  readonly result_json: string | null;
  readonly user_input: string;
}
interface AssessmentRow {
  readonly count: number;
  readonly approved: number;
}

interface PlanStepRow {
  readonly step_id: string;
  readonly position: number;
  readonly objective: string;
  readonly role: string | null;
  readonly dependencies_json: string | null;
  readonly required_facts_json: string | null;
  readonly skill_ids_json: string | null;
  readonly required_capabilities_json: string | null;
  readonly recommended_tool_names_json: string | null;
  readonly execution_binding_json: string | null;
  readonly evidence_contract_json: string | null;
  readonly success_criteria_json: string | null;
}

interface RuntimeActionRow {
  readonly id: string;
  readonly step_id: string | null;
  readonly metadata_json: string;
  readonly state: string;
  readonly error_code: string | null;
  readonly kind: string;
  readonly created_at: number;
}

/** Reads only canonical local Run/Outcome/Assessment rows for settlement. */
export class LocalMemorySettlementReader implements MemorySettlementReader {
  private readonly databases: () => readonly RuntimePersistenceInput[];
  private readonly tenantId: string;

  constructor(database: RuntimePersistenceInput | (() => readonly RuntimePersistenceInput[]), tenantId: string) {
    this.databases = typeof database === "function" ? database : () => [database];
    this.tenantId = tenantId;
  }

  async isDeleted(input: { tenantId: string; ownerUserId: string; runId: string }): Promise<boolean> {
    if (input.tenantId !== this.tenantId) throw new Error("settlement_tenant_mismatch");
    for (const database of this.databases()) {
      const state = runtimePersistence(database);
      const admission = (await state.records.find("local_run_admissions", { owner_user_id: input.ownerUserId, run_id: input.runId }))[0];
      if (admission?.run_deleted === 1 || admission && (await state.records.find("runtime_deletions", { run_id: input.runId })).length) return true;
    }
    return false;
  }

  async read(input: { tenantId: string; ownerUserId: string; runId: string; terminalCommitRef: string }): Promise<MemorySettlementEvidence | undefined> {
    if (input.tenantId !== this.tenantId) throw new Error("settlement_tenant_mismatch");
    let row: OutcomeRow | undefined;
    let database: RuntimePersistence | undefined;
    for (const candidate of this.databases()) {
      const state = runtimePersistence(candidate);
      const found = await state.transaction(async (): Promise<OutcomeRow | undefined> => {
        const run = (await state.records.find("runs", { id: input.runId, owner_user_id: input.ownerUserId }))[0];
        const outcome = (await state.records.find("run_outcomes", { run_id: input.runId }))[0];
        if (!run || !outcome) return undefined;
        const plan = outcome.plan_id ? (await state.records.find("plans", { id: outcome.plan_id }))[0] : undefined;
        const canonical = (await state.records.find("canonical_run_states", { run_id: input.runId }))[0];
        return { ...outcome, owner_user_id: run.owner_user_id, conversation_id: run.conversation_id, user_input: run.input,
          plan_goal: plan?.goal ?? null, selected_skill_ids_json: plan?.selected_skill_ids_json ?? null, state_json: canonical?.state_json ?? null };
      });
      if (found !== undefined) { row = found; database = state; break; }
    }
    if (row === undefined) return undefined;
    const actualCommitRef = row.result_ref ?? `${input.runId}:${row.committed_at}`;
    if (actualCommitRef !== input.terminalCommitRef) throw new Error("settlement_terminal_commit_mismatch");
    const assessments = row.plan_id === null ? [] : await database!.records.find("skill_compliance_assessments", { plan_id: row.plan_id });
    const assessment = { count: assessments.length, approved: assessments.filter(item => item.approved === 1).length };
    const state = parseJsonRecord(row.state_json);
    const understanding = recordAt(state, ["intent", "understanding"]);
    const deliverable = recordAt(understanding, ["deliverable"]);
    const evidence = recordAt(understanding, ["evidence"]);
    const operationProfiles = arrayAt(understanding, ["operationProfiles"]);
    const terminalStatus = row.status;
    const assessmentApproved = terminalStatus === "completed"
      && row.reason_code === "plan_assessed_and_completed"
      && Number(assessment.count) > 0
      && Number(assessment.count) === Number(assessment.approved);
    const feedback: { run_id: string; seq: number; type: string; payload_json: string; created_at: number }[] = [];
    if (row.conversation_id !== null) for (const feedbackDatabase of this.databases()) {
      const source = runtimePersistence(feedbackDatabase);
      for (const run of await source.records.find("runs", { owner_user_id: input.ownerUserId, conversation_id: row.conversation_id }))
        feedback.push(...(await source.records.find("run_events", { run_id: run.id })).filter(event => ["conversation.outcome.disputed", "conversation.outcome.superseded"].includes(event.type)));
    }
    feedback.sort(ascending("created_at"));
    const targetedFeedback = feedback.filter(event => parseJsonRecord(event.payload_json).targetRunId === input.runId);
    const laterDisputed = targetedFeedback.some(event => event.type === 'conversation.outcome.disputed');
    const laterCorrected = targetedFeedback.some(event => memoryFeedbackEffect(event.type, parseJsonRecord(event.payload_json)) === 'corrected');
    const scope: MemoryRunScope = {
      tenantId: this.tenantId,
      ownerUserId: input.ownerUserId,
      runId: input.runId,
    };
    const outcomeRef = row.result_ref ?? `${input.runId}:${row.committed_at}`;
    const selectedSkills = parseStringArray(row.selected_skill_ids_json);
    const planSkeleton: PlanStepRow[] = row.plan_id === null ? [] : (await database!.records.find("plan_steps", { plan_id: row.plan_id })).sort(ascending("position"));
    const observedActions: RuntimeActionRow[] = (await database!.records.find("runtime_actions", { run_id: input.runId }))
      .filter(action => ["tool_call", "recovery_review"].includes(action.kind)).sort(ascending("created_at"));
    const events = (await database!.records.find("run_events", { run_id: input.runId })).sort(ascending("seq"));
    const entities = memoryEntities([row.plan_goal ?? "", ...planSkeleton.map((step) => step.objective)]);
    const safe = (value: string, max = 500) => memorySafeText(value, entities, max);
    const actionArguments = events.filter(event => event.type === "tool.planned");
    const actionSequences = new Map(actionArguments.map(({ seq, payload_json }) => [recordString(parseJsonRecord(payload_json), "toolCallId"), seq]));
    const argumentsByCall = new Map(actionArguments.map(({ payload_json }) => {
      const payload = parseJsonRecord(payload_json);
      return [recordString(payload, "toolCallId"), parseJsonRecord(JSON.stringify(payload.arguments ?? {}))] as const;
    }));
    const activations = events.filter(event => event.type === "prompt_augmentation.activated");
    const methodHandoffs = activations.flatMap(({ seq, payload_json }) => {
      const data = parseJsonRecord(payload_json), stepId = recordString(data, "stepId");
      if (!stepId || !planSkeleton.some(step => step.step_id === stepId)) return [];
      const activeIds = parseStringArrayValue(data.augmentationIds);
      return parseJsonArray(JSON.stringify(data.augmentations ?? [])).flatMap(item => {
        const augmentation = parseJsonRecord(JSON.stringify(item));
        if (augmentation.source !== "local_memory" || !activeIds.includes(String(augmentation.id))) return [];
        const provenance = recordAt(augmentation, ["provenance"]), projectionId = recordString(provenance, "projectionId");
        if (provenance.schema !== "agentloop.memoryMethodHandoff/v1" || !projectionId) return [];
        return parseJsonArray(JSON.stringify(provenance.bindings ?? [])).flatMap(binding => {
          const row = parseJsonRecord(JSON.stringify(binding));
          const memoryRevisionId = recordString(row, "memoryRevisionId"), knowledgeId = recordString(row, "knowledgeId");
          return memoryRevisionId && knowledgeId ? [{ seq, stepId, projectionId, memoryRevisionId, knowledgeId,
            sourceRef: { type: "event" as const, runId: input.runId, sourceId: `${input.runId}:${seq}` } }] : [];
        });
      });
    });
    const observedToolsByStep = new Map<string, string[]>();
    const committedActions = events.filter(event => event.type === "action.result_committed");
    const committedSequences = new Map(committedActions.map(event => [recordString(parseJsonRecord(event.payload_json), "actionId"), event.seq]));
    const recalledHandoffs: Array<{ seq: number; stepId: string; projectionId: string; memoryRevisionId: string; knowledgeId: string; sourceRef: MemorySourceRef }> = [];
    const observations: NonNullable<MemorySettlementEvidence["observations"]>[number][] = [];
    const positions = new Map<string, { at: number; seq: number }>();
    const dependencies: NonNullable<MemorySettlementEvidence["dependencies"]>[number][] = [];
    const semanticEvents = events.filter(event => ["human_loop.answered", "conversation.turn.resolved", "memory.recalled"].includes(event.type));
    const safeValue = (value: unknown, depth = 0): unknown => {
      if (depth > 4) return "[OMITTED]";
      if (typeof value === "string") return safe(value, 600);
      if (Array.isArray(value)) return value.slice(0, 24).map(item => safeValue(item, depth + 1));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 24).map(([key, item]) => [key, /password|passwd|token|cookie|secret|credential|密码|令牌/iu.test(key) ? "[REDACTED]" : safeValue(item, depth + 1)]));
      return value;
    };
    for (const event of semanticEvents) {
      const payload = parseJsonRecord(event.payload_json);
      const refs: MemorySourceRef[] = [{ type: "event", runId: input.runId, sourceId: `${input.runId}:${event.seq}` }];
      if (event.type === "human_loop.answered") {
        const requestId = recordString(payload, "requestId");
        if (!requestId) continue;
        const request = (await database!.records.find("human_loop_requests", { id: requestId, run_id: input.runId }))[0];
        if (!request) continue;
        const schema = parseJsonRecord(request.response_schema_json);
        const options = Array.isArray(schema.options) ? schema.options : [];
        const selected = Array.isArray(payload.value) ? payload.value : [payload.value];
        const selectedOptions = options.filter(option => selected.includes(recordString(option, "id")));
        observations.push({ id: `decision_${event.seq}`, kind: "decision", status: "user_confirmed", summary: safe(request.title),
          details: { requestId, planId: request.plan_id, stepId: request.step_id, evidenceRefs: safeValue(parseJsonArray(request.evidence_refs_json)), question: safe(request.prompt, 1000), rationale: safe(request.rationale),
            candidates: safeValue(options), selectedOptions: safeValue(selectedOptions), value: safeValue(payload.value),
            candidateCoverage: { total: options.length, retained: Math.min(24, options.length), omitted: Math.max(0, options.length - 24) },
            persistenceIntent: "task_only" }, sourceRefs: refs });
        positions.set(observations.at(-1)!.id, { at: event.created_at, seq: event.seq });
      } else if (event.type === "conversation.turn.resolved") {
        observations.push({ id: `turn_${event.seq}`, kind: "decision", status: "interpreted",
          summary: safe(recordString(payload, "effectiveGoal") ?? "本轮任务意图"),
          details: safeValue({ relation: payload.relation, mode: payload.mode, inputMode: payload.inputMode,
            userConstraints: payload.userConstraints, sourceBinding: payload.sourceBinding, targetRunId: payload.targetRunId,
            targetResult: payload.targetResult, authority: "model_interpretation" }) as Record<string, unknown>, sourceRefs: refs });
        positions.set(observations.at(-1)!.id, { at: event.created_at, seq: event.seq });
        const resultId = recordString(recordAt(payload, ["targetResult"]), "resultId");
        if (payload.inputMode === "prior_result" && resultId) dependencies.push({ kind: "prior_result", id: resultId,
          ...(recordString(payload, "targetRunId") ? { sourceRunId: recordString(payload, "targetRunId") } : {}), sourceRefs: refs });
      } else if (Array.isArray(payload.memoryRevisionIds)) {
        for (const id of payload.memoryRevisionIds) if (typeof id === "string") dependencies.push({ kind: "memory", id, sourceRefs: refs });
      }
    }
    for (const event of targetedFeedback) {
      const payload = parseJsonRecord(event.payload_json), effect = memoryFeedbackEffect(event.type, payload);
      observations.push({ id: `feedback_${event.run_id}_${event.seq}`, kind: "feedback", status: ["disputed", "corrected"].includes(effect) ? "negative" : "context",
        summary: effect === "disputed" ? "用户质疑了该任务的结果" : effect === "corrected" ? "该任务结果已被后续纠正替代" : effect === "refined" ? "后续任务补充或细化了范围，不代表原结果错误" : "后续结果替代了该任务，是否纠错未知",
        details: { feedbackEffect: effect, ...(typeof payload.relation === "string" ? { relation: payload.relation } : {}) },
        sourceRefs: [{ type: "user_feedback", runId: event.run_id, sourceId: `${event.run_id}:${event.seq}` }] });
      positions.set(observations.at(-1)!.id, { at: event.created_at, seq: event.seq });
    }
    let artifactVerified: boolean | undefined;
    const actionObservationsByEvidence = new Map<string, { id: string; stepId: string | null }>();
    const insights: Array<{ id: string; stepId: string | null; sources: string[] }> = [];
    for (const action of observedActions) {
      const metadata = parseJsonRecord(action.metadata_json);
      const toolName = recordString(metadata, "toolName") ?? recordString(metadata, "name");
      const result = recordAt(metadata, ["runtimeResult"]);
      const payload = recordAt(result, ["payload"]);
      const content = parseJsonRecord(typeof payload.content === "string" && payload.content.length < 300_000 ? payload.content : undefined);
      const sourceRefs: MemorySourceRef[] = [{ type: "action", runId: input.runId, sourceId: action.id }];
      const stepOrder = planSkeleton.findIndex((step) => step.step_id === action.step_id) + 1;
      const args = argumentsByCall.get(recordString(metadata, "toolCallId"));
      const plannedSeq = actionSequences.get(recordString(metadata, "toolCallId"));
      const memoryGuidance = methodHandoffs.filter(item => item.stepId === action.step_id && plannedSeq !== undefined && item.seq < plannedSeq)
        .map(({ seq: _seq, stepId: _stepId, ...binding }) => binding);
      const method = args ? proceduralArguments(args) : "";
      const step = planSkeleton.find(step => step.step_id === action.step_id);
      const insight = toolName === "record_execution_insight" && action.state === "succeeded"
        && content.schema === "agentloop.executionInsight/v1" && content.authority === "model_interpretation";
      if (toolName === "recall_task_knowledge" && action.state === "succeeded" && content.schema === "agentloop.taskKnowledgeRecall/v1"
        && content.runId === input.runId && content.planId === row.plan_id && content.stepId === action.step_id
        && typeof content.projectionId === "string" && committedSequences.has(action.id)) {
        for (const item of parseJsonArray(JSON.stringify(content.knowledgeCards ?? []))) {
          const card = recordAt(item, []), memoryRevisionId = recordString(card, "memoryRevisionId"), knowledgeId = recordString(card, "knowledgeId");
          if (memoryRevisionId && knowledgeId && action.step_id) {
            recalledHandoffs.push({ seq: committedSequences.get(action.id)!, stepId: action.step_id, projectionId: content.projectionId,
              memoryRevisionId, knowledgeId, sourceRef: { type: "action", runId: input.runId, sourceId: action.id } });
            dependencies.push({ kind: "memory", id: memoryRevisionId, sourceRefs });
          }
        }
      }
      if (["record_execution_insight", "recall_task_knowledge"].includes(toolName ?? "")) sourceRefs[0] = { ...sourceRefs[0]!, authority: "model_interpretation" };
      const errors = [action.error_code, recordString(content, "errorCode")].filter((value): value is string => !!value);
      const failed = action.state !== "succeeded" || content.isError === true || (typeof content.exitCode === "number" && content.exitCode !== 0)
        || errors.length > 0 || !!recordString(content, "error");
      const checkResults = toolName === "verify_artifact_acceptance" ? parseJsonArray(JSON.stringify(content.checks ?? [])) : [];
      if (toolName === "verify_artifact_acceptance") {
        const passed = new Set(checkResults.filter((check) => check !== null && typeof check === "object" && (check as Record<string, unknown>).status === "passed").map((check) => String((check as Record<string, unknown>).id)));
        artifactVerified = ["artifact_non_empty", "format_matches_request", "artifact_openable"].every((id) => passed.has(id));
      }
      const summary = [
        method, recordString(content, "schema"),
        toolName === "load_skill" ? "加载 Skill 指令（正文不进入记忆证据）" : undefined,
        typeof content.exitCode === "number" ? `exitCode=${content.exitCode}` : undefined,
        ...errors,
        ...checkResults.map((check) => check && typeof check === "object" ? `${String((check as Record<string, unknown>).id)}=${String((check as Record<string, unknown>).status)}` : ""),
      ].filter(Boolean).join("；");
      observations.push({ id: `observation_${observations.length + 1}`, kind: insight ? "decision" : action.kind === "recovery_review" ? "recovery" : "action", ...(stepOrder ? { stepOrder } : {}), ...(toolName ? { toolName } : {}), status: failed ? "failed" : insight ? "interpreted" : "succeeded", summary: safe(insight ? recordString(content, "finding") ?? "执行发现" : summary || `${action.kind}:${action.state}`),
        details: { executionObserved: action.state === "succeeded" || typeof payload.content === "string",
          // Opaque equality is only used locally by compaction. Matching
          // command forms never establish equivalent information acquisition.
          repeatIdentity: createHash("sha256").update(JSON.stringify([args ?? action.id, payload.content ?? action.id])).digest("hex"),
          ...(step ? { purpose: safe(step.objective), purposeAuthority: "plan_step" } : {}),
          resultProfile: neutralResultProfile(content, safe),
          resultDiagnostics: neutralResultDiagnostics(content, safe),
          ...(insight ? { purpose: safe(recordString(content, "purpose") ?? ""), purposeAuthority: "model_interpretation",
            finding: safe(recordString(content, "finding") ?? ""), informationStatus: recordString(content, "informationStatus"),
            nextAction: safe(recordString(content, "nextAction") ?? ""), authority: "model_interpretation" } : {}),
          method: { operation: safe(method || toolName || action.kind),
            argumentFields: Object.keys(args ?? {}).filter(key => !/password|passwd|token|cookie|secret|credential/iu.test(key)).sort(),
            selectors: [args?.pointer, ...parseJsonArray(JSON.stringify(args?.queries ?? [])).map(item => recordAt(item, []).pointer)]
              .filter((value): value is string => typeof value === "string").slice(0, 20).map(value => safe(value)) },
          ...(errors.length ? { errorCodes: errors.map(error => safe(error)) } : {}),
          ...(memoryGuidance.length ? { memoryGuidance } : {}) }, sourceRefs });
      positions.set(observations.at(-1)!.id, { at: action.created_at, seq: plannedSeq ?? Number.MAX_SAFE_INTEGER });
      if (insight) insights.push({ id: observations.at(-1)!.id, stepId: action.step_id, sources: parseStringArrayValue(content.resultIds) });
      if (action.kind === "tool_call") for (const key of [recordString(metadata, "toolCallId"), recordString(recordAt(result, ["ref"]), "resultId")]) {
        if (key) actionObservationsByEvidence.set(key, { id: observations.at(-1)!.id, stepId: action.step_id });
      }
      if (action.step_id === null || toolName === undefined || failed) continue;
      const current = observedToolsByStep.get(action.step_id) ?? [];
      if (!current.includes(toolName)) current.push(toolName);
      observedToolsByStep.set(action.step_id, current);
    }
    for (const observation of observations) {
      if (observation.kind !== "action" || observation.toolName === "recall_task_knowledge") continue;
      const action = observedActions.find(item => item.id === observation.sourceRefs[0]?.sourceId);
      const position = positions.get(observation.id);
      const handoffs = recalledHandoffs.filter(item => item.stepId === action?.step_id && position && item.seq < position.seq)
        .map(({ seq: _seq, stepId: _stepId, ...binding }) => binding);
      if (handoffs.length) (observation as { details: Record<string, unknown> }).details = { ...observation.details,
        memoryGuidance: [...(Array.isArray(observation.details?.memoryGuidance) ? observation.details.memoryGuidance : []), ...handoffs] };
    }
    for (const insight of insights) {
      const observation = observations.find(item => item.id === insight.id)!;
      const linked = insight.sources.map(id => actionObservationsByEvidence.get(id));
      const valid = insight.sources.length > 0 && linked.every(item => item && item.stepId === insight.stepId
        && !["record_execution_insight", "recall_task_knowledge"].includes(observations.find(observation => observation.id === item.id)?.toolName ?? "")
        && positions.get(item.id)!.seq < positions.get(insight.id)!.seq);
      if (valid) {
        (observation as { relatedObservationIds?: readonly string[] }).relatedObservationIds = [...new Set(linked.map(item => item!.id))];
        // Exact selected values come from the Runtime-owned Result, separately
        // from the Agent's interpretation. Never expand a complete tool body.
        const action = observedActions.find(item => item.id === observation.sourceRefs[0]?.sourceId);
        const runtime = recordAt(parseJsonRecord(action?.metadata_json), ["runtimeResult", "payload"]);
        const report = parseJsonRecord(typeof runtime.content === "string" ? runtime.content : undefined);
        for (const [index, selected] of parseJsonArray(JSON.stringify(report.groundedEvidence ?? [])).entries()) {
          const item = recordAt(selected, []), resultId = recordString(item, "resultId"), pointer = recordString(item, "pointer");
          const source = resultId ? actionObservationsByEvidence.get(resultId) : undefined;
          const original = source && observations.find(row => row.id === source.id);
          const serialized = JSON.stringify(item.value);
          if (!source || !original || source.stepId !== insight.stepId || !insight.sources.includes(resultId!) || !pointer || !serialized
            || serialized.length > 600 || safe(serialized, 600) !== serialized
            || original?.sourceRefs[0]?.sourceId !== item.actionId) continue;
          const id = `${insight.id}_grounding_${index + 1}`;
          observations.push({ id, kind: "action", stepOrder: observation.stepOrder, toolName: original.toolName,
            status: "observed", summary: "从已提交结果选择的精确证据片段；含义和适用范围仍须核验",
            details: { executionObserved: true, grounding: "exact_result_selection", pointer, value: item.value },
            sourceRefs: [{ type: "action", runId: input.runId, sourceId: item.actionId as string, resultId, pointer,
              sourceHash: createHash("sha256").update(serialized).digest("hex") }] });
          positions.set(id, positions.get(insight.id)!);
        }
      } else {
        // A malformed/legacy self-report cannot enter the learning view as a
        // grounded finding. Keep an explicit audit gap, never invent a link.
        (observation as { summary: string }).summary = "执行发现缺少可解析的当前步骤回执";
        (observation as { details?: Readonly<Record<string, unknown>> }).details = { grounding: "unresolved" };
      }
    }
    // Runtime control decisions are observable applications too. A stop after
    // recall must not borrow a later recall or a different leaf's failures.
    const controlEvents = events.filter(event => event.type === "candidate.repair_stopped");
    for (const event of controlEvents) {
      const payload = parseJsonRecord(event.payload_json), boundary = recordAt(payload, ["failedBoundary"]);
      const stepId = recordString(boundary, "stepId"), stepOrder = planSkeleton.findIndex(step => step.step_id === stepId) + 1;
      if (!stepId || !stepOrder || boundary.suggestedRepairShape !== "fail") continue;
      const relatedObservationIds = [...new Set(parseStringArrayValue(boundary.reusableEvidenceRefs).flatMap(ref => {
        const linked = actionObservationsByEvidence.get(ref), observation = observations.find(item => item.id === linked?.id);
        const action = observedActions.find(item => item.id === observation?.sourceRefs[0]?.sourceId);
        const producer = recordAt(parseJsonRecord(action?.metadata_json), ["runtimeResult", "producer"]);
        return linked?.stepId === stepId && observation?.status === "failed" && observation.details?.executionObserved === true
          && producer.runId === input.runId && producer.planId === row.plan_id && producer.stepId === stepId && producer.actionId === action?.id
          && positions.get(linked.id)!.seq < event.seq ? [linked.id] : [];
      }))];
      if (!relatedObservationIds.length) continue;
      const memoryGuidance = [...methodHandoffs, ...recalledHandoffs].filter(item => item.stepId === stepId && item.seq < event.seq)
        .map(({ seq: _seq, stepId: _stepId, ...binding }) => binding);
      const id = `control_${event.seq}`;
      observations.push({ id, kind: "decision", status: "observed", stepOrder, relatedObservationIds,
        summary: "Runtime stopped the current candidate loop after assessment required failure; requested results remain unmet",
        details: { executionObserved: true, executionDecision: "stop", ...(memoryGuidance.length ? { memoryGuidance } : {}) },
        sourceRefs: [{ type: "event", runId: input.runId, sourceId: `${input.runId}:${event.seq}` }] });
      positions.set(id, { at: event.created_at, seq: event.seq });
    }
    const normalizedPlanSkeleton: Readonly<Record<string, unknown>>[] = planSkeleton.map((step, i) => ({ ...planStepForMemory(step, observedToolsByStep.get(step.step_id) ?? []), stepId: `step_${i + 1}`, objective: safe(step.objective), cautions: [], successCriteria: parseJsonArray(step.success_criteria_json).map((item) => safe(typeof item === "string" ? item : String((item as Record<string, unknown>)?.description ?? ""))).filter(Boolean).slice(0, 6) }));
    const assessmentDetails = assessments.sort(ascending("created_at"));
    for (const assessment of assessmentDetails) {
      const stepOrder = planSkeleton.findIndex(step => step.step_id === assessment.step_id) + 1;
      const relatedObservationIds = [...new Set(parseJsonArray(assessment.criteria_json).flatMap(criterion =>
        parseStringArrayValue(recordAt(criterion, []).evidenceRefs)).flatMap(ref => {
          const linked = actionObservationsByEvidence.get(ref);
          return linked?.stepId === assessment.step_id ? [linked.id] : [];
        }))];
      observations.push({ id: `observation_${observations.length + 1}`, kind: "assessment", ...(stepOrder ? { stepOrder } : {}), relatedObservationIds, status: assessment.approved ? "approved" : "rejected", summary: safe(assessment.feedback), sourceRefs: [{ type: "assessment", runId: input.runId, sourceId: assessment.id }] });
      positions.set(observations.at(-1)!.id, { at: assessment.created_at, seq: Number.MAX_SAFE_INTEGER });
    }
    // The final statement is an Agent claim, not a source observation. Follow
    // canonical Result inputs instead of assuming the last tool call delivered
    // the answer. Broad provenance does not prove every input was used as the
    // principal result; the model must preserve that uncertainty.
    const finalResult = parseJsonRecord(row.result_json);
    const finalProducer = recordAt(finalResult, ["producer"]);
    const canonicalFinal = finalResult.schema === "agentloop.runtimeResult/v1" && finalResult.kind === "run" && finalProducer.runId === input.runId
      && (row.plan_id === null || finalProducer.planId === row.plan_id) && recordAt(finalResult, ["publication"]).status === "published"
      && recordAt(finalResult, ["ref"]).resultId === row.result_ref;
    const deliveryInputs = new Set<string>();
    if (canonicalFinal && row.plan_id) {
      const results = await new RuntimeResultRepository(database!).listPlanResults({ runId: input.runId, planId: row.plan_id, actorUserId: input.ownerUserId });
      const byId = new Map(results.map(result => [result.ref.resultId, result]));
      const pending = parseJsonArray(JSON.stringify(finalResult.inputs ?? [])).map(ref => recordString(ref, "resultId")).filter((id): id is string => !!id);
      while (pending.length) {
        const id = pending.pop()!;
        if (deliveryInputs.has(id)) continue;
        deliveryInputs.add(id);
        const result = byId.get(id);
        if (result) pending.push(...result.inputs.map(ref => ref.resultId));
      }
    }
    const deliveryRelated = [...new Set([...deliveryInputs].flatMap(id => {
      const linked = actionObservationsByEvidence.get(id);
      return linked ? [linked.id] : [];
    }))];
    for (const observation of observations) if (observation.kind === "action") {
      (observation as { details: Record<string, unknown> }).details = { ...observation.details,
        deliveryRelation: deliveryRelated.includes(observation.id) ? "declared_input" : "unknown" };
    }
    if (canonicalFinal) {
      const text = recordString(recordAt(finalResult, ["payload"]), "content") ?? "";
      // Retain short prose at the boundaries; never send tables, fenced code,
      // whole files or the complete output as another transcript.
      const prose = text.replace(/```[\s\S]*?(?:```|$)/gu, " ").split(/\r?\n/u).filter(line => !/^\s*\|/u.test(line)).join(" ");
      const excerpt = prose.length > 600 ? `${prose.slice(0, 300)} … ${prose.slice(-295)}` : prose;
      observations.push({ id: "delivery_statement", kind: "delivery", status: row.status, relatedObservationIds: deliveryRelated,
        summary: "Agent committed a final statement; its claims require source verification",
        details: { authority: "model_interpretation", statementExcerpt: safe(excerpt, 600), excerptComplete: false,
          inputLinkage: deliveryRelated.length ? "declared_provenance" : "unknown", reasonCode: row.reason_code },
        sourceRefs: [{ type: "outcome", runId: input.runId, sourceHash: outcomeRef, authority: "model_interpretation" }] });
      positions.set("delivery_statement", { at: Number(row.committed_at), seq: Number.MAX_SAFE_INTEGER });
    }
    // Keep every structural observation. Settlement owns request budgets and
    // evidence windows; sampling here irreversibly loses middle actions and
    // handoff/assessment links before that adaptive boundary can see them.
    const completeObservations = [...new Map(observations.map(item => [item.id, item])).values()].sort((left, right) => {
      const a = positions.get(left.id)!, b = positions.get(right.id)!;
      return a.at - b.at || a.seq - b.seq;
    });
    const capabilityIds = [...new Set(normalizedPlanSkeleton.flatMap((step) => parseStringArrayValue(step.requiredCapabilities)))].sort();
    return {
      scope,
      runId: input.runId,
      terminalCommitRef: input.terminalCommitRef,
      terminalStatus,
      taskFingerprint: {
        taskKind: stringAt(understanding, ["operation"]) ?? "unknown",
        domain: typeof operationProfiles[0] === "string" ? operationProfiles[0] : undefined,
        artifactKind: stringAt(deliverable, ["kind"]),
        sourceKind: typeof arrayAt(evidence, ["sourceKinds"])[0] === "string" ? arrayAt(evidence, ["sourceKinds"])[0] : undefined,
        ...(capabilityIds.length === 0 ? {} : { capabilityIds }),
      },
      ...(row.plan_goal === null || row.plan_goal.trim().length === 0 ? {} : { strategy: safe(row.plan_goal, 1200) }),
      ...(normalizedPlanSkeleton.length === 0 ? {} : { planSkeleton: normalizedPlanSkeleton }),
      observations: completeObservations,
      taskRequest: { text: safe(row.user_input, 600), authority: "user_request", complete: row.user_input.length <= 600 },
      dependencies,
      coverage: { totalObservations: observations.length, retainedObservations: completeObservations.length, omittedObservations: observations.length - completeObservations.length },
      evidenceGaps: [
        ...(!canonicalFinal ? ["delivery_statement_not_available"] : []),
        ...(!assessmentApproved ? ["assessment_not_fully_approved"] : []),
        ...(artifactVerified === undefined && deliverable.kind !== undefined && deliverable.kind !== "none" ? ["artifact_acceptance_not_observed"] : []),
      ],
      ...(selectedSkills.length === 0 ? {} : { keyDecisions: [`复用已选 Skill：${selectedSkills.join(", ")}`] }),
      quality: {
        terminalCommitted: true,
        assessmentApproved,
        ...(artifactVerified === undefined ? (deliverable.kind && deliverable.kind !== "none" ? { artifactVerified: false } : {}) : { artifactVerified }),
        laterCorrected,
        laterDisputed,
        evidenceCoverage: assessmentApproved && artifactVerified !== false ? 0.8 : 0.4,
      },
      sourceRefs: [
        { type: "run", runId: input.runId },
        { type: "outcome", runId: input.runId, sourceHash: outcomeRef },
      ],
      occurredAt: Number(row.committed_at),
    };
  }
}

/** Structural observations only: no row values, stdout bodies or conclusions.
 * Counts describe returned evidence, never fulfillment of the task's goal. */
function neutralResultDiagnostics(content: Record<string, unknown>, safe: (value: string, max?: number) => string): unknown[] {
  const diagnostics: unknown[] = [];
  // Preserve declared result state and short diagnostics, never infer a
  // domain failure category or copy rows, logs, arbitrary details or stderr.
  const visit = (value: unknown, pointer: string, depth: number) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3 || diagnostics.length >= 8) return;
    const row = value as Record<string, unknown>;
    const diagnosticMessage = typeof row.code === "string" || typeof row.errorCode === "string" || /\/(?:error|diagnostic)$/u.test(pointer);
    const fields = Object.fromEntries(["status", "isError", "code", "errorCode", "phase", ...(diagnosticMessage ? ["message"] : [])].flatMap(key => {
      const item = row[key];
      return typeof item === "boolean" || typeof item === "string" && item.length > 0
        ? [[key, typeof item === "string" ? safe(item, key === "message" ? 240 : 80) : item]] : [];
    }));
    if (Object.keys(fields).length) diagnostics.push({ pointer, ...fields });
    for (const key of ["error", "diagnostic", "content"]) {
      visit(row[key], `${pointer}/${key}`, depth + 1);
    }
  };
  visit(content, "", 0);
  for (const key of ["stdout", "content"]) {
    const value = content[key];
    if (typeof value === "string" && value.length < 300_000) {
      try { visit(JSON.parse(value), `/${key}`, 0); } catch { /* Unstructured text is not a diagnostic contract. */ }
    }
  }
  return diagnostics;
}

function neutralResultProfile(content: Record<string, unknown>, safe: (value: string, max?: number) => string): unknown[] {
  const profile: unknown[] = [];
  let partial = false;
  // These Runtime envelope fields locate audit receipts, not new source
  // observations. Their own arrays must not crowd out the returned data.
  const envelopeFields = new Set(["executionReceipt", "workflowEvidenceReceipt", "evidenceReceipt", "artifactReceipt", "artifactReceipts",
    "computationReceipt", "controlSignals", "resultRef", "stdoutRef", "stderrRef", "inputRefs", "sourceRefs", "fileChanges", "outputBindings"]);
  const visit = (value: unknown, pointer: string, depth: number) => {
    if (profile.length >= 16 || depth > 3) { if (value && typeof value === "object") partial = true; return; }
    if (Array.isArray(value)) { profile.push({ pointer: safe(pointer), items: value.length }); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (envelopeFields.has(key) || /password|passwd|token|cookie|secret|credential/iu.test(key)) continue;
      const path = `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      if (typeof item === "number" && /^(?:count|rowCount|row_count|total|totalItems|returned|returnedItems|matched|failed|passed)$/u.test(key)) {
        if (profile.length < 16) profile.push({ pointer: safe(path), count: item });
      } else if (item && typeof item === "object") visit(item, path, depth + 1);
    }
  };
  if (content.schema === "agentloop.jsonRead/v1" && Array.isArray(content.queries)) {
    for (const value of content.queries.slice(0, 20)) {
      const query = recordAt(value, []);
      const pointer = typeof query.sourcePointer === "string" ? query.sourcePointer : typeof query.pointer === "string" ? query.pointer : undefined;
      if (pointer === undefined) continue;
      profile.push({ pointer: safe(pointer),
        ...(Array.isArray(query.value) ? { returnedItems: query.value.length } : { valueType: typeof query.value }),
        ...(typeof query.totalItems === "number" ? { totalItems: query.totalItems } : {}),
        ...(query.nextOffset !== undefined ? { hasMore: query.nextOffset !== null } : {}) });
    }
    if (content.queries.length > 20) profile.push({ complete: false, reason: "structural_profile_budget" });
    return profile;
  }
  visit(content, "", 0);
  // Parse only bounded JSON to read structure; its text and row values never
  // cross into the settlement evidence or the model's learning context.
  for (const key of ["stdout", "content"]) {
    const value = content[key];
    if (typeof value === "string" && value.length < 300_000) {
      try { visit(JSON.parse(value), `/${key}`, 0); } catch { /* No structured observation. */ }
    } else if (typeof value === "string" && value.length >= 300_000) {
      profile.push({ pointer: `/${key}`, available: false, reason: "structural_read_budget" });
    }
  }
  if (partial) profile.push({ complete: false, reason: "structural_profile_budget" });
  return profile;
}

function planStepForMemory(row: PlanStepRow, observedToolNames: readonly string[] = []): Readonly<Record<string, unknown>> {
  const requiredFacts = parseJsonArray(row.required_facts_json);
  const dependencies = parseJsonArray(row.dependencies_json);
  const successCriteria = parseJsonArray(row.success_criteria_json)
    .map((item) => typeof item === "string" ? item : recordString(item, "description"))
    .filter((item): item is string => item !== undefined);
  const evidenceContract = parseJsonRecord(row.evidence_contract_json);
  const requiredEvidenceKinds = parseStringArrayValue(evidenceContract.requiredKinds);
  const executionBinding = parseJsonRecord(row.execution_binding_json);
  const recommendedTools = parseStringArray(row.recommended_tool_names_json);
  const resolvedTools = parseStringArrayValue(executionBinding.resolvedToolNames);
  const toolNames = [...new Set(observedToolNames)].slice(0, 24);
  const plannedToolNames = [...new Set([...recommendedTools, ...resolvedTools])].slice(0, 24);
  const factLabels = requiredFacts.map((item) => typeof item === "string" ? item : recordString(item, "id") ?? recordString(item, "label"))
    .filter((item): item is string => item !== undefined).slice(0, 8);
  const cautions = [
    ...(factLabels.length === 0 ? [] : ["先验证本步骤声明的前置事实，再进入后续计算或交付"]),
    ...(requiredEvidenceKinds.includes("explicit_caveats") ? ["对缺失、口径差异或不可验证内容显式记录 caveat"] : []),
  ];
  return {
    stepId: row.step_id,
    order: Number(row.position) + 1,
    // Preserve the canonical Planner objective. The settlement model may
    // generalize it, but replacing it here loses the goal semantics needed
    // for Task Group matching and makes unrelated Runs look equivalent.
    objective: row.objective.trim().length > 0
      ? row.objective.trim().slice(0, 500)
      : generalizedObjective(row.role, requiredEvidenceKinds, toolNames),
    ...(row.role === null ? {} : { role: row.role }),
    dependencies,
    ...(factLabels.length ? { requiredFacts: factLabels } : {}),
    ...(parseStringArray(row.skill_ids_json).length === 0 ? {} : { skillIds: parseStringArray(row.skill_ids_json) }),
    ...(parseStringArray(row.required_capabilities_json).length === 0 ? {} : { requiredCapabilities: parseStringArray(row.required_capabilities_json) }),
    ...(toolNames.length === 0 ? {} : { toolNames }),
    ...(plannedToolNames.length === 0 ? {} : { plannedToolNames }),
    plannedToolNames: [...new Set([...recommendedTools, ...resolvedTools])].slice(0, 24),
    requiredEvidenceKinds,
    ...(successCriteria.length === 0 ? {} : { successCriteria: [`满足本步骤的证据契约（${requiredEvidenceKinds.join("、") || "无额外契约"}）`] }),
    ...(cautions.length === 0 ? {} : { cautions }),
    producedEvidenceKinds: parseStringArrayValue(executionBinding.evidenceKinds),
  };
}

function proceduralArguments(args: Record<string, unknown>): string {
  // Preserve script entrypoint/subcommand/flag names, omit option values,
  // executable code, credentials, raw SQL and user-supplied file contents.
  const command = typeof args.command === "string" && /^[\w.-]+$/u.test(args.command) ? args.command : undefined;
  const values = Array.isArray(args.args) ? args.args.filter((value): value is string => typeof value === "string") : [];
  const script = values.find((value) => /(?:^|\/)scripts\/[\w./-]+\.(?:py|js|mjs|ts)$/u.test(value));
  const scriptIndex = script === undefined ? -1 : values.indexOf(script);
  const subcommand = scriptIndex >= 0 && /^[a-z][a-z-]{1,40}$/u.test(values[scriptIndex + 1] ?? "") ? values[scriptIndex + 1] : undefined;
  const flags = values.filter((value) => /^--[a-z][a-z-]{1,40}$/u.test(value)).slice(0, 12);
  const skill = typeof args.name === "string" && args.name.startsWith("discovered:") ? args.name : undefined;
  return [command, script, subcommand, ...flags, skill].filter(Boolean).join(" ");
}

function generalizedObjective(role: string | null, evidenceKinds: readonly string[], toolNames: readonly string[]): string {
  switch (role) {
    case "fact_acquisition": return "获取并验证来源事实、统计口径与适用范围";
    case "produce": return "基于已验证事实生成目标格式交付物并完成验收";
    case "deliver": return "确认最终交付物身份、可打开性与交付凭证";
    case "repair": return "定位失败边界，修复后重新执行相关步骤并验证证据";
    default:
      return evidenceKinds.length > 0
        ? `执行步骤并满足证据契约（${evidenceKinds.join("、")}）`
        : toolNames.length > 0 ? "使用已绑定工具完成计划步骤" : "完成计划步骤并记录可验证结果";
  }
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (value == null) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function recordAt(value: unknown, path: readonly string[]): Record<string, unknown> {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return {};
    current = (current as Record<string, unknown>)[key];
  }
  return current !== null && typeof current === "object" && !Array.isArray(current) ? current as Record<string, unknown> : {};
}

function arrayAt(value: Record<string, unknown>, path: readonly string[]): unknown[] {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return [];
    current = (current as Record<string, unknown>)[key];
  }
  return Array.isArray(current) ? current : [];
}

function stringAt(value: Record<string, unknown>, path: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
}

function parseStringArray(value: string | null): string[] {
  if (value === null) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonArray(value: string | null): unknown[] {
  if (value === null) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseStringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function recordString(value: unknown, key: string): string | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>)[key] === "string"
    ? (value as Record<string, string>)[key]
    : undefined;
}
