import { createHash } from "node:crypto";
import type { MemorySourceRef } from "./types.ts";

type Row = Record<string, any>;
export interface KnowledgeUnit {
  readonly id: string;
  readonly section: "classicPath" | "reusableKnowledge" | "failureLessons";
  readonly content: unknown;
  readonly supports: readonly { readonly runId: string; readonly executionKey: string; readonly evidenceHash?: string }[];
  readonly evidence: readonly MemorySourceRef[];
  readonly status: "candidate" | "verified";
}
function normalized(value: any): any {
  return Array.isArray(value) ? value.map(normalized) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).filter(key => key !== "evidenceRefs").sort().map(key => [key, normalized(value[key])])) : value;
}
function unitId(section: string, content: unknown, learning: Row): string {
  return `knowledge_${createHash("sha256").update(JSON.stringify(normalized({ section, content, parameters: learning.reuse?.parameters, appliesTo: learning.appliesTo, exclusions: learning.exclusions }))).digest("hex").slice(0, 24)}`;
}

/** Support belongs to the cited claim, not to the whole group's success count.
 * Previous-group citations preserve provenance but cannot verify a new claim. */
export function accumulateKnowledge(learning: Row, sources: Record<string, readonly MemorySourceRef[]>, episodes: readonly Row[], previous: readonly KnowledgeUnit[] = [], incoming: Row = learning): KnowledgeUnit[] {
  const entries = [
    ...(learning.classicPath.length ? [{ section: "classicPath" as const, content: learning.classicPath }] : []),
    ...["reusableKnowledge", "failureLessons"].flatMap(section => learning[section].map((item: Row) => ({ section: section as "reusableKnowledge" | "failureLessons", content: item }))),
  ];
  return entries.map(({ section, content }) => {
    const id = unitId(section, content, learning);
    const old = previous.find(unit => unit.id === id);
    const incomingContent = section === "classicPath" ? incoming.classicPath
      : incoming[section].find((item: Row) => unitId(section, item, incoming) === id);
    const currentRefs: string[] = incomingContent && unitId(section, incomingContent, incoming) === id
      ? section === "classicPath" ? incomingContent.flatMap((step: Row) => step.evidenceRefs) : incomingContent.evidenceRefs : [];
    const cited = currentRefs.flatMap(ref => sources[ref] ?? []);
    // A plan or outcome can locate a claim, but does not prove its execution.
    const observedRuns = (references: readonly string[]) => new Set(references.filter(ref => !ref.startsWith("group_")).flatMap(ref => sources[ref] ?? [])
      .filter(ref => ["action", "assessment"].includes(ref.type)).map(ref => ref.runId));
    const citedRuns = observedRuns(currentRefs);
    const completeRuns = section === "classicPath" && incomingContent
      ? [...citedRuns].filter(runId => incomingContent.every((step: Row) => observedRuns(step.evidenceRefs).has(runId))) : [...citedRuns];
    const checkedOld = revalidateKnowledge(old ? [old] : [], episodes)[0];
    const supports = [...new Map([...(checkedOld?.supports ?? []), ...episodes.filter(episode => episode.outcome === "verified_success"
      && episode.independent !== false && completeRuns.includes(episode.runId)).map(episode => ({ runId: episode.runId, executionKey: episode.executionKey ?? `run:${episode.runId}`, evidenceHash: episode.evidenceHash }))]
      .map(support => [support.executionKey, support])).values()];
    const evidence = [...new Map([...(old?.evidence ?? []), ...cited].map(ref => [JSON.stringify(ref), ref])).values()];
    return { id, section, content: normalized(content), supports, evidence,
      status: supports.length >= 2 && (section !== "failureLessons" || (content as Row).causeStatus === "confirmed") ? "verified" : "candidate" };
  });
}

export function verifiedLearning(learning: Row, units: readonly KnowledgeUnit[]): Row {
  const verified = (section: KnowledgeUnit["section"]) => units.filter(unit => unit.section === section && unit.status === "verified");
  return { ...learning,
    classicPath: verified("classicPath").length ? learning.classicPath : [],
    reusableKnowledge: learning.reusableKnowledge.filter((content: Row) => verified("reusableKnowledge").some(unit => unit.id === unitId("reusableKnowledge", content, learning))),
    failureLessons: learning.failureLessons.filter((content: Row) => verified("failureLessons").some(unit => unit.id === unitId("failureLessons", content, learning))),
  };
}

/** Canonical corrections retract support even when the model learns nothing new. */
export function revalidateKnowledge(units: readonly KnowledgeUnit[], episodes: readonly Row[]): KnowledgeUnit[] {
  return units.map(unit => {
    const supports = unit.supports.filter(support => !episodes.some(episode => episode.runId === support.runId
      && (episode.outcome !== "verified_success" || episode.independent === false || episode.evidenceHash !== undefined && support.evidenceHash !== episode.evidenceHash)));
    return { ...unit, supports, status: supports.length >= 2
      && (unit.section !== "failureLessons" || (unit.content as Row).causeStatus === "confirmed") ? "verified" : "candidate" };
  });
}
