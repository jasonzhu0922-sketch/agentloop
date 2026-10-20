import type { SqlConnection } from "./connection.ts";

const PROFILE_CHECK = "assessment_profile IN ('deterministic', 'evidence_gate', 'lookup_lite', 'source_grounded', 'result_judged', 'risk_sensitive')";

/** Forward schema change; preserve all observations and assessment metadata. */
export async function installAssessmentProfileSchema(database: SqlConnection): Promise<void> {
  if (database.dialect === "sqlite") {
    const row = await database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'skill_compliance_assessments'").get<{ sql: string }>();
    if (row === undefined || row.sql.includes("'result_judged'")) return;
    await database.transaction(async () => {
      const columns = await database.prepare("PRAGMA table_info(skill_compliance_assessments)").all<{ name: string }>();
      const indexes = await database.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'skill_compliance_assessments' AND type IN ('index', 'trigger') AND sql IS NOT NULL").all<{ sql: string }>();
      const check = /CHECK\s*\(\s*assessment_profile\s+IN\s*\([^)]*\)\s*\)/i;
      let schema = row.sql.replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`\[]?skill_compliance_assessments["`\]]?/i,
        "CREATE TABLE skill_compliance_assessments_new");
      schema = check.test(schema) ? schema.replace(check, `CHECK(${PROFILE_CHECK})`)
        : schema.replace(/\)\s*$/, `, CHECK(${PROFILE_CHECK}))`);
      const names = columns.map((column) => quote(column.name, '"')).join(", ");
      await database.exec(schema);
      await database.exec(`INSERT INTO skill_compliance_assessments_new (${names}) SELECT ${names} FROM skill_compliance_assessments`);
      await database.exec("DROP TABLE skill_compliance_assessments");
      await database.exec("ALTER TABLE skill_compliance_assessments_new RENAME TO skill_compliance_assessments");
      for (const index of indexes) await database.exec(index.sql);
    });
    return;
  }
  const constraints = database.dialect === "postgres"
    ? await database.prepare(`SELECT conname AS name, pg_get_constraintdef(oid) AS clause FROM pg_constraint
        WHERE conrelid = 'skill_compliance_assessments'::regclass AND contype = 'c'`).all<{ name: string; clause: string }>()
    : await database.prepare(`SELECT tc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS clause
        FROM information_schema.TABLE_CONSTRAINTS tc JOIN information_schema.CHECK_CONSTRAINTS cc
        ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
        WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.TABLE_NAME = 'skill_compliance_assessments' AND tc.CONSTRAINT_TYPE = 'CHECK'`).all<{ name: string; clause: string }>();
  const profiles = constraints.filter((constraint) => /assessment_profile/i.test(constraint.clause));
  if (profiles.length > 0 && profiles.every((constraint) => constraint.clause.includes("'result_judged'"))) return;
  await database.transaction(async () => {
    for (const constraint of profiles) {
      await database.exec(`ALTER TABLE skill_compliance_assessments DROP ${database.dialect === "postgres" ? "CONSTRAINT" : "CHECK"} ${quote(constraint.name, database.dialect === "postgres" ? '"' : "`")}`);
    }
    await database.exec(`ALTER TABLE skill_compliance_assessments ADD CONSTRAINT skill_assessment_profile_check CHECK(${PROFILE_CHECK})`);
  });
}

function quote(value: string, delimiter: string): string {
  return `${delimiter}${value.replaceAll(delimiter, delimiter + delimiter)}${delimiter}`;
}
