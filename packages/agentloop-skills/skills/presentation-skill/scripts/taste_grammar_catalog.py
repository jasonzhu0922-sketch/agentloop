#!/usr/bin/env python3
"""Canonical composition grammars and renderer role-system contracts."""

from __future__ import annotations

import copy
import json
from collections import Counter
from typing import Any


CATALOG_VERSION = "taste_grammar_catalog_v1"
RENDERER_ROLE_SYSTEM_VERSION = "renderer_role_systems_v1"
ROLE_SYSTEMS_VERSION = RENDERER_ROLE_SYSTEM_VERSION

ROLE_NAMES = (
    "title",
    "section",
    "evidence",
    "comparison",
    "data",
    "decision",
    "references",
)
ROLE_ID_FIELDS = {role: f"{role}_system_id" for role in ROLE_NAMES}

SUPPORTED_ROLE_VARIANTS = {
    "title",
    "standard",
    "split",
    "cards-2",
    "cards-3",
    "timeline",
    "stats",
    "kpi-hero",
    "table",
    "lab-run-results",
    "comparison-2col",
    "matrix",
    "flow",
    "chart",
    "image-sidebar",
    "scientific-figure",
    "generated-image",
}


COMPOSITION_GRAMMARS: dict[str, dict[str, Any]] = {
    "consulting-answer-pyramid": {
        "lane": "answer-led",
        "description": "Lead with the answer, prove it with structured exhibits, and close on ownership.",
        "style_presets": ["data-heavy-boardroom", "arctic-minimal"],
        "prompt_keywords": ["board", "consulting", "executive", "recommendation", "strategy", "tradeoff"],
        "role_system_ids": {
            "title": "title-answer-ledger",
            "section": "section-claim-chapters",
            "evidence": "evidence-proof-stack",
            "comparison": "comparison-option-scorecard",
            "data": "data-executive-exhibit",
            "decision": "decision-owner-commitment",
            "references": "references-executive-notes",
        },
        "narrative_arc": {
            "arc_id": "answer-context-proof-action",
            "stages": ["answer", "context", "proof", "tradeoffs", "action"],
        },
        "density": {"level": "high", "distribution": "dense exhibits with short interpretive headlines"},
        "grid": {"columns": 12, "gutter": "0.22-0.28in", "anchor": "left claim rail and aligned exhibit edge"},
        "reading_path": ["headline answer", "primary exhibit", "implication and owner"],
        "preferred_role_variants": {
            "title": ["title"],
            "section": ["standard", "kpi-hero"],
            "evidence": ["chart", "table"],
            "comparison": ["comparison-2col", "matrix"],
            "data": ["chart", "table", "stats"],
            "decision": ["table", "standard"],
            "references": ["table"],
        },
        "invariant_moves": [
            "State the governing answer before supporting detail.",
            "Attach every exhibit to an explicit implication.",
            "End with a named decision, owner, or next action.",
        ],
        "forbidden_moves": [
            "Do not delay the recommendation until the final slide.",
            "Do not use decorative cards as a substitute for evidence hierarchy.",
        ],
    },
    "scientific-evidence-plate": {
        "lane": "evidence-led",
        "description": "Organize methods, figures, measurements, and limits as a traceable evidence plate.",
        "style_presets": ["lab-report", "forest-research"],
        "prompt_keywords": ["assay", "experiment", "figure", "lab", "method", "research", "results", "validation"],
        "role_system_ids": {
            "title": "title-study-plate",
            "section": "section-method-result",
            "evidence": "evidence-multipanel-plate",
            "comparison": "comparison-control-cohort",
            "data": "data-assay-readout",
            "decision": "decision-evidence-threshold",
            "references": "references-scientific-register",
        },
        "narrative_arc": {
            "arc_id": "question-method-result-limit",
            "stages": ["question", "method", "result", "interpretation", "limit", "next test"],
        },
        "density": {"level": "high", "distribution": "figure-dense center with compact methods and provenance rails"},
        "grid": {"columns": 12, "gutter": "0.18-0.24in", "anchor": "figure plate with aligned captions and readouts"},
        "reading_path": ["research question", "figure or assay plate", "interpretation", "limit and next test"],
        "preferred_role_variants": {
            "title": ["title"],
            "section": ["standard"],
            "evidence": ["scientific-figure", "image-sidebar"],
            "comparison": ["comparison-2col", "table"],
            "data": ["lab-run-results", "chart", "table"],
            "decision": ["standard", "table"],
            "references": ["table"],
        },
        "invariant_moves": [
            "Keep methods, result, and interpretation visually distinguishable.",
            "Carry units, denominators, and provenance beside the evidence.",
            "State uncertainty or limitations before the recommendation.",
        ],
        "forbidden_moves": [
            "Do not crop or decorate evidence in ways that obscure interpretation.",
            "Do not present a proxy metric as the final outcome without qualification.",
        ],
    },
    "clinical-care-pathway": {
        "lane": "pathway-led",
        "description": "Move from population and care state through evidence gates to a bounded clinical action.",
        "style_presets": ["executive-clinical"],
        "prompt_keywords": ["care", "clinical", "cohort", "diagnostic", "patient", "pathway", "safety", "treatment"],
        "role_system_ids": {
            "title": "title-clinical-status",
            "section": "section-care-stage",
            "evidence": "evidence-clinical-cohort",
            "comparison": "comparison-care-options",
            "data": "data-clinical-outcomes",
            "decision": "decision-care-gate",
            "references": "references-clinical-evidence",
        },
        "narrative_arc": {
            "arc_id": "population-state-evidence-care-action",
            "stages": ["population", "current state", "evidence gate", "care options", "action", "monitoring"],
        },
        "density": {"level": "medium-high", "distribution": "stage bands with one dominant clinical evidence object"},
        "grid": {"columns": 12, "gutter": "0.22-0.28in", "anchor": "care-stage rail and outcome field"},
        "reading_path": ["patient or cohort state", "evidence gate", "care decision", "monitoring implication"],
        "preferred_role_variants": {
            "title": ["title"],
            "section": ["standard", "flow"],
            "evidence": ["scientific-figure", "chart", "image-sidebar"],
            "comparison": ["comparison-2col", "table"],
            "data": ["chart", "table", "stats"],
            "decision": ["flow", "table"],
            "references": ["table"],
        },
        "invariant_moves": [
            "Identify the patient or cohort state before discussing intervention.",
            "Separate evidence threshold from care recommendation.",
            "Make safety, monitoring, and escalation explicit.",
        ],
        "forbidden_moves": [
            "Do not imply clinical certainty beyond the cited evidence.",
            "Do not hide contraindications or unresolved safety signals.",
        ],
    },
    "editorial-spread": {
        "lane": "narrative-led",
        "description": "Use editorial pacing, strong hierarchy, and selective evidence to build a readable argument.",
        "style_presets": ["editorial-minimal", "paper-journal"],
        "prompt_keywords": ["article", "editorial", "essay", "feature", "journal", "narrative", "public", "story"],
        "role_system_ids": {
            "title": "title-editorial-masthead",
            "section": "section-editorial-folio",
            "evidence": "evidence-captioned-feature",
            "comparison": "comparison-editorial-columns",
            "data": "data-annotated-graphic",
            "decision": "decision-editorial-takeaway",
            "references": "references-editorial-notes",
        },
        "narrative_arc": {
            "arc_id": "premise-scene-evidence-turn-close",
            "stages": ["premise", "scene", "evidence", "turn", "implication", "close"],
        },
        "density": {"level": "medium", "distribution": "alternating open spreads and evidence-rich features"},
        "grid": {"columns": 10, "gutter": "0.24-0.32in", "anchor": "masthead baseline and asymmetric feature column"},
        "reading_path": ["editorial headline", "feature object", "caption or annotation", "closing implication"],
        "preferred_role_variants": {
            "title": ["title"],
            "section": ["standard", "generated-image"],
            "evidence": ["image-sidebar", "generated-image", "scientific-figure"],
            "comparison": ["split", "comparison-2col"],
            "data": ["chart", "table"],
            "decision": ["standard"],
            "references": ["table"],
        },
        "invariant_moves": [
            "Alternate open narrative space with denser proof moments.",
            "Use captions and annotations to connect visuals to the argument.",
            "Keep one clear editorial turn per section.",
        ],
        "forbidden_moves": [
            "Do not repeat the same card grid across consecutive slides.",
            "Do not use decorative imagery without an explanatory role.",
        ],
    },
    "investor-thesis-stage": {
        "lane": "thesis-led",
        "description": "Stage the market thesis, proof, economics, risk, and ask as a cumulative investment case.",
        "style_presets": ["sunset-investor", "bold-startup-narrative"],
        "prompt_keywords": ["ask", "fundraising", "growth", "investor", "market", "pitch", "revenue", "startup"],
        "role_system_ids": {
            "title": "title-investor-thesis",
            "section": "section-thesis-stage",
            "evidence": "evidence-market-proof",
            "comparison": "comparison-market-position",
            "data": "data-unit-economics",
            "decision": "decision-investment-ask",
            "references": "references-investor-diligence",
        },
        "narrative_arc": {
            "arc_id": "problem-window-proof-economics-ask",
            "stages": ["problem", "market window", "solution", "proof", "economics", "risk", "ask"],
        },
        "density": {"level": "medium", "distribution": "high-contrast thesis stages punctuated by dense proof slides"},
        "grid": {"columns": 12, "gutter": "0.24-0.30in", "anchor": "thesis field with proof and downside rails"},
        "reading_path": ["thesis", "proof signal", "economic implication", "risk", "ask"],
        "preferred_role_variants": {
            "title": ["title"],
            "section": ["kpi-hero", "standard"],
            "evidence": ["stats", "chart", "generated-image"],
            "comparison": ["comparison-2col", "matrix"],
            "data": ["chart", "stats", "table"],
            "decision": ["kpi-hero", "standard"],
            "references": ["table"],
        },
        "invariant_moves": [
            "Tie each proof point to the investment thesis.",
            "Show the economic mechanism, not only market size.",
            "State the ask, milestone, and principal downside clearly.",
        ],
        "forbidden_moves": [
            "Do not substitute vanity metrics for durable proof.",
            "Do not present upside without a bounded risk or assumption.",
        ],
    },
    "operations-grid": {
        "lane": "state-led",
        "description": "Expose operating state, variance, dependencies, owners, and the next control action.",
        "style_presets": ["lavender-ops", "charcoal-safety"],
        "prompt_keywords": ["incident", "operations", "owner", "process", "risk", "safety", "status", "workflow"],
        "role_system_ids": {
            "title": "title-operations-state",
            "section": "section-operating-cycle",
            "evidence": "evidence-operations-signal",
            "comparison": "comparison-plan-actual",
            "data": "data-operations-grid",
            "decision": "decision-control-action",
            "references": "references-operations-log",
        },
        "narrative_arc": {
            "arc_id": "state-variance-cause-control-owner",
            "stages": ["state", "variance", "cause", "control", "owner", "follow-up"],
        },
        "density": {"level": "high", "distribution": "stable operating grid with bounded exception emphasis"},
        "grid": {"columns": 12, "gutter": "0.18-0.24in", "anchor": "status index, variance field, and owner column"},
        "reading_path": ["operating state", "exception or variance", "root cause", "control and owner"],
        "preferred_role_variants": {
            "title": ["title"],
            "section": ["stats", "standard"],
            "evidence": ["chart", "flow", "table"],
            "comparison": ["comparison-2col", "table"],
            "data": ["stats", "table", "chart"],
            "decision": ["table", "flow"],
            "references": ["table"],
        },
        "invariant_moves": [
            "Separate baseline state from exceptions and escalation.",
            "Connect every variance to a cause, control, or owner.",
            "Keep repeated operational coordinates stable across slides.",
        ],
        "forbidden_moves": [
            "Do not use color as the only status encoding.",
            "Do not hide unresolved exceptions inside aggregate metrics.",
        ],
    },
    "policy-public-docket": {
        "lane": "docket-led",
        "description": "Frame the public question, affected groups, evidence, options, implementation, and accountability.",
        "style_presets": ["warm-terracotta"],
        "prompt_keywords": ["civic", "community", "government", "implementation", "policy", "public", "stakeholder"],
        "role_system_ids": {
            "title": "title-public-question",
            "section": "section-policy-docket",
            "evidence": "evidence-public-record",
            "comparison": "comparison-policy-options",
            "data": "data-public-impact",
            "decision": "decision-policy-recommendation",
            "references": "references-public-docket",
        },
        "narrative_arc": {
            "arc_id": "public-question-impact-options-implementation",
            "stages": ["public question", "affected groups", "evidence", "options", "recommendation", "implementation", "accountability"],
        },
        "density": {"level": "medium-high", "distribution": "open public framing followed by evidence and option registers"},
        "grid": {"columns": 12, "gutter": "0.24-0.30in", "anchor": "question header with stakeholder and evidence columns"},
        "reading_path": ["public question", "affected groups", "evidence", "options", "implementation and accountability"],
        "preferred_role_variants": {
            "title": ["title"],
            "section": ["standard", "timeline"],
            "evidence": ["image-sidebar", "chart", "table"],
            "comparison": ["matrix", "comparison-2col"],
            "data": ["chart", "table"],
            "decision": ["table", "timeline"],
            "references": ["table"],
        },
        "invariant_moves": [
            "Name affected groups before comparing policy options.",
            "Separate evidence, value judgments, and implementation assumptions.",
            "Close with accountability, timing, and measurable public outcomes.",
        ],
        "forbidden_moves": [
            "Do not collapse stakeholder impacts into one aggregate score.",
            "Do not state implementation certainty without owners and constraints.",
        ],
    },
    "technical-telemetry-canvas": {
        "lane": "telemetry-led",
        "description": "Trace system state from architecture and signals through failure modes to remediation.",
        "style_presets": ["midnight-neon"],
        "prompt_keywords": ["architecture", "engineering", "incident", "latency", "platform", "system", "technical", "telemetry"],
        "role_system_ids": {
            "title": "title-telemetry-state",
            "section": "section-system-layer",
            "evidence": "evidence-signal-trace",
            "comparison": "comparison-architecture-tradeoff",
            "data": "data-telemetry-canvas",
            "decision": "decision-remediation-gate",
            "references": "references-technical-register",
        },
        "narrative_arc": {
            "arc_id": "system-state-signal-failure-remediation",
            "stages": ["system scope", "architecture", "signal", "failure mode", "remediation", "verification"],
        },
        "density": {"level": "high", "distribution": "signal-dense canvas with explicit diagnostic and action zones"},
        "grid": {"columns": 12, "gutter": "0.18-0.24in", "anchor": "system layer rail, telemetry field, and remediation lane"},
        "reading_path": ["system state", "signal trace", "failure mode", "remediation", "verification"],
        "preferred_role_variants": {
            "title": ["title"],
            "section": ["flow", "standard"],
            "evidence": ["flow", "chart", "image-sidebar"],
            "comparison": ["comparison-2col", "matrix"],
            "data": ["chart", "stats", "table"],
            "decision": ["flow", "table"],
            "references": ["table"],
        },
        "invariant_moves": [
            "Anchor every signal to a named system layer or component.",
            "Distinguish observation, diagnosis, remediation, and verification.",
            "Keep units, thresholds, and time windows visible.",
        ],
        "forbidden_moves": [
            "Do not present telemetry without a baseline or threshold.",
            "Do not conflate correlation with a confirmed failure cause.",
        ],
    },
}


PRESET_TO_GRAMMAR = {
    preset: grammar_id
    for grammar_id, grammar in COMPOSITION_GRAMMARS.items()
    for preset in grammar["style_presets"]
}


def _role_system_catalogs() -> dict[str, list[dict[str, str]]]:
    catalogs: dict[str, list[dict[str, str]]] = {}
    for role in ROLE_NAMES:
        seen: dict[str, dict[str, str]] = {}
        for grammar_id, grammar in COMPOSITION_GRAMMARS.items():
            system_id = str(grammar["role_system_ids"][role])
            seen[system_id] = {
                "system_id": system_id,
                "role": role,
                "composition_grammar_id": grammar_id,
                "intent": str(grammar["description"]),
            }
        catalogs[f"{role}_systems"] = list(seen.values())
    return catalogs


ROLE_SYSTEM_CATALOGS = _role_system_catalogs()


def composition_grammar(grammar_id: str) -> dict[str, Any]:
    grammar = COMPOSITION_GRAMMARS.get(str(grammar_id or "").strip())
    if grammar is None:
        raise KeyError(f"unknown composition grammar: {grammar_id!r}")
    return copy.deepcopy({"grammar_id": grammar_id, **grammar})


def grammar_for_preset(preset: str) -> dict[str, Any]:
    key = str(preset or "").strip() or "executive-clinical"
    grammar_id = PRESET_TO_GRAMMAR.get(key, PRESET_TO_GRAMMAR["executive-clinical"])
    return composition_grammar(grammar_id)


def renderer_role_systems_for_grammar(grammar_id: str, *, preset: str = "") -> dict[str, Any]:
    grammar = composition_grammar(grammar_id)
    role_ids = grammar["role_system_ids"]
    payload: dict[str, Any] = {
        "schema_version": RENDERER_ROLE_SYSTEM_VERSION,
        "catalog_version": CATALOG_VERSION,
        "composition_grammar_id": grammar_id,
        "style_preset": str(preset or "").strip() or grammar["style_presets"][0],
        "narrative_arc": grammar["narrative_arc"],
        "density": grammar["density"],
        "grid": grammar["grid"],
        "reading_path": grammar["reading_path"],
        "preferred_role_variants": grammar["preferred_role_variants"],
        "invariant_moves": grammar["invariant_moves"],
        "forbidden_moves": grammar["forbidden_moves"],
    }
    for role, field in ROLE_ID_FIELDS.items():
        payload[field] = role_ids[role]
    return copy.deepcopy(payload)


def renderer_role_systems_for_preset(preset: str) -> dict[str, Any]:
    key = str(preset or "").strip() or "executive-clinical"
    grammar_id = PRESET_TO_GRAMMAR.get(key, PRESET_TO_GRAMMAR["executive-clinical"])
    resolved_preset = key if key in PRESET_TO_GRAMMAR else "executive-clinical"
    return renderer_role_systems_for_grammar(grammar_id, preset=resolved_preset)


def build_taste_grammar_catalog() -> dict[str, Any]:
    grammars = [composition_grammar(grammar_id) for grammar_id in COMPOSITION_GRAMMARS]
    narrative_arcs = [copy.deepcopy(grammar["narrative_arc"]) for grammar in grammars]
    return {
        "catalog_version": CATALOG_VERSION,
        "renderer_role_systems_version": RENDERER_ROLE_SYSTEM_VERSION,
        "grammar_count": len(grammars),
        "preset_count": len(PRESET_TO_GRAMMAR),
        "grammars": grammars,
        "preset_to_grammar": dict(PRESET_TO_GRAMMAR),
        "role_system_catalogs": copy.deepcopy(ROLE_SYSTEM_CATALOGS),
        "narrative_arcs": narrative_arcs,
    }


def validate_renderer_role_systems_v1(
    payload: Any,
    *,
    expected_preset: str = "",
) -> list[str]:
    failures: list[str] = []
    if not isinstance(payload, dict):
        return ["must be an object"]
    if payload.get("schema_version") != RENDERER_ROLE_SYSTEM_VERSION:
        failures.append(f"schema_version must be {RENDERER_ROLE_SYSTEM_VERSION!r}")
    if payload.get("catalog_version") != CATALOG_VERSION:
        failures.append(f"catalog_version must be {CATALOG_VERSION!r}")
    grammar_id = str(payload.get("composition_grammar_id") or "").strip()
    grammar = COMPOSITION_GRAMMARS.get(grammar_id)
    if grammar is None:
        failures.append(f"unknown composition_grammar_id {grammar_id!r}")
        return failures
    preset = str(payload.get("style_preset") or "").strip()
    if preset not in grammar["style_presets"]:
        failures.append(f"style_preset {preset!r} is not mapped to {grammar_id!r}")
    if expected_preset and preset != expected_preset:
        failures.append(f"style_preset {preset!r} does not match expected preset {expected_preset!r}")
    for role, field in ROLE_ID_FIELDS.items():
        value = payload.get(field)
        if not isinstance(value, str) or not value.strip():
            failures.append(f"{field} must be a non-empty string")
        elif value != grammar["role_system_ids"][role]:
            failures.append(f"{field} {value!r} does not match grammar {grammar_id!r}")
    narrative_arc = payload.get("narrative_arc")
    if not isinstance(narrative_arc, dict):
        failures.append("narrative_arc must be an object")
    else:
        if narrative_arc.get("arc_id") != grammar["narrative_arc"]["arc_id"]:
            failures.append("narrative_arc.arc_id does not match the composition grammar")
        if not isinstance(narrative_arc.get("stages"), list) or len(narrative_arc["stages"]) < 3:
            failures.append("narrative_arc.stages must contain at least three stages")
    for key in ("density", "grid"):
        if not isinstance(payload.get(key), dict) or not payload[key]:
            failures.append(f"{key} must be a non-empty object")
    reading_path = payload.get("reading_path")
    if not isinstance(reading_path, list) or len(reading_path) < 2 or not all(
        isinstance(item, str) and item.strip() for item in reading_path
    ):
        failures.append("reading_path must contain at least two non-empty strings")
    variants = payload.get("preferred_role_variants")
    if not isinstance(variants, dict):
        failures.append("preferred_role_variants must be an object")
    else:
        for role in ROLE_NAMES:
            values = variants.get(role)
            if not isinstance(values, list) or not values:
                failures.append(f"preferred_role_variants.{role} must be a non-empty list")
                continue
            invalid = [value for value in values if value not in SUPPORTED_ROLE_VARIANTS]
            if invalid:
                failures.append(f"preferred_role_variants.{role} contains unsupported values {invalid}")
    for key in ("invariant_moves", "forbidden_moves"):
        values = payload.get(key)
        if not isinstance(values, list) or not values or not all(
            isinstance(item, str) and item.strip() for item in values
        ):
            failures.append(f"{key} must be a non-empty string list")
    return failures


def validate_taste_grammar_catalog(catalog: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = catalog or build_taste_grammar_catalog()
    grammars = payload.get("grammars") if isinstance(payload.get("grammars"), list) else []
    failures: list[str] = []
    grammar_ids = [str(grammar.get("grammar_id") or "") for grammar in grammars if isinstance(grammar, dict)]
    expected_ids = list(COMPOSITION_GRAMMARS)
    if len(grammars) != 8:
        failures.append(f"grammar_count={len(grammars)} expected=8")
    if set(grammar_ids) != set(expected_ids):
        failures.append("composition grammar IDs do not match the canonical eight")
    preset_map = payload.get("preset_to_grammar") if isinstance(payload.get("preset_to_grammar"), dict) else {}
    if len(preset_map) != 13:
        failures.append(f"preset_count={len(preset_map)} expected=13")
    usage = Counter(map(str, preset_map.values()))
    overused = {grammar_id: count for grammar_id, count in usage.items() if count > 2}
    if overused:
        failures.append(f"composition grammars mapped to more than two presets: {overused}")
    catalogs = payload.get("role_system_catalogs") if isinstance(payload.get("role_system_catalogs"), dict) else {}
    counts = {
        role: len(catalogs.get(f"{role}_systems") or [])
        for role in ROLE_NAMES
    }
    if counts["title"] != 8:
        failures.append(f"title_system_count={counts['title']} expected=8")
    if counts["section"] < 6:
        failures.append(f"section_system_count={counts['section']} expected>=6")
    if counts["evidence"] < 8:
        failures.append(f"evidence_system_count={counts['evidence']} expected>=8")
    if counts["data"] < 8:
        failures.append(f"data_system_count={counts['data']} expected>=8")
    narrative_arcs = payload.get("narrative_arcs") if isinstance(payload.get("narrative_arcs"), list) else []
    arc_ids = {
        str(arc.get("arc_id") or "")
        for arc in narrative_arcs
        if isinstance(arc, dict) and str(arc.get("arc_id") or "").strip()
    }
    if len(arc_ids) < 6:
        failures.append(f"narrative_arc_count={len(arc_ids)} expected>=6")
    for preset in preset_map:
        role_failures = validate_renderer_role_systems_v1(
            renderer_role_systems_for_preset(preset),
            expected_preset=preset,
        )
        failures.extend(f"{preset}: {failure}" for failure in role_failures)
    return {
        "passed": not failures,
        "catalog_version": payload.get("catalog_version"),
        "renderer_role_systems_version": payload.get("renderer_role_systems_version"),
        "grammar_count": len(grammars),
        "preset_count": len(preset_map),
        "max_presets_per_grammar": max(usage.values(), default=0),
        "role_system_counts": counts,
        "narrative_arc_count": len(arc_ids),
        "failures": failures,
    }


def main() -> int:
    print(json.dumps(validate_taste_grammar_catalog(), indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
