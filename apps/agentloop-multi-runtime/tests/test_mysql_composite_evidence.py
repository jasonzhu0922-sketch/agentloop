"""Offline contract tests for the installed, deployment-owned MySQL Skill."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "custom-skills/mysql-steel-data/scripts/mysql_steel_data.py"
SPEC = importlib.util.spec_from_file_location("mysql_composite_contract", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CompositeEvidenceTests(unittest.TestCase):
    def fixture(self, schema=True, action="query-series"):
        preflight = {
            "action": "preflight-catalog", "dataContract": {"relationship": "INDEX_CODE"},
            "queryUnderstanding": {"recommendedFilters": {"city_name": "唐山市"}},
            "evidenceReceipt": {
                "receiptId": "preflight", "facts": [{"kind": "schema_summary"}] if schema else [],
                "caveats": ["Catalog scope is bounded"],
                "sourceRefs": [{"receiptId": "catalog"}],
                "evidenceKinds": {"satisfied": ["schema_summary"] if schema else [], "caveated": ["explicit_caveats"], "failed": []},
            },
        }
        acquired = {
            "action": action,
            "evidenceReceipt": {
                "receiptId": "acquired", "facts": [{"kind": "record_counts"}],
                "caveats": ["Observation coverage is bounded"],
                "evidenceKinds": {"satisfied": ["record_counts"], "caveated": ["explicit_caveats"], "failed": []},
            },
        }
        return preflight, acquired

    def acquire(self, preflight, acquired):
        with patch.object(MODULE, "preflight_catalog", return_value=preflight), patch.object(MODULE, "locate_indicator_series", return_value=acquired):
            return MODULE.resolve_and_locate_indicator_series({}, {}, "query", None, None)

    def test_combined_and_separate_actions_preserve_the_same_facts(self):
        preflight, acquired = self.fixture()
        originals = copy.deepcopy((preflight, acquired))
        result = self.acquire(preflight, acquired)
        self.assertEqual(result["catalogPreflight"]["evidenceReceipt"], preflight["evidenceReceipt"])
        self.assertEqual(result["catalogPreflight"]["dataContract"], preflight["dataContract"])
        receipt = result["evidenceReceipt"]
        self.assertEqual(receipt["facts"], preflight["evidenceReceipt"]["facts"] + acquired["evidenceReceipt"]["facts"])
        self.assertEqual(receipt["evidenceKinds"]["satisfied"], ["schema_summary", "record_counts"])
        self.assertEqual(receipt["caveats"], ["Catalog scope is bounded", "Observation coverage is bounded"])
        self.assertEqual(receipt["componentReceiptIds"], ["preflight", "acquired"])
        self.assertNotEqual(receipt["receiptId"], "acquired")
        self.assertEqual(receipt["receiptId"], self.acquire(preflight, acquired)["evidenceReceipt"]["receiptId"])
        self.assertEqual((preflight, acquired), originals)

    def test_missing_preflight_schema_is_not_fabricated(self):
        result = self.acquire(*self.fixture(schema=False))
        self.assertNotIn("schema_summary", result["evidenceReceipt"]["evidenceKinds"]["satisfied"])

    def test_ambiguous_acquisition_keeps_preflight_but_does_not_claim_series(self):
        result = self.acquire(*self.fixture(action="discover-indicators"))
        self.assertEqual(result["action"], "discover-indicators")
        self.assertIn("schema_summary", result["evidenceReceipt"]["evidenceKinds"]["satisfied"])
        self.assertNotIn("structured_extraction_artifact", result["evidenceReceipt"]["evidenceKinds"]["satisfied"])

    def test_failed_preflight_does_not_execute_acquisition(self):
        with patch.object(MODULE, "preflight_catalog", side_effect=RuntimeError("preflight failed")), patch.object(MODULE, "locate_indicator_series") as locate:
            with self.assertRaisesRegex(RuntimeError, "preflight failed"):
                MODULE.resolve_and_locate_indicator_series({}, {}, "query", None, None)
            locate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
