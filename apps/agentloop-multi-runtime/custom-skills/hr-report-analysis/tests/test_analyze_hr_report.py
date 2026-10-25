"""Regression tests for HR report derived facts."""

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "analyze_hr_report.py"
SPEC = importlib.util.spec_from_file_location("analyze_hr_report", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def raw_row(month, code, name, metric, amount):
    return {
        "month": month,
        "organization_code": code,
        "organization_name": name,
        "metric": metric,
        "amount": amount,
    }


class HrReportAnalysisTests(unittest.TestCase):
    def test_complete_gender_dimension_produces_shares(self):
        rows, invalid = MODULE.normalize_rows([
            raw_row("202609", "BWSS", "宝武共享服务有限公司", "男职工人数", 600),
            raw_row("202609", "BWSS", "宝武共享服务有限公司", "女职工人数", 400),
        ])
        values, duplicates = MODULE.aggregate_rows(rows)
        distributions = MODULE.build_distributions(values)

        self.assertEqual(invalid, 0)
        self.assertEqual(duplicates, 0)
        self.assertEqual(len(distributions), 1)
        self.assertEqual(distributions[0]["dimension"], "gender")
        self.assertEqual(distributions[0]["total"], 1000)
        self.assertEqual([item["share"] for item in distributions[0]["items"]], [0.6, 0.4])

    def test_incomplete_dimension_does_not_invent_a_distribution(self):
        rows, _ = MODULE.normalize_rows([
            raw_row("202609", "BWSS", "宝武共享服务有限公司", "男职工人数", 600),
        ])
        values, _ = MODULE.aggregate_rows(rows)
        self.assertEqual(MODULE.build_distributions(values), [])

    def test_youth_and_party_rates_require_the_same_workforce_denominator(self):
        rows, _ = MODULE.normalize_rows([
            raw_row("202609", "BWSS", "宝武共享服务有限公司", "在岗员工人数", 1000),
            raw_row("202609", "BWSS", "宝武共享服务有限公司", "35岁以下职工人数", 250),
            raw_row("202609", "BWSS", "宝武共享服务有限公司", "中共党员人数", 300),
        ])
        values, _ = MODULE.aggregate_rows(rows)
        ratios = MODULE.build_subset_ratios(values)

        self.assertEqual({item["ratio"]: item["value"] for item in ratios}, {
            "youth_share": 0.25,
            "party_member_share": 0.3,
        })

    def test_changes_and_rankings_keep_company_and_headquarters_separate(self):
        rows, _ = MODULE.normalize_rows([
            raw_row("202608", "BWSS", "宝武共享服务有限公司", "在岗员工人数", 900),
            raw_row("202609", "BWSS", "宝武共享服务有限公司", "在岗员工人数", 927),
            raw_row("202609", "BSTA", "中国宝武钢铁集团有限公司", "在岗员工人数", 10000),
            raw_row("202609", "BWSS00", "宝武共享服务有限公司（总部）", "在岗员工人数", 500),
            raw_row("202609", "BSTA00", "宝武集团（总部）", "在岗员工人数", 800),
        ])
        values, _ = MODULE.aggregate_rows(rows)
        series = MODULE.build_metric_series(values)
        rankings = MODULE.build_rankings(values)

        bwss = next(item for item in series if item["organization"]["code"] == "BWSS")
        self.assertEqual(bwss["change"], {"computable": True, "absolute": 27.0, "rate": 0.03, "direction": "up"})
        self.assertEqual({item["scope"] for item in rankings}, {"full_company", "headquarters"})
        self.assertTrue(all(len({entry["organizationCode"].endswith("00") for entry in item["entries"]}) == 1 for item in rankings))

    def test_cli_emits_derived_receipt_and_no_cross_organization_total(self):
        source = {
            "schema": "agentloop.hrReportData/v1",
            "action": "query-report",
            "rows": [
                raw_row("202609", "BWSS", "宝武共享服务有限公司", "在岗员工人数", 927),
                raw_row("202609", "BSTA", "中国宝武钢铁集团有限公司", "在岗员工人数", 10000),
            ],
            "truncated": False,
            "evidenceReceipt": {"receiptId": "hr-source-123"},
        }
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "hr.json"
            source_path.write_text(json.dumps(source, ensure_ascii=False), encoding="utf-8")
            completed = subprocess.run(["python3", str(SCRIPT), "--input-file", str(source_path)], check=True, capture_output=True, text=True)

        result = json.loads(completed.stdout)
        self.assertEqual(result["derivedFrom"]["sourceReceiptId"], "hr-source-123")
        self.assertEqual(result["evidenceReceipt"]["evidenceKinds"]["satisfied"], ["derived_aggregation"])
        self.assertEqual(result["evidenceReceipt"]["deliveryFacts"]["kind"], "hr_report_analysis")
        self.assertNotIn("grandTotal", json.dumps(result))
        self.assertTrue(any("No cross-organization grand total" in caveat for caveat in result["calculationCaveats"]))


if __name__ == "__main__":
    unittest.main()

