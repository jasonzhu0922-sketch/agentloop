"""Skill-owned catalog and query workflow using its bundled deterministic gateway."""
from __future__ import annotations

from copy import deepcopy
import hashlib
import inspect
import json
from time import monotonic
from datetime import datetime, timezone
from uuid import uuid4
from query_errors import QueryParameterError, query_diagnostic
from catalog_knowledge import (catalog_config, prepare_knowledge, project_sources, semantic_metadata,
                               table_signature)
from entity_binding import (EntityBindingError, lookup_spec, query_plan_from_artifact,
                            resolution_result, validate_plan)


def catalog_projection(config, scenario_id, revision=None, *, schema_verified=True):
    knowledge = catalog_config(config)
    value = {"schema": "nl2sql.data-catalog/v1", "scenario_id": scenario_id,
             "database_engine": "tidb", "sql_dialect": "mysql",
             **knowledge}
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    value["catalog_revision"] = revision or hashlib.sha256(encoded).hexdigest()
    value.update(prepare_knowledge(knowledge, schema_verified=schema_verified))
    return value


class Gateway:
    def __init__(self, store, scope, physical_catalog, execute, policy_error):
        self.store, self.scope, self.physical_catalog = store, scope, physical_catalog
        self.execute, self.policy_error = execute, policy_error

    def _snapshot(self, scenario_id, *, reuse=True, verify_current=True, reader_required=False):
        """Use the Run snapshot when available, while keeping test/custom stores compatible."""
        reader = getattr(self.store, 'read_snapshot', None)
        connections = getattr(self.store, 'connections', None)
        is_catalog_store = (type(connections) is dict and 'query_databases' in connections)
        if callable(reader) and (reader_required or is_catalog_store):
            target = getattr(reader, 'side_effect', None)
            if not callable(target):
                target = reader
            parameters = inspect.signature(target).parameters
            supports_snapshot_options = ('reuse' in parameters or 'verify_current' in parameters
                                         or any(p.kind is inspect.Parameter.VAR_KEYWORD
                                                for p in parameters.values()))
            if supports_snapshot_options:
                return reader(scenario_id, reuse=reuse, verify_current=verify_current)
            # Existing Skill-local test stores expose the original
            # one-argument contract.
            return reader(scenario_id)
        scenario = self.store.get_scenario(scenario_id)
        with self.scope(scenario):
            return scenario, self.store.load_config()

    def scenarios(self):
        # Only identity and business descriptions reach the model.
        return [{key: row[key] for key in ("id", "name", "description")}
                for row in self.store.list_scenarios()]

    def catalog(self, scenario_id, source_ids=None, question=None):
        if question is not None and (not isinstance(question, str) or not question.strip() or len(question) > 4000):
            raise ValueError("Catalog question must contain 1..4000 characters")
        scenario, raw = self._snapshot(scenario_id, verify_current=True)
        with self.scope(scenario):
            config = raw
            revision = catalog_projection(config, scenario_id)['catalog_revision']
            value = catalog_projection(self.physical_catalog(config), scenario_id, revision)
        requested = set(source_ids or [])
        tables = value["tables"]
        if requested - {table["name"] for table in tables}:
            raise ValueError("Source is absent from the selected scenario")
        return project_sources(value, requested, question)

    def quick_query(self, scenario_id, request):
        """Execute one whitelisted catalog-derived lookup without model-authored SQL."""
        if not isinstance(request, dict) or set(request) - {'kind', 'source_label', 'dimension_labels', 'count_label'}:
            raise ValueError('Quick query only accepts its declared request fields')
        kind = request.get('kind')
        scenario, raw = self._snapshot(scenario_id, verify_current=True)
        with self.scope(scenario):
            revision = catalog_projection(raw, scenario_id)['catalog_revision']
            catalog = catalog_projection(self.physical_catalog(raw), scenario_id, revision)
        quote = lambda value: '`' + value + '`'

        def identifier(value):
            if not isinstance(value, str) or not value.isidentifier() or not value.isascii():
                raise ValueError('Quick query requires valid physical identifiers')
            return value

        def table_ref(table):
            return quote(identifier(table['schema'])) + '.' + quote(identifier(table['name']))

        def source_plan(tables):
            bindings = [semantic_metadata(
                catalog, 'source', table['name'], table['name'],
                definition=next((item for item in catalog.get('table_summaries', [])
                                 if item.get('source_id') == table['name']), None),
            ) for table in tables]
            return {'schema': 'nl2sql.query-plan/v1', 'scenario_id': scenario_id,
                    'catalog_revision': catalog['catalog_revision'],
                    'source_signatures': {table['name']: table_signature(table) for table in tables},
                    'semantic_model_version': catalog.get('semantic_model_version'),
                    'metric_bindings': [], 'entity_bindings': [], 'time_bindings': [],
                    'semantic_bindings': bindings, 'semantic_gap_refs': []}

        if kind == 'scenario_table_counts':
            tables = catalog['tables']
            if not tables:
                raise ValueError('Selected scenario has no authorized tables')
            sql = ' UNION ALL '.join(
                "SELECT %s AS source_id, %s AS source_label, COUNT(*) AS row_count FROM " + table_ref(table)
                for table in tables)
            params = [value for table in tables
                      for value in (table['name'], table.get('label') or table['name'])]
            result = self.execute_sql(scenario_id, sql, params, source_plan(tables))
            result.update(quick_query_kind=kind, deterministic_answer=True)
            return result

        if kind == 'source_dimension_counts':
            source_label = request.get('source_label')
            dimension_labels = request.get('dimension_labels')
            count_label = request.get('count_label')
            if (not isinstance(source_label, str) or not source_label.strip()
                    or not isinstance(dimension_labels, list) or not 1 <= len(dimension_labels) <= 4
                    or any(not isinstance(value, str) or not value.strip() for value in dimension_labels)
                    or not isinstance(count_label, str) or not count_label.strip()):
                raise ValueError('Quick dimension counts need source_label, dimension_labels and count_label')
            sources = [table for table in catalog['tables']
                       if source_label in {table['name'], table.get('label')}
                       or source_label in (table.get('label') or '')]
            if len(sources) != 1:
                raise ValueError('Quick query source label must identify exactly one table')
            table = sources[0]
            columns = table.get('columns', [])

            def match_column(label):
                exact = [column for column in columns if label in {column.get('name'), column.get('label')}]
                partial = [column for column in columns if label in (column.get('label') or '')
                           or (column.get('label') or '') in label]
                matches = exact or partial
                if len(matches) != 1 or matches[0].get('allow_output') is False:
                    raise ValueError('Quick query field label must identify exactly one output column')
                return matches[0]

            dimensions = [match_column(label) for label in dimension_labels]
            count_column = match_column(count_label)
            sql_parts, params = [], []
            for column in dimensions:
                name = identifier(column['name'])
                count_name = identifier(count_column['name'])
                sql_parts.append(
                    "SELECT %s AS dimension_field, %s AS dimension_label, "
                    + quote(name) + " AS dimension_value, COUNT(DISTINCT " + quote(count_name)
                    + ") AS item_count FROM " + table_ref(table) + " WHERE " + quote(name)
                    + " IS NOT NULL AND TRIM(CAST(" + quote(name) + " AS CHAR)) <> '' GROUP BY "
                    + quote(name))
                params.extend([name, column.get('label') or name])
            sql = ' UNION ALL '.join(sql_parts) + ' ORDER BY dimension_field, item_count DESC, dimension_value'
            result = self.execute_sql(scenario_id, sql, params, source_plan([table]))
            result.update(quick_query_kind=kind, deterministic_answer=True,
                          source_id=table['name'], source_label=table.get('label') or table['name'])
            return result

        raise ValueError('Unsupported quick query kind')

    def knowledge(self, action, scenario_id, request):
        from semantic_retrieval import validate_request, selected_sources, configured_scope, response, check
        from gateway.query_policy import allowed_relations
        validate_request(action, request)
        # Retrieval after the first stage carries catalog_revision. Reuse the
        # immutable Run snapshot across independent CLI processes; execution
        # still performs a fresh authoritative read below.
        scenario, raw = self._snapshot(scenario_id, reuse=True,
                                       reader_required=True,
                                       verify_current=not bool(request.get('catalog_revision')))
        with self.scope(scenario):
            revision = catalog_projection(raw, scenario_id)['catalog_revision']
            config = configured_scope(raw, allowed_relations())
            # Stored table rows may omit native precision, nullability or
            # normalized types included in the live signature. This read has
            # not verified physical drift: retain maintained summaries for
            # discovery and qualify them as unverified. Live selected-source
            # retrieval below still rejects stale executable definitions.
            snapshot = catalog_projection(config, scenario_id, revision, schema_verified=False)
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

    def candidate_lookup(self, scenario_id, request):
        """Return bounded fuzzy candidates without creating an executable binding."""
        if not isinstance(request, dict) or not all(isinstance(request.get(key), str) and request[key].strip()
                                                    for key in ('source_id', 'entity_id', 'mention')):
            raise ValueError('source_id, entity_id and mention are required')
        limit = request.get('limit', 20)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError('limit is outside its bounds')
        catalog = self.catalog(scenario_id, [request['source_id']], question=request['mention'])
        entity = next((item for item in catalog.get('entities', [])
                       if item.get('id') == request['entity_id']), None)
        if not entity:
            raise ValueError('Entity definition is absent from the selected source')
        fields = list(dict.fromkeys([entity.get('key_field'), *entity.get('name_fields', [])]))
        if not entity.get('name_fields') or any(not isinstance(field, str) or not field.isidentifier() or not field.isascii()
                                                for field in fields):
            raise ValueError('Entity definition is not executable')
        table = next(item for item in catalog['tables'] if item['name'] == request['source_id'])
        quote = lambda value: '`' + value + '`'
        sql = ('SELECT DISTINCT ' + ', '.join(quote(field) for field in fields) + ' FROM '
               + quote(table['schema']) + '.' + quote(table['name']) + ' WHERE '
               + ' OR '.join(quote(field) + ' LIKE %s' for field in entity['name_fields'])
               + f' LIMIT {limit}')
        params = [f"%{request['mention']}%"] * len(entity['name_fields'])
        result = self.execute_sql(scenario_id, sql, params)
        return {"schema": "nl2sql.entity-candidates/v1", "scenario_id": scenario_id,
                "catalog_revision": catalog['catalog_revision'], "status": result.get('status'),
                "source_id": request['source_id'], "entity_id": request['entity_id'],
                "mention": request['mention'], "candidate_lookup": {
                    'mode': 'candidate_lookup', 'query_id': result.get('query_id'),
                    'sql': result.get('sql'), 'params': result.get('params', []),
                    'status': result.get('status'), 'truncated': True},
                "selection_evidence": None, "selected_codes": [],
                "candidates": result.get('dataset', {}).get('rows', []),
                "error": result.get('error')}

    def probe_values(self, scenario_id, source_id, field, limit=50, request=None):
        """Bounded, source-local value probe for an unresolved field definition.

        The probe is intentionally generic: it only uses the live schema to
        validate identifiers and returns observed values as evidence. It never
        promotes a value range or encoding to a global semantic definition.
        """
        if not isinstance(source_id, str) or not source_id.strip() or not isinstance(field, str) or not field.strip():
            raise ValueError('source_id and field are required')
        if type(limit) is not int or not 1 <= limit <= 200:
            raise ValueError('limit is outside its bounds')
        request = {} if request is None else request
        if not isinstance(request, dict) or set(request) - {'filters', 'group_by'}:
            raise ValueError('Probe options only accept filters and group_by')
        filters, group_by = request.get('filters', []), request.get('group_by', [])
        if not isinstance(filters, list) or len(filters) > 8:
            raise ValueError('Probe accepts at most 8 filters')
        if (not isinstance(group_by, list) or len(group_by) > 3
                or any(not isinstance(name, str) or not name for name in group_by)
                or len(set(group_by)) != len(group_by)):
            raise ValueError('Probe accepts at most 3 distinct grouping fields')
        for item in filters:
            if (not isinstance(item, dict) or set(item) != {'field', 'operator', 'values'}
                    or not isinstance(item['field'], str)
                    or item['operator'] not in ('eq', 'in', 'like')
                    or not isinstance(item['values'], list) or not 1 <= len(item['values']) <= 50
                    or any(type(value) not in (str, int) for value in item['values'])
                    or (item['operator'] != 'in' and len(item['values']) != 1)
                    or (item['operator'] == 'like' and not isinstance(item['values'][0], str))):
                raise ValueError('Probe filters need field, operator=eq/in/like and bounded scalar values')
        scenario, raw = self._snapshot(scenario_id, verify_current=True)
        with self.scope(scenario):
            revision = catalog_projection(raw, scenario_id)['catalog_revision']
            try:
                config = self.physical_catalog(raw, source_ids=[source_id])
            except TypeError as exc:
                # Skill-local test stores and older host adapters expose the
                # original one-argument physical-catalog contract.
                if 'source_ids' not in str(exc):
                    raise
                config = self.physical_catalog(raw)
            catalog = catalog_projection(config, scenario_id, revision)
            table = next((t for t in catalog['tables'] if t['name'] == source_id), None)
            if table is None:
                raise ValueError('Source is absent from the selected scenario')
            column = next((c for c in table.get('columns', []) if c['name'] == field), None)
            if column is None:
                raise ValueError('Field is absent from the selected source')
            fields = list(dict.fromkeys([field, *group_by]))
            referenced = set(fields) | {item['field'] for item in filters}
            known = {c['name']: c for c in table.get('columns', [])}
            if referenced - known.keys():
                raise ValueError('Probe fields must exist on the selected source')
            if not (table.get('schema', '').isidentifier() and table['name'].isidentifier()
                    and table['schema'].isascii() and table['name'].isascii()
                    and all(name.isidentifier() and name.isascii() for name in referenced)):
                raise ValueError('Probe requires valid physical identifiers')
            if any(known[name].get('allow_output') is False for name in fields):
                raise ValueError('Probe cannot expose a restricted field')
            quote = lambda value: '`' + value + '`'
            qualified = quote(table['schema']) + '.' + quote(table['name'])
            quoted_field = quote(field)
            group_columns, output_names = {}, {'value', 'frequency'}
            for index, name in enumerate(fields[1:], 1):
                output_name = name
                while output_name in output_names:
                    output_name = f'probe_group_{index}_' + output_name
                group_columns[name] = output_name
                output_names.add(output_name)
            projections = [f'{quoted_field} AS value',
                           *(quote(name) + ' AS ' + quote(alias) for name, alias in group_columns.items())]
            predicates, params = [], []
            for item in filters:
                selected_field, operator, values = quote(item['field']), item['operator'], item['values']
                if operator == 'in':
                    predicates.append(selected_field + ' IN (' + ', '.join(['%s'] * len(values)) + ')')
                else:
                    predicates.append(selected_field + (' LIKE %s' if operator == 'like' else ' = %s'))
                params.extend(values)
            where = ' WHERE ' + ' AND '.join(predicates) if predicates else ''
            grouping = ', '.join(quote(name) for name in fields)
            ordering = ', '.join(['frequency DESC', 'value', *(quote(name) for name in group_columns.values())])
            sql = (f'SELECT {", ".join(projections)}, COUNT(*) AS frequency FROM {qualified}{where} '
                   f'GROUP BY {grouping} ORDER BY {ordering} LIMIT {limit}')
        result = self.execute_sql(scenario_id, sql, params)
        if result.get('status') != 'completed':
            return {"schema": "nl2sql.value-probe/v1", "scenario_id": scenario_id,
                    "catalog_revision": catalog['catalog_revision'], "status": "failed",
                    "error": result.get('error')}
        rows = result['dataset']['rows']
        evidence = {"query_id": result.get("query_id"), "sql": result.get("sql"),
                    "params": result.get("params", []),
                    "observed_at": datetime.now(timezone.utc).isoformat()}
        binding = semantic_metadata(catalog, 'column', source_id, field, definition=column)
        binding.update(status='observed_only',
                       scope={**binding.get('scope', {}), 'source_id': source_id,
                              'field': field, 'completeness': 'observed_only'},
                       evidence=list(dict.fromkeys([*binding.get('evidence', []),
                                                    f"probe:{result.get('query_id')}" ])))
        probe = {"schema": "nl2sql.value-probe/v1", "scenario_id": scenario_id,
                "catalog_revision": catalog['catalog_revision'], "status": "completed",
                "source_id": source_id, "field": field,
                "column": column, "source_signature": table.get('table_signature'),
                "semantic_binding": binding,
                "filters": deepcopy(filters), "group_by": group_by, "group_columns": group_columns,
                "limit": limit, "truncated": len(rows) >= limit,
                "values": rows, "evidence": evidence}
        from scoped_periods import save_probe
        reference = save_probe(probe)
        if reference:
            probe['probe_ref'] = reference
        return probe

    def _refresh_probe(self, probe):
        return self.probe_values(probe['scenario_id'], probe['source_id'], probe['field'], probe['limit'],
                                 {'filters': probe.get('filters', []), 'group_by': probe.get('group_by', [])})

    def execute_sql(self, scenario_id, sql, params, query_plan=None):
        started = monotonic()
        result = {"schema": "nl2sql.query-result/v1", "scenario_id": scenario_id,
                  "query_id": "query_" + uuid4().hex, "sql": sql, "params": params}
        scenario, raw = self._snapshot(scenario_id, verify_current=True)
        with self.scope(scenario):
            revision = catalog_projection(raw, scenario_id)['catalog_revision']
            config = self.physical_catalog(raw)
            catalog = catalog_projection(config, scenario_id, revision)
            result["catalog_revision"] = catalog["catalog_revision"]
            plan_supplied = query_plan is not None
            if plan_supplied:
                query_plan = query_plan_from_artifact(query_plan)
                if isinstance(query_plan, dict):
                    result['query_plan'] = query_plan
            config["_run_id"] = result["query_id"]
            config["_query_audit"] = self.store.record_query_audit
            try:
                if plan_supplied and not isinstance(query_plan, dict):
                    raise EntityBindingError('query_plan_invalid', 'query_plan must resolve to an object')
                if query_plan is not None:
                    result['plan_verification'] = validate_plan(catalog, sql, params, query_plan,
                                                                probe_refresh=self._refresh_probe)
                dataset = self.execute(sql, params, config)
            except EntityBindingError as exc:
                entity_error = exc.code.startswith(('entity_', 'term_', 'canonical_', 'matched_term_')) and exc.code not in {'term_data_binding_invalid', 'term_sql_mismatch'}
                needs_inspection = exc.code in {
                    'semantic_gap_blocking', 'semantic_binding_unresolved',
                    'time_definition_missing', 'time_definition_conflict',
                    'time_variant_required', 'entity_selection_required',
                    'probe_incomplete', 'probe_encoding_unresolved', 'probe_stale',
                }
                result.update(status='rejected', plan_verification={'status': 'rejected', 'code': exc.code},
                              error={'code': 'entity_binding_rejected' if entity_error else 'query_plan_rejected',
                                     'message': str(exc), 'diagnostic': {
                                         'phase': 'query.entity_binding' if entity_error else 'query.plan',
                                         'code': exc.code,
                                         'human_loop_allowed': False,
                                         'recovery': 'inspect_source' if needs_inspection else 'repair_plan_once'}})
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
    import os
    from runtime_config import connections
    from gateway.store import CatalogStore
    from gateway.scenarios import scenario_scope
    from gateway.table_catalog import physical_catalog
    from gateway.database import execute_readonly
    from gateway.query_policy import QueryPolicyError
    return Gateway(CatalogStore(connections(),
                                snapshot_root=os.environ.get('AGENTLOOP_WORKSPACE_ROOT'),
                                run_id=os.environ.get('AGENTLOOP_RUN_ID')),
                   scenario_scope, physical_catalog,
                   execute_readonly, QueryPolicyError)
