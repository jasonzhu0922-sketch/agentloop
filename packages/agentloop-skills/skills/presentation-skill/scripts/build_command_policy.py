#!/usr/bin/env python3
"""Shared build command policy for generated presentation workflows."""

from __future__ import annotations

import shlex
from pathlib import Path
from typing import Any, Mapping


STRICT_WARNING_FLAGS = (
    "--fail-on-planning-warnings",
    "--fail-on-whitespace-warnings",
)


def shell_join(parts: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in parts)


def default_build_command(
    workspace: str | Path,
    *,
    qa: bool = True,
    skip_render: bool = False,
    visual_review: bool = False,
    overwrite: bool = True,
    strict_warnings: bool = False,
    fail_on_visual_review_warnings: bool = False,
) -> list[str]:
    command = ["python3", "scripts/build_workspace.py", "--workspace", str(workspace)]
    if qa:
        command.append("--qa")
    if skip_render:
        command.append("--skip-render")
    if visual_review:
        command.append("--visual-review")
    if fail_on_visual_review_warnings:
        command.append("--fail-on-visual-review-warnings")
    if strict_warnings:
        command.extend(STRICT_WARNING_FLAGS)
    if overwrite:
        command.append("--overwrite")
    return command


def default_build_command_text(
    workspace: str | Path,
    **kwargs: Any,
) -> str:
    return shell_join(default_build_command(workspace, **kwargs))


def repeat_build_command(options: Mapping[str, Any] | Any, workspace: str | Path) -> list[str]:
    command = ["python3", "scripts/build_workspace.py", "--workspace", str(workspace)]
    if bool(_option(options, "fast_first_pass", False)):
        command.append("--fast-first-pass")
    bool_flags = (
        ("qa", "--qa"),
        ("skip_render", "--skip-render"),
        ("visual_review", "--visual-review"),
        ("fail_on_visual_review_warnings", "--fail-on-visual-review-warnings"),
        ("fail_on_whitespace_warnings", "--fail-on-whitespace-warnings"),
        ("fail_on_planning_warnings", "--fail-on-planning-warnings"),
        ("skip_preflight", "--skip-preflight"),
        ("strict_preflight", "--strict-preflight"),
        ("skip_asset_staging", "--skip-asset-staging"),
        ("allow_network_assets", "--allow-network-assets"),
        ("allow_generated_images", "--allow-generated-images"),
        ("plan_research_assets", "--plan-research-assets"),
        ("scaffold_data_artifacts", "--scaffold-data-artifacts"),
        ("skip_data_artifact_run", "--skip-data-artifact-run"),
        ("overwrite_data_artifacts", "--overwrite-data-artifacts"),
        ("auto_bind_artifacts", "--auto-bind-artifacts"),
        ("strict_provenance", "--strict-provenance"),
        ("overwrite", "--overwrite"),
    )
    fast_first_pass_attrs = {
        "qa",
        "skip_render",
        "scaffold_data_artifacts",
        "auto_bind_artifacts",
        "fail_on_planning_warnings",
        "fail_on_whitespace_warnings",
        "overwrite",
    }
    for attr, flag in bool_flags:
        if bool(_option(options, "fast_first_pass", False)) and attr in fast_first_pass_attrs:
            continue
        if bool(_option(options, attr, False)):
            command.append(flag)
    for data_path in _option(options, "data_path", []) or []:
        command.extend(["--data-path", str(data_path)])
    renderer = str(_option(options, "renderer", "auto"))
    if renderer != "auto":
        command.extend(["--renderer", renderer])
    artifact_selection_out = str(_option(options, "artifact_selection_out", "artifact_selections.auto.json"))
    if artifact_selection_out != "artifact_selections.auto.json":
        command.extend(["--artifact-selection-out", artifact_selection_out])
    artifact_bind_variants = str(_option(options, "artifact_bind_variants", "image-sidebar,chart,lab-run-results"))
    if artifact_bind_variants != "image-sidebar,chart,lab-run-results":
        command.extend(["--artifact-bind-variants", artifact_bind_variants])
    default_bind_mode = "lead" if bool(_option(options, "fast_first_pass", False)) else "all"
    artifact_bind_mode = str(_option(options, "artifact_bind_mode", default_bind_mode))
    if artifact_bind_mode != default_bind_mode:
        command.extend(["--artifact-bind-mode", artifact_bind_mode])
    build_report = str(_option(options, "build_report", "build/build_workspace_report.json"))
    if build_report != "build/build_workspace_report.json":
        command.extend(["--build-report", build_report])
    return command


def _option(options: Mapping[str, Any] | Any, name: str, default: Any) -> Any:
    if isinstance(options, Mapping):
        return options.get(name, default)
    return getattr(options, name, default)
