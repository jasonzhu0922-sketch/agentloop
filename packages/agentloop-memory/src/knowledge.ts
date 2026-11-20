import { createHash } from "node:crypto";
import type { MemorySourceRef } from "./types.ts";
import { alignKnowledgeClaims, claimAt, relationFor, type KnowledgeRelation } from "./knowledge-relations.ts";

type Row = Record<string, any>;
export interface KnowledgeUnit {
  readonly id: string;
  /** Content identity can change across revisions while the knowledge ID stays stable. */
  readonly contentId?: string;
  readonly parameters?: readonly { readonly name: string; readonly description: string }[];
  readonly section: "classicPath" | "reusableKnowledge" | "failureLessons";
  readonly content: unknown;
  readonly supports: readonly { readonly runId: string; readonly executionKey: string; readonly evidenceHash?: string }[];
  readonly evidence: readonly MemorySourceRef[];
  readonly status: "candidate" | "verified";
  readonly verificationBasis?: "independent_executions" | "source_observation" | "execution_observation";
  readonly assessment?: {
    readonly status: "supported" | "tentative" | "contradicted";
    readonly rationale: string;
    readonly limitations: readonly string[];
    readonly evidence: readonly MemorySourceRef[];
    readonly supports: KnowledgeUnit["supports"];
  };
}
function normalized(value: any): any {
  return Array.isArray(value) ? value.map(normalized) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).filter(key => !["evidenceRefs", "evidenceAssessment"].includes(key)).sort().map(key => [key, normalized(value[key])])) : value;
}
function unitId(section: string, content: unknown, learning: Row): string {
  if (section === "reusableKnowledge" && (content as Row).standalone === true) {
    return `knowledge_${createHash("sha256").update(JSON.stringify(normalized({ section, content, parameters: knowledgeParameters(content, learning) }))).digest("hex").slice(0, 24)}`;
  }
  return `knowledge_${createHash("sha256").update(JSON.stringify(normalized({ section, content, parameters: learning.reuse?.parameters, appliesTo: learning.appliesTo, exclusions: learning.exclusions }))).digest("hex").slice(0, 24)}`;
}

/** Unrelated task inputs cannot change a standalone claim's identity. */
export function knowledgeParameters(content: unknown, learning: Row): Array<{ name: string; description: string }> {
  const names = new Set([...JSON.stringify(content).matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/gu)].map(match => match[1]));
  return (learning.reuse?.parameters ?? []).filter((parameter: Row) => names.has(parameter.name));
}

/** Support belongs to the cited claim, not to the whole group's success count.
 * Previous-group citations preserve provenance but cannot verify a new claim. */
export function accumulateKnowledge(learning: Row, sources: Record<string, readonly MemorySourceRef[]>, episodes: readonly Row[], previous: readonly KnowledgeUnit[] = [], incoming: Row = learning): KnowledgeUnit[] {
  const entries = [
    ...(learning.classicPath.length ? [{ section: "classicPath" as const, content: learning.classicPath, claimRef: "classicPath" }] : []),
    ...["reusableKnowledge", "failureLessons"].flatMap(section => learning[section].map((item: Row, index: number) => ({ section: section as "reusableKnowledge" | "failureLessons", content: item, claimRef: `${section}:${index}` }))),
  ];
  const updated: KnowledgeUnit[] = entries.map(({ section, content, claimRef }) => {
    let contentId = unitId(section, content, learning);
    const exactOld = previous.find(unit => (unit.contentId ?? unit.id) === contentId);
    const directRelation = relationFor(incoming, claimRef);
    const incomingAtPosition = claimAt(incoming, claimRef);
    const positionMatches = incomingAtPosition !== undefined && incomingAtPosition.section === section && unitId(section, incomingAtPosition.content, incoming) === contentId;
    const canonicalTarget = directRelation && directRelation.decision !== "revise" ? previous.find(unit => unit.id === directRelation.targetKnowledgeId
      && unit.section === section && JSON.stringify(normalized(unit.content)) === JSON.stringify(normalized(content))) : undefined;
    const relation = ((incoming.knowledgeRelations ?? []) as KnowledgeRelation[]).find(item => item.targetKnowledgeId === exactOld?.id)
      ?? (positionMatches || canonicalTarget ? directRelation : undefined);
    const old = relation ? previous.find(unit => unit.id === relation.targetKnowledgeId && unit.section === section) : exactOld;
    // A supporting paraphrase retains the original content AND parameter
    // definitions; changing their wording cannot silently create a revision.
    if (old && relation && relation.decision !== "revise") contentId = old.contentId ?? old.id;
    const id = old?.id ?? contentId;
    const incomingContent = relation ? claimAt(incoming, relation.claimRef)?.content : section === "classicPath" ? incoming.classicPath
      : incoming[section].find((item: Row) => unitId(section, item, incoming) === contentId);
    const sameClaim = !!incomingContent && (!!relation || unitId(section, incomingContent, incoming) === contentId);
    const currentRefs: string[] = sameClaim
      ? section === "classicPath" ? incomingContent.flatMap((step: Row) => step.evidenceRefs) : incomingContent.evidenceRefs : [];
    const cited = currentRefs.flatMap(ref => sources[ref] ?? []);
    const sourceObservation = section === "reusableKnowledge" && (content as Row).standalone === true && (content as Row).kind === "scoped_rule"
      && (content as Row).resourceContext?.length > 0 && (content as Row).recheckRules?.length > 0;
    const decisionCandidate = section === "reusableKnowledge" && (content as Row).standalone === true && (content as Row).kind === "decision_rule";
    const groundedRuns = new Set(currentRefs.filter(ref => !ref.startsWith("group_")).flatMap(ref => sources[ref] ?? []).filter(ref => ref.authority !== "model_interpretation"
      && ref.type === "action" && ref.pointer && ref.resultId && ref.sourceHash).map(ref => ref.runId));
    // A plan or outcome can locate a claim, but does not prove its execution.
    const observedRuns = (references: readonly string[]) => new Set(references.filter(ref => !ref.startsWith("group_")).flatMap(ref => sources[ref] ?? [])
      .filter(ref => ref.authority !== "model_interpretation" && ["action", "assessment"].includes(ref.type)).map(ref => ref.runId));
    const citedRuns = observedRuns(currentRefs);
    const completeRuns = section === "classicPath" && incomingContent
      ? [...citedRuns].filter(runId => incomingContent.every((step: Row) => observedRuns(step.evidenceRefs).has(runId))) : [...citedRuns];
    const checkedOld = revalidateKnowledge(old && relation?.decision !== "revise" ? [old] : [], episodes)[0];
    const supports = [...new Map([...(checkedOld?.supports ?? []), ...episodes.filter(episode => relation?.decision !== "contradict" && episode.independent !== false
      && (sourceObservation || decisionCandidate ? episode.outcome !== "failure" && groundedRuns.has(episode.runId)
        : episode.outcome === "verified_success" && completeRuns.includes(episode.runId))).map(episode => ({ runId: episode.runId, executionKey: episode.executionKey ?? `run:${episode.runId}`, evidenceHash: episode.evidenceHash }))]
      .map(support => [support.executionKey, support])).values()];
    const evidence = [...new Map([...(old?.evidence ?? []), ...cited].map(ref => [JSON.stringify(ref), ref])).values()];
    const verificationBasis = decisionCandidate ? "execution_observation" : sourceObservation ? "source_observation" : "independent_executions";
    const assessments = sameClaim ? section === "classicPath" ? incomingContent.map((step: Row) => step.evidenceAssessment) : [incomingContent.evidenceAssessment] : [];
    const completeAssessment = assessments.length > 0 && assessments.every((item: Row) => item && ["supported", "tentative", "contradicted"].includes(item.status)
      && typeof item.rationale === "string" && item.rationale.trim() && Array.isArray(item.limitations) && item.evidenceRefs?.length
      && item.evidenceRefs.every((ref: string) => currentRefs.includes(ref) && Object.hasOwn(sources, ref)));
    const assessment: KnowledgeUnit["assessment"] = completeAssessment ? {
      status: assessments.some((item: Row) => item.status === "contradicted") ? "contradicted" : assessments.every((item: Row) => item.status === "supported") ? "supported" : "tentative",
      rationale: assessments.map((item: Row) => item.rationale).join("; ").slice(0, 600),
      limitations: [...new Set<string>(assessments.flatMap((item: Row) => item.limitations))].slice(0, 12),
      evidence: [...new Map<string, MemorySourceRef>(assessments.flatMap((item: Row) => item.evidenceRefs.flatMap((ref: string) => sources[ref] ?? []))
        .map((ref: MemorySourceRef) => [JSON.stringify(ref), ref])).values()], supports,
    } : sameClaim ? undefined : checkedOld?.assessment;
    const effectiveAssessment = relation?.decision === "contradict" && assessment ? { ...assessment, status: "contradicted" as const } : assessment;
    return { id, contentId, section, content: normalized(content),
      ...(section === "reusableKnowledge" && (content as Row).standalone === true ? { parameters: old?.parameters && relation?.decision !== "revise" ? old.parameters : knowledgeParameters(content, learning) } : {}),
      supports, evidence, verificationBasis, ...(effectiveAssessment ? { assessment: effectiveAssessment } : {}),
      // Observing failures supports considering a decision, not its correctness
      // or efficiency. Repetition alone never promotes it to a verified method.
      status: relation?.decision !== "contradict" && !decisionCandidate && (effectiveAssessment?.status === "supported" || !sameClaim && checkedOld?.status === "verified") && supports.length >= (sourceObservation ? 1 : 2)
        && (section !== "failureLessons" || (content as Row).causeStatus === "confirmed") ? "verified" : "candidate" };
  });
  const replaced = new Set([...(incoming.knowledgeRelations ?? []).map((relation: KnowledgeRelation) => relation.targetKnowledgeId), ...updated.map(unit => unit.id)]);
  // Independent claims are not a transcript that the model must rewrite on
  // each refinement. Keep their own definition, parameters and validation;
  // omitted group-scoped content cannot inherit a different parent scope.
  const retained = previous.filter(unit => unit.section === "reusableKnowledge" && (unit.content as Row).standalone === true && !replaced.has(unit.id)
    && (unit.parameters !== undefined || !/\{\{/u.test(JSON.stringify(unit.content))));
  // Reinforcing the canonical group must not discard newly extracted
  // independent claims. They keep their own scope/parameters and can also be
  // addressed later when not present in the group's canonical text.
  let additional: KnowledgeUnit[] = [];
  if (learning !== incoming && incoming.reusableKnowledge.some((item: Row) => item.standalone === true)) {
    const positions = incoming.reusableKnowledge.flatMap((item: Row, index: number) => item.standalone === true ? [index] : []);
    const independent = { ...incoming, classicPath: [], failureLessons: [], reusableKnowledge: positions.map(index => incoming.reusableKnowledge[index]),
      knowledgeRelations: (incoming.knowledgeRelations ?? []).flatMap((relation: KnowledgeRelation) => {
        const match = /^reusableKnowledge:(\d+)$/u.exec(relation.claimRef), index = match ? positions.indexOf(Number(match[1])) : -1;
        return index < 0 ? [] : [{ ...relation, claimRef: `reusableKnowledge:${index}` }];
      }) };
    const aligned = alignKnowledgeClaims(independent, previous);
    additional = accumulateKnowledge(aligned, sources, episodes, previous, aligned);
  }
  return [...new Map([...revalidateKnowledge(retained, episodes), ...additional, ...updated].map(unit => [unit.id, unit])).values()];
}

export function verifiedLearning(learning: Row, units: readonly KnowledgeUnit[]): Row {
  const verified = (section: KnowledgeUnit["section"]) => units.filter(unit => unit.section === section && unit.status === "verified");
  return { ...learning,
    cautions: [...new Set([...(learning.cautions ?? []), ...units.filter(unit => unit.status === "verified").flatMap(unit => unit.assessment?.limitations ?? [])])],
    classicPath: verified("classicPath").length ? learning.classicPath : [],
    reusableKnowledge: learning.reusableKnowledge.filter((content: Row) => verified("reusableKnowledge").some(unit => (unit.contentId ?? unit.id) === unitId("reusableKnowledge", content, learning))),
    failureLessons: learning.failureLessons.filter((content: Row) => verified("failureLessons").some(unit => (unit.contentId ?? unit.id) === unitId("failureLessons", content, learning))),
  };
}

/** Bind IDs to published content, without projecting evidence ledgers or
 * duplicating the method text. Candidate knowledge never gets a binding. */
export function projectedKnowledgeBindings(value: Readonly<Record<string, unknown>>) {
  const learning = value.taskGroup as Row | undefined;
  const units = value.knowledgeUnits as readonly KnowledgeUnit[] | undefined;
  if (!learning || !Array.isArray(units)) return [];
  const published = verifiedLearning(learning, units);
  return units.filter(unit => unit.status === "verified").flatMap(unit => {
    if (unit.section === "classicPath") return published.classicPath.length
      ? [{ knowledgeId: unit.id, section: unit.section }] : [];
    const index = published[unit.section].findIndex((content: Row) => unitId(unit.section, content, learning) === (unit.contentId ?? unit.id));
    return index < 0 ? [] : [{ knowledgeId: unit.id, section: unit.section, index }];
  });
}

/** Canonical corrections retract support even when the model learns nothing new. */
export function revalidateKnowledge(units: readonly KnowledgeUnit[], episodes: readonly Row[]): KnowledgeUnit[] {
  return units.map(unit => {
    const supports = unit.supports.filter(support => !episodes.some(episode => episode.runId === support.runId
      && ((["source_observation", "execution_observation"].includes(unit.verificationBasis ?? "") ? episode.outcome === "failure" : episode.outcome !== "verified_success") || episode.independent === false || episode.evidenceHash !== undefined && support.evidenceHash !== episode.evidenceHash)));
    const assessmentCurrent = unit.assessment ? unit.assessment.status === "supported" && unit.assessment.supports.every(reviewed =>
      supports.some(support => support.executionKey === reviewed.executionKey && support.evidenceHash === reviewed.evidenceHash)) : unit.status === "verified";
    return { ...unit, supports, status: assessmentCurrent && unit.verificationBasis !== "execution_observation" && supports.length >= (unit.verificationBasis === "source_observation" ? 1 : 2)
      && (unit.section !== "failureLessons" || (unit.content as Row).causeStatus === "confirmed") ? "verified" : "candidate" };
  });
}

/** Tentative decision advice can be considered only through an explicitly
 * labelled card with exact resources and a current execution observation. */
export function isDecisionCandidate(unit: KnowledgeUnit): boolean {
  const content = unit.content as Row;
  return unit.section === "reusableKnowledge" && unit.status === "candidate" && unit.verificationBasis === "execution_observation"
    && unit.assessment?.status !== "contradicted"
    && unit.supports.length > 0 && content.kind === "decision_rule" && content.standalone === true
    && content.resourceContext?.length > 0 && content.conditions?.length > 0 && content.exclusions?.length > 0
    && content.recheckRules?.length > 0 && ["stop", "retry", "change_path"].includes(content.decisionPolicy?.action)
    && content.decisionPolicy?.alternatives?.length > 0 && content.decisionPolicy?.resumeWhen?.length > 0;
}
