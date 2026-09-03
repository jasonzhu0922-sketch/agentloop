import type { PlanTemplate, TemplateReliability } from "../types.ts";

export function shouldRetireTemplate(template: PlanTemplate): boolean {
  const reliability: TemplateReliability = template.reliability;
  return reliability.planAdmissionFailureRate > 0.15 || reliability.assessmentFailureRate > 0.2;
}
