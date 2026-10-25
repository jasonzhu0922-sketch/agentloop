"""Regression tests for bounded HR report access."""

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "hr_report_data.py"
SPEC = importlib.util.spec_from_file_location("hr_report_data", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

CONFIG = {
    "url": "https://example.invalid/hr",
    "client_id": "client",
    "client_secret": "secret",
    "model_id": "model",
}


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class HrReportDataTests(unittest.TestCase):
    def test_hr_report_configuration_takes_precedence_over_source_aliases(self):
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env"
            env_file.write_text("\n".join([
                "HR_REPORT_EPLAT_URL=https://preferred.invalid/hr",
                "HR_REPORT_EPLAT_CLIENT_ID=preferred-client",
                "HR_REPORT_EPLAT_CLIENT_SECRET=preferred-secret",
                "HR_REPORT_EPLAT_MODEL_ID=preferred-model",
                "HR_DATA_QUERY_API_URL=https://legacy.invalid/hr",
                "HR_DATA_QUERY_CLIENT_ID=legacy-client",
                "HR_DATA_QUERY_CLIENT_SECRET=legacy-secret",
                "HR_DATA_QUERY_MODEL_ID=legacy-model",
            ]), encoding="utf-8")
            with mock.patch.dict(os.environ, {"HR_REPORT_ENV_FILE": str(env_file)}):
                config = MODULE.read_config()

        self.assertEqual(config, {
            "url": "https://preferred.invalid/hr",
            "client_id": "preferred-client",
            "client_secret": "preferred-secret",
            "model_id": "preferred-model",
        })

    def test_request_accepts_only_the_fixed_metric_catalog(self):
        request = MODULE.parse_request(json.dumps({
            "months": {"start": "202608", "end": "202609"},
            "metrics": ["男职工人数", "女职工人数"],
            "companyScope": "full_company",
        }, ensure_ascii=False))
        self.assertEqual(request["metrics"], ["男职工人数", "女职工人数"])

        with self.assertRaisesRegex(MODULE.SafeError, "unsupported HR report metric"):
            MODULE.parse_request(json.dumps({
                "months": {"start": "202609", "end": "202609"},
                "metrics": ["离职人数"],
                "companyScope": "full_company",
            }, ensure_ascii=False))

    def test_request_rejects_sql_and_excessive_month_ranges(self):
        with self.assertRaisesRegex(MODULE.SafeError, "unsupported fields"):
            MODULE.parse_request(json.dumps({
                "months": {"start": "202609", "end": "202609"},
                "metrics": ["在岗员工人数"],
                "companyScope": "full_company",
                "sql": "SELECT * FROM secret",
            }, ensure_ascii=False))
        with self.assertRaisesRegex(MODULE.SafeError, "24 months"):
            MODULE.parse_request(json.dumps({
                "months": {"start": "202401", "end": "202609"},
                "metrics": ["在岗员工人数"],
                "companyScope": "full_company",
            }, ensure_ascii=False))

    def test_long_company_alias_wins_over_short_prefix_alias(self):
        result = MODULE.resolve_organizations(CONFIG, "查询宝武共享2026年9月在岗员工人数")

        self.assertEqual(result["status"], "resolved")
        self.assertEqual(result["organizations"][0]["displayName"], "宝武共享服务有限公司")
        self.assertEqual(result["selection"]["codes"], ["BWSS", "BWSS00"])
        self.assertNotIn("BSTA", result["selection"]["codes"])

    def test_explicit_headquarters_selects_only_hq_code(self):
        result = MODULE.resolve_organizations(CONFIG, "查询宝钢股份总部的本科人数")

        self.assertEqual(result["status"], "resolved")
        self.assertEqual(result["selection"]["codes"], ["BGTA00"])

    def test_selection_token_detects_changed_codes(self):
        result = MODULE.resolve_organizations(CONFIG, "查询宝武共享在岗员工人数")
        selection = result["selection"]
        MODULE.verify_organization_selection(CONFIG, {
            "codes": selection["codes"],
            "selectionToken": selection["selectionToken"],
        })
        with self.assertRaisesRegex(MODULE.SafeError, "not selected"):
            MODULE.verify_organization_selection(CONFIG, {
                "codes": ["BSTA"],
                "selectionToken": selection["selectionToken"],
            })

    def test_query_report_compiles_fixed_table_and_scope(self):
        captured = {}
        original = MODULE.eplat_query

        def fake_query(_config, sql, max_rows=MODULE.MAX_ROWS):
            captured["sql"] = " ".join(sql.split())
            captured["max_rows"] = max_rows
            return ([{
                "month": "202609", "organization_code": "BWSS", "organization_name": "宝武共享服务有限公司",
                "metric": "在岗员工人数", "amount": "927.0",
            }], False)

        MODULE.eplat_query = fake_query
        try:
            request = MODULE.parse_request(json.dumps({
                "months": {"start": "202609", "end": "202609"},
                "metrics": ["在岗员工人数"],
                "companyScope": "full_company",
            }, ensure_ascii=False))
            result = MODULE.query_report(CONFIG, request)
        finally:
            MODULE.eplat_query = original

        self.assertIn("FROM BSTAMSHR00.V_FAWHZHSS0401 A", captured["sql"])
        self.assertIn("A.REPORT_ITEM_DES IN ('在岗员工人数')", captured["sql"])
        self.assertIn("LENGTH(A.ORG_CODE) = 4", captured["sql"])
        self.assertEqual(result["rows"][0]["organization_code"], "BWSS")
        self.assertEqual(result["evidenceReceipt"]["sourceType"], "eplat_sql_service")
        self.assertIn("structured_extraction_artifact", result["evidenceReceipt"]["evidenceKinds"]["satisfied"])

    def test_eplat_protocol_normalizes_columns_and_rejects_missing_result(self):
        success = {
            "__sys__": {"status": 1},
            "__blocks__": {"result": {
                "meta": {"columns": [{"name": "NY"}, {"name": "MONTH_AMT"}]},
                "rows": [["202609", "927.0"]],
            }},
        }
        captured = {}

        def fake_urlopen(request, timeout):
            captured["payload"] = json.loads(request.data.decode("utf-8"))
            captured["timeout"] = timeout
            return FakeResponse(success)

        with mock.patch.object(MODULE.urllib.request, "urlopen", side_effect=fake_urlopen):
            rows, truncated = MODULE.eplat_query(CONFIG, "SELECT 1", max_rows=5)

        self.assertEqual(rows, [{"ny": "202609", "month_amt": "927.0"}])
        self.assertFalse(truncated)
        self.assertEqual(captured["payload"]["modelId"], "model")
        self.assertEqual(captured["payload"]["offset"], "0")
        self.assertEqual(captured["payload"]["limit"], 5)
        self.assertEqual(captured["timeout"], 30)

        denied = {"__sys__": {"status": 0, "msg": "permission denied"}, "__blocks__": {}}
        with mock.patch.object(MODULE.urllib.request, "urlopen", return_value=FakeResponse(denied)):
            with self.assertRaisesRegex(MODULE.SafeError, "permission denied"):
                MODULE.eplat_query(CONFIG, "SELECT 1")


if __name__ == "__main__":
    unittest.main()

