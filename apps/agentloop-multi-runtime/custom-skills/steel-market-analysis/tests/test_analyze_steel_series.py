"""Regression tests for the durable user-visible steel analysis facts."""

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "analyze_steel_series.py"
SKILL_DOCUMENT = Path(__file__).resolve().parents[1] / "SKILL.md"
EXECUTOR_MANIFEST = Path(__file__).resolve().parents[1] / "agentloop.executors.json"
SPEC = importlib.util.spec_from_file_location("analyze_steel_series", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AnalysisDeliveryFactsTests(unittest.TestCase):
    def test_locate_series_contract_runs_directly_to_delivery_facts(self):
        """The acquisition shortcut must not make a raw series unreadable."""
        located_series = {
            "schema": "agentloop.steelMarketData/v1",
            "action": "query-series",
            "acquisitionAction": "locate-series",
            "series": [{
                "observation_date": "2025-11-03",
                "value": 3540,
                "indicator_id": "ID00001915",
                "indicator_name": "热轧盘螺：HRB400E：Φ8：工程采购价",
                "unit": "元/吨",
                "region": "唐山市",
                "category": "HRB400E Φ8",
            }, {
                "observation_date": "2025-12-04",
                "value": 3560,
                "indicator_id": "ID00001915",
                "indicator_name": "热轧盘螺：HRB400E：Φ8：工程采购价",
                "unit": "元/吨",
                "region": "唐山市",
                "category": "HRB400E Φ8",
            }],
            "evidenceReceipt": {"receiptId": "located-source-123"},
        }
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "located-series.json"
            source_path.write_text(json.dumps(located_series, ensure_ascii=False), encoding="utf-8")
            completed = subprocess.run(
                ["python3", str(SCRIPT), "--input-file", str(source_path)],
                check=True,
                capture_output=True,
                text=True,
            )

        result = json.loads(completed.stdout)
        self.assertEqual(result["derivedFrom"], {
            "sourceSchema": "agentloop.steelMarketData/v1",
            "action": "query-series",
            "sourceReceiptId": "located-source-123",
        })
        self.assertEqual(result["evidenceReceipt"]["deliveryFacts"]["schema"], "agentloop.deliveryFacts/v1")
        self.assertEqual(result["evidenceReceipt"]["evidenceKinds"]["satisfied"], ["derived_aggregation"])

    def test_query_plan_execution_contract_runs_all_exact_raw_batches_to_delivery_facts(self):
        first = {
            "indicator_id": "ID-A", "indicator_name": "唐山价格", "unit": "元/吨", "region": "唐山", "category": "HRB400E",
            "observation_date": "2025-11-03", "value": 3540,
        }
        second = {
            "indicator_id": "ID-B", "indicator_name": "北京价格", "unit": "元/吨", "region": "北京", "category": "HRB400E",
            "observation_date": "2025-11-03", "value": 3580,
        }
        plan_execution = {
            "schema": "agentloop.steelMarketData/v1",
            "action": "execute-query-plan",
            "batches": [
                {"planQuery": {"id": "tangshan"}, "result": {"action": "query-series", "series": [first]}},
                {"planQuery": {"id": "beijing"}, "result": {"action": "query-series", "series": [second]}},
                {"planQuery": {"id": "unresolved"}, "result": {"action": "discover-indicators", "candidates": []}},
            ],
            "evidenceReceipt": {"receiptId": "query-plan-123"},
        }
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "query-plan-result.json"
            source_path.write_text(json.dumps(plan_execution, ensure_ascii=False), encoding="utf-8")
            completed = subprocess.run(
                ["python3", str(SCRIPT), "--input-file", str(source_path)], check=True, capture_output=True, text=True,
            )
        result = json.loads(completed.stdout)
        self.assertEqual(result["derivedFrom"]["action"], "execute-query-plan")
        self.assertEqual(result["derivedFrom"]["rawSeriesBatchCount"], 2)
        self.assertEqual(result["inputQuality"]["rawRowCount"], 2)
        self.assertEqual({scope["identity"]["indicatorId"] for scope in result["analysisDeliveryFacts"]["scopes"]}, {"ID-A", "ID-B"})

    def test_delivery_facts_keep_the_user_visible_trend_numbers(self):
        scopes, invalid = MODULE.group_rows([
            {
                "observation_date": "2025-11-17",
                "value": 3200,
                "indicator_id": "ID00001915",
                "indicator_name": "热轧盘螺",
                "unit": "元/吨",
                "region": "唐山市",
                "category": "HRB400E Φ8",
            },
            {
                "observation_date": "2025-11-20",
                "value": 3250,
                "indicator_id": "ID00001915",
                "indicator_name": "热轧盘螺",
                "unit": "元/吨",
                "region": "唐山市",
                "category": "HRB400E Φ8",
            },
            {
                "observation_date": "2025-11-25",
                "value": 3180,
                "indicator_id": "ID00001915",
                "indicator_name": "热轧盘螺",
                "unit": "元/吨",
                "region": "唐山市",
                "category": "HRB400E Φ8",
            },
        ])
        described = [MODULE.describe_scope(scope, rows) for scope, rows in scopes.items()]
        facts = MODULE.analysis_delivery_facts(described, [], "source-123", invalid)

        self.assertEqual(facts["schema"], "agentloop.deliveryFacts/v1")
        self.assertEqual(facts["sourceReceiptId"], "source-123")
        delivered = facts["scopes"][0]
        self.assertEqual(delivered["identity"]["indicatorId"], "ID00001915")
        self.assertEqual(delivered["dataBasis"]["dateRange"], {"start": "2025-11-17", "end": "2025-11-25"})
        self.assertEqual(delivered["first"], {
            "date": "2025-11-17", "value": 3200.0, "values": [3200.0], "valuesTruncated": False,
            "observationCount": 1, "distinctValueCount": 1, "computable": True,
        })
        self.assertEqual(delivered["last"], {
            "date": "2025-11-25", "value": 3180.0, "values": [3180.0], "valuesTruncated": False,
            "observationCount": 1, "distinctValueCount": 1, "computable": True,
        })
        self.assertEqual(delivered["change"], {"computable": True, "absolute": -20.0, "rate": -0.00625, "trend": "down"})
        self.assertEqual(delivered["extrema"]["minimum"], {"value": 3180.0, "dates": ["2025-11-25"]})
        self.assertEqual(delivered["extrema"]["maximum"], {"value": 3250.0, "dates": ["2025-11-20"]})

    def test_receipt_carries_delivery_facts_through_command_projection(self):
        scope = MODULE.describe_scope(
            ("ID00001915", "热轧盘螺", "元/吨", "唐山市", "HRB400E Φ8"),
            [
                (MODULE.dt.date(2025, 11, 17), 3200.0),
                (MODULE.dt.date(2025, 11, 25), 3180.0),
            ],
        )
        result = {
            "derivedFrom": {"sourceReceiptId": "source-123"},
            "inputQuality": {"validObservationCount": 2},
            "scopes": [scope],
            "analysisDeliveryFacts": MODULE.analysis_delivery_facts([scope], [], "source-123", 0),
        }
        receipt = MODULE.analysis_receipt(result, [])

        self.assertIs(receipt["deliveryFacts"], result["analysisDeliveryFacts"])
        self.assertEqual(receipt["deliveryFacts"]["scopes"][0]["change"]["absolute"], -20.0)

    def test_delivery_facts_retain_conflicting_endpoint_values_without_selecting_one(self):
        endpoint = MODULE.endpoint(MODULE.dt.date(2025, 11, 17), [3540.0, 3560.0, 3570.0])
        delivered = MODULE.delivery_endpoint(endpoint)

        self.assertEqual(delivered["value"], None)
        self.assertEqual(delivered["values"], [3540.0, 3560.0, 3570.0])
        self.assertEqual(delivered["distinctValueCount"], 3)
        self.assertFalse(delivered["computable"])

    def test_multi_value_dates_are_profiled_without_being_mislabeled_as_duplicates(self):
        scope = MODULE.describe_scope(
            ("ID00001915", "热轧盘螺", "元/吨", "唐山市", "HRB400E Φ8"),
            [
                (MODULE.dt.date(2025, 11, 17), 3540.0),
                (MODULE.dt.date(2025, 11, 17), 3560.0),
                (MODULE.dt.date(2025, 11, 17), 3570.0),
                (MODULE.dt.date(2025, 11, 18), 3570.0),
                (MODULE.dt.date(2025, 11, 18), 3580.0),
                (MODULE.dt.date(2025, 11, 18), 3580.0),
                (MODULE.dt.date(2025, 11, 25), 3580.0),
                (MODULE.dt.date(2025, 11, 25), 3590.0),
                (MODULE.dt.date(2025, 11, 25), 3590.0),
            ],
        )

        self.assertEqual(scope["multiObservationDateCount"], 3)
        self.assertEqual(scope["additionalSameDateObservationCount"], 6)
        self.assertEqual(scope["multiValueDateCount"], 3)
        self.assertEqual(scope["sameDateSameValueDateCount"], 2)
        self.assertEqual(scope["sameDateSameValueAdditionalObservationCount"], 2)
        self.assertEqual(scope["endpointRangeMovement"], {
            "firstDate": "2025-11-17",
            "lastDate": "2025-11-25",
            "firstRange": {"minimum": 3540.0, "maximum": 3570.0},
            "lastRange": {"minimum": 3580.0, "maximum": 3590.0},
            "lowerBoundChange": 40.0,
            "upperBoundChange": 20.0,
            "direction": "up",
        })
        facts = MODULE.analysis_delivery_facts([scope], [], "source-123", 0)
        delivered = facts["scopes"][0]
        self.assertEqual(facts["kind"], "series_data_profile")
        self.assertEqual(delivered["dataBasis"]["multiValueDateCount"], 3)
        self.assertEqual(delivered["dataBasis"]["sameDateSameValueAdditionalObservationCount"], 2)
        self.assertEqual(delivered["dailyProfiles"]["totalDateCount"], 3)
        self.assertFalse(delivered["dailyProfiles"]["truncated"])
        self.assertEqual(delivered["dailyProfiles"]["items"][0]["values"], [3540.0, 3560.0, 3570.0])

    def test_skill_and_manifest_require_actual_analysis_delivery(self):
        skill = SKILL_DOCUMENT.read_text(encoding="utf-8")
        manifest = EXECUTOR_MANIFEST.read_text(encoding="utf-8")
        self.assertIn("钢材市场数值结论时，必须**先加载本 Skill**", skill)
        self.assertIn("不是可替代本 Skill 的入口", skill)
        self.assertIn("按方法选择取数，而非反过来", skill)
        self.assertIn("agentloop.steelMarketQueryPlan/v1", skill)
        self.assertIn("execute-query-plan", skill)
        self.assertIn("没有“预检→定位→时序→分析”的全局固定路线", skill)
        self.assertIn("取数后按可得数据选择分析路径", skill)
        self.assertIn("同日多条", skill)
        self.assertIn("首末价不是每次分析的固定主结论", skill)
        self.assertIn("deliveryFacts", manifest)
        self.assertIn("dailyProfiles", manifest)
        self.assertIn("endpointRangeMovement", manifest)

    def test_executor_manifest_strings_stay_within_runtime_limits(self):
        manifest = json.loads(EXECUTOR_MANIFEST.read_text(encoding="utf-8"))
        for executor in manifest["executors"]:
            self.assertLessEqual(len(executor["id"]), 80)
            self.assertLessEqual(len(executor["description"]), 500)
            self.assertLessEqual(len(executor["command"]), 120)
            self.assertLessEqual(len(executor["script"]), 240)
            for action in executor["actions"]:
                self.assertLessEqual(len(action["id"]), 80)
                self.assertLessEqual(len(action["description"]), 500)
                self.assertLessEqual(len(action["result"]), 500)
                for argument in action["args"]:
                    self.assertLessEqual(len(argument), 2000)
                for input_value in action["inputs"]:
                    self.assertLessEqual(len(input_value["name"]), 80)
                    self.assertLessEqual(len(input_value["description"]), 300)


if __name__ == "__main__":
    unittest.main()
