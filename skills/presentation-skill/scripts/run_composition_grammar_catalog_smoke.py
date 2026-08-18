#!/usr/bin/env python3
"""Focused smoke test for dynamic composition-grammar routing."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from composition_grammar_catalog import (  # noqa: E402
    route_composition_grammars,
    validate_composition_grammar_catalog,
)
from style_reference_catalog import rank_style_references, style_reference_mix_plan  # noqa: E402
from workflow_atom_context import build_workflow_atom_context, compact_workflow_atom_context  # noqa: E402


def _primary_id(route: dict) -> str:
    primary = route.get("primary") if isinstance(route.get("primary"), dict) else {}
    return str(primary.get("grammar_id") or "")


def main() -> int:
    failures: list[str] = []
    summary = validate_composition_grammar_catalog()
    if not summary.get("passed"):
        failures.extend(summary.get("failures") or ["catalog validation failed"])
    if summary.get("grammar_count") != 8:
        failures.append(f"grammar_count={summary.get('grammar_count')} expected=8")
    if summary.get("unique_structural_signature_count") != 8:
        failures.append("composition grammar structural signatures are not unique")
    role_counts = summary.get("role_system_counts") if isinstance(summary.get("role_system_counts"), dict) else {}
    if role_counts.get("title") != 8:
        failures.append("expected exactly eight title systems")
    if int(role_counts.get("section") or 0) < 6:
        failures.append("expected at least six section systems")
    if int(role_counts.get("evidence") or 0) < 8 or int(role_counts.get("data") or 0) < 8:
        failures.append("expected at least eight evidence and eight data systems")
    if int(summary.get("narrative_arc_count") or 0) < 6:
        failures.append("expected at least six narrative arcs")

    cases = [
        (
            "lab",
            route_composition_grammars(
                topic="RT-LAMP validation run",
                user_prompt="scientific evidence figures, assay table, QC decision",
                style_preset="lab-report",
            ),
            "scientific-evidence-plate",
        ),
        (
            "board",
            route_composition_grammars(
                topic="Q3 retention review",
                user_prompt="board decision, variance chart, owner table, risk tradeoff",
                style_preset="data-heavy-boardroom",
            ),
            "consulting-answer-pyramid",
        ),
        (
            "editorial",
            route_composition_grammars(
                topic="Museum membership renewal",
                user_prompt="human-centered editorial case story with evidence and recommendation",
                style_preset="editorial-minimal",
            ),
            "editorial-spread",
        ),
    ]
    for label, route, expected in cases:
        if _primary_id(route) != expected:
            failures.append(f"{label}: primary={_primary_id(route)} expected={expected}")
        alternatives = route.get("alternatives") if isinstance(route.get("alternatives"), list) else []
        if len(alternatives) != 2:
            failures.append(f"{label}: expected two bounded alternatives")

    adversarial_lock = route_composition_grammars(
        topic="Investor launch market transformation",
        user_prompt=(
            "founder pitch market launch product story investor narrative transformation "
            "hero metric big number dashboard comparison roadmap"
        ),
        style_preset="lab-report",
    )
    if _primary_id(adversarial_lock) != "scientific-evidence-plate":
        failures.append("adversarial prompt overrode the explicit preset lock")

    context = compact_workflow_atom_context(
        build_workflow_atom_context(
            user_prompt="Investor fundraising unit economics deck with a hero metric",
            style_preset="lab-report",
            slide_count=8,
            include_prompt=False,
        )
    )
    plan = context.get("style_execution_plan") if isinstance(context.get("style_execution_plan"), dict) else {}
    grammar_route = (
        context.get("composition_grammar_route")
        if isinstance(context.get("composition_grammar_route"), dict)
        else {}
    )
    primary = grammar_route.get("primary") if isinstance(grammar_route.get("primary"), dict) else {}
    deck_style = context.get("deck_style_delta") if isinstance(context.get("deck_style_delta"), dict) else {}
    decision = context.get("decision") if isinstance(context.get("decision"), dict) else {}
    if context.get("target_family") != "lab-report":
        failures.append("explicit preset was overridden by prompt routing")
    if plan.get("schema_version") != "style_execution_plan_v1":
        failures.append("missing style_execution_plan_v1")
    if plan.get("explicit_style_lock") is not True:
        failures.append("explicit style lock not preserved")
    if primary.get("grammar_id") != "scientific-evidence-plate":
        failures.append("composition grammar ignored explicit lab-report preset")
    if deck_style.get("page_system") != "lab-plate":
        failures.append("resolved deck style did not carry lab-plate page system")
    if decision.get("status") != "accepted":
        failures.append("normal workflow route lacks an accepted decision state")
    if len(plan.get("treatment_plan") or {}) != 8:
        failures.append("style execution plan does not expose all treatment recipes")
    role_systems = context.get("renderer_role_systems_v1") if isinstance(context.get("renderer_role_systems_v1"), dict) else {}
    if role_systems.get("schema_version") != "renderer_role_systems_v1":
        failures.append("normal workflow omitted renderer_role_systems_v1")
    if role_systems.get("composition_grammar_id") != "scientific-evidence-plate":
        failures.append("normal workflow persisted the wrong role-system grammar")

    zero_matches = rank_style_references("zzqv unmatched vocabulary", limit=3)
    zero_mix = style_reference_mix_plan("zzqv unmatched vocabulary", limit=3)
    if zero_matches:
        failures.append("zero-score style references should not be returned")
    if zero_mix.get("primary"):
        failures.append("zero-score style mix should not promote an arbitrary primary")

    payload = {
        "passed": not failures,
        "catalog": summary,
        "routes": {label: _primary_id(route) for label, route, _expected in cases},
        "explicit_lock": {
            "target_family": context.get("target_family"),
            "grammar_id": primary.get("grammar_id"),
            "page_system": deck_style.get("page_system"),
            "decision": decision,
            "treatment_count": len(plan.get("treatment_plan") or {}),
        },
        "failures": failures,
    }
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
