#!/usr/bin/env python3
"""Build and route the canonical eight deck composition grammars."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
from collections import Counter
from typing import Any

from style_treatment_profiles import preset_treatment_profile
from taste_grammar_catalog import (
    COMPOSITION_GRAMMARS,
    PRESET_TO_GRAMMAR,
    ROLE_NAMES,
    build_taste_grammar_catalog,
    renderer_role_systems_for_grammar,
    validate_taste_grammar_catalog,
)
from role_layout_contracts import renderer_role_contracts_for_grammar


CATALOG_VERSION = "composition_grammar_catalog_v1"

REQUESTED_VARIANT_HINTS = {
    "chart": ("chart", "plot", "graph", "trend"),
    "table": ("table", "ledger", "rows", "matrix data"),
    "scientific-figure": ("scientific figure", "multi-panel", "figure panels"),
    "image-sidebar": ("image sidebar", "figure sidebar", "map", "microscopy"),
    "lab-run-results": ("lab results", "run results", "assay results", "qc table"),
    "comparison-2col": ("comparison", "before and after", "versus", "tradeoff"),
    "matrix": ("matrix", "quadrant", "2x2"),
    "timeline": ("timeline", "roadmap", "milestones"),
    "flow": ("flow", "process", "workflow", "architecture"),
    "stats": ("stats", "metrics", "kpis", "dashboard"),
    "kpi-hero": ("hero metric", "big number", "single kpi"),
}

STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "can", "deck", "for", "from",
    "in", "into", "is", "it", "of", "on", "or", "presentation", "slide", "slides", "the",
    "this", "to", "use", "with",
}


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _ordered_unique(values: list[Any]) -> list[str]:
    out: list[str] = []
    for value in values:
        text = str(value or "").strip()
        if text and text not in out:
            out.append(text)
    return out


def _tokens(value: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9]+", str(value or "").lower())
        if len(token) > 1 and token not in STOPWORDS
    }


def _requested_variants(text: str) -> list[str]:
    lower = str(text or "").lower()
    return [
        variant
        for variant, hints in REQUESTED_VARIANT_HINTS.items()
        if any(hint in lower for hint in hints)
    ]


def _structural_signature(grammar: dict[str, Any]) -> str:
    payload = {
        "grammar_id": grammar.get("grammar_id"),
        "role_system_ids": {
            role: grammar.get(f"{role}_system_id")
            for role in ROLE_NAMES
        },
        "narrative_arc": grammar.get("narrative_arc"),
        "density": grammar.get("density"),
        "grid": grammar.get("grid"),
        "reading_path": grammar.get("reading_path"),
        "invariant_moves": grammar.get("invariant_moves"),
        "forbidden_moves": grammar.get("forbidden_moves"),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _record_from_grammar(grammar_id: str, *, style_preset: str = "") -> dict[str, Any]:
    spec = copy.deepcopy(COMPOSITION_GRAMMARS[grammar_id])
    presets = [str(value) for value in spec.get("style_presets") or []]
    resolved_preset = style_preset if style_preset in presets else presets[0]
    role_systems = renderer_role_systems_for_grammar(grammar_id, preset=resolved_preset)
    role_contracts = renderer_role_contracts_for_grammar(grammar_id, preset=resolved_preset)
    preferred_role_variants = _as_dict(spec.get("preferred_role_variants"))
    role_variant_map = {
        role: str((_as_list(preferred_role_variants.get(role)) or ["standard"])[0])
        for role in ROLE_NAMES
    }
    rhythm_treatments = list(ROLE_NAMES)
    rhythm_pattern = [role_variant_map[role] for role in rhythm_treatments]
    profile = preset_treatment_profile(resolved_preset)
    record: dict[str, Any] = {
        "grammar_id": grammar_id,
        "catalog_version": CATALOG_VERSION,
        "style_preset": resolved_preset,
        "style_presets": presets,
        "family": profile.get("family"),
        "lane": spec.get("lane"),
        "description": spec.get("description"),
        "best_for": _ordered_unique([*presets, *map(str, spec.get("prompt_keywords") or [])]),
        "prompt_keywords": list(spec.get("prompt_keywords") or []),
        "rhythm_treatments": rhythm_treatments,
        "rhythm_pattern": rhythm_pattern,
        "role_variant_map": role_variant_map,
        "preferred_variants": _ordered_unique(
            [variant for role in ROLE_NAMES for variant in _as_list(preferred_role_variants.get(role))]
        ),
        "renderer_bias": copy.deepcopy(profile.get("renderer_treatment_defaults") or {}),
        "renderer_role_systems_v1": role_systems,
        "renderer_role_contracts_v2": role_contracts,
        "narrative_arc": copy.deepcopy(spec.get("narrative_arc") or {}),
        "density": copy.deepcopy(spec.get("density") or {}),
        "grid": copy.deepcopy(spec.get("grid") or {}),
        "reading_path": list(spec.get("reading_path") or []),
        "preferred_role_variants": preferred_role_variants,
        "invariant_moves": list(spec.get("invariant_moves") or []),
        "forbidden_moves": list(spec.get("forbidden_moves") or []),
        "distinctive_moves": list(spec.get("invariant_moves") or []),
        "avoid": list(spec.get("forbidden_moves") or []),
        "mix_rule": (
            "Keep one composition grammar coherent across the deck. Borrow isolated treatment ideas, "
            "but do not merge complete role systems or page systems."
        ),
        "max_consecutive_same_variant": 2,
    }
    for role in ROLE_NAMES:
        record[f"{role}_system_id"] = role_systems[f"{role}_system_id"]
    record["structural_signature"] = _structural_signature(record)
    return record


def build_composition_grammar_catalog() -> dict[str, Any]:
    records = [_record_from_grammar(grammar_id) for grammar_id in COMPOSITION_GRAMMARS]
    taste_catalog = build_taste_grammar_catalog()
    return {
        "catalog_version": CATALOG_VERSION,
        "taste_catalog_version": taste_catalog.get("catalog_version"),
        "renderer_role_systems_version": taste_catalog.get("renderer_role_systems_version"),
        "grammar_count": len(records),
        "preset_count": len(PRESET_TO_GRAMMAR),
        "preset_to_grammar": dict(PRESET_TO_GRAMMAR),
        "role_system_counts": {
            role: len(_as_list(_as_dict(taste_catalog.get("role_system_catalogs")).get(f"{role}_systems")))
            for role in ROLE_NAMES
        },
        "narrative_arc_count": len(
            {
                str(_as_dict(record.get("narrative_arc")).get("arc_id") or "")
                for record in records
            }
        ),
        "records": records,
    }


def validate_composition_grammar_catalog(catalog: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = catalog or build_composition_grammar_catalog()
    records = _as_list(payload.get("records"))
    failures: list[str] = []
    ids: list[str] = []
    signatures: list[str] = []
    preset_map = _as_dict(payload.get("preset_to_grammar"))
    usage = Counter(map(str, preset_map.values()))
    for record in records:
        if not isinstance(record, dict):
            failures.append("non-object grammar record")
            continue
        grammar_id = str(record.get("grammar_id") or "")
        ids.append(grammar_id)
        signatures.append(str(record.get("structural_signature") or ""))
        for role in ROLE_NAMES:
            if not str(record.get(f"{role}_system_id") or "").strip():
                failures.append(f"{grammar_id}: missing {role}_system_id")
        for key in (
            "narrative_arc", "density", "grid", "reading_path", "preferred_role_variants",
            "invariant_moves", "forbidden_moves", "renderer_role_systems_v1", "renderer_role_contracts_v2",
        ):
            if record.get(key) in (None, {}, []):
                failures.append(f"{grammar_id}: missing {key}")
    if len(records) != 8:
        failures.append(f"grammar_count={len(records)} expected=8")
    if set(ids) != set(COMPOSITION_GRAMMARS):
        failures.append("composition grammar IDs do not match the canonical eight")
    if len(set(ids)) != len(ids):
        failures.append("duplicate grammar ids")
    if len(set(signatures)) != len(signatures):
        failures.append("duplicate structural signatures")
    if len(preset_map) != 13:
        failures.append(f"preset_count={len(preset_map)} expected=13")
    if max(usage.values(), default=0) > 2:
        failures.append("a composition grammar is mapped to more than two presets")
    taste_summary = validate_taste_grammar_catalog()
    if not taste_summary.get("passed"):
        failures.extend(f"taste catalog: {item}" for item in taste_summary.get("failures") or [])
    role_counts = _as_dict(payload.get("role_system_counts"))
    if role_counts.get("title") != 8:
        failures.append(f"title_system_count={role_counts.get('title')} expected=8")
    if int(role_counts.get("section") or 0) < 6:
        failures.append(f"section_system_count={role_counts.get('section')} expected>=6")
    if int(role_counts.get("evidence") or 0) < 8:
        failures.append(f"evidence_system_count={role_counts.get('evidence')} expected>=8")
    if int(role_counts.get("data") or 0) < 8:
        failures.append(f"data_system_count={role_counts.get('data')} expected>=8")
    if int(payload.get("narrative_arc_count") or 0) < 6:
        failures.append(f"narrative_arc_count={payload.get('narrative_arc_count')} expected>=6")
    return {
        "passed": not failures,
        "catalog_version": payload.get("catalog_version"),
        "grammar_count": len(records),
        "preset_count": len(preset_map),
        "max_presets_per_grammar": max(usage.values(), default=0),
        "unique_grammar_id_count": len(set(ids)),
        "unique_structural_signature_count": len(set(signatures)),
        "role_system_counts": role_counts,
        "narrative_arc_count": payload.get("narrative_arc_count"),
        "preset_to_grammar": preset_map,
        "failures": failures,
    }


def _score_record(record: dict[str, Any], *, text: str, style_preset: str) -> tuple[int, list[str]]:
    query_tokens = _tokens(text)
    score = 0
    reasons: list[str] = []
    presets = set(map(str, _as_list(record.get("style_presets"))))
    if style_preset and style_preset in presets:
        score += 100
        reasons.append("requested preset grammar")
    keyword_hits = query_tokens.intersection(_tokens(" ".join(map(str, record.get("prompt_keywords") or []))))
    if keyword_hits:
        score += min(24, len(keyword_hits) * 4)
        reasons.append("grammar terms: " + ", ".join(sorted(keyword_hits)[:5]))
    descriptor_hits = query_tokens.intersection(
        _tokens(" ".join([str(record.get("description") or ""), " ".join(map(str, record.get("best_for") or []))]))
    )
    if descriptor_hits:
        score += min(12, len(descriptor_hits) * 2)
        reasons.append("topic fit: " + ", ".join(sorted(descriptor_hits)[:5]))
    requested = _requested_variants(text)
    preferred = set(map(str, _as_list(record.get("preferred_variants"))))
    variant_hits = [variant for variant in requested if variant in preferred]
    if variant_hits:
        score += len(variant_hits) * 3
        reasons.append("requested shapes: " + ", ".join(variant_hits))
    return score, reasons


def route_composition_grammars(
    *,
    topic: str,
    user_prompt: str,
    style_preset: str = "",
    limit: int = 3,
) -> dict[str, Any]:
    text = " ".join(part for part in [topic, user_prompt] if str(part or "").strip())
    scored: list[dict[str, Any]] = []
    for grammar_id in COMPOSITION_GRAMMARS:
        mapped_presets = COMPOSITION_GRAMMARS[grammar_id]["style_presets"]
        record_preset = style_preset if style_preset in mapped_presets else mapped_presets[0]
        record = _record_from_grammar(grammar_id, style_preset=record_preset)
        score, reasons = _score_record(record, text=text, style_preset=style_preset)
        record["route_score"] = score
        record["selection_reasons"] = reasons or ["stable catalog fallback"]
        scored.append(record)
    scored.sort(key=lambda item: (-int(item.get("route_score") or 0), str(item.get("grammar_id") or "")))
    locked_id = PRESET_TO_GRAMMAR.get(style_preset) if style_preset else None
    primary = next((record for record in scored if record.get("grammar_id") == locked_id), None)
    primary = primary or (scored[0] if scored else {})
    alternatives = [
        record
        for record in scored
        if record.get("grammar_id") != primary.get("grammar_id")
    ][: max(0, min(2, limit - 1))]
    return {
        "route_version": "composition_grammar_route_v1",
        "catalog_version": CATALOG_VERSION,
        "topic": topic,
        "style_preset_hint": style_preset,
        "requested_variants": _requested_variants(text),
        "primary": primary,
        "alternatives": alternatives,
        "selection_rule": (
            "Use primary as the deck grammar. Borrow isolated treatments only when the content shape benefits; "
            "never merge complete role systems or page systems."
        ),
    }


def _compact_record(record: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "grammar_id", "style_preset", "style_presets", "family", "lane", "description",
        "rhythm_treatments", "rhythm_pattern", "role_variant_map", "preferred_variants",
        "renderer_bias", "renderer_role_systems_v1", "renderer_role_contracts_v2", "title_system_id", "section_system_id",
        "evidence_system_id", "comparison_system_id", "data_system_id", "decision_system_id",
        "references_system_id", "narrative_arc", "density", "grid", "reading_path",
        "preferred_role_variants", "invariant_moves", "forbidden_moves", "distinctive_moves",
        "avoid", "mix_rule", "max_consecutive_same_variant", "structural_signature",
        "route_score", "selection_reasons",
    )
    return {key: record.get(key) for key in keys if record.get(key) not in (None, [], {}, "")}


def compact_grammar_route(route: dict[str, Any]) -> dict[str, Any]:
    return {
        "route_version": route.get("route_version"),
        "catalog_version": route.get("catalog_version"),
        "requested_variants": route.get("requested_variants"),
        "primary": _compact_record(_as_dict(route.get("primary"))),
        "alternatives": [
            _compact_record(record)
            for record in _as_list(route.get("alternatives"))
            if isinstance(record, dict)
        ],
        "selection_rule": route.get("selection_rule"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build or route the canonical composition-grammar catalog.")
    parser.add_argument("--summary", action="store_true", help="Validate and summarize the eight grammar routes.")
    parser.add_argument("--topic", default="")
    parser.add_argument("--user-prompt", default="")
    parser.add_argument("--style-preset", default="")
    parser.add_argument("--limit", type=int, default=3)
    args = parser.parse_args()
    if args.summary or not (args.topic or args.user_prompt or args.style_preset):
        print(json.dumps(validate_composition_grammar_catalog(), indent=2, ensure_ascii=False))
        return 0
    route = route_composition_grammars(
        topic=args.topic,
        user_prompt=args.user_prompt,
        style_preset=args.style_preset,
        limit=max(1, min(3, args.limit)),
    )
    print(json.dumps(compact_grammar_route(route), indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
