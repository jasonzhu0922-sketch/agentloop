import { readSkillExecutionManifest, type PrivateSkill, type SqlConnection, type ToolExecutionPlugin } from "@zhujun/agentloop";
import { createHash } from "node:crypto";
import { posix } from "node:path";

type RunEventRow = { type: string; payload_json: string };
const evidenceActions = new Set(["catalog", "retrieve-knowledge", "search-tables", "get-query-context",
  "search-metrics", "get-metrics", "search-columns", "get-columns", "resolve-entity", "probe"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function json(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return record(value);
  try { return record(JSON.parse(value)); } catch { return undefined; }
}
function actionOf(value: unknown): string | undefined {
  const args = json(value);
  return Array.isArray(args?.args) && args.args[0] === "scripts/data_client.py" && typeof args.args[1] === "string"
    ? args.args[1] : undefined;
}
function diagnosticOf(value: unknown): Record<string, unknown> | undefined {
  const command = json(value);
  const receipt = json(command?.stdout);
  const content = record(receipt?.content);
  return record(receipt?.diagnostic) ?? record(record(content?.error)?.diagnostic)
    ?? record(content?.diagnostic);
}
function evidenceFingerprint(value: unknown): string | undefined {
  const command = json(value);
  const receipt = json(command?.stdout);
  if (!receipt || typeof receipt.status === "string" && receipt.status !== "completed") return undefined;
  const content = record(receipt.content);
  // Query IDs and output paths are request artifacts, not new business facts.
  // Large metadata responses are stored as files; their stable content hash
  // distinguishes new directory facts from a repeated output-path change.
  if (!content) return typeof receipt.sha256 === "string" && /^[a-f0-9]{64}$/.test(receipt.sha256)
    ? receipt.sha256 : undefined;
  const facts = structuredClone(content);
  for (const key of ["query_id", "duration_ms", "request_id", "path"]) delete facts[key];
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}

/** At most two same-cause corrections, six total rejects since real progress. */
export function gateRepairDecision(rows: readonly RunEventRow[]): { decision: "allow" } | { decision: "deny"; reason: string } {
  const actions = new Map<string, string>();
  const seenEvidence = new Set<string>();
  const failures: string[] = [];
  for (const row of rows) {
    const data = json(row.payload_json);
    if (!data) continue;
    if (row.type === "assistant.tool_call.committed" && typeof data.toolCallId === "string") {
      actions.set(data.toolCallId, actionOf(data.arguments) ?? "");
      continue;
    }
    if (row.type === "human_loop.answered") { failures.length = 0; continue; }
    if (row.type !== "tool.completed" || typeof data.toolCallId !== "string"
        || data.toolName !== "computer_run_command") continue;
    const action = actions.get(data.toolCallId);
    if (action === "execute") {
      const diagnostic = diagnosticOf(data.result);
      if (diagnostic?.origin === "query_gateway" && diagnostic.sql_executed === false
          && typeof diagnostic.code === "string" && typeof diagnostic.field === "string") {
        failures.push(JSON.stringify([diagnostic.code, diagnostic.field, diagnostic.expected, diagnostic.actual]));
      } else if (json(json(data.result)?.stdout)?.status === "completed") failures.length = 0;
    } else if (action && evidenceActions.has(action)) {
      const fingerprint = evidenceFingerprint(data.result);
      if (fingerprint && !seenEvidence.has(fingerprint)) {
        seenEvidence.add(fingerprint);
        failures.length = 0;
      }
    }
  }
  if (failures.length >= 6) return { decision: "deny", reason: "本 Run 的计划校验已连续拒绝六次；停止正式取数，说明具体阻断。" };
  const counts = new Map<string, number>();
  for (const failure of failures) counts.set(failure, (counts.get(failure) ?? 0) + 1);
  if ([...counts.values()].some(count => count >= 3)) return { decision: "deny", reason: "同一计划错误已三次拒绝且无新证据；停止重试并说明具体失败条件。" };
  return { decision: "allow" };
}

/** Host-authorized command scope follows the fixed package's execution manifest. */
export async function fixedSkillExecutionPolicy(skill: PrivateSkill, database?: SqlConnection, mode: "legacy" | "enforce" = "legacy"): Promise<ToolExecutionPlugin> {
  if (!skill.package) throw new Error("The fixed data Skill must be a package");
  const entries = await readSkillExecutionManifest(skill.package.root);
  const root = `@skills/${skill.name}`;
  return {
    id: "data-agent.fixed-skill", version: "1",
    async evaluate({ tool, input, context }) {
      const value = input as { command?: string; args?: string[]; cwd?: string; path?: string };
      if (tool.name === "computer_run_command") {
        const allowed = value.cwd === root && entries.some(entry => entry.command === value.command && value.args?.[0] === entry.script);
        if (!allowed) return { decision: "deny", code: "FIXED_SKILL_COMMAND_REQUIRED", reason: "本应用只执行固定 Skill 声明的查询入口。" };
        if (mode === "enforce" && database && value.args?.[1] === "execute" && context?.grant?.runId) {
          const rows = await database.prepare("SELECT type, payload_json FROM run_events WHERE run_id = ? ORDER BY seq")
            .all<RunEventRow>(context.grant.runId);
          const repair = gateRepairDecision(rows);
          if (repair.decision === "deny") return { decision: "deny", code: "PLAN_REPAIR_EXHAUSTED", reason: repair.reason };
        }
        return { decision: "allow" };
      }
      if (typeof value.path === "string" && value.path.startsWith("@skills")) {
        const path = posix.normalize(value.path.replaceAll("\\", "/"));
        if (path === `${root}/SKILL.md` || path.startsWith(`${root}/references/`) || path === `${root}/agentloop.executors.json`) return { decision: "allow" };
        return { decision: "deny", code: "SKILL_PRIVATE_FILE", reason: "连接配置和程序内部文件由执行器读取，不作为模型输入。" };
      }
      return { decision: "allow" };
    },
  };
}
