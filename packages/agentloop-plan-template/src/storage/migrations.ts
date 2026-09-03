import type { SqlConnection } from "@zhujun/agentloop";
import { normalizeSchemaName } from "./storage-config.ts";

export interface PlanTemplateTableNames {
  readonly templates: string;
  readonly examples: string;
  readonly matches: string;
}

export function planTemplateTableNames(input: {
  readonly dialect: "sqlite" | "postgres";
  readonly schemaName?: string;
}): PlanTemplateTableNames {
  if (input.dialect === "sqlite") {
    return {
      templates: quoteIdent("plan_templates"),
      examples: quoteIdent("plan_template_examples"),
      matches: quoteIdent("plan_template_matches"),
    };
  }
  const schema = quoteIdent(normalizeSchemaName(input.schemaName));
  return {
    templates: `${schema}.${quoteIdent("plan_templates")}`,
    examples: `${schema}.${quoteIdent("plan_template_examples")}`,
    matches: `${schema}.${quoteIdent("plan_template_matches")}`,
  };
}

export async function migratePlanTemplateStorage(input: {
  readonly connection: SqlConnection;
  readonly schemaName?: string;
}): Promise<PlanTemplateTableNames> {
  const tables = planTemplateTableNames({
    dialect: input.connection.dialect,
    ...(input.schemaName === undefined ? {} : { schemaName: input.schemaName }),
  });
  if (input.connection.dialect === "postgres") {
    await input.connection.exec(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(normalizeSchemaName(input.schemaName))}`);
  }
  await input.connection.exec(`
    CREATE TABLE IF NOT EXISTS ${tables.templates} (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      intent_family TEXT NOT NULL,
      source_need TEXT NOT NULL,
      accepted_source_types_json TEXT NOT NULL,
      artifact_kind TEXT NOT NULL,
      side_effect_kind TEXT NOT NULL,
      required_capabilities_json TEXT NOT NULL,
      required_evidence_json TEXT NOT NULL,
      risk_ceiling TEXT NOT NULL,
      plan_skeleton_json TEXT NOT NULL,
      positive_example_refs_json TEXT NOT NULL,
      negative_example_refs_json TEXT NOT NULL,
      reliability_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await input.connection.exec(`
    CREATE TABLE IF NOT EXISTS ${tables.examples} (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      example_type TEXT NOT NULL,
      task_text_hash TEXT NOT NULL,
      task_fingerprint_json TEXT NOT NULL,
      outcome_status TEXT NOT NULL,
      evidence_summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (template_id) REFERENCES ${tables.templates}(id)
    )
  `);
  await input.connection.exec(`
    CREATE TABLE IF NOT EXISTS ${tables.matches} (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      template_id TEXT,
      task_fingerprint_json TEXT NOT NULL,
      score REAL,
      decision TEXT NOT NULL,
      rejection_reasons_json TEXT NOT NULL,
      admission_result_json TEXT,
      outcome_status TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await input.connection.exec(`CREATE INDEX IF NOT EXISTS ${indexName(input.connection.dialect, input.schemaName, "idx_plan_template_matches_run_id")} ON ${tables.matches} (run_id)`);
  await input.connection.exec(`CREATE INDEX IF NOT EXISTS ${indexName(input.connection.dialect, input.schemaName, "idx_plan_template_examples_template_id")} ON ${tables.examples} (template_id)`);
  return tables;
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function indexName(dialect: "sqlite" | "postgres", schemaName: string | undefined, name: string): string {
  if (dialect === "sqlite") return quoteIdent(name);
  return `${quoteIdent(normalizeSchemaName(schemaName))}.${quoteIdent(name)}`;
}
