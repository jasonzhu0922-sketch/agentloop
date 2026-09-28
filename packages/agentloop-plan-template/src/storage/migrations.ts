import type { SqlConnection, SqlDialect } from "@zhujun/agentloop";
import { normalizeSchemaName } from "./storage-config.ts";

export interface PlanTemplateTableNames {
  readonly templates: string;
  readonly examples: string;
  readonly matches: string;
}

export function planTemplateTableNames(input: {
  readonly dialect: SqlDialect;
  readonly schemaName?: string;
}): PlanTemplateTableNames {
  if (input.dialect === "sqlite" || input.dialect === "tidb") {
    if (input.dialect === "tidb" && input.schemaName !== undefined) {
      throw new Error("PlanTemplate TiDB storage uses the database in connectionString; schemaName is PostgreSQL-only.");
    }
    return {
      templates: quoteIdent("plan_templates", input.dialect),
      examples: quoteIdent("plan_template_examples", input.dialect),
      matches: quoteIdent("plan_template_matches", input.dialect),
    };
  }
  const schema = quoteIdent(normalizeSchemaName(input.schemaName), "postgres");
  return {
    templates: `${schema}.${quoteIdent("plan_templates", "postgres")}`,
    examples: `${schema}.${quoteIdent("plan_template_examples", "postgres")}`,
    matches: `${schema}.${quoteIdent("plan_template_matches", "postgres")}`,
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
    await input.connection.exec(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(normalizeSchemaName(input.schemaName), "postgres")}`);
  }
  const templatesSchema = `
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
  `;
  await input.connection.exec(input.connection.dialect === "tidb" ? tidbTemplatesSchema(tables) : templatesSchema);
  const examplesSchema = `
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
  `;
  await input.connection.exec(input.connection.dialect === "tidb" ? tidbExamplesSchema(tables) : examplesSchema);
  const matchesSchema = `
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
  `;
  await input.connection.exec(input.connection.dialect === "tidb" ? tidbMatchesSchema(tables) : matchesSchema);
  await input.connection.exec(`CREATE INDEX IF NOT EXISTS ${indexName(input.connection.dialect, input.schemaName, "idx_plan_template_matches_run_id")} ON ${tables.matches} (run_id)`);
  await input.connection.exec(`CREATE INDEX IF NOT EXISTS ${indexName(input.connection.dialect, input.schemaName, "idx_plan_template_examples_template_id")} ON ${tables.examples} (template_id)`);
  return tables;
}

function quoteIdent(value: string, dialect: "sqlite" | "postgres" | "tidb"): string {
  const delimiter = dialect === "tidb" ? "`" : "\"";
  return `${delimiter}${value.replaceAll(delimiter, `${delimiter}${delimiter}`)}${delimiter}`;
}

function indexName(dialect: SqlDialect, schemaName: string | undefined, name: string): string {
  if (dialect === "sqlite" || dialect === "tidb") return quoteIdent(name, dialect);
  return `${quoteIdent(normalizeSchemaName(schemaName), "postgres")}.${quoteIdent(name, "postgres")}`;
}

function tidbTemplatesSchema(tables: PlanTemplateTableNames): string {
  return `CREATE TABLE IF NOT EXISTS ${tables.templates} (
    id VARCHAR(191) PRIMARY KEY, version BIGINT NOT NULL, status LONGTEXT NOT NULL,
    intent_family LONGTEXT NOT NULL, source_need LONGTEXT NOT NULL,
    accepted_source_types_json LONGTEXT NOT NULL, artifact_kind LONGTEXT NOT NULL,
    side_effect_kind LONGTEXT NOT NULL, required_capabilities_json LONGTEXT NOT NULL,
    required_evidence_json LONGTEXT NOT NULL, risk_ceiling LONGTEXT NOT NULL,
    plan_skeleton_json LONGTEXT NOT NULL, positive_example_refs_json LONGTEXT NOT NULL,
    negative_example_refs_json LONGTEXT NOT NULL, reliability_json LONGTEXT NOT NULL,
    created_at LONGTEXT NOT NULL, updated_at LONGTEXT NOT NULL
  )`;
}

function tidbExamplesSchema(tables: PlanTemplateTableNames): string {
  return `CREATE TABLE IF NOT EXISTS ${tables.examples} (
    id VARCHAR(191) PRIMARY KEY, template_id VARCHAR(191) NOT NULL, run_id VARCHAR(191) NOT NULL,
    example_type LONGTEXT NOT NULL, task_text_hash LONGTEXT NOT NULL, task_fingerprint_json LONGTEXT NOT NULL,
    outcome_status LONGTEXT NOT NULL, evidence_summary_json LONGTEXT NOT NULL, created_at LONGTEXT NOT NULL,
    FOREIGN KEY (template_id) REFERENCES ${tables.templates}(id)
  )`;
}

function tidbMatchesSchema(tables: PlanTemplateTableNames): string {
  return `CREATE TABLE IF NOT EXISTS ${tables.matches} (
    id VARCHAR(191) PRIMARY KEY, run_id VARCHAR(191) NOT NULL, template_id VARCHAR(191),
    task_fingerprint_json LONGTEXT NOT NULL, score REAL, decision LONGTEXT NOT NULL,
    rejection_reasons_json LONGTEXT NOT NULL, admission_result_json LONGTEXT,
    outcome_status LONGTEXT, created_at LONGTEXT NOT NULL
  )`;
}
