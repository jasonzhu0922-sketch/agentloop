import { randomUUID } from "node:crypto";
import type { PlanTemplateFastPathConfig } from "../config.ts";
import type { PlanTemplate, TaskFingerprint, TemplateMatchDecision } from "../types.ts";
import { rankTemplateCandidates } from "../matching/template-retriever.ts";
import { instantiatePlanTemplate } from "./template-plan-instantiator.ts";
import type { PlanningExtensionInput } from "@zhujun/agentloop";

export function routePlanTemplate(input: {
  readonly task: PlanningExtensionInput;
  readonly fingerprint: TaskFingerprint;
  readonly templates: readonly PlanTemplate[];
  readonly config: PlanTemplateFastPathConfig;
}): TemplateMatchDecision {
  const ranked = rankTemplateCandidates({
    fingerprint: input.fingerprint,
    templates: input.templates,
    availableToolNames: input.task.availableToolNames,
    config: input.config,
  });
  const best = ranked.find((candidate) => candidate.rejectionReasons.length === 0);
  if (best === undefined) {
    return {
      kind: "rejected",
      fingerprint: input.fingerprint,
      rejectionReasons: ranked[0]?.rejectionReasons ?? ["no_template_candidate"],
      ...(ranked[0] === undefined ? {} : { template: ranked[0].template, score: ranked[0].score }),
    };
  }
  if (
    input.config.mode === "direct_use"
    && input.config.allowDirectUse
    && best.score >= input.config.minDirectUseScore
    && (!input.config.requireActiveTemplateForDirectUse || best.template.status === "active")
  ) {
    return {
      kind: "direct_use",
      fingerprint: input.fingerprint,
      template: best.template,
      score: best.score,
      proposal: instantiatePlanTemplate({
        template: best.template,
        task: input.task,
        fingerprint: input.fingerprint,
      }),
    };
  }
  if (
    (input.config.mode === "planner_context" || input.config.mode === "direct_use")
    && best.score >= input.config.minPlannerContextScore
  ) {
    return {
      kind: "planner_context",
      fingerprint: input.fingerprint,
      template: best.template,
      score: best.score,
    };
  }
  return {
    kind: "rejected",
    fingerprint: input.fingerprint,
    template: best.template,
    score: best.score,
    rejectionReasons: ["score_below_threshold"],
  };
}

export function newMatchId(): string {
  return randomUUID();
}
