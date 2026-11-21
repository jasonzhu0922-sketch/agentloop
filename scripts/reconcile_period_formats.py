#!/usr/bin/env python3
"""Reconcile explicit period declarations with bounded source observations.

The procedure is generic: it walks period definitions from the catalog, checks
the physical storage shape, and marks contradictory declarations unresolved.
It never chooses one encoding from mixed data and never writes global coverage.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "apps/agentloop-data-agent/skills/data-analysis/scripts"
sys.path.insert(0, str(SKILL))
sys.path.insert(0, str(ROOT / "scripts"))

from data_access import load_gateway  # noqa: E402
from gateway.store import CatalogStore  # noqa: E402
from runtime_config import connections  # noqa: E402
from seed_local_semantic_model import build_semantics, materialize_field_formats  # noqa: E402


FORMAT_LENGTHS = {"%Y": {4}, "%Y%m": {6}, "%Y-%m": {7},
                  "%Y%m%d": {8}, "%Y-%m-%d": {10},
                  "YYYY": {4}, "YYYYMM": {6}, "YYYY-MM": {7},
                  "YYYYMMDD": {8}, "YYYY-MM-DD": {10}}


def reconcile(scenario_id="group"):
    gateway = load_gateway()
    index = gateway.catalog(scenario_id)
    details = {table["name"]: gateway.catalog(scenario_id, [table["name"]])["tables"][0]
               for table in index["tables"]}
    settings = connections()
    store = CatalogStore(settings)
    with store.connect(readonly=False) as cursor:
        cursor.execute("SELECT config FROM scenarios WHERE id=%s FOR UPDATE", (scenario_id,))
        row = cursor.fetchone()
        if not row:
            raise ValueError("scenario not found: " + scenario_id)
        raw = row["config"] if isinstance(row["config"], dict) else json.loads(row["config"])
        updated = deepcopy(raw)
        table_map = {table.get("name"): table for table in updated.get("tables", [])}
        changes = []
        for period in updated.get("period_formats", []):
            source, field = period.get("source_id"), period.get("field")
            table = details.get(source)
            column = next((item for item in (table or {}).get("columns", [])
                           if item.get("name") == field), None)
            if not table or not column:
                continue
            physical_type = str(column.get("type", "")).lower()
            if not any(token in physical_type for token in ("char", "text", "binary")):
                continue
            if not isinstance(field, str) or not field.isidentifier() or not field.isascii():
                continue
            sql = (f"SELECT CHAR_LENGTH(`{field}`) AS value_length, COUNT(*) AS frequency "
                   f"FROM `{table['schema']}`.`{source}` GROUP BY CHAR_LENGTH(`{field}`) "
                   "ORDER BY value_length")
            observed = gateway.execute_sql(scenario_id, sql, [])
            if observed.get("status") != "completed":
                continue
            shapes = observed.get("dataset", {}).get("rows", [])
            lengths = {row.get("value_length") for row in shapes if isinstance(row.get("value_length"), int)}
            expected = FORMAT_LENGTHS.get(period.get("format"), set())
            if not lengths or (expected and lengths <= expected):
                continue
            declared_format = period.get("format")
            # Persist only a source/field-scoped observed_only receipt. The
            # declared global period variant remains untouched until a human
            # confirms the format and selector.
            updated.setdefault("observed_probes", []).append({
                "source_id": source, "field": field, "status": "observed_only",
                "scope": {"kind": "source", "source_id": source, "field": field,
                          "completeness": "observed_only"},
                "evidence": {"query_id": observed.get("query_id"), "sql": observed.get("sql"),
                             "params": observed.get("params", []), "observed_at": datetime.now(timezone.utc).isoformat()},
                "observed_shapes": shapes,
            })
            gap_id = f"definition_gap:time:{source}:{field}"
            gaps = updated.setdefault("semantic_gaps", [])
            if not any(gap.get("gap_id") == gap_id for gap in gaps):
                gaps.append({"gap_id": gap_id,
                    "code": "time_format_unresolved", "status": "unresolved", "blocking": True,
                    "source_ids": [source], "affected_refs": [f"time:{source}:{field}"],
                    "evidence": ["probe:" + str(observed.get("query_id"))],
                    "meaning": "Physical values contain multiple shapes; choose a source-local period variant with evidence."})
            changes.append({"source_id": source, "field": field,
                            "declared_format": declared_format,
                            "observed_shapes": shapes})
        updated, _ = materialize_field_formats(updated)
        updated.update(build_semantics(updated, scenario_id))
        cursor.execute("UPDATE scenarios SET config=%s WHERE id=%s",
                       (json.dumps(updated, ensure_ascii=False, separators=(",", ":")), scenario_id))
    return changes


if __name__ == "__main__":
    print(json.dumps({"scenario_id": "group", "changes": reconcile()}, ensure_ascii=False, indent=2))
