"""Skill-owned catalog and query workflow using its bundled deterministic gateway."""
from __future__ import annotations

import hashlib
import json
from time import monotonic
from uuid import uuid4
from query_errors import QueryParameterError, query_diagnostic
from catalog_knowledge import catalog_config, prepare_knowledge, project_sources
from entity_binding import EntityBindingError, lookup_spec, resolution_result, validate_plan


def catalog_projection(config, scenario_id, revision=None):
    knowledge = catalog_config(config)
    value = {"schema": "nl2sql.data-catalog/v1", "scenario_id": scenario_id,
             "database_engine": "tidb", "sql_dialect": "mysql",
             **knowledge}
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    value["catalog_revision"] = revision or hashlib.sha256(encoded).hexdigest()
    value.update(prepare_knowledge(knowledge))
    return value


class Gateway:
    def __init__(self, store, scope, physical_catalog, execute, policy_error):
        self.store, self.scope, self.physical_catalog = store, scope, physical_catalog
        self.execute, self.policy_error = execute, policy_error

    def scenarios(self):
        # Only identity and business descriptions reach the model.
        return [{key: row[key] for key in ("id", "name", "description")}
                for row in self.store.list_scenarios()]

    def catalog(self, scenario_id, source_ids=None, question=None):
        if question is not None and (not isinstance(question, str) or not question.strip() or len(question) > 4000):
            raise ValueError("Catalog question must contain 1..4000 characters")
        with self.scope(self.store.get_scenario(scenario_id)):
            config = self.store.load_config()
            revision = catalog_projection(config, scenario_id)['catalog_revision']
            value = catalog_projection(self.physical_catalog(config), scenario_id, revision)
        requested = set(source_ids or [])
        tables = value["tables"]
        if requested - {table["name"] for table in tables}:
            raise ValueError("Source is absent from the selected scenario")
        return project_sources(value, requested, question)

    def knowledge(self, action, scenario_id, request):
        from semantic_retrieval import validate_request, selected_sources, configured_scope, response, check
        from gateway.query_policy import allowed_relations
        validate_request(action, request)
        scenario, raw = self.store.read_snapshot(scenario_id)
        with self.scope(scenario):
            revision = catalog_projection(raw, scenario_id)['catalog_revision']
            config = configured_scope(raw, allowed_relations())
            snapshot = catalog_projection(config, scenario_id, revision)
            sources = selected_sources(request)
            check(not (sources - {t['name'] for t in snapshot['tables']}),
                  'source_not_authorized', 'Source is outside the selected scenario catalog')
            check(not request.get('catalog_revision') or request['catalog_revision'] == revision,
                  'knowledge_revision_changed', 'Catalog definitions changed; retrieve and rebind affected knowledge')
            if action in {'search-columns', 'get-columns', 'get-query-context'}:
                # Keep related-source identities and definitions, refresh only selected physical tables.
                current = self.physical_catalog(config, source_ids=sources)
                live = {t['name']: t for t in current['tables']}
                config['tables'] = [live.get(t['name'], t) for t in config['tables']]
                config['relationships'] = list({r['id']: r for r in config['relationships'] + current['relationships']}.values())
                catalog = catalog_projection(config, scenario_id, revision)
            else:
                catalog = snapshot
        return response(catalog, action, request)

    def resolve_entity(self, scenario_id, request):
        catalog = self.catalog(scenario_id, [request.get('source_id')], question=request.get('mention'))
        spec = lookup_spec(catalog, request)
        lookup = self.execute_sql(scenario_id, spec['sql'], spec['params'])
        return resolution_result(catalog, spec, lookup)

    def execute_sql(self, scenario_id, sql, params, query_plan=None):
        started = monotonic()
        result = {"schema": "nl2sql.query-result/v1", "scenario_id": scenario_id,
                  "query_id": "query_" + uuid4().hex, "sql": sql, "params": params}
        with self.scope(self.store.get_scenario(scenario_id)):
            raw = self.store.load_config()
            revision = catalog_projection(raw, scenario_id)['catalog_revision']
            config = self.physical_catalog(raw)
            catalog = catalog_projection(config, scenario_id, revision)
            result["catalog_revision"] = catalog["catalog_revision"]
            if query_plan is not None:
                result['query_plan'] = query_plan
            config["_run_id"] = result["query_id"]
            config["_query_audit"] = self.store.record_query_audit
            try:
                if query_plan is not None:
                    result['plan_verification'] = validate_plan(catalog, sql, params, query_plan)
                dataset = self.execute(sql, params, config)
            except EntityBindingError as exc:
                entity_error = exc.code.startswith(('entity_', 'term_', 'canonical_', 'matched_term_'))
                result.update(status='rejected', plan_verification={'status': 'rejected', 'code': exc.code},
                              error={'code': 'entity_binding_rejected' if entity_error else 'query_plan_rejected',
                                     'message': str(exc), 'diagnostic': {
                                         'phase': 'query.entity_binding' if entity_error else 'query.plan', 'code': exc.code}})
                self.store.record_query_audit({'run_id': result['query_id'],
                    'query_hash': hashlib.sha256(sql.encode()).hexdigest(),
                    'params_hash': hashlib.sha256(json.dumps(params, ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
                    'decision': 'rejected', 'reason': exc.code})
            except QueryParameterError as exc:
                result.update(status="rejected", error={"code": "query_parameter_invalid", "message": str(exc),
                                                       "diagnostic": query_diagnostic(exc)})
            except self.policy_error as exc:
                result.update(status="rejected", error={"code": "query_policy_rejected", "message": str(exc),
                                                       "diagnostic": {"phase": getattr(exc, "phase", "query.validate"),
                                                                      "code": "query_policy_rejected"}})
            except Exception as exc:
                result.update(status="failed", error={"code": "query_execution_failed",
                                                      "message": "Read-only query failed; check SQL, field types or gateway availability"})
                diagnostic = query_diagnostic(exc)
                result["error"]["diagnostic"] = diagnostic
                for key in ("sqlstate", "position"):
                    if key in diagnostic:
                        result["error"][key] = diagnostic[key]
            else:
                result.update(status="completed", dataset=dataset, error=None)
        result["duration_ms"] = round((monotonic() - started) * 1000)
        return result


def load_gateway():
    """Load only code and connection settings contained in this Skill package."""
    from runtime_config import connections
    from gateway.store import CatalogStore
    from gateway.scenarios import scenario_scope
    from gateway.table_catalog import physical_catalog
    from gateway.database import execute_readonly
    from gateway.query_policy import QueryPolicyError
    return Gateway(CatalogStore(connections()), scenario_scope, physical_catalog,
                   execute_readonly, QueryPolicyError)
