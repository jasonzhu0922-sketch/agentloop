import type { PlanTemplateFastPathConfig } from "../config.ts";
import type { PlanTemplate, TaskFingerprint, TemplateMatchCandidate } from "../types.ts";
import { verifyTemplateConstraints } from "./constraint-verifier.ts";
import { scoreTemplateMatch } from "./match-scorer.ts";

export function rankTemplateCandidates(input: {
  readonly fingerprint: TaskFingerprint;
  readonly templates: readonly PlanTemplate[];
  readonly availableToolNames: readonly string[];
  readonly config: PlanTemplateFastPathConfig;
}): readonly TemplateMatchCandidate[] {
  return input.templates
    .map((template) => {
      const rejectionReasons = verifyTemplateConstraints({
        fingerprint: input.fingerprint,
        template,
        availableToolNames: input.availableToolNames,
        config: input.config,
      });
      return {
        template,
        rejectionReasons,
        score: rejectionReasons.length === 0
          ? scoreTemplateMatch({ fingerprint: input.fingerprint, template })
          : 0,
      };
    })
    .sort((left, right) => right.score - left.score);
}
