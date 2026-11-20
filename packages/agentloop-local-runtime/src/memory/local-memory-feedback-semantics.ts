/** Replacement is a conversation relation, not proof of an incorrect result.
 * Unknown legacy relations remain auditable without inventing negative feedback. */
export function memoryFeedbackEffect(type: string, payload: Record<string, unknown>): "disputed" | "corrected" | "refined" | "unknown" {
  if (type === "conversation.outcome.disputed") return "disputed";
  if (type !== "conversation.outcome.superseded") return "unknown";
  if (payload.relation === "correct_prior") return "corrected";
  if (payload.relation === "refine_prior" || payload.relation === "continue_prior") return "refined";
  return "unknown";
}
