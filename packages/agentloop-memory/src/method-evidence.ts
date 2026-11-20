import type { MemorySettlementEvidence } from "./types.ts";

type Observation = NonNullable<MemorySettlementEvidence["observations"]>[number];

/** A model view of methods, never a transcript. Original observations remain
 * local audit evidence and application-review inputs. Equivalent successful
 * actions share one method card; the route still records their actual order. */
export function settlementMethodView(evidence: MemorySettlementEvidence) {
  const cards: Array<{ -readonly [Key in keyof Observation]: Observation[Key] } & { occurrences: number; sourceIndex: number }> = [];
  const equivalent = new Map<string, number>();
  const identities = new Map<string, string>();
  const sources = new Map<number, Map<string, Observation["sourceRefs"][number]>>();
  const route: string[] = [];
  let phase = 0;
  for (const [index, observation] of (evidence.observations ?? []).entries()) {
    const details = observation.details ?? {};
    // Explicit allowlist: no tool bodies, full candidate catalogs, model
    // prompts/responses, inherited answers or arbitrary nested payloads.
    const selected = observation.kind === "decision"
      ? ["question", "rationale", "selectedOptions", "persistenceIntent", "relation", "mode", "inputMode", "userConstraints", "authority", "purpose", "purposeAuthority", "finding", "informationStatus", "nextAction", "grounding", "executionDecision", "executionObserved"]
      : ["method", "checks", "errorCodes", "resultDiagnostics", "causalVerification", "executionObserved", "purpose", "purposeAuthority", "resultProfile", "grounding", "pointer", "value", "deliveryRelation", "authority", "statementExcerpt", "excerptComplete", "inputLinkage", "reasonCode", "feedbackEffect", "relation"];
    const methodDetails = Object.fromEntries(selected.filter(key => details[key] !== undefined).map(key => [key, details[key]]));
    // stepOrder already resolves the broad objective in the supplied steps.
    // Repeating it on every call wastes context and suggests false precision.
    if (methodDetails.purposeAuthority === "plan_step") { delete methodDetails.purpose; delete methodDetails.purposeAuthority; }
    const card = { ...observation, details: methodDetails };
    // Without exact input/result identity, command-form equality cannot prove
    // equivalent acquisition. Missing evidence stays distinct, never guessed.
    const repeatable = observation.kind === "action" && observation.status === "succeeded" && typeof details.repeatIdentity === "string";
    if (!repeatable) phase++;
    const key = JSON.stringify([phase, details.repeatIdentity, card.stepOrder, card.kind, card.toolName, card.status, card.summary, methodDetails]);
    const previous = repeatable ? equivalent.get(key) : undefined;
    const position = previous ?? cards.length;
    if (previous === undefined) {
      cards.push({ ...card, id: `method_${position + 1}`, occurrences: 1, sourceIndex: index });
      if (repeatable) equivalent.set(key, position);
    } else {
      const current = cards[position]!;
      current.occurrences++;
      let refs = sources.get(position);
      if (!refs) { refs = new Map(current.sourceRefs.map(ref => [JSON.stringify(ref), ref])); sources.set(position, refs); }
      for (const ref of card.sourceRefs) refs.set(JSON.stringify(ref), ref);
    }
    identities.set(observation.id, cards[position]!.id);
    route.push(cards[position]!.id);
  }
  for (const [index, card] of cards.entries()) {
    if (sources.has(index)) card.sourceRefs = [...sources.get(index)!.values()];
    if (card.relatedObservationIds) card.relatedObservationIds = [...new Set(card.relatedObservationIds.flatMap(id => identities.has(id) ? [identities.get(id)!] : []))];
  }
  return {
    observations: cards,
    executionPath: compactRoute(route),
    methodCoverage: { originalObservations: evidence.observations?.length ?? 0, methodCards: cards.length,
      repeatedActions: cards.reduce((sum, card) => sum + card.occurrences - 1, 0) },
  };
}

/** Fold repeated acquisition cycles without confusing repeats with separate
 * successful executions. Unrepeated transitions retain their exact order. */
function compactRoute(route: readonly string[]) {
  const segments: Array<{ methods: string[]; repetitions: number }> = [];
  for (let index = 0; index < route.length;) {
    let width = 1, repetitions = 1, saving = 0;
    for (let size = 1; size <= Math.min(12, Math.floor((route.length - index) / 2)); size++) {
      let count = 1;
      while (index + (count + 1) * size <= route.length
        && route.slice(index, index + size).every((id, offset) => id === route[index + count * size + offset])) count++;
      if ((count - 1) * size > saving) { width = size; repetitions = count; saving = (count - 1) * size; }
    }
    const methods = route.slice(index, index + width);
    if (repetitions === 1 && segments.at(-1)?.repetitions === 1) segments.at(-1)!.methods.push(...methods);
    else segments.push({ methods, repetitions });
    index += width * repetitions;
  }
  return segments;
}
