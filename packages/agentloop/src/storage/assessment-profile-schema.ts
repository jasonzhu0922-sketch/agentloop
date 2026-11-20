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
    : await tidbTableChecks(database);
  const profiles = constraints.filter((constraint) => /assessment_profile/i.test(constraint.clause));
  if (profiles.length > 0 && profiles.every((constraint) => constraint.clause.includes("'result_judged'"))) return;
  await database.transaction(async () => {
    for (const constraint of profiles) {
      await database.exec(`ALTER TABLE skill_compliance_assessments DROP ${database.dialect === "postgres" ? "CONSTRAINT" : "CHECK"} ${quote(constraint.name, database.dialect === "postgres" ? '"' : "`")}`);
    }
    await database.exec(`ALTER TABLE skill_compliance_assessments ADD CONSTRAINT skill_assessment_profile_check CHECK(${PROFILE_CHECK})`);
  });
}

/** TiDB exposes checks in SHOW CREATE TABLE even when TABLE_CONSTRAINTS omits them.
 * Read the owning table directly: CHECK_CONSTRAINTS alone has no table identity.
 */
async function tidbTableChecks(database: SqlConnection): Promise<{ name: string; clause: string }[]> {
  const row = await database.prepare("SHOW CREATE TABLE skill_compliance_assessments").get<{ "Create Table": string }>();
  if (typeof row?.["Create Table"] !== "string") throw new Error("TiDB did not return the assessment table definition");
  const ddl = row["Create Table"];
  const checks: { name: string; clause: string }[] = [];
  const declaration = /\bCONSTRAINT\s+`((?:``|[^`])+)`\s+CHECK\s*\(/giu;
  for (const match of ddl.matchAll(declaration)) {
    const start = match.index! + match[0].length;
    let depth = 1, quote: string | undefined, end = start;
    for (; end < ddl.length; end++) {
      const char = ddl[end];
      if (quote) {
        if (char === "\\" && quote !== "`") { end++; continue; }
        if (char === quote) {
          if (ddl[end + 1] === quote) end++;
          else quote = undefined;
        }
      } else if (["'", '"', "`"].includes(char)) quote = char;
      else if (char === "(") depth++;
      else if (char === ")" && --depth === 0) break;
    }
    if (depth !== 0) throw new Error("Invalid TiDB CHECK definition");
    checks.push({ name: match[1].replaceAll("``", "`"), clause: ddl.slice(start, end) });
  }
  return checks;
}

function quote(value: string, delimiter: string): string {
  return `${delimiter}${value.replaceAll(delimiter, delimiter + delimiter)}${delimiter}`;
}
