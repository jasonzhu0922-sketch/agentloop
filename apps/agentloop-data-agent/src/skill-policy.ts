import { readSkillExecutionManifest, type PrivateSkill, type SqlConnection, type ToolExecutionPlugin } from "@zhujun/agentloop";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { resolve, sep } from "node:path";

type RunEventRow = { type: string; payload_json: string };
type QuestionAssessment = { status: "conflict" | "matched_limited" | "unproven"; months: string[]; missing: string[] };

function literalMonths(question: string): string[] {
  const chinese: Record<string, number> = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6,
    "七": 7, "八": 8, "九": 9, "十": 10, "十一": 11, "十二": 12 };
  return [...question.matchAll(/(?<!\d)(20\d{2})\s*年\s*(1[0-2]|0?[1-9]|十[一二]?|[一二三四五六七八九])\s*月/gu)]
    .map(match => { const raw = match[2]!; const month = /^\d+$/u.test(raw) ? Number(raw) : chinese[raw];
      return month ? `${match[1]}-${String(month).padStart(2, "0")}-01` : ""; }).filter(Boolean);
}

/**
 * 从宿主保存的 Run 原题独立核对明确月份。冲突可以证明计划漏掉了该月份；
 * matched_limited 仅表示这一项吻合，绝不代表主体、指标或答案也已验证。
 */
export function assessOriginalQuestion(question: string, plan: unknown): QuestionAssessment {
  const intent = record(record(plan)?.business_intent);
  const range = record(intent?.time_range);
  const months = literalMonths(question);
  // 多个月份可以由多个各自完整绑定的查询分别交付；仅凭当前单个计划
  // 无法判断整道题是否覆盖，故保持 unproven，避免新增错误硬拒绝。
  if (months.length !== 1) return { status: "unproven", months, missing: [] };
  const start = typeof range?.start === "string" ? range.start : "";
  const end = typeof range?.end === "string" ? range.end : "";
  const missing = months.filter(month => !start || !end || !(start <= month && month < end));
  return { status: missing.length ? "conflict" : "matched_limited", months, missing };
}
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
function inlinePlan(argumentsValue: unknown): unknown {
  const args = record(argumentsValue)?.args;
  if (!Array.isArray(args)) return undefined;
  const index = args.indexOf("--request-json");
  if (index < 0 || typeof args[index + 1] !== "string") return undefined;
  return json(args[index + 1])?.query_plan;
}
async function submittedPlan(argumentsValue: unknown, workspaceRoot?: string): Promise<unknown> {
  const direct = inlinePlan(argumentsValue);
  if (direct !== undefined) return direct;
  const args = record(argumentsValue)?.args;
  if (!Array.isArray(args) || !workspaceRoot) return undefined;
  const index = args.indexOf("--query-plan");
  const alias = args[index + 1];
  if (index < 0 || typeof alias !== "string" || !alias.startsWith("@workspace/")) return undefined;
  const root = resolve(workspaceRoot);
  const path = resolve(root, alias.slice("@workspace/".length));
  // 模型可提交工作区计划文件，但仅允许读取当前 Run 工作区内的路径；
  // 越界或不可读时不从其他位置推断计划，交由原有 Gateway 输入校验处理。
  if (!path.startsWith(root + sep)) return undefined;
  try {
    const plan = json(await readFile(path, "utf8"));
    return plan?.schema === "nl2sql.entity-resolution/v1" ? plan.query_plan : plan;
  } catch { return undefined; }
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
  // query_id 与输出路径只是请求产物，不算新增业务证据。大结果只返回文件
  // 回执时使用内容哈希；这样换一个输出文件名不会重置拒绝预算。
  if (!content) return typeof receipt.sha256 === "string" && /^[a-f0-9]{64}$/.test(receipt.sha256)
    ? receipt.sha256 : undefined;
  const facts = structuredClone(content);
  for (const key of ["query_id", "duration_ms", "request_id", "path"]) delete facts[key];
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}

/** 有实质新证据前，同根因最多修复两次，累计拒绝达到六次即停止正式查询。 */
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
        // 同一诊断字段的期望绑定未改变时，换 SQL 文本或 actual 表述不算进展。
        // 指纹仅保留错误码、字段与期望值，防止靠反复改写请求耗尽整个 Run。
        failures.push(JSON.stringify([diagnostic.code, diagnostic.field, diagnostic.expected]));
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

/** 固定 Skill 的命令授权以包内执行清单为准，两个模式共用只读入口边界。 */
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
        if (database && value.args?.[1] === "execute" && context?.grant?.runId) {
          // 只在确实取得计划时核对宿主原题。legacy 保留诊断能力但不加业务
          // 硬拒绝；enforce 也只拒绝字面月份与计划明确冲突的窄范围情况。
          const plan = await submittedPlan(value, context.grant.workspaceRoot);
          if (plan !== undefined) {
            const row = await database.prepare("SELECT input FROM runs WHERE id = ?")
              .get<{ input: string }>(context.grant.runId);
            if (!row) return { decision: "deny", code: "RUN_QUESTION_MISSING", reason: "无法读取本次 Run 原题。" };
            const submitted = record(plan);
            const assessment = assessOriginalQuestion(row.input, submitted);
            const typed = record(submitted?.business_intent);
            if (mode === "enforce" && typed && assessment.status === "conflict")
              return { decision: "deny", code: "ORIGINAL_QUESTION_CONFLICT",
                reason: `执行计划遗漏原题中的明确月份：${assessment.missing.join("、")}；请重选候选并重编计划。` };
          }
        }
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
