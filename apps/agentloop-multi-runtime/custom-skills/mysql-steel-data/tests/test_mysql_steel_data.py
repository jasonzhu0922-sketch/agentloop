"""Regression tests for catalog preflight and structured indicator discovery."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "mysql_steel_data.py"
EXECUTOR_MANIFEST = Path(__file__).resolve().parents[1] / "agentloop.executors.json"
SKILL_DOCUMENT = Path(__file__).resolve().parents[1] / "SKILL.md"
QUERY_PATTERN_REFERENCE = Path(__file__).resolve().parents[1] / "references" / "nl2sql-query-patterns.md"
DATA_SEMANTICS_REFERENCE = Path(__file__).resolve().parents[1] / "references" / "data-semantics.md"
UPPER_SKILL_DOCUMENT = Path(__file__).resolve().parents[2] / "steel-market-analysis" / "SKILL.md"
UPPER_DATA_SEMANTICS_REFERENCE = Path(__file__).resolve().parents[2] / "steel-market-analysis" / "references" / "data-semantics.md"
SPEC = importlib.util.spec_from_file_location("mysql_steel_data", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


MAPPING = {
    "indicatorTable": "MB_INDEX_MAIN_INFO",
    "valueTable": "MB_INDEX_MAIN_DATA",
    "indicatorIdColumn": "INDEX_CODE",
    "indicatorNameColumn": "INDEX_NAME",
    "valueIndicatorIdColumn": "INDEX_CODE",
    "observationDateColumn": "DATA_DATE",
    "valueColumn": "DATA_VALUE",
    "optionalColumns": {},
    "semanticColumns": {
        "region": "REGION_NAME",
        "brand": "SOURCE_NAME",
        "product": "BREED_NAME",
        "specification": "DESCRIPTION",
    },
}
CANONICAL_MAPPING = {
    **MAPPING,
    "semanticColumns": {
        "province_name": "PROVINCE_NAME",
        "city_name": "CITY_NAME",
        "county_name": "COUNTY_NAME",
        "region_name": "REGION_NAME",
        "breed_name": "BREED_NAME",
        "caliber_name": "CALIBER_NAME",
        "metric_name": "METRIC_NAME",
        "frequency_name": "FREQUENCY_NAME",
        "unit_name": "UNIT_NAME",
        "producer_name": "CP_NAME",
        "producer_short_name": "CP_SHORT_NAME",
        "source_name": "SOURCE_NAME",
        "market_name": "MARKET_NAME",
        "description": "DESCRIPTION",
    },
}
CONFIG = {"host": "localhost", "database": "steel", "password": "test-selection-secret"}


class FakeCursor:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, parameters=()):
        self.calls.append((" ".join(sql.split()), tuple(parameters)))

    def fetchall(self):
        return self.responses.pop(0)


class FakeDatabase:
    def __init__(self, cursor):
        self.cursor_value = cursor

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def cursor(self):
        return self.cursor_value


class CatalogDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.original_connection = MODULE.connection

    def tearDown(self):
        MODULE.connection = self.original_connection

    def test_structured_conditions_are_searched_in_their_own_catalog_fields(self):
        cursor = FakeCursor([[
            {
                "indicator_id": "P001",
                "indicator_name": "河钢盘螺工程采购价",
                "region": "唐山",
                "brand": "河钢",
                "product": "盘螺",
                "specification": "HRB400E Φ8 热轧盘螺",
            },
        ]])
        MODULE.connection = lambda _config: FakeDatabase(cursor)
        filters = MODULE.parse_discovery_filters(
            '{"region":"唐山","brand":"河钢","product":"盘螺",'
            '"specification":"HRB400E Φ8 热轧盘螺",'
            '"indicator_name":"河钢盘螺"}'
        )

        result = MODULE.discover_indicators(CONFIG, MAPPING, filters)

        sql, parameters = cursor.calls[0]
        self.assertIn("i.`REGION_NAME` LIKE", sql)
        self.assertIn("i.`SOURCE_NAME` LIKE", sql)
        self.assertIn("i.`BREED_NAME` LIKE", sql)
        self.assertIn("i.`DESCRIPTION` LIKE", sql)
        self.assertIn("i.`INDEX_NAME` LIKE", sql)
        self.assertEqual(parameters, ("唐山", "河钢", "盘螺", "HRB400E Φ8 热轧盘螺", "河钢盘螺"))
        self.assertEqual(result["candidates"][0]["indicator_id"], "P001")

    def test_preflight_reports_configured_fields_and_bounded_examples(self):
        columns = MODULE.catalog_columns(MAPPING)
        responses = [[{"indicator_count": 42}]]
        for field in columns:
            responses.extend([
                [{"total_count": 42, "populated_count": 40, "distinct_count": 3}],
                [{"value": f"{field}-sample", "occurrences": 12}],
            ])
        cursor = FakeCursor(responses)
        MODULE.connection = lambda _config: FakeDatabase(cursor)

        result = MODULE.preflight_catalog(CONFIG, MAPPING)

        self.assertEqual(result["indicatorCount"], 42)
        self.assertEqual(result["assessmentProjection"]["recordCount"], len(columns))
        region = next(field for field in result["fields"] if field["field"] == "region")
        self.assertEqual(region["column"], "REGION_NAME")
        self.assertEqual(region["examples"], [{"value": "region-sample", "occurrences": 12}])
        self.assertEqual(region["semanticDefinition"]["label"], "区域")
        self.assertEqual(region["semanticDefinition"]["valueDomain"]["kind"], "catalog_enumeration")
        self.assertEqual(region["semanticDefinition"]["valueDomain"]["distinctCount"], 3)
        self.assertFalse(region["semanticDefinition"]["valueDomain"]["isExhaustive"])
        contract = result["dataContract"]
        self.assertEqual(contract["indicatorCatalog"]["grain"], "one row is one defined market indicator")
        self.assertEqual(contract["observations"]["grain"], "one raw observation for one indicator at one observation date")
        self.assertEqual(contract["relationship"]["cardinality"], "one_indicator_definition_to_many_observations")
        self.assertEqual(contract["relationship"]["join"], "MB_INDEX_MAIN_INFO.INDEX_CODE = MB_INDEX_MAIN_DATA.INDEX_CODE")
        self.assertEqual(contract["indicatorCatalog"]["semanticFields"][0]["identityRole"], "indicator_identity")
        self.assertEqual(result["discoveryContract"]["action"], "discover-indicators")
        self.assertIn("schema_summary", result["evidenceReceipt"]["evidenceKinds"]["satisfied"])
        schema_fact = next(fact for fact in result["evidenceReceipt"]["facts"] if fact["kind"] == "schema_summary")
        self.assertEqual(schema_fact["fields"][-1], {
            "name": "join",
            "value": "MB_INDEX_MAIN_INFO.INDEX_CODE = MB_INDEX_MAIN_DATA.INDEX_CODE",
        })

    def test_discovery_rejects_an_unmapped_semantic_field(self):
        with self.assertRaisesRegex(MODULE.SafeError, "unsupported field"):
            MODULE.parse_discovery_filters('{"metric":"工程采购价"}')

        with self.assertRaisesRegex(MODULE.SafeError, "unsupported field"):
            MODULE.parse_discovery_filters('{"keywords":["工程采购价"]}')

    def test_canonical_semantics_keep_city_producer_metric_and_source_separate(self):
        cursor = FakeCursor([[
            {
                "indicator_id": "ID00001915",
                "indicator_name": "热轧盘螺：HRB400E：Φ8：工程采购价：唐山市：河钢集团有限公司：河钢（日度）",
                "province_name": "河北省",
                "city_name": "唐山市",
                "region_name": "华北地区",
                "breed_name": "热轧盘螺",
                "caliber_name": "HRB400E Φ8",
                "metric_name": "工程采购价",
                "frequency_name": "日度",
                "unit_name": "元/吨",
                "producer_name": "河钢集团有限公司",
                "source_name": "我的钢铁网",
                "market_name": "唐山市场",
                "description": "含税、送到价",
            },
        ]])
        MODULE.connection = lambda _config: FakeDatabase(cursor)
        filters = MODULE.parse_discovery_filters(
            '{"city_name":"唐山市","producer_name":"河钢集团",'
            '"breed_name":"热轧盘螺","caliber_name":"HRB400E Φ8",'
            '"metric_name":"工程采购价","frequency_name":"日度"}'
        )
        result = MODULE.discover_indicators(CONFIG, CANONICAL_MAPPING, filters)
        sql, parameters = cursor.calls[0]
        for column in ("CITY_NAME", "CP_NAME", "BREED_NAME", "CALIBER_NAME", "METRIC_NAME", "FREQUENCY_NAME"):
            self.assertIn(f"i.`{column}` LIKE", sql)
        self.assertEqual(parameters, ("唐山市", "河钢集团", "热轧盘螺", "HRB400E Φ8", "工程采购价", "日度"))
        self.assertEqual(result["candidates"][0]["producer_name"], "河钢集团有限公司")

    def test_canonical_mapping_covers_each_business_dimension_once(self):
        expected = {
            "province_name": "PROVINCE_NAME",
            "city_name": "CITY_NAME",
            "county_name": "COUNTY_NAME",
            "region_name": "REGION_NAME",
            "breed_name": "BREED_NAME",
            "caliber_name": "CALIBER_NAME",
            "metric_name": "METRIC_NAME",
            "frequency_name": "FREQUENCY_NAME",
            "unit_name": "UNIT_NAME",
            "producer_name": "CP_NAME",
            "producer_short_name": "CP_SHORT_NAME",
            "source_name": "SOURCE_NAME",
            "market_name": "MARKET_NAME",
            "description": "DESCRIPTION",
        }
        self.assertEqual(CANONICAL_MAPPING["semanticColumns"], expected)
        self.assertEqual(set(MODULE.CANONICAL_QUERY_FIELDS), {"indicator_name", *expected})

    def test_candidate_discovery_does_not_require_a_nullable_specification_column(self):
        cursor = FakeCursor([[
            {
                "indicator_id": "ID00001915",
                "indicator_name": "热轧盘螺：HRB400E：Φ8：工程采购价：唐山市：河钢集团有限公司：河钢（日度）",
                "city_name": "唐山市",
                "breed_name": "热轧盘螺",
                "caliber_name": None,
                "metric_name": "工程采购价",
                "producer_short_name": "河钢集团",
            },
        ]])
        MODULE.connection = lambda _config: FakeDatabase(cursor)
        filters = MODULE.parse_discovery_filters(
            '{"city_name":"唐山市","producer_short_name":"河钢",'
            '"breed_name":"热轧盘螺","metric_name":"工程采购价",'
            '"indicator_name":"HRB400E"}'
        )

        result = MODULE.discover_indicators(CONFIG, CANONICAL_MAPPING, filters)

        sql, parameters = cursor.calls[0]
        self.assertNotIn("i.`CALIBER_NAME` LIKE", sql)
        self.assertIn("i.`INDEX_NAME` LIKE", sql)
        self.assertEqual(
            parameters,
            ("唐山市", "河钢", "热轧盘螺", "工程采购价", "HRB400E"),
        )
        self.assertIsNone(result["candidates"][0]["caliber_name"])
        self.assertIn("Φ8", result["candidates"][0]["indicator_name"])

    def test_preflight_query_understanding_keeps_grade_out_of_breed_name(self):
        rows = [{
            "indicator_id": "ID00001915",
            "indicator_name": "热轧盘螺：HRB400E：Φ8：工程采购价：唐山市：河钢集团有限公司：河钢（日度）",
            "city_name": "唐山市",
            "breed_name": "热轧盘螺",
            "caliber_name": "HRB400E Φ8",
            "metric_name": "工程采购价",
            "producer_name": "河钢集团有限公司",
            "producer_short_name": "河钢",
        }]

        understanding = MODULE.query_understanding_from_catalog_rows(
            "分析唐山市河钢生产的热轧盘螺 HRB400E 工程采购价",
            rows,
            MODULE.catalog_columns(CANONICAL_MAPPING),
            indicator_count=1,
        )

        self.assertEqual(understanding["method"], "bounded_exact_catalog_match")
        self.assertEqual(understanding["recommendedFilters"], {
            "city_name": "唐山市",
            "breed_name": "热轧盘螺",
            "metric_name": "工程采购价",
            "producer_short_name": "河钢",
        })
        self.assertNotIn("caliber_name", understanding["recommendedFilters"])
        self.assertNotEqual(understanding["recommendedFilters"]["breed_name"], "HRB400E")
        self.assertIn("HRB400E", understanding["indicatorNameTerms"])
        self.assertFalse(understanding["catalogScanTruncated"])

    def test_locate_series_reads_only_the_unique_indicator_returned_by_discovery(self):
        candidate = {
            "indicator_id": "ID00001915",
            "indicator_name": "热轧盘螺：HRB400E：Φ8：工程采购价：唐山市：河钢集团有限公司：河钢（日度）",
            "city_name": "唐山市",
            "breed_name": "热轧盘螺",
            "metric_name": "工程采购价",
            "producer_short_name": "河钢",
        }
        cursor = FakeCursor([[
            candidate,
        ], [
            {
                **candidate,
                "observation_date": "2025-11-03",
                "value": 3540,
            },
        ]])
        MODULE.connection = lambda _config: FakeDatabase(cursor)

        result = MODULE.locate_indicator_series(
            CONFIG,
            CANONICAL_MAPPING,
            {
                "city_name": "唐山市",
                "producer_short_name": "河钢",
                "breed_name": "热轧盘螺",
                "metric_name": "工程采购价",
                "indicator_name": "HRB400E",
            },
            MODULE.dt.date(2025, 11, 3),
            MODULE.dt.date(2025, 12, 4),
        )

        self.assertEqual(result["action"], "query-series")
        self.assertEqual(result["acquisitionAction"], "locate-series")
        self.assertEqual(result["selectedIndicator"]["indicator_id"], "ID00001915")
        self.assertEqual(result["series"][0]["indicator_id"], "ID00001915")
        self.assertEqual(result["seriesEvidence"]["identity"]["requestedIndicatorId"], "ID00001915")
        self.assertEqual(result["analysisInputContract"], {
            "schema": "agentloop.steelMarketData/v1",
            "action": "query-series",
            "seriesPath": "$.series",
            "consumer": "steel-market-analysis/analyze-series",
            "instruction": "Pass this complete persisted JSON artifact, not a copied summary or its stdout text, to steel-market-analysis analyze-series --input-file.",
        })
        self.assertEqual(len(cursor.calls), 2)
        self.assertEqual(cursor.calls[1][1], ("ID00001915", "2025-11-03", "2025-12-04"))

    def test_resolve_and_locate_keeps_preflight_semantics_in_one_acquisition_call(self):
        preflight = {
            "schema": "agentloop.steelMarketData/v1",
            "action": "preflight-catalog",
            "queryUnderstanding": {
                "recommendedFilters": {"city_name": "唐山市", "breed_name": "热轧盘螺"},
                "indicatorNameTerms": ["HRB400E"],
            },
            "dataContract": {"relationship": {"join": "INDEX_CODE"}},
            "evidenceReceipt": {
                "receiptId": "preflight-123", "facts": [{"kind": "schema_summary"}],
                "evidenceKinds": {"satisfied": ["schema_summary"], "caveated": [], "failed": []},
            },
        }
        acquired = {
            "schema": "agentloop.steelMarketData/v1",
            "action": "query-series",
            "series": [],
            "evidenceReceipt": {
                "receiptId": "query-123", "facts": [{"kind": "record_counts"}],
                "evidenceKinds": {"satisfied": ["record_counts"], "caveated": ["explicit_caveats"], "failed": []},
            },
        }
        original_preflight = MODULE.preflight_catalog
        original_locator = MODULE.locate_indicator_series
        try:
            MODULE.preflight_catalog = lambda *_args: preflight
            captured = {}
            def locate(_config, _mapping, filters, start, end):
                captured.update(filters=filters, start=start, end=end)
                return dict(acquired)
            MODULE.locate_indicator_series = locate
            result = MODULE.resolve_and_locate_indicator_series(
                CONFIG, CANONICAL_MAPPING, "唐山市热轧盘螺 HRB400E", MODULE.dt.date(2025, 11, 3), MODULE.dt.date(2025, 12, 4),
            )
        finally:
            MODULE.preflight_catalog = original_preflight
            MODULE.locate_indicator_series = original_locator

        self.assertEqual(captured["filters"], {"city_name": "唐山市", "breed_name": "热轧盘螺"})
        self.assertEqual(captured["start"], MODULE.dt.date(2025, 11, 3))
        self.assertEqual(result["catalogPreflight"]["receiptId"], "preflight-123")
        self.assertEqual(result["catalogPreflight"]["queryUnderstanding"], preflight["queryUnderstanding"])
        self.assertEqual(result["catalogPreflight"]["dataContract"], preflight["dataContract"])
        self.assertEqual(result["catalogPreflight"]["evidenceReceipt"], preflight["evidenceReceipt"])
        self.assertEqual(result["evidenceReceipt"]["evidenceKinds"]["satisfied"], ["schema_summary", "record_counts"])
        self.assertEqual(result["evidenceReceipt"]["evidenceKinds"]["caveated"], ["explicit_caveats"])
        self.assertEqual(result["evidenceReceipt"]["facts"], [{"kind": "schema_summary"}, {"kind": "record_counts"}])
        self.assertEqual(result["evidenceReceipt"]["componentReceiptIds"], ["preflight-123", "query-123"])
        self.assertNotEqual(result["evidenceReceipt"]["receiptId"], "query-123")
        self.assertEqual(acquired["evidenceReceipt"]["evidenceKinds"]["satisfied"], ["record_counts"])

    def test_locate_series_does_not_query_when_discovery_is_ambiguous(self):
        cursor = FakeCursor([[
            {"indicator_id": "A", "indicator_name": "A"},
            {"indicator_id": "B", "indicator_name": "B"},
        ]])
        MODULE.connection = lambda _config: FakeDatabase(cursor)

        result = MODULE.locate_indicator_series(
            CONFIG,
            CANONICAL_MAPPING,
            {"indicator_name": "HRB400E"},
            MODULE.dt.date(2025, 11, 3),
            MODULE.dt.date(2025, 12, 4),
        )

        self.assertEqual(result["action"], "discover-indicators")
        self.assertEqual(len(result["candidates"]), 2)
        self.assertEqual(len(cursor.calls), 1)

    def test_query_plan_executes_only_the_upper_skill_confirmed_indicator_ids(self):
        row = {
            "indicator_id": "ID00001915",
            "indicator_name": "热轧盘螺：HRB400E：Φ8：工程采购价：唐山市：河钢",
            "observation_date": "2025-11-03",
            "value": 3540,
        }
        cursor = FakeCursor([[row]])
        MODULE.connection = lambda _config: FakeDatabase(cursor)
        plan = {
            "schema": "agentloop.steelMarketQueryPlan/v1",
            "method": {"id": "single-series-trend", "summary": "Describe one exact daily price series."},
            "queries": [{
                "id": "target-price",
                "purpose": "单序列走势的主价格证据",
                "startDate": "2025-11-03",
                "endDate": "2025-12-04",
                "selector": {
                    "indicatorId": "ID00001915",
                    "selectionToken": MODULE.selection_token(CONFIG, "ID00001915"),
                },
            }],
        }
        with tempfile.TemporaryDirectory() as directory:
            plan_path = Path(directory) / "query-plan.json"
            plan_path.write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")
            result = MODULE.execute_query_plan(CONFIG, CANONICAL_MAPPING, MODULE.read_query_plan(plan_path))

        self.assertEqual(result["action"], "execute-query-plan")
        self.assertEqual(result["queryPlan"], plan)
        self.assertEqual(result["batches"][0]["planQuery"]["acquisition"], "exact_indicator_series")
        self.assertEqual(result["batches"][0]["result"]["action"], "query-series")
        self.assertEqual(result["assessmentProjection"]["exactSeriesBatchCount"], 1)
        self.assertIn("structured_extraction_artifact", result["evidenceReceipt"]["evidenceKinds"]["satisfied"])
        sql, parameters = cursor.calls[0]
        self.assertIn("i.`INDEX_CODE` = %s", sql)
        self.assertEqual(parameters, ("ID00001915", "2025-11-03", "2025-12-04"))

    def test_query_plan_rejects_sql_or_unmapped_selectors_before_any_query(self):
        plan = {
            "schema": "agentloop.steelMarketQueryPlan/v1",
            "method": {"id": "single-series-trend", "summary": "This does not authorize arbitrary SQL."},
            "queries": [{
                "id": "unsafe",
                "purpose": "This text is retained only for audit.",
                "startDate": "2025-11-03",
                "endDate": "2025-12-04",
                "selector": {"sql": "SELECT * FROM MB_INDEX_MAIN_DATA"},
            }],
        }
        with tempfile.TemporaryDirectory() as directory:
            plan_path = Path(directory) / "unsafe-query-plan.json"
            plan_path.write_text(json.dumps(plan), encoding="utf-8")
            with self.assertRaisesRegex(MODULE.SafeError, "exactly one of indicatorId or filters"):
                MODULE.read_query_plan(plan_path)

    def test_query_plan_requires_the_upper_skill_method_rationale(self):
        plan = {
            "schema": "agentloop.steelMarketQueryPlan/v1",
            "queries": [{
                "id": "target-price", "purpose": "Price evidence.", "startDate": "2025-11-03", "endDate": "2025-12-04",
                "selector": {"indicatorId": "ID00001915"},
            }],
        }
        with tempfile.TemporaryDirectory() as directory:
            plan_path = Path(directory) / "methodless-query-plan.json"
            plan_path.write_text(json.dumps(plan), encoding="utf-8")
            with self.assertRaisesRegex(MODULE.SafeError, "analysis-owned method object"):
                MODULE.read_query_plan(plan_path)

    def test_executor_descriptions_stay_within_runtime_manifest_limits(self):
        manifest = json.loads(EXECUTOR_MANIFEST.read_text(encoding="utf-8"))
        for action in manifest["executors"][0]["actions"]:
            self.assertLessEqual(len(action["description"]), 500)
            for item in action.get("inputs", []):
                self.assertLessEqual(len(item["description"]), 300)
        action_ids = {action["id"] for action in manifest["executors"][0]["actions"]}
        self.assertTrue({"locate-day", "locate-series", "query-day-by-selection", "query-series-by-selection"}.issubset(action_ids))
        self.assertNotIn("query-series-by-id", action_ids)
        self.assertNotIn("query-series", action_ids)

    def test_time_series_acquisition_requires_exact_query_before_step_completion(self):
        skill = SKILL_DOCUMENT.read_text(encoding="utf-8")
        self.assertIn("`locate-day`", skill)
        self.assertIn("`locate-series`", skill)
        self.assertIn("selectionToken", skill)
        self.assertIn("query-day-by-selection", skill)
        self.assertIn("query-series-by-selection", skill)
        self.assertIn("不能擅自取第一条、最后一条或均值", skill)
        self.assertIn("agentloop.steelMarketQueryPlan/v1", skill)
        self.assertIn("`execute-query-plan`", skill)
        self.assertIn("- structured_extraction_artifact", skill)

    def test_nl2sql_reference_keeps_sql_generation_in_the_data_skill_with_bounded_examples(self):
        skill = SKILL_DOCUMENT.read_text(encoding="utf-8")
        reference = QUERY_PATTERN_REFERENCE.read_text(encoding="utf-8")

        self.assertIn("[NL2SQL 查询边界]", skill)
        self.assertIn("SQL 的生成和执行属于本下层 Skill", skill)
        self.assertIn("正向：语义选择器到数据", reference)
        self.assertIn("反向：数据与空结果回溯目录", reference)
        self.assertIn("MB_INDEX_MAIN_INFO.INDEX_CODE = MB_INDEX_MAIN_DATA.INDEX_CODE", reference)
        self.assertIn("%s", reference)
        self.assertIn("COUNT(", reference)
        self.assertIn("GROUP BY", reference)
        self.assertIn("不接收原始 SQL", reference)
        self.assertIn("query-day-by-selection", reference)
        self.assertIn("query-series-by-selection", reference)

    def test_table_data_semantics_are_owned_once_by_the_data_skill(self):
        skill = SKILL_DOCUMENT.read_text(encoding="utf-8")
        upper_skill = UPPER_SKILL_DOCUMENT.read_text(encoding="utf-8")
        semantics = DATA_SEMANTICS_REFERENCE.read_text(encoding="utf-8")

        self.assertIn("[数据语义]", skill)
        self.assertIn("MB_INDEX_MAIN_INFO", semantics)
        self.assertIn("MB_INDEX_MAIN_DATA", semantics)
        self.assertIn("INDEX_CODE", semantics)
        self.assertIn("MS_ID", semantics)
        self.assertIn("DATA_DATE", semantics)
        self.assertIn("DATA_VALUE", semantics)
        self.assertIn("preflight-catalog` 返回的 `dataContract`", semantics)
        self.assertIn("../mysql-steel-data/references/data-semantics.md", upper_skill)
        self.assertFalse(UPPER_DATA_SEMANTICS_REFERENCE.exists())

    def test_workflow_progress_carries_the_exact_series_and_aggregation_handoffs(self):
        discovery = MODULE.workflow_progress_from_payload("discover-indicators", {
            "candidates": [{"indicator_id": "ID00001915"}],
            "truncated": False,
        })
        self.assertEqual(discovery["schema"], "agentloop.evidenceWorkflowProgress/v1")
        self.assertEqual(discovery["completedRequirementIds"], ["exact_indicator_discovery"])
        self.assertEqual(discovery["required"][0]["id"], "exact_indicator_series")
        self.assertIn("ID00001915", discovery["required"][0]["instruction"])
        self.assertIn("query-day-by-selection", discovery["required"][0]["instruction"])
        self.assertIn("query-series-by-selection", discovery["required"][0]["instruction"])

        series = MODULE.workflow_progress_from_payload("query-series", {})
        self.assertEqual(series["completedRequirementIds"], ["exact_indicator_series"])
        self.assertEqual(series["required"][0]["requiredEvidenceKinds"], ["derived_aggregation"])
        self.assertEqual(series["required"][0]["scope"], "downstream_step")

    def test_empty_or_ambiguous_discovery_remains_unfinished(self):
        empty = MODULE.workflow_progress_from_payload("discover-indicators", {
            "filters": {"city_name": "唐山市", "breed_name": "HRB400E"},
            "candidates": [],
            "truncated": False,
        })
        self.assertEqual(empty["completedRequirementIds"], [])
        self.assertEqual(empty["required"][0]["id"], "catalog_backed_discovery_refinement")
        self.assertIn("preflight-catalog --query", empty["required"][0]["instruction"])

        ambiguous = MODULE.workflow_progress_from_payload("discover-indicators", {
            "candidates": [{"indicator_id": "A"}, {"indicator_id": "B"}],
            "truncated": False,
        })
        self.assertEqual(ambiguous["completedRequirementIds"], [])
        self.assertEqual(ambiguous["required"][0]["id"], "exact_indicator_selection")

    def test_exact_time_series_query_emits_reusable_series_evidence(self):
        cursor = FakeCursor([[
            {
                "indicator_id": "ID00001915",
                "indicator_name": "热轧盘螺：HRB400E：Φ8：工程采购价：唐山市：河钢",
                "observation_date": "2025-11-17",
                "value": 3540,
            },
            {
                "indicator_id": "ID00001915",
                "indicator_name": "热轧盘螺：HRB400E：Φ8：工程采购价：唐山市：河钢",
                "observation_date": "2025-11-17",
                "value": 3560,
            },
            {
                "indicator_id": "ID00001915",
                "indicator_name": "热轧盘螺：HRB400E：Φ8：工程采购价：唐山市：河钢",
                "observation_date": "2025-11-18",
                "value": 3580,
            },
        ]])
        MODULE.connection = lambda _config: FakeDatabase(cursor)

        result = MODULE.query_series(
            CONFIG, CANONICAL_MAPPING, "ID00001915",
            MODULE.dt.date(2025, 11, 15), MODULE.dt.date(2025, 11, 25),
        )

        evidence = result["seriesEvidence"]
        self.assertEqual(evidence["schema"], "agentloop.steelMarketSeriesEvidence/v1")
        self.assertEqual(evidence["seriesPath"], "$.series")
        self.assertEqual(evidence["query"], {
            "action": "query-series", "mode": "catalog_selection", "startDate": "2025-11-15", "endDate": "2025-11-25",
        })
        self.assertEqual(evidence["identity"]["requestedIndicatorId"], "ID00001915")
        self.assertTrue(evidence["identity"]["queryBoundToExactIndicatorId"])
        self.assertEqual(evidence["identity"]["returnedIndicatorIds"], ["ID00001915"])
        self.assertEqual(evidence["observations"], {
            "dataAvailability": "observations_available",
            "rowCount": 3,
            "uniqueObservationDateCount": 2,
            "observedStartDate": "2025-11-17",
            "observedEndDate": "2025-11-18",
            "duplicateObservationRowCount": 1,
            "truncated": False,
        })
        fact = next(fact for fact in result["evidenceReceipt"]["facts"] if fact["kind"] == "time_series_identity")
        fields = {field["name"]: field["value"] for field in fact["fields"]}
        self.assertEqual(fields["requestedIndicatorId"], "ID00001915")
        self.assertEqual(fields["requestedStartDate"], "2025-11-15")
        self.assertEqual(fields["requestedEndDate"], "2025-11-25")
        self.assertEqual(fields["returnedRowCount"], "3")
        self.assertEqual(fields["uniqueObservationDateCount"], "2")
        self.assertEqual(fields["duplicateObservationRowCount"], "1")
        receipt = result["evidenceReceipt"]
        self.assertIn("structured_extraction_artifact", receipt["evidenceKinds"]["satisfied"])
        artifact_fact = next(fact for fact in receipt["facts"] if fact["kind"] == "structured_extraction_artifact")
        self.assertEqual(
            {field["name"]: field["value"] for field in artifact_fact["fields"]},
            {
                "schema": "agentloop.steelMarketSeriesEvidence/v1",
                "seriesPath": "$.series",
                "consumer": "steel-market-analysis/analyze-series",
            },
        )

    def test_invented_indicator_id_has_no_selection_proof_and_never_reaches_the_database(self):
        cursor = FakeCursor([])
        MODULE.connection = lambda _config: FakeDatabase(cursor)

        with self.assertRaisesRegex(MODULE.SafeError, "not selected by a catalog receipt"):
            MODULE.verify_selection_token(CONFIG, "HBIS_TANG_HRB400E8_ENGPR", "v1.not-a-catalog-token")

        self.assertEqual(cursor.calls, [])

    def test_query_plan_routes_an_equal_date_window_to_raw_day_not_raw_series(self):
        row = {
            "indicator_id": "ID00001915",
            "indicator_name": "热轧盘螺：HRB400E：Φ8：工程采购价：唐山市：河钢",
            "observation_date": "2025-11-17",
            "value": 3540,
        }
        cursor = FakeCursor([[row]])
        MODULE.connection = lambda _config: FakeDatabase(cursor)
        plan = {
            "schema": "agentloop.steelMarketQueryPlan/v1",
            "method": {"id": "single-day-fact", "summary": "Return one date's raw observations."},
            "queries": [{
                "id": "target-day", "purpose": "单日原始值",
                "startDate": "2025-11-17", "endDate": "2025-11-17",
                "selector": {
                    "indicatorId": "ID00001915",
                    "selectionToken": MODULE.selection_token(CONFIG, "ID00001915"),
                },
            }],
        }

        result = MODULE.execute_query_plan(CONFIG, CANONICAL_MAPPING, plan)

        self.assertEqual(result["batches"][0]["planQuery"]["acquisition"], "exact_indicator_day")
        self.assertEqual(result["batches"][0]["result"]["action"], "query-day")
        self.assertEqual(result["assessmentProjection"]["exactDayBatchCount"], 1)
        self.assertEqual(result["assessmentProjection"]["exactSeriesBatchCount"], 0)

    def test_single_day_keeps_all_same_day_raw_values_and_uses_day_evidence(self):
        candidate = {
            "indicator_id": "ID00001915",
            "indicator_name": "热轧盘螺：HRB400E：Φ8：工程采购价：唐山市：河钢",
            "city_name": "唐山市",
            "breed_name": "热轧盘螺",
            "metric_name": "工程采购价",
        }
        cursor = FakeCursor([[
            candidate,
        ], [
            {**candidate, "observation_date": "2025-11-17", "value": 3540},
            {**candidate, "observation_date": "2025-11-17", "value": 3560},
        ]])
        MODULE.connection = lambda _config: FakeDatabase(cursor)

        result = MODULE.locate_indicator_day(
            CONFIG, CANONICAL_MAPPING,
            {"city_name": "唐山市", "breed_name": "热轧盘螺", "metric_name": "工程采购价"},
            MODULE.dt.date(2025, 11, 17),
        )

        self.assertEqual(result["action"], "query-day")
        self.assertEqual(result["acquisitionAction"], "locate-day")
        self.assertEqual([row["value"] for row in result["series"]], [3540, 3560])
        self.assertEqual(result["seriesEvidence"]["schema"], "agentloop.steelMarketDayEvidence/v1")
        self.assertEqual(result["seriesEvidence"]["day"], "2025-11-17")
        self.assertEqual(result["seriesEvidence"]["observations"]["uniqueObservationDateCount"], 1)
        self.assertEqual(result["seriesEvidence"]["observations"]["duplicateObservationRowCount"], 1)
        self.assertEqual(result["evidenceReceipt"]["workflowProgress"]["completedRequirementIds"], ["exact_indicator_day"])


if __name__ == "__main__":
    unittest.main()
