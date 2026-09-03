import type { SqlConnection } from "@zhujun/agentloop";
import type {
  PlanTemplate,
  PlanTemplateExample,
  PlanTemplateMatch,
  PlanTemplateOutcome,
  TaskFingerprint,
  TemplateReliability,
} from "../types.ts";
import { migratePlanTemplateStorage, planTemplateTableNames, type PlanTemplateTableNames } from "./migrations.ts";

interface PlanTemplateRow {
  readonly id: string;
  readonly version: number;
  readonly status: PlanTemplate["status"];
  readonly intent_family: string;
  readonly source_need: PlanTemplate["sourceNeed"];
  readonly accepted_source_types_json: string;
  readonly artifact_kind: PlanTemplate["artifactKind"];
  readonly side_effect_kind: PlanTemplate["sideEffectKind"];
  readonly required_capabilities_json: string;
  readonly required_evidence_json: string;
  readonly risk_ceiling: PlanTemplate["riskCeiling"];
  readonly plan_skeleton_json: string;
  readonly positive_example_refs_json: string;
  readonly negative_example_refs_json: string;
  readonly reliability_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface PlanTemplateMatchRow {
  readonly id: string;
  readonly run_id: string;
  readonly template_id: string | null;
  readonly task_fingerprint_json: string;
  readonly score: number | null;
  readonly decision: PlanTemplateMatch["decision"];
  readonly rejection_reasons_json: string;
  readonly admission_result_json: string | null;
  readonly outcome_status: string | null;
  readonly created_at: string;
}

export class SqlPlanTemplateStore {
  private readonly connection: SqlConnection;
  private readonly schemaName?: string;
  private tables: PlanTemplateTableNames;

  constructor(input: { readonly connection: SqlConnection; readonly schemaName?: string }) {
    this.connection = input.connection;
    this.schemaName = input.schemaName;
    this.tables = planTemplateTableNames({
      dialect: this.connection.dialect,
      ...(this.schemaName === undefined ? {} : { schemaName: this.schemaName }),
    });
  }

  async migrate(): Promise<void> {
    this.tables = await migratePlanTemplateStorage({
      connection: this.connection,
      ...(this.schemaName === undefined ? {} : { schemaName: this.schemaName }),
    });
  }

  async close(): Promise<void> {
    await this.connection.close();
  }

  async listCandidates(fingerprint: TaskFingerprint): Promise<PlanTemplate[]> {
    const rows = await this.connection.prepare(`
      SELECT * FROM ${this.tables.templates}
      WHERE status IN ('candidate', 'active')
        AND artifact_kind = ?
        AND side_effect_kind = ?
      ORDER BY updated_at DESC
      LIMIT 50
    `).all<PlanTemplateRow>(fingerprint.artifactKind, fingerprint.sideEffectKind);
    return rows.map(rowToTemplate);
  }

  async getTemplate(id: string): Promise<PlanTemplate | null> {
    const row = await this.connection.prepare(`
      SELECT * FROM ${this.tables.templates}
      WHERE id = ?
    `).get<PlanTemplateRow>(id);
    return row === undefined ? null : rowToTemplate(row);
  }

  async matchesByRun(runId: string): Promise<PlanTemplateMatch[]> {
    const rows = await this.connection.prepare(`
      SELECT * FROM ${this.tables.matches}
      WHERE run_id = ?
      ORDER BY created_at ASC
    `).all<PlanTemplateMatchRow>(runId);
    return rows.map(rowToMatch);
  }

  async listObservedMatchesForMining(limit: number): Promise<PlanTemplateMatch[]> {
    const rows = await this.connection.prepare(`
      SELECT * FROM ${this.tables.matches}
      WHERE decision = 'observed'
        AND outcome_status = 'completed'
        AND admission_result_json IS NOT NULL
      ORDER BY created_at ASC
      LIMIT ?
    `).all<PlanTemplateMatchRow>(limit);
    return rows.map(rowToMatch);
  }

  async listTemplates(filter?: { readonly status?: PlanTemplate["status"] }): Promise<PlanTemplate[]> {
    const status = filter?.status;
    const rows = status === undefined
      ? await this.connection.prepare(`
          SELECT * FROM ${this.tables.templates}
          ORDER BY updated_at DESC
        `).all<PlanTemplateRow>()
      : await this.connection.prepare(`
          SELECT * FROM ${this.tables.templates}
          WHERE status = ?
          ORDER BY updated_at DESC
        `).all<PlanTemplateRow>(status);
    return rows.map(rowToTemplate);
  }

  async upsertTemplate(template: PlanTemplate): Promise<void> {
    const now = new Date().toISOString();
    await this.connection.prepare(`
      INSERT INTO ${this.tables.templates} (
        id, version, status, intent_family, source_need,
        accepted_source_types_json, artifact_kind, side_effect_kind,
        required_capabilities_json, required_evidence_json, risk_ceiling,
        plan_skeleton_json, positive_example_refs_json, negative_example_refs_json,
        reliability_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        version = excluded.version,
        status = excluded.status,
        intent_family = excluded.intent_family,
        source_need = excluded.source_need,
        accepted_source_types_json = excluded.accepted_source_types_json,
        artifact_kind = excluded.artifact_kind,
        side_effect_kind = excluded.side_effect_kind,
        required_capabilities_json = excluded.required_capabilities_json,
        required_evidence_json = excluded.required_evidence_json,
        risk_ceiling = excluded.risk_ceiling,
        plan_skeleton_json = excluded.plan_skeleton_json,
        positive_example_refs_json = excluded.positive_example_refs_json,
        negative_example_refs_json = excluded.negative_example_refs_json,
        reliability_json = excluded.reliability_json,
        updated_at = excluded.updated_at
    `).run(
      template.id,
      template.version,
      template.status,
      template.intentFamily,
      template.sourceNeed,
      JSON.stringify(template.acceptedSourceTypes),
      template.artifactKind,
      template.sideEffectKind,
      JSON.stringify(template.requiredCapabilities),
      JSON.stringify(template.requiredEvidenceKinds),
      template.riskCeiling,
      JSON.stringify(template.planSkeleton),
      JSON.stringify(template.positiveExampleRefs),
      JSON.stringify(template.negativeExampleRefs),
      JSON.stringify(template.reliability),
      now,
      now,
    );
  }

  async recordExample(example: PlanTemplateExample): Promise<void> {
    await this.connection.prepare(`
      INSERT INTO ${this.tables.examples} (
        id, template_id, run_id, example_type, task_text_hash,
        task_fingerprint_json, outcome_status, evidence_summary_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        template_id = excluded.template_id,
        run_id = excluded.run_id,
        example_type = excluded.example_type,
        task_text_hash = excluded.task_text_hash,
        task_fingerprint_json = excluded.task_fingerprint_json,
        outcome_status = excluded.outcome_status,
        evidence_summary_json = excluded.evidence_summary_json
    `).run(
      example.id,
      example.templateId,
      example.runId,
      example.exampleType,
      example.taskTextHash,
      JSON.stringify(example.taskFingerprint),
      example.outcomeStatus,
      JSON.stringify(example.evidenceSummary),
      example.createdAt,
    );
  }

  async recordMatch(match: PlanTemplateMatch): Promise<void> {
    await this.connection.prepare(`
      INSERT INTO ${this.tables.matches} (
        id, run_id, template_id, task_fingerprint_json, score, decision,
        rejection_reasons_json, admission_result_json, outcome_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        template_id = excluded.template_id,
        task_fingerprint_json = excluded.task_fingerprint_json,
        score = excluded.score,
        decision = excluded.decision,
        rejection_reasons_json = excluded.rejection_reasons_json,
        admission_result_json = excluded.admission_result_json,
        outcome_status = excluded.outcome_status
    `).run(
      match.id,
      match.runId,
      match.templateId ?? null,
      JSON.stringify(match.taskFingerprint),
      match.score ?? null,
      match.decision,
      JSON.stringify(match.rejectionReasons),
      match.admissionResult === undefined ? null : JSON.stringify(match.admissionResult),
      match.outcomeStatus ?? null,
      match.createdAt,
    );
  }

  async recordOutcome(outcome: PlanTemplateOutcome): Promise<void> {
    await this.connection.prepare(`
      UPDATE ${this.tables.matches}
      SET outcome_status = ?
      WHERE run_id = ?
    `).run(outcome.status, outcome.runId);
  }

  async updateReliability(templateId: string, reliability: TemplateReliability): Promise<void> {
    await this.connection.prepare(`
      UPDATE ${this.tables.templates}
      SET reliability_json = ?, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(reliability), new Date().toISOString(), templateId);
  }

  async updateTemplateStatus(templateId: string, status: PlanTemplate["status"]): Promise<PlanTemplate> {
    const result = await this.connection.prepare(`
      UPDATE ${this.tables.templates}
      SET status = ?, updated_at = ?
      WHERE id = ?
    `).run(status, new Date().toISOString(), templateId);
    if (Number(result.changes) === 0) throw new Error(`PlanTemplate not found: ${templateId}`);
    const template = await this.getTemplate(templateId);
    if (template === null) throw new Error(`PlanTemplate not found after status update: ${templateId}`);
    return template;
  }
}

function rowToTemplate(row: PlanTemplateRow): PlanTemplate {
  return {
    schema: "agentloop.planTemplate/v1",
    id: row.id,
    version: Number(row.version),
    status: row.status,
    intentFamily: row.intent_family,
    sourceNeed: row.source_need,
    acceptedSourceTypes: parseJsonArray(row.accepted_source_types_json),
    artifactKind: row.artifact_kind,
    sideEffectKind: row.side_effect_kind,
    requiredCapabilities: parseJsonArray(row.required_capabilities_json),
    requiredEvidenceKinds: parseJsonArray(row.required_evidence_json),
    riskCeiling: row.risk_ceiling,
    planSkeleton: parseJsonArray(row.plan_skeleton_json),
    positiveExampleRefs: parseJsonArray(row.positive_example_refs_json),
    negativeExampleRefs: parseJsonArray(row.negative_example_refs_json),
    reliability: parseJsonObject(row.reliability_json),
  };
}

function rowToMatch(row: PlanTemplateMatchRow): PlanTemplateMatch {
  return {
    id: row.id,
    runId: row.run_id,
    ...(row.template_id === null ? {} : { templateId: row.template_id }),
    taskFingerprint: parseJsonObject(row.task_fingerprint_json),
    ...(row.score === null ? {} : { score: Number(row.score) }),
    decision: row.decision,
    rejectionReasons: parseJsonArray(row.rejection_reasons_json),
    ...(row.admission_result_json === null ? {} : { admissionResult: parseJsonObject(row.admission_result_json) }),
    ...(row.outcome_status === null ? {} : { outcomeStatus: row.outcome_status }),
    createdAt: row.created_at,
  };
}

function parseJsonArray<T = unknown>(value: string): readonly T[] {
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed as readonly T[] : [];
}

function parseJsonObject<T = Record<string, unknown>>(value: string): T {
  const parsed = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PlanTemplate JSON column did not contain an object");
  }
  return parsed as T;
}
