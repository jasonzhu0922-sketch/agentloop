#!/usr/bin/env python3
"""Smoke test for compact GPT-5.6-family deck briefs and page systems."""

from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

from style_treatment_profiles import PAGE_SYSTEM_BY_PRESET, preset_treatment_profile
from emit_deck_start_packet import build_packet
from model_adaptive_workflow import build_agent_brief


ROOT = Path(__file__).resolve().parents[1]


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        list(args),
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Command failed ({result.returncode}): {' '.join(args)}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    cases = [
        ("sol", "quality-first", "Clinical assay validation with local run data and a regulatory decision"),
        ("terra", "balanced", "Professional strategy review for a municipal cooling program"),
        ("luna", "fast", "Quick five-slide internal draft on warehouse slotting"),
    ]
    results = []
    with tempfile.TemporaryDirectory(prefix="presentation-model-adaptive-") as tmp:
        root = Path(tmp)
        for idx, (requested, expected, prompt) in enumerate(cases, start=1):
            workspace = root / f"case-{idx}"
            _run(
                "python3",
                "scripts/init_deck_workspace.py",
                "--workspace",
                str(workspace),
                "--title",
                f"Model adaptive case {idx}",
                "--style-preset",
                "executive-clinical",
                "--user-prompt",
                prompt,
                "--agent-profile",
                requested,
            )
            brief_path = workspace / "agent_brief.json"
            markdown_path = workspace / "agent_brief.md"
            packet_path = workspace / "deck_start_packet.json"
            if not brief_path.exists() or not markdown_path.exists() or not packet_path.exists():
                raise AssertionError("init did not emit the model-adaptive brief and full audit packet")
            brief = json.loads(brief_path.read_text(encoding="utf-8"))
            resolved = brief.get("execution_profile", {}).get("resolved")
            if resolved != expected:
                raise AssertionError(f"{requested} resolved to {resolved!r}, expected {expected!r}")
            budget = brief.get("prompt_budget", {})
            if not budget.get("within_budget") or int(budget.get("compact_json_chars") or 0) > 20000:
                raise AssertionError(f"brief exceeded compact prompt budget: {budget}")
            if brief_path.stat().st_size >= packet_path.stat().st_size / 5:
                raise AssertionError("compact agent brief is not materially smaller than the audit packet")
            routing = brief.get("routing") if isinstance(brief.get("routing"), dict) else {}
            grammar = (
                routing.get("composition_grammar")
                if isinstance(routing.get("composition_grammar"), dict)
                else {}
            )
            execution_plan = (
                routing.get("style_execution_plan")
                if isinstance(routing.get("style_execution_plan"), dict)
                else {}
            )
            if not grammar.get("grammar_id") or not grammar.get("rhythm_pattern"):
                raise AssertionError("compact brief omitted the resolved composition grammar")
            if execution_plan.get("schema_version") != "style_execution_plan_v1":
                raise AssertionError("compact brief omitted style_execution_plan_v1")
            if len(execution_plan.get("treatment_keys") or []) != 8:
                raise AssertionError("compact brief omitted treatment-plan coverage")
            if "Composition grammar:" not in markdown_path.read_text(encoding="utf-8"):
                raise AssertionError("agent brief markdown omitted the composition grammar")
            before = _sha(brief_path)
            _run(
                "python3",
                "scripts/model_adaptive_workflow.py",
                "--workspace",
                str(workspace),
                "--packet",
                "deck_start_packet.json",
                "--user-prompt",
                prompt,
                "--agent-profile",
                requested,
            )
            if _sha(brief_path) != before:
                raise AssertionError("model-adaptive brief is not deterministic")
            results.append(
                {
                    "requested": requested,
                    "resolved": resolved,
                    "brief_bytes": brief_path.stat().st_size,
                    "packet_bytes": packet_path.stat().st_size,
                }
            )

    page_systems = set(PAGE_SYSTEM_BY_PRESET.values())
    if len(page_systems) != 6:
        raise AssertionError(f"expected 6 preset-owned page systems, found {sorted(page_systems)}")
    for preset, expected_page_system in PAGE_SYSTEM_BY_PRESET.items():
        profile = preset_treatment_profile(preset)
        defaults = profile.get("renderer_treatment_defaults", {})
        if defaults.get("page_system") != expected_page_system:
            raise AssertionError(f"{preset} page system drift: {defaults.get('page_system')!r}")
        if defaults.get("image_sidebar_mode") not in {"analysis-rail", "evidence-mosaic", "editorial-atlas"}:
            raise AssertionError(f"{preset} missing image/sidebar composition default")
        if defaults.get("comparison_mode") not in {"open-columns", "scorecard"}:
            raise AssertionError(f"{preset} missing comparison composition default")

    generic_packet = build_packet(
        workspace=None,
        user_prompt="Create an editable PowerPoint with evidence and a chart.",
        mode="agent",
    )
    generic_routes = set(
        generic_packet.get("agent_kickoff_brief", {})
        .get("route_snapshot", {})
        .get("active_routes", [])
    )
    if "pptx_style_import" in generic_routes:
        raise AssertionError("generic PowerPoint request incorrectly activated reference-style import")
    if "content_research" not in generic_routes:
        raise AssertionError("explicit evidence request did not activate source planning")
    shape_prompt = "Create an editable PowerPoint with evidence, a chart, and a comparison."
    generic_brief = build_agent_brief(
        packet=build_packet(workspace=None, user_prompt=shape_prompt, mode="agent"),
        workspace=Path("."),
        user_prompt=shape_prompt,
        requested_profile="balanced",
    )
    requested_shapes = (
        generic_brief.get("routing", {})
        .get("atom_seed", {})
        .get("requested_content_shapes", [])
    )
    if "chart" not in requested_shapes or "comparison-2col" not in requested_shapes:
        raise AssertionError(f"explicit content shapes were not retained: {requested_shapes}")
    reference_packet = build_packet(
        workspace=None,
        user_prompt="Rebuild this from the attached reference deck sample.pptx.",
        mode="agent",
    )
    reference_routes = set(
        reference_packet.get("agent_kickoff_brief", {})
        .get("route_snapshot", {})
        .get("active_routes", [])
    )
    if "pptx_style_import" not in reference_routes:
        raise AssertionError("explicit reference PPTX did not activate style import")

    print(
        json.dumps(
            {
                "passed": True,
                "brief_cases": results,
                "page_system_count": len(page_systems),
                "page_systems": sorted(page_systems),
                "routing_guardrails": {
                    "generic_powerpoint_style_import": False,
                    "evidence_research": True,
                    "reference_pptx_style_import": True,
                },
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
