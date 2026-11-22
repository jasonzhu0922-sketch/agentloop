#!/usr/bin/env python3
"""Persist only explicit, source-backed semantic definitions.

The catalog is the authority for this seed operation. This script deliberately
does not classify tables from names, infer a term's source from its wording,
sample rows, or manufacture observed date ranges. Missing or unresolved
definitions remain gaps so the Skill can request a bounded probe later.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit


MODEL_VERSION = "nl2sql.semantic-model/v1"
FORMAT_DISPLAY = {
    "%Y": "YYYY", "%Y%m": "YYYYMM", "%Y-%m": "YYYY-MM",
    "%Y%m%d": "YYYYMMDD", "%Y-%m-%d": "YYYY-MM-DD",
    "YYYY": "YYYY", "YYYYMM": "YYYYMM", "YYYY-MM": "YYYY-MM",
    "YYYYMMDD": "YYYYMMDD", "YYYY-MM-DD": "YYYY-MM-DD",
}


def object_id(kind, source_id, identity):
    return f"{kind}:{source_id + ':' if source_id else ''}{identity}"


def _evidence(definition):
    values = [*(definition.get("evidence", []) or []), *(definition.get("evidence_ids", []) or [])]
    provenance = definition.get("provenance")
    if isinstance(provenance, dict):
        values.extend(provenance.get(key) for key in ("discovery_id", "evidence_id"))
    return list(dict.fromkeys(value for value in values if isinstance(value, str) and value))


def _status(definition, *, default="provisional"):
    value = definition.get("status") or definition.get("definition_status")
    if value in {"confirmed", "provisional", "unresolved", "stale", "invalid"}:
        return value
    return default


def _scope(source_id, *, scenario_id):
    return {"kind": "source" if source_id else "domain", "scenario_id": scenario_id,
            **({"source_id": source_id} if source_id else {}), "completeness": "partial"}


def materialize_field_formats(config):
    """Move explicit legacy period definitions onto their physical fields.

    This is a structural migration only: it copies a persisted definition and
    never derives a format from a field name or from sampled rows.
    """
    updated = deepcopy(config)
    tables = {table.get("name"): table for table in updated.get("tables", [])}
    migrated = 0
    for period in updated.get("period_formats", []):
        table = tables.get(period.get("source_id"))
        if not table:
            continue
        column = next((item for item in table.get("columns", [])
                       if item.get("name") == period.get("field")), None)
        if not column or not period.get("format"):
            continue
        if not column.get("format"):
            column["format"] = FORMAT_DISPLAY.get(period["format"], period["format"])
            migrated += 1
        if not column.get("granularity") and period.get("granularity"):
            column["granularity"] = period["granularity"]
    return updated, migrated


def generic_entity_id(entity):
    """Create a stable executable identity from source fields, never a domain type."""
    source = entity.get("source_id")
    key = entity.get("key_field")
    selector = entity.get("scope_filter") or {}
    suffix = f":scope:{selector['field']}" if isinstance(selector, dict) and selector.get("field") else ""
    if not isinstance(source, str) or not isinstance(key, str) or not source or not key:
        return entity.get("id")
    return f"entity:{source}:{key}{suffix}"


def normalize_generic_entities(config):
    """Migrate legacy domain IDs while preserving catalog labels and evidence."""
    updated = deepcopy(config)
    mapping = {}
    for entity in updated.get("entities", []):
        old = entity.get("id")
        new = generic_entity_id(entity)
        if old and new and old != new:
            mapping[old] = new
            entity["id"] = new
        entity.setdefault("semantic_role", "dimension")
        entity.setdefault("status", "provisional")
    for relation in updated.get("relationships", []):
        for side in ("parent", "child", "subject", "object"):
            value = relation.get(side)
            if isinstance(value, dict) and value.get("entity_id") in mapping:
                value["entity_id"] = mapping[value["entity_id"]]
        if isinstance(relation.get("parent"), dict) and isinstance(relation.get("child"), dict):
            source = relation["parent"].get("source_id") or relation.get("left", {}).get("source_id", "")
            fields = relation["parent"].get("fields") or relation.get("left", {}).get("fields") or ["relation"]
            relation["id"] = f"relationship:{source}:{':'.join(fields)}:hierarchy"
    # A period row without an explicit format is an unresolved observation,
    # never a global format variant. Its evidence remains in semantic_gaps.
    periods, unresolved = [], []
    observed_probes = updated.setdefault("observed_probes", [])
    for period in updated.get("period_formats", []):
        if not period.get("format") or not period.get("granularity"):
            unresolved.append(period)
            evidence_ids = _evidence(period)
            query_id = next((value.split(":", 1)[1] for value in evidence_ids if value.startswith("probe:")), None)
            if period.get("observed_shapes") and not any(item.get("source_id") == period.get("source_id")
                                                         and item.get("field") == period.get("field")
                                                         and item.get("status") == "observed_only"
                                                         for item in observed_probes):
                observed_probes.append({"source_id": period.get("source_id"), "field": period.get("field"),
                                        "status": "observed_only",
                                        "scope": {"kind": "source", "source_id": period.get("source_id"),
                                                  "field": period.get("field"), "completeness": "observed_only"},
                                        "evidence": {"query_id": query_id, "observed_at": None},
                                        "observed_shapes": deepcopy(period.get("observed_shapes", []))})
            continue
        period.setdefault("variant_id", f"period:{period.get('source_id')}:{period.get('field')}:{period.get('format')}:{period.get('granularity')}")
        period.setdefault("status", "confirmed")
        periods.append(period)
    updated["period_formats"] = periods
    gaps = updated.setdefault("semantic_gaps", [])
    for period in unresolved:
        source, field = period.get("source_id"), period.get("field")
        gap_id = f"definition_gap:time:{source}:{field}"
        if not any(g.get("gap_id") == gap_id for g in gaps):
            gaps.append({"gap_id": gap_id, "code": "time_format_unresolved", "status": "unresolved",
                         "blocking": True, "affected_refs": [object_id("time", source, field)],
                         "source_ids": [source], "meaning": "Period storage format is missing or conflicting; probe evidence remains source-local.",
                         "evidence": _evidence(period)})
    return updated, mapping


def enrich_generic_metric_properties(config):
    """Materialize optional metric properties from explicit SQL and period facts."""
    updated = deepcopy(config)
    periods = {(p.get("source_id"), p.get("field")): p for p in updated.get("period_formats", [])}
    for metric in updated.get("metrics", []):
        expression = str(metric.get("expression", ""))
        match = re.match(r"\s*(COUNT|SUM|AVG|AVERAGE|MIN|MAX)\s*\(", expression, re.I)
        if match:
            aggregation = match.group(1).lower()
            metric.setdefault("aggregation", "average" if aggregation == "avg" else aggregation)
            metric.setdefault("measure_kind", "count" if aggregation == "count" else "numeric")
        grain = metric.get("grain") or []
        candidates = [field for field in grain if (metric.get("table"), field) in periods]
        if len(candidates) == 1:
            period = periods[(metric.get("table"), candidates[0])]
            metric.setdefault("time_field", candidates[0])
            metric.setdefault("frequency", period.get("granularity"))
            metric.setdefault("time_format", period.get("format"))
    return updated


def build_semantics(config, scenario_id="group"):
    """Build a semantic graph from persisted definitions without business rules."""
    config, _ = normalize_generic_entities(config)
    tables = config.get("tables", [])
    table_ids = {table.get("name") for table in tables if table.get("name")}
    objects, bindings, gaps = [], [], deepcopy(config.get("semantic_gaps", []))

    def add_object(kind, source_id, identity, definition, *, status=None, gap_refs=None,
                   layer=None, parent_ref=None, semantic_role=None):
        ref = object_id(kind, source_id, identity)
        evidence = _evidence(definition)
        row = {
            "object_id": ref, "kind": kind, "source_id": source_id,
            "identity": identity, "label": definition.get("label", identity),
            "status": status or _status(definition), "completeness": "partial",
            "scope": _scope(source_id, scenario_id=scenario_id),
            "evidence": evidence, "gap_refs": list(gap_refs or []),
            "layer": layer or definition.get("layer") or kind,
            "semantic_role": semantic_role or definition.get("semantic_role") or "definition",
        }
        if parent_ref:
            row["parent_ref"] = parent_ref
        objects.append(row)
        return ref, row

    for table in tables:
        source = table.get("name")
        if not source:
            continue
        ref, row = add_object("source", source, source, table, status="confirmed", layer="source",
                              semantic_role="physical_source")
        row["evidence"] = list(dict.fromkeys([f"table_catalog:{source}", *row["evidence"]]))
        bindings.append({"binding_id": f"source-binding:{source}", "semantic_ref": ref,
                         "source_id": source, "relation": "physical_source",
                         "status": row["status"], "evidence": row["evidence"]})

    for metric in config.get("metrics", []):
        source, identity = metric.get("table"), metric.get("name")
        if not source or not identity or source not in table_ids:
            continue
        ref, row = add_object("metric", source, identity, metric, layer="measure",
                              parent_ref=object_id("source", source, source), semantic_role="measure")
        bindings.append({"binding_id": f"metric-binding:{source}:{identity}",
                         "semantic_ref": ref, "source_id": source,
                         "relation": "metric_definition", "status": row["status"],
                         "evidence": row["evidence"]})

    for term in config.get("terms", []):
        identity, source = term.get("term"), term.get("source_id")
        if not identity:
            continue
        status = _status(term, default="confirmed" if term.get("meaning") else "unresolved")
        gap_refs = []
        if status in {"unresolved", "invalid"} or not term.get("meaning"):
            gap_id = f"definition_gap:term:{source or 'domain'}:{identity}"
            gap_refs.append(gap_id)
            gaps.append({"gap_id": gap_id, "code": "definition_unresolved",
                         "status": "unresolved", "blocking": True,
                         "affected_refs": [object_id("term", source, identity)],
                         "source_ids": [source] if source else [],
                         "meaning": "Term meaning or source binding is not confirmed; resolve from catalog evidence or a bounded probe.",
                         "evidence": _evidence(term)})
        ref, row = add_object("term", source, identity, term, status=status, gap_refs=gap_refs,
                              layer="term", parent_ref=(object_id("source", source, source) if source else None),
                              semantic_role="lexical_definition")
        row["projection_of"] = {"collection": "terms", "key": "term", "value": identity}
        if source in table_ids:
            bindings.append({"binding_id": f"term-binding:{source}:{identity}",
                             "semantic_ref": ref, "source_id": source,
                             "relation": "term_source", "status": row["status"],
                             "evidence": row["evidence"]})

    for entity in config.get("entities", []):
        source, entity_id = entity.get("source_id"), entity.get("id")
        if not source or not entity_id or source not in table_ids:
            continue
        # The executable entity ID is already ``entity:<source>:<field>``.
        # Store only the identity portion in the graph so object_id remains
        # exactly the same source-bound ID instead of duplicating the prefix.
        prefix = f"entity:{source}:"
        identity = entity_id[len(prefix):] if entity_id.startswith(prefix) else entity_id
        ref, row = add_object("entity", source, identity, entity,
                              status=_status(entity, default="provisional"), layer="object",
                              parent_ref=object_id("source", source, source), semantic_role=entity.get("semantic_role", "dimension"))
        bindings.append({"binding_id": f"entity-binding:{source}:{entity_id}",
                         "semantic_ref": ref, "source_id": source,
                         "relation": "entity_lookup", "status": row["status"],
                         "evidence": row["evidence"]})

    for period in config.get("period_formats", []):
        source, identity = period.get("source_id"), period.get("field")
        if not source or not identity or source not in table_ids:
            continue
        complete = bool(period.get("format") and period.get("granularity"))
        status = _status(period, default="confirmed" if complete else "unresolved")
        gap_refs = []
        if not complete or status in {"unresolved", "invalid"}:
            gap_id = f"definition_gap:time:{source}:{identity}"
            gap_refs.append(gap_id)
            gaps.append({"gap_id": gap_id, "code": "time_format_unresolved",
                         "status": "unresolved", "blocking": True,
                         "affected_refs": [object_id("time", source, identity)],
                         "source_ids": [source],
                         "meaning": "Period storage format is missing or conflicting; inspect the physical definition and probe representative values before binding a range.",
                         "evidence": _evidence(period)})
        ref, row = add_object("time", source, identity, period, status=status, gap_refs=gap_refs,
                              layer="time", parent_ref=object_id("source", source, source), semantic_role="period")
        bindings.append({"binding_id": f"time-binding:{source}:{identity}",
                         "semantic_ref": ref, "source_id": source,
                         "relation": "time_format", "status": row["status"],
                         "evidence": row["evidence"]})

    # Field-level objects complete the generic hierarchy without assigning a
    # domain type. Only fields with maintained descriptions or format facts
    # are materialized; the physical schema remains the authority for all
    # other columns.
    for table in tables:
        source = table.get("name")
        for column in table.get("columns", []):
            if not any(column.get(key) for key in ("label", "description", "format", "granularity", "value_domain")):
                continue
            identity = column.get("name")
            ref, row = add_object("attribute", source, identity, column, status="confirmed",
                                  layer="attribute", parent_ref=object_id("source", source, source),
                                  semantic_role="field")
            row["label"] = column.get("label") or identity
            bindings.append({"binding_id": f"attribute-binding:{source}:{identity}",
                             "semantic_ref": ref, "source_id": source,
                             "relation": "attribute_definition", "status": row["status"],
                             "evidence": row["evidence"]})

    # Coverage is never manufactured here. A later bounded probe may persist
    # an observed_only record with its query/evidence; it is never global fact.
    return {"semantic_model_version": MODEL_VERSION, "semantic_objects": objects,
            "source_bindings": bindings, "coverage": [],
            "observed_probes": deepcopy(config.get("observed_probes", [])),
            "semantic_gaps": gaps}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", default="group")
    args = parser.parse_args()
    skill_root = Path(__file__).resolve().parents[1] / "skills" / "data-analysis"
    sys.path.insert(0, str(skill_root / "scripts"))
    from runtime_config import connections
    from gateway.store import CatalogStore
    settings = connections()
    parsed = urlsplit(settings["catalog_database_url"])
    if parsed.hostname != "127.0.0.1" or parsed.port != 4000 or parsed.path.strip("/") != "nl2sql_skill":
        raise SystemExit("refusing to seed a non-local nl2sql_skill database")
    store = CatalogStore(settings)
    with store.connect(readonly=False) as cursor:
        cursor.execute("SELECT config FROM scenarios WHERE id=%s", (args.scenario,))
        row = cursor.fetchone()
        if not row:
            raise SystemExit(f"scenario not found: {args.scenario}")
        config = row["config"] if isinstance(row["config"], dict) else json.loads(row["config"])
        updated, migrated = materialize_field_formats(config)
        updated, _ = normalize_generic_entities(updated)
        updated = enrich_generic_metric_properties(updated)
        updated.update(build_semantics(updated, args.scenario))
        cursor.execute("UPDATE scenarios SET config=%s WHERE id=%s",
                       (json.dumps(updated, ensure_ascii=False, separators=(",", ":")), args.scenario))
    print(json.dumps({"scenario_id": args.scenario, "semantic_model_version": MODEL_VERSION,
                      "semantic_objects": len(updated["semantic_objects"]),
                      "source_bindings": len(updated["source_bindings"]),
                      "field_formats_migrated": migrated,
                      "coverage": len(updated["coverage"]),
                      "semantic_gaps": updated["semantic_gaps"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
