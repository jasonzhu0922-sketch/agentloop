import type { PlanTemplate } from "../types.ts";
import { tokenizeInstructionText } from "../semantic/instruction-tokens.ts";

export function templateOperationHints(template: PlanTemplate): readonly string[] {
  const hints = new Set<string>();
  for (const step of template.planSkeleton) {
    for (const token of tokensFromOperationRef(step.operationRef)) {
      hints.add(token);
    }
    for (const hint of step.skillRoleHints) {
      if (hint.trim().length > 0) hints.add(normalizeHint(hint));
    }
    for (const capability of step.requiredCapabilities) {
      addCapabilityHint(hints, capability);
    }
  }
  for (const capability of template.requiredCapabilities) {
    addCapabilityHint(hints, capability);
  }
  return [...hints];
}

export function templateInstructionTokens(template: PlanTemplate): readonly string[] {
  const tokens = new Set<string>();
  for (const step of template.planSkeleton) {
    for (const token of tokenizeInstructionText(step.objective ?? "")) {
      tokens.add(token);
    }
    for (const token of tokenizeInstructionText(step.operationRef)) {
      tokens.add(token);
    }
  }
  if (tokens.size === 0) {
    for (const token of tokenizeInstructionText(template.intentFamily)) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

export function taskInstructionTokens(text: string): readonly string[] {
  return tokenizeInstructionText(text);
}

function tokensFromOperationRef(operationRef: string): readonly string[] {
  const rawTokens = operationRef
    .split(":")
    .map((token) => normalizeHint(token))
    .filter((token) => token.length > 0);
  const tail = rawTokens.at(-1);
  if (tail === undefined) return [];
  return tail === "produce" || tail === "fact_acquisition" || tail === "repair" || tail === "deliver"
    ? rawTokens.slice(0, 1)
    : [tail, ...rawTokens.slice(0, -1)];
}

function addCapabilityHint(hints: Set<string>, capability: string): void {
  const normalized = capability.trim().toLowerCase();
  if (normalized.length === 0) return;
  if (normalized === "web_research") hints.add("research");
  else if (normalized === "external_api") hints.add("external_api");
  else if (normalized === "browser_operation") hints.add("browser_operation");
  else hints.add(normalized);
}

function normalizeHint(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
