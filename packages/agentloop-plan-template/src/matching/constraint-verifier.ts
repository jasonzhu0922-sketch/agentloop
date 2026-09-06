import type { PlanTemplateFastPathConfig, PlanTemplateRiskLevel } from "../config.ts";
import type { PlanTemplate, TaskFingerprint } from "../types.ts";
import { templateOperationHints } from "./template-signals.ts";

export function verifyTemplateConstraints(input: {
  readonly fingerprint: TaskFingerprint;
  readonly template: PlanTemplate;
  readonly availableToolNames: readonly string[];
  readonly config: PlanTemplateFastPathConfig;
}): readonly string[] {
  const reasons: string[] = [];
  const { fingerprint, template, config } = input;
  if (template.status !== "candidate" && template.status !== "active") reasons.push("template_status_not_usable");
  if (config.allowedIntentFamilies !== undefined && !config.allowedIntentFamilies.includes(template.intentFamily)) {
    reasons.push("intent_family_not_allowed");
  }
  if (config.disabledIntentFamilies?.includes(template.intentFamily) === true) reasons.push("intent_family_disabled");
  if (riskRank(fingerprint.riskLevel) > riskRank(config.allowedRiskCeiling)) reasons.push("task_risk_exceeds_config");
  if (riskRank(fingerprint.riskLevel) > riskRank(template.riskCeiling)) reasons.push("task_risk_exceeds_template");
  if (template.sourceNeed !== fingerprint.sourceNeed) reasons.push("source_need_mismatch");
  if (template.artifactKind !== fingerprint.artifactKind) reasons.push("artifact_kind_mismatch");
  if (template.sideEffectKind !== fingerprint.sideEffectKind) reasons.push("side_effect_mismatch");
  if (template.acceptedSourceTypes.length > 0 && fingerprint.sourceTypes.length > 0) {
    const accepted = new Set(template.acceptedSourceTypes);
    if (!fingerprint.sourceTypes.some((type) => accepted.has(type))) reasons.push("source_type_mismatch");
  }
  const templateHints = templateOperationHints(template);
  if (template.intentFamily === "research" && !fingerprint.operationHints.includes("research")) {
    reasons.push("operation_class_mismatch");
  }
  if (templateHints.includes("external_api") && !fingerprint.operationHints.includes("external_api")) {
    reasons.push("operation_class_mismatch");
  }
  for (const capability of template.requiredCapabilities) {
    if (!fingerprint.requiredCapabilities.includes(capability)) reasons.push(`capability_missing:${capability}`);
  }
  return reasons;
}

function riskRank(value: PlanTemplateRiskLevel): number {
  if (value === "low") return 0;
  if (value === "medium") return 1;
  return 2;
}
