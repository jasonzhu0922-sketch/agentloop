---
name: research
description: Research an open-ended question using relevant available sources, assess evidence and uncertainty, and synthesize a traceable answer. Use for investigations, landscape reviews, comparisons, and fact-finding that require finding or assessing source material.
---

# Research

Answer the user's question within the scope and depth requested. Use supplied material and authorized sources appropriate to the question; do not assume that public web access, a particular provider, or any specific execution tool is available or required. When the request also asks for a document, presentation, dashboard, or other artifact, treat research as an upstream content and evidence stage: hand off a structured evidence brief, source references, caveats, and content outline to the artifact-producing Skill, which owns the final artifact.

## Capability needs

Depending on the task, research may need capabilities to discover relevant sources, read their actual content, navigate longer documents, and retain source references or passages. Select available capabilities appropriate to the source and task. Supplied documents, structured data, repositories, authorized internal sources, and public sources can each be relevant. Do not claim access or successful retrieval when it did not occur. If a necessary capability or authorization is unavailable, work with the accessible evidence and state the resulting limitation.

## Research process

1. Identify the user's decision or question, relevant time scope, source constraints, and the important claims that must be answered. Scale the investigation to the request; a simple question need not become an exhaustive review.
2. Identify which claims are already supported by supplied material and which need more evidence. For each material gap, choose sources and discovery queries likely to resolve it. Use exact entities, aliases, relationships, dates, and source context where useful; vary the approach when results do not address the gap.
3. Read the relevant source content before treating it as support. Search snippets, titles, metadata, and references are leads, not proof of the underlying claim. Prioritize sources with direct knowledge and appropriate authority, relevance, and recency; do not assume an official source is authoritative on every question.
4. Keep a working record of each important claim, its supporting passage and source location, date or time scope, and any material gaps or conflicts. Check whether apparently independent sources share an underlying source. When sources disagree, consider their context and dates, seek additional evidence if it can resolve a consequential conflict, and retain unresolved disagreement.
5. Continue when a consequential missing fact, conflict, freshness requirement, or user-requested verification has a plausible path to resolution within the available budget. Avoid repeated equivalent searches or reads with no expected material gain. Respect execution limits and access restrictions; never imply that a budget can be extended or a restricted source accessed without authorization.

## Workflow boundaries

Match the workflow to the task rather than forcing every question through the same number of stages. A simple, bounded question may be answered in one pass. For a larger investigation, keep source acquisition, evidence interpretation, and user-facing synthesis conceptually separate when that separation protects evidence quality, output limits, or a downstream handoff. These are responsibilities, not required Plan step names.

When source evidence will be reused by another part of the task, finish the evidence work as a structured handoff before writing the final delivery. Preserve the claims, source locations, time scope, coverage, conflicts, caveats, and unresolved gaps that the next stage needs. Treat that handoff as the authoritative input for later synthesis; do not replace it with a prose summary or a model recollection.

After the evidence obligations are met, stop searching and synthesize from the retained evidence. Reopen source acquisition only for a material unresolved gap, conflict, freshness requirement, or explicit user constraint. Do not keep alternating between retrieval and long-form writing without a concrete evidence reason, and do not create a multi-stage workflow merely to make the task appear structured.

## Handoff to an artifact workflow

For a downstream artifact, make the handoff explicit. Include the researched claims, supporting passages or source locations, terminology and definitions, unresolved questions, audience assumptions, and a proposed content structure. Keep source-backed statements separate from recommendations about emphasis or presentation. Do not create or alter the artifact unless this Skill is also explicitly the artifact owner.

If the downstream consumer is another Skill, hand off the evidence brief and let that Skill own its domain analysis or artifact production. If there is no downstream consumer, this Skill may perform the final synthesis itself, subject to the same evidence and uncertainty rules.

The user's original request authorizes the requested downstream artifact. Do not pause to ask for approval to continue to that artifact stage after completing research. If a material decision genuinely requires the user's choice, expose it through the Runtime's structured human-decision workflow and wait for its recorded response; never present a prose question such as “是否批准继续” as a substitute for that workflow. If the choice is not blocking, record it as a caveat and continue using the least-assumptive option.

## Synthesis

Give the user a direct answer supported by the available evidence. Distinguish what sources state from your own inference, and cite or identify the relevant sources close to material claims with usable locations where available. Do not convert a discovery snippet, a successful retrieval, multiple copies of one source, or a model recollection into verified evidence. Do not invent facts, quotations, links, dates, or source independence.

Explain material uncertainty, inaccessible or incomplete sources, and unresolved conflicts in proportion to their impact. If the evidence is insufficient, provide the supported partial answer, identify what remains unknown and why, and suggest a concrete next source or action when useful. Follow the user's requested format and avoid imposing a fixed report template.
