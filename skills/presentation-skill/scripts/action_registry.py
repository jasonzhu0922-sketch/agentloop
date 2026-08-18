#!/usr/bin/env python3
"""Typed, workspace-contained actions for readiness automation.

Readiness reports are data, not executable authority. This registry converts a
small set of repository-owned operations into validated action records and
reconstructs commands only after validating their typed parameters.
"""

from __future__ import annotations

import shlex
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence


ACTION_SCHEMA_VERSION = "deck_action_v1"


class ActionRegistryError(ValueError):
    """Raised when an action cannot be represented by the fixed registry."""


@dataclass(frozen=True)
class FlagSpec:
    value_type: str
    repeat: bool = False
    choices: tuple[str, ...] = ()


@dataclass(frozen=True)
class ActionSpec:
    script: str
    flags: Mapping[str, FlagSpec]


_PATH = FlagSpec("path")
_PATHS = FlagSpec("path", repeat=True)
_BOOL = FlagSpec("bool")
_TEXT = FlagSpec("text")


_BUILD_FLAGS = {
    "--workspace": _PATH,
    "--fast-first-pass": _BOOL,
    "--data-path": _PATHS,
    "--qa": _BOOL,
    "--visual-review": _BOOL,
    "--fail-on-planning-warnings": _BOOL,
    "--fail-on-whitespace-warnings": _BOOL,
    "--fail-on-visual-review-warnings": _BOOL,
    "--overwrite": _BOOL,
}


ACTION_REGISTRY: dict[str, ActionSpec] = {
    "apply_deck_intake_answers": ActionSpec(
        "scripts/apply_deck_intake_answers.py",
        {
            "--workspace": _PATH,
            "--packet": _PATH,
            "--answers": _PATH,
            "--report": _PATH,
        },
    ),
    "apply_data_analysis_handoff": ActionSpec(
        "scripts/apply_data_analysis_handoff.py",
        {"--workspace": _PATH, "--handoff": _PATH, "--report": _PATH},
    ),
    "apply_design_contract": ActionSpec(
        "scripts/apply_design_contract.py",
        {"--workspace": _PATH, "--contract": _PATH, "--report": _PATH},
    ),
    "apply_outline_authoring_handoff": ActionSpec(
        "scripts/apply_outline_authoring_handoff.py",
        {"--workspace": _PATH, "--handoff": _PATH, "--report": _PATH},
    ),
    "extract_pptx_style": ActionSpec(
        "scripts/extract_pptx_style.py",
        {
            "--input": _PATHS,
            "--report": _PATH,
            "--markdown-report": _PATH,
            "--design-brief-fragment": _PATH,
        },
    ),
    "apply_pptx_style_fragment": ActionSpec(
        "scripts/apply_pptx_style_fragment.py",
        {
            "--workspace": _PATH,
            "--fragment": _PATH,
            "--style-report": _PATH,
            "--report": _PATH,
        },
    ),
    "compact_source_footers": ActionSpec(
        "scripts/compact_source_footers.py",
        {"--workspace": _PATH, "--report": _PATH},
    ),
    "bind_generated_artifacts": ActionSpec(
        "scripts/apply_artifact_manifest_bindings.py",
        {
            "--workspace": _PATH,
            "--auto-select": _BOOL,
            "--auto-select-mode": FlagSpec("enum", choices=("lead", "all")),
            "--selection-out": _PATH,
            "--report": _PATH,
        },
    ),
    "refresh_generated_artifacts": ActionSpec("scripts/build_workspace.py", _BUILD_FLAGS),
    "rebuild_stale_build": ActionSpec("scripts/build_workspace.py", _BUILD_FLAGS),
    "scaffold_data_artifacts": ActionSpec("scripts/build_workspace.py", _BUILD_FLAGS),
    "run_visual_review_delivery_build": ActionSpec("scripts/build_workspace.py", _BUILD_FLAGS),
    "run_final_delivery_build": ActionSpec("scripts/build_workspace.py", _BUILD_FLAGS),
}


def _parameter_name(flag: str) -> str:
    return flag.removeprefix("--").replace("-", "_")


def _flag_name(parameter: str) -> str:
    return "--" + parameter.replace("_", "-")


def _inside_workspace(path: Path, workspace: Path) -> bool:
    try:
        path.resolve().relative_to(workspace.resolve())
        return True
    except ValueError:
        return False


def _validated_path(value: Any, *, workspace: Path, parameter: str) -> str:
    text = str(value or "").strip()
    if not text or "\x00" in text:
        raise ActionRegistryError(f"{parameter} must be a non-empty path")
    raw = Path(text).expanduser()
    resolved = raw.resolve() if raw.is_absolute() else (workspace / raw).resolve()
    if not _inside_workspace(resolved, workspace):
        raise ActionRegistryError(f"{parameter} escapes the workspace: {text}")
    if parameter == "workspace" and resolved != workspace.resolve():
        raise ActionRegistryError("workspace parameter must equal the active workspace")
    return str(resolved)


def _validated_scalar(value: Any, spec: FlagSpec, *, parameter: str) -> Any:
    if spec.value_type == "bool":
        if value is not True:
            raise ActionRegistryError(f"{parameter} must be true when present")
        return True
    text = str(value or "").strip()
    if not text or "\x00" in text:
        raise ActionRegistryError(f"{parameter} must be a non-empty value")
    if spec.value_type == "enum" and text not in spec.choices:
        raise ActionRegistryError(
            f"{parameter} must be one of: {', '.join(spec.choices)}"
        )
    if spec.value_type not in {"enum", "text"}:
        raise ActionRegistryError(f"Unsupported registry value type: {spec.value_type}")
    return text


def _parse_command(
    command: Any,
    *,
    action_id: str,
    repo: Path,
    workspace: Path,
) -> dict[str, Any]:
    spec = ACTION_REGISTRY.get(action_id)
    if spec is None:
        raise ActionRegistryError(f"Unregistered action_id: {action_id}")
    if not isinstance(command, list) or len(command) < 2:
        raise ActionRegistryError("Registered actions require a command token list")
    tokens = [str(item) for item in command]
    if any("\x00" in token for token in tokens):
        raise ActionRegistryError("Command contains a NUL byte")
    if Path(tokens[0]).name not in {"python", "python3"}:
        raise ActionRegistryError("Registered actions must use the Python runtime")
    expected_script = (repo / spec.script).resolve()
    raw_script = Path(tokens[1])
    actual_script = raw_script.resolve() if raw_script.is_absolute() else (repo / raw_script).resolve()
    if actual_script != expected_script:
        raise ActionRegistryError(
            f"Action {action_id} cannot run script {tokens[1]!r}"
        )

    parameters: dict[str, Any] = {}
    index = 2
    while index < len(tokens):
        flag = tokens[index]
        flag_spec = spec.flags.get(flag)
        if flag_spec is None:
            raise ActionRegistryError(f"Action {action_id} does not allow flag {flag!r}")
        parameter = _parameter_name(flag)
        if flag_spec.value_type == "bool":
            value: Any = True
            index += 1
        else:
            if index + 1 >= len(tokens) or tokens[index + 1].startswith("--"):
                raise ActionRegistryError(f"Flag {flag} requires a value")
            raw_value = tokens[index + 1]
            value = (
                _validated_path(raw_value, workspace=workspace, parameter=parameter)
                if flag_spec.value_type == "path"
                else _validated_scalar(raw_value, flag_spec, parameter=parameter)
            )
            index += 2
        if flag_spec.repeat:
            parameters.setdefault(parameter, []).append(value)
        elif parameter in parameters:
            raise ActionRegistryError(f"Flag {flag} may only be provided once")
        else:
            parameters[parameter] = value

    workspace_value = parameters.get("workspace")
    if "--workspace" in spec.flags and not workspace_value:
        raise ActionRegistryError(f"Action {action_id} requires --workspace")
    return parameters


def _validate_parameters(
    parameters: Any,
    *,
    action_id: str,
    workspace: Path,
) -> dict[str, Any]:
    spec = ACTION_REGISTRY.get(action_id)
    if spec is None:
        raise ActionRegistryError(f"Unregistered action_id: {action_id}")
    if not isinstance(parameters, Mapping):
        raise ActionRegistryError("Registered actions require a parameters object")
    allowed = {_parameter_name(flag): flag_spec for flag, flag_spec in spec.flags.items()}
    unknown = sorted(set(str(key) for key in parameters) - set(allowed))
    if unknown:
        raise ActionRegistryError(f"Unknown action parameters: {', '.join(unknown)}")
    validated: dict[str, Any] = {}
    for parameter, value in parameters.items():
        parameter = str(parameter)
        flag_spec = allowed[parameter]
        values: Sequence[Any]
        if flag_spec.repeat:
            if not isinstance(value, list) or not value:
                raise ActionRegistryError(f"{parameter} must be a non-empty list")
            values = value
        else:
            values = [value]
        parsed = [
            _validated_path(item, workspace=workspace, parameter=parameter)
            if flag_spec.value_type == "path"
            else _validated_scalar(item, flag_spec, parameter=parameter)
            for item in values
        ]
        validated[parameter] = parsed if flag_spec.repeat else parsed[0]
    if "--workspace" in spec.flags and "workspace" not in validated:
        raise ActionRegistryError(f"Action {action_id} requires workspace")
    return validated


def _command_from_parameters(
    *,
    action_id: str,
    parameters: Mapping[str, Any],
    repo: Path,
) -> list[str]:
    spec = ACTION_REGISTRY[action_id]
    command = [sys.executable, str((repo / spec.script).resolve())]
    for flag, flag_spec in spec.flags.items():
        parameter = _parameter_name(flag)
        if parameter not in parameters:
            continue
        value = parameters[parameter]
        if flag_spec.value_type == "bool":
            command.append(flag)
            continue
        values = value if flag_spec.repeat else [value]
        for item in values:
            command.extend([flag, str(item)])
    return command


def materialize_registered_action(
    action: Mapping[str, Any],
    *,
    repo: Path,
    workspace: Path,
) -> dict[str, Any]:
    """Validate a producer-owned command and add its typed action record."""
    result = dict(action)
    if str(result.get("action_type") or "") != "run_command":
        return result
    action_id = str(result.get("action_id") or result.get("kind") or "").strip()
    if result.get("command") is None and result.get("parameters") is not None:
        parameters = _validate_parameters(
            result.get("parameters"),
            action_id=action_id,
            workspace=workspace.resolve(),
        )
    else:
        parameters = _parse_command(
            result.get("command"),
            action_id=action_id,
            repo=repo.resolve(),
            workspace=workspace.resolve(),
        )
    canonical = _command_from_parameters(
        action_id=action_id,
        parameters=parameters,
        repo=repo.resolve(),
    )
    # Reports carry typed intent, never the producer's executable token list.
    result.pop("command", None)
    result.update(
        {
            "action_schema_version": ACTION_SCHEMA_VERSION,
            "action_id": action_id,
            "parameters": parameters,
            "display_command": shlex.join(canonical),
        }
    )
    return result


def resolve_registered_action(
    action: Mapping[str, Any],
    *,
    repo: Path,
    workspace: Path,
) -> list[str]:
    """Resolve a report action to a fixed command after adversarial validation."""
    if str(action.get("action_schema_version") or "") != ACTION_SCHEMA_VERSION:
        raise ActionRegistryError("Legacy or missing action schema is not executable")
    action_id = str(action.get("action_id") or "").strip()
    parameters = _validate_parameters(
        action.get("parameters"),
        action_id=action_id,
        workspace=workspace.resolve(),
    )
    canonical = _command_from_parameters(
        action_id=action_id,
        parameters=parameters,
        repo=repo.resolve(),
    )
    display_command = str(action.get("display_command") or "").strip()
    if display_command and display_command != shlex.join(canonical):
        raise ActionRegistryError("Display command does not match the registered action")
    legacy_command = action.get("command")
    if legacy_command is not None:
        legacy_parameters = _parse_command(
            legacy_command,
            action_id=action_id,
            repo=repo.resolve(),
            workspace=workspace.resolve(),
        )
        if legacy_parameters != parameters:
            raise ActionRegistryError("Legacy command does not match registered parameters")
    return canonical


def registered_action_ids() -> tuple[str, ...]:
    return tuple(sorted(ACTION_REGISTRY))
