import type { SqlConnection } from "@zhujun/agentloop";
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
}

/** Reads only canonical local Run/Outcome/Assessment rows for settlement. */
export class LocalMemorySettlementReader implements MemorySettlementReader {
  private readonly databases: () => readonly SqlConnection[];
  private readonly tenantId: string;

  constructor(database: SqlConnection | (() => readonly SqlConnection[]), tenantId: string) {
    this.databases = typeof database === "function" ? database : () => [database];
    this.tenantId = tenantId;
  }

  async read(input: { tenantId: string; ownerUserId: string; runId: string; terminalCommitRef: string }): Promise<MemorySettlementEvidence | undefined> {
    if (input.tenantId !== this.tenantId) throw new Error("settlement_tenant_mismatch");
    let row: OutcomeRow | undefined;
    let database: SqlConnection | undefined;
    for (const candidate of this.databases()) {
      const found = await candidate.prepare(`
      SELECT r.owner_user_id, r.conversation_id, o.status, o.reason_code, o.plan_id, o.result_ref, o.committed_at, o.delivery_receipt_json,
             p.goal AS plan_goal, p.selected_skill_ids_json,
             c.state_json
      FROM runs r
      JOIN run_outcomes o ON o.run_id = r.id
      LEFT JOIN plans p ON p.id = o.plan_id
      LEFT JOIN canonical_run_states c ON c.run_id = r.id
      WHERE r.id = ? AND r.owner_user_id = ?
      `).get<OutcomeRow>(input.runId, input.ownerUserId);
      if (found !== undefined) { row = found; database = candidate; break; }
    }
    if (row === undefined) return undefined;
    const actualCommitRef = row.result_ref ?? `${input.runId}:${row.committed_at}`;
    if (actualCommitRef !== input.terminalCommitRef) throw new Error("settlement_terminal_commit_mismatch");
    const assessment = row.plan_id === null
      ? { count: 0, approved: 0 }
      : await database!.prepare(`
          SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN approved = 1 THEN 1 ELSE 0 END), 0) AS approved
          FROM skill_compliance_assessments WHERE plan_id = ?
        `).get<AssessmentRow>(row.plan_id) ?? { count: 0, approved: 0 };
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
    const laterDisputed = row.conversation_id === null ? false : (await database!.prepare(`
      SELECT 1 AS found FROM run_events e
      JOIN runs later_run ON later_run.id = e.run_id
      WHERE later_run.conversation_id = ?
        AND e.type = 'conversation.outcome.disputed'
        AND e.payload_json LIKE ? LIMIT 1
    `).get<{ found: number }>(row.conversation_id, `%"targetRunId":"${input.runId}"%`)) !== undefined;
    const laterCorrected = row.conversation_id === null ? false : (await database!.prepare(`
      SELECT 1 AS found FROM run_events e
      JOIN runs later_run ON later_run.id = e.run_id
      WHERE later_run.conversation_id = ?
        AND e.type = 'conversation.outcome.superseded'
        AND e.payload_json LIKE ? LIMIT 1
    `).get<{ found: number }>(row.conversation_id, `%"targetRunId":"${input.runId}"%`)) !== undefined;
    const scope: MemoryRunScope = {
      tenantId: this.tenantId,
      ownerUserId: input.ownerUserId,
      runId: input.runId,
    };
    const outcomeRef = row.result_ref ?? `${input.runId}:${row.committed_at}`;
    const selectedSkills = parseStringArray(row.selected_skill_ids_json);
    const planSkeleton = row.plan_id === null ? [] : await database!.prepare(`
      SELECT step_id, position, objective, role, dependencies_json, required_facts_json,
             skill_ids_json, required_capabilities_json, recommended_tool_names_json,
             execution_binding_json, evidence_contract_json, success_criteria_json
      FROM plan_steps WHERE plan_id = ? ORDER BY position
    `).all<PlanStepRow>(row.plan_id);
    const observedActions = await database!.prepare(`
      SELECT id, step_id, metadata_json, state, error_code, kind
      FROM runtime_actions
      WHERE run_id = ? AND kind IN ('tool_call', 'recovery_review')
      ORDER BY created_at ASC
    `).all<RuntimeActionRow>(input.runId);
    const entities = memoryEntities([row.plan_goal ?? "", ...planSkeleton.map((step) => step.objective)]);
    const safe = (value: string, max = 500) => memorySafeText(value, entities, max);
    const actionArguments = await database!.prepare(`SELECT payload_json FROM run_events
      WHERE run_id = ? AND type = 'tool.planned' ORDER BY seq LIMIT 200`).all<{ payload_json: string }>(input.runId);
    const argumentsByCall = new Map(actionArguments.map(({ payload_json }) => {
      const payload = parseJsonRecord(payload_json);
      return [recordString(payload, "toolCallId"), parseJsonRecord(JSON.stringify(payload.arguments ?? {}))] as const;
    }));
    const observedToolsByStep = new Map<string, string[]>();
    const observations: NonNullable<MemorySettlementEvidence["observations"]>[number][] = [];
    let artifactVerified: boolean | undefined;
    for (const action of observedActions) {
      const metadata = parseJsonRecord(action.metadata_json);
      const toolName = recordString(metadata, "toolName") ?? recordString(metadata, "name");
      const result = recordAt(metadata, ["runtimeResult"]);
      const payload = recordAt(result, ["payload"]);
      const content = parseJsonRecord(typeof payload.content === "string" && payload.content.length < 300_000 ? payload.content : undefined);
      const sourceRefs: MemorySourceRef[] = [{ type: "action", runId: input.runId, sourceId: action.id }];
      const stepOrder = planSkeleton.findIndex((step) => step.step_id === action.step_id) + 1;
      const args = argumentsByCall.get(recordString(metadata, "toolCallId"));
      const method = args ? proceduralArguments(args) : "";
      const errors = [action.error_code, recordString(content, "error"), recordString(content, "errorCode")].filter((value): value is string => !!value);
      const failed = action.state !== "succeeded" || content.isError === true || (typeof content.exitCode === "number" && content.exitCode !== 0) || errors.length > 0;
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
        // Only explicit bounded structural summaries are copied, never stdout, rows, file or Skill bodies.
        recordString(content, "summary"),
      ].filter(Boolean).join("；");
      observations.push({ id: `observation_${observations.length + 1}`, kind: action.kind === "recovery_review" ? "recovery" : "action", ...(stepOrder ? { stepOrder } : {}), ...(toolName ? { toolName } : {}), status: failed ? "failed" : "succeeded", summary: safe(summary || `${action.kind}:${action.state}`), sourceRefs });
      if (action.step_id === null || toolName === undefined || failed) continue;
      const current = observedToolsByStep.get(action.step_id) ?? [];
      if (!current.includes(toolName)) current.push(toolName);
      observedToolsByStep.set(action.step_id, current);
    }
    const normalizedPlanSkeleton: Readonly<Record<string, unknown>>[] = planSkeleton.map((step, i) => ({ ...planStepForMemory(step, observedToolsByStep.get(step.step_id) ?? []), stepId: `step_${i + 1}`, objective: safe(step.objective), cautions: [], successCriteria: parseJsonArray(step.success_criteria_json).map((item) => safe(typeof item === "string" ? item : String((item as Record<string, unknown>)?.description ?? ""))).filter(Boolean).slice(0, 6) }));
    const assessmentDetails = row.plan_id === null ? [] : await database!.prepare(`SELECT id, step_id, approved, feedback FROM skill_compliance_assessments WHERE plan_id = ? ORDER BY created_at DESC LIMIT 8`)
      .all<{ id: string; step_id: string; approved: number; feedback: string }>(row.plan_id);
    for (const assessment of assessmentDetails) observations.push({ id: `observation_${observations.length + 1}`, kind: "assessment", status: assessment.approved ? "approved" : "rejected", summary: safe(assessment.feedback), sourceRefs: [{ type: "assessment", runId: input.runId, sourceId: assessment.id }] });
    const boundedObservations = observations.length > 24 ? [...observations.slice(0, 8), ...observations.filter((item) => item.status === "failed" || item.status === "rejected").slice(-8), ...observations.slice(-8)] : observations;
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
      observations: [...new Map(boundedObservations.map((item) => [item.id, item])).values()],
      evidenceGaps: [
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

function recordAt(value: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
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
