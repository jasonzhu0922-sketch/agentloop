import { createHash } from "node:crypto";
import type { ExecutionPlan } from "../planning/contracts.ts";
import { activeLeafSteps } from "../planning/plan-utils.ts";

/** Identity churn cannot constitute progress. Hash assessed content and actual receipts. */
export function roundEvidenceFingerprints(plan: ExecutionPlan): string[] {
  const values: string[] = [];
  for (const step of activeLeafSteps(plan)) {
    const result = step.evidence?.publishedResult;
    if (result?.publication.status === "published") values.push(JSON.stringify({ kind: "assessed_result", content: result.payload.content }));
    for (const call of step.evidence?.toolCalls ?? []) {
      if (call.isError || call.toolName === "read_result") continue;
      let value: unknown = call.result;
      try { value = JSON.parse(call.result); } catch { /* Plain text is evidence too. */ }
      values.push(JSON.stringify({ kind: "tool_receipt", tool: call.toolName, value: canonical(value) }));
    }
  }
  return [...new Set(values.map(value => createHash("sha256").update(value).digest("hex")))].sort();
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]));
}
