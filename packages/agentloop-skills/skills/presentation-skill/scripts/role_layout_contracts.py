#!/usr/bin/env python3
"""Load and validate declarative renderer role-layout contracts."""

from __future__ import annotations

import argparse
import copy
import json
from functools import lru_cache
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
CATALOG_PATH = ROOT / "references" / "renderer_role_contracts_v2.json"
CATALOG_SCHEMA_VERSION = "renderer_role_contract_catalog_v2"
CONTRACT_VERSION = "renderer_role_contracts_v2"
SUPPORTED_LAYOUT_VARIANTS = ("primary", "alternate", "dense")
ROLE_NAMES = (
    "title",
    "section",
    "evidence",
    "comparison",
    "chart",
    "table",
    "decision",
    "references",
)


@lru_cache(maxsize=1)
def load_role_layout_catalog() -> dict[str, Any]:
    payload = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    failures = validate_role_layout_catalog(payload)
    if failures:
        raise ValueError("Invalid renderer role-layout catalog: " + "; ".join(failures))
    return payload


def _rectangles_overlap(left: list[float], right: list[float]) -> bool:
    left_x, left_y, left_w, left_h = left
    right_x, right_y, right_w, right_h = right
    return not (
        left_x + left_w <= right_x
        or right_x + right_w <= left_x
        or left_y + left_h <= right_y
        or right_y + right_h <= left_y
    )


def _validate_contract(contract: Any, *, base: str) -> list[str]:
    failures: list[str] = []
    if not isinstance(contract, dict):
        return [f"{base} must be an object"]
    for field in ("system_id", "layout_family", "coordinate_space", "anchor_slot"):
        if not isinstance(contract.get(field), str) or not str(contract.get(field)).strip():
            failures.append(f"{base}.{field} must be a non-empty string")
    if contract.get("coordinate_space") not in {"slide", "body"}:
        failures.append(f"{base}.coordinate_space must be 'slide' or 'body'")
    reading_order = contract.get("reading_order")
    slots = contract.get("slots")
    if not isinstance(slots, dict) or not slots:
        failures.append(f"{base}.slots must be a non-empty object")
        slots = {}
    normalized_slots: dict[str, list[float]] = {}
    for slot_name, raw_rect in slots.items():
        if not isinstance(slot_name, str) or not slot_name.strip():
            failures.append(f"{base}.slots contains an invalid slot name")
            continue
        if not isinstance(raw_rect, list) or len(raw_rect) != 4:
            failures.append(f"{base}.slots.{slot_name} must be [x, y, w, h]")
            continue
        try:
            rect = [float(value) for value in raw_rect]
        except (TypeError, ValueError):
            failures.append(f"{base}.slots.{slot_name} must contain numbers")
            continue
        x, y, width, height = rect
        if width <= 0 or height <= 0 or x < 0 or y < 0 or x + width > 1.000001 or y + height > 1.000001:
            failures.append(f"{base}.slots.{slot_name} must fit inside normalized coordinates")
            continue
        normalized_slots[slot_name] = rect
    if not isinstance(reading_order, list) or not reading_order:
        failures.append(f"{base}.reading_order must be a non-empty list")
    else:
        unknown = [slot for slot in reading_order if slot not in normalized_slots]
        if unknown:
            failures.append(f"{base}.reading_order contains unknown slots {unknown}")
    if contract.get("anchor_slot") not in normalized_slots:
        failures.append(f"{base}.anchor_slot must name a declared slot")
    density = contract.get("density")
    if not isinstance(density, dict) or not str(density.get("level") or "").strip():
        failures.append(f"{base}.density.level must be a non-empty string")
    else:
        try:
            if int(density.get("max_items")) < 1:
                raise ValueError
        except (TypeError, ValueError):
            failures.append(f"{base}.density.max_items must be a positive integer")
    variants = contract.get("supported_variants")
    if not isinstance(variants, list) or not variants:
        failures.append(f"{base}.supported_variants must be a non-empty list")
    else:
        invalid_variants = [value for value in variants if value not in SUPPORTED_LAYOUT_VARIANTS]
        if invalid_variants:
            failures.append(f"{base}.supported_variants contains unsupported values {invalid_variants}")
    fallback = contract.get("fallback")
    if not isinstance(fallback, dict):
        failures.append(f"{base}.fallback must be an object")
    elif fallback.get("version") != "renderer_role_systems_v1" or not str(
        fallback.get("system_id") or ""
    ).strip():
        failures.append(f"{base}.fallback must identify a renderer_role_systems_v1 system")
    slot_items = list(normalized_slots.items())
    for index, (left_name, left_rect) in enumerate(slot_items):
        for right_name, right_rect in slot_items[index + 1 :]:
            if _rectangles_overlap(left_rect, right_rect):
                failures.append(f"{base}.slots.{left_name} overlaps {right_name}")
    return failures


def validate_role_layout_catalog(payload: Any) -> list[str]:
    failures: list[str] = []
    if not isinstance(payload, dict):
        return ["catalog must be an object"]
    if payload.get("schema_version") != CATALOG_SCHEMA_VERSION:
        failures.append(f"schema_version must be {CATALOG_SCHEMA_VERSION!r}")
    if payload.get("contract_version") != CONTRACT_VERSION:
        failures.append(f"contract_version must be {CONTRACT_VERSION!r}")
    if payload.get("supported_layout_variants") != list(SUPPORTED_LAYOUT_VARIANTS):
        failures.append("supported_layout_variants must be primary, alternate, dense")
    if payload.get("roles") != list(ROLE_NAMES):
        failures.append("roles must contain the canonical eight roles in order")
    grammars = payload.get("grammars")
    if not isinstance(grammars, dict) or len(grammars) != 8:
        failures.append("grammars must contain exactly eight composition grammars")
        return failures
    for grammar_id, roles in grammars.items():
        if not isinstance(roles, dict):
            failures.append(f"grammars.{grammar_id} must be an object")
            continue
        if set(roles) != set(ROLE_NAMES):
            failures.append(f"grammars.{grammar_id} must define exactly the canonical eight roles")
        for role in ROLE_NAMES:
            failures.extend(
                _validate_contract(roles.get(role), base=f"grammars.{grammar_id}.{role}")
            )
    for role in ROLE_NAMES:
        system_ids = {
            str(roles.get(role, {}).get("system_id") or "")
            for roles in grammars.values()
            if isinstance(roles, dict) and isinstance(roles.get(role), dict)
        }
        layout_families = {
            str(roles.get(role, {}).get("layout_family") or "")
            for roles in grammars.values()
            if isinstance(roles, dict) and isinstance(roles.get(role), dict)
        }
        if len(system_ids) != 8:
            failures.append(f"role {role!r} must have eight unique system IDs")
        if len(layout_families) != 8:
            failures.append(f"role {role!r} must have eight unique layout families")
    return failures


def renderer_role_contracts_for_grammar(grammar_id: str, *, preset: str = "") -> dict[str, Any]:
    catalog = load_role_layout_catalog()
    grammars = catalog["grammars"]
    key = str(grammar_id or "").strip()
    if key not in grammars:
        raise KeyError(f"unknown composition grammar: {grammar_id!r}")
    roles = copy.deepcopy(grammars[key])
    for role, contract in roles.items():
        contract["grammar_id"] = key
        contract["role"] = role
    return {
        "schema_version": CONTRACT_VERSION,
        "catalog_version": catalog["schema_version"],
        "composition_grammar_id": key,
        "style_preset": str(preset or "").strip(),
        "supported_layout_variants": list(SUPPORTED_LAYOUT_VARIANTS),
        "roles": roles,
    }


def renderer_role_contracts_for_preset(preset: str) -> dict[str, Any]:
    from taste_grammar_catalog import PRESET_TO_GRAMMAR

    key = str(preset or "").strip() or "executive-clinical"
    resolved_preset = key if key in PRESET_TO_GRAMMAR else "executive-clinical"
    return renderer_role_contracts_for_grammar(
        PRESET_TO_GRAMMAR[resolved_preset],
        preset=resolved_preset,
    )


def validate_renderer_role_contracts_v2(payload: Any, *, expected_preset: str = "") -> list[str]:
    failures: list[str] = []
    if not isinstance(payload, dict):
        return ["must be an object"]
    if payload.get("schema_version") != CONTRACT_VERSION:
        failures.append(f"schema_version must be {CONTRACT_VERSION!r}")
    if payload.get("catalog_version") != CATALOG_SCHEMA_VERSION:
        failures.append(f"catalog_version must be {CATALOG_SCHEMA_VERSION!r}")
    grammar_id = str(payload.get("composition_grammar_id") or "").strip()
    try:
        canonical = renderer_role_contracts_for_grammar(
            grammar_id,
            preset=str(payload.get("style_preset") or "").strip(),
        )
    except KeyError:
        return [*failures, f"unknown composition_grammar_id {grammar_id!r}"]
    preset = str(payload.get("style_preset") or "").strip()
    if expected_preset and preset != expected_preset:
        failures.append(f"style_preset {preset!r} does not match expected preset {expected_preset!r}")
    if payload.get("supported_layout_variants") != list(SUPPORTED_LAYOUT_VARIANTS):
        failures.append("supported_layout_variants must be primary, alternate, dense")
    if payload.get("roles") != canonical["roles"]:
        failures.append("roles must match the canonical contracts for the composition grammar")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preset", default="executive-clinical")
    parser.add_argument("--summary", action="store_true")
    args = parser.parse_args()
    catalog = load_role_layout_catalog()
    if args.summary:
        print(
            json.dumps(
                {
                    "passed": True,
                    "schema_version": catalog["schema_version"],
                    "contract_version": catalog["contract_version"],
                    "grammar_count": len(catalog["grammars"]),
                    "roles": catalog["roles"],
                    "systems_per_role": {
                        role: len({grammar[role]["system_id"] for grammar in catalog["grammars"].values()})
                        for role in ROLE_NAMES
                    },
                },
                indent=2,
            )
        )
        return 0
    print(json.dumps(renderer_role_contracts_for_preset(args.preset), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
