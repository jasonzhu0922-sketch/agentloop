import type { MemoryCandidate, MemoryKind, MemoryPolicyDecision, MemoryRevision } from "./types.ts";
import { isMemoryApplicability } from "@zhujun/agentloop";

const SECRET_MARKERS = /(?:password|passwd|token|cookie|private\s*key|secret|密码|口令|令牌|私钥|支付密码)/iu;

export function evaluateCandidate(candidate: MemoryCandidate, now?: number): MemoryPolicyDecision {
  if (candidate.proposedApplicability !== undefined && !isMemoryApplicability(candidate.proposedApplicability)) return { kind: "reject", reason: "applicability_invalid" };
  if (candidate.proposedApplicability?.scope === "global_interaction" && (candidate.proposedKind !== "preference"
    || !["explicit_user", "user_confirmed"].includes(candidate.authority)
    || candidate.applicationTargets.some(target => !["response", "human_loop"].includes(target))
    || !candidate.sourceRefs.some(ref => ["user_message", "user_setting"].includes(ref.type)))) {
    return { kind: "reject", reason: "global_interaction_requires_explicit_interaction_preference" };
  }
  const validFrom = candidate.validFrom ?? now;
  if ([candidate.validFrom, candidate.expiresAt].some(value => value !== undefined && (!Number.isFinite(value) || value < 0))
    || candidate.expiresAt !== undefined && validFrom !== undefined && candidate.expiresAt <= validFrom) return { kind: "reject", reason: "validity_interval_invalid" };
  if (candidate.sensitivity === "secret" || SECRET_MARKERS.test(candidate.proposedContentMarkdown)
    || SECRET_MARKERS.test(JSON.stringify(candidate.proposedValue))
    || SECRET_MARKERS.test(JSON.stringify(candidate.proposedApplicability ?? {}))
    || candidate.sourceRefs.some((ref) => ref.quotedText !== undefined && SECRET_MARKERS.test(ref.quotedText))) {
    return { kind: "reject", reason: "secret_data_is_never_persisted" };
  }
  if (candidate.sensitivity === "restricted") {
    return { kind: "confirmation_required", reason: "restricted_data_requires_explicit_v1_confirmation" };
  }
  if (candidate.persistenceIntent === "inferred" || candidate.authority === "inferred") {
    return { kind: "confirmation_required", reason: "inferred_memory_cannot_be_persisted_silently" };
  }
  if (candidate.proposedKind === "preference" && candidate.proposedPreferenceEffect === undefined) {
    return { kind: "reject", reason: "preference_effect_is_required" };
  }
  if (candidate.proposedKind === "experience" && candidate.proposedExperienceMaturity === undefined) {
    return { kind: "reject", reason: "experience_maturity_is_required" };
  }
  if (candidate.proposedKind !== "preference" && candidate.proposedPreferenceEffect !== undefined) {
    return { kind: "reject", reason: "preference_effect_is_only_valid_for_preference" };
  }
  if (candidate.proposedKind !== "experience" && candidate.proposedExperienceMaturity !== undefined) {
    return { kind: "reject", reason: "experience_maturity_is_only_valid_for_experience" };
  }
  if (candidate.confidence < 0 || candidate.confidence > 1) {
    return { kind: "reject", reason: "confidence_must_be_between_zero_and_one" };
  }
  if (candidate.applicationTargets.length === 0) {
    return { kind: "reject", reason: "application_target_is_required" };
  }
  return { kind: "accept", reason: "candidate_satisfies_v1_policy" };
}

export function validateRevision(revision: MemoryRevision, kind?: MemoryKind): void {
  if (!isMemoryApplicability(revision.applicability)) throw new Error("applicability_invalid");
  if (revision.expiresAt !== undefined && revision.expiresAt <= revision.validFrom) throw new Error("validity_interval_invalid");
  if (kind === "preference" && revision.preferenceEffect === undefined) {
    throw new Error("preference_effect_is_required");
  }
  if (kind !== undefined && kind !== "preference" && revision.preferenceEffect !== undefined) {
    throw new Error("preference_effect_is_only_valid_for_preference");
  }
  if (kind === "experience" && revision.experienceMaturity === undefined) {
    throw new Error("experience_maturity_is_required");
  }
  if (kind !== undefined && kind !== "experience" && revision.experienceMaturity !== undefined) {
    throw new Error("experience_maturity_is_only_valid_for_experience");
  }
  if (revision.confidence < 0 || revision.confidence > 1) {
    throw new Error("confidence_must_be_between_zero_and_one");
  }
}
