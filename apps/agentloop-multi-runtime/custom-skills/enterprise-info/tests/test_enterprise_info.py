import importlib.util
import json
import unittest
import argparse
from unittest.mock import patch
from pathlib import Path


SCRIPT_PATH = Path(__file__).parents[1] / "scripts" / "enterprise_info.py"
SPEC = importlib.util.spec_from_file_location("enterprise_info", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
enterprise_info = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(enterprise_info)


class PersonnelDeliveryTest(unittest.TestCase):
    def test_query_returns_source_records_without_claiming_final_delivery(self) -> None:
        detail = {"name": "示例公司", "credit_no": "company-001", "check_date": "2026-10-08",
                  "employees": [{"name": "张甲", "job_title": "董事长"}, {"name": "李乙", "job_title": "总经理"}]}
        for action in ("detail", "personnel"):
            args = argparse.Namespace(action=action, names=["示例公司"], identity_ref="company-001", offset=0)
            with patch.object(enterprise_info, "post_json", side_effect=[
                {"success": True, "token": "token-fixture"},
                {"responseStatus": {"success": True}, "detailAndContactByName": detail},
            ]):
                result = enterprise_info.query(args, "https://fixture.test", "client-fixture", "secret-fixture")
            self.assertNotIn("deliveryCandidate", result)
            self.assertEqual(result["result"]["employees"], detail["employees"])
            self.assertIn("示例公司", result["evidenceReceipt"]["facts"][0]["textPreview"])
            self.assertNotIn("sourceSummary", result)
            self.assertEqual(result["decisionClaim"]["status"], "satisfied")
            if action == "personnel":
                source = result["evidenceReceipt"]["facts"][0]["textPreview"]
                self.assertIn("张甲", source)
                self.assertIn("李乙", source)
                self.assertIn("2026-10-08", source)

    def test_search_exposes_identity_without_claiming_detail(self) -> None:
        args = argparse.Namespace(action="search", names=["示例公司"], identity_ref=None,
                                  offset=0, limit=10, region="", match_type="")
        with patch.object(enterprise_info, "post_json", side_effect=[
            {"success": True, "token": "token-fixture"},
            {"responseStatus": {"success": True}, "advSearchNew": {
                "items": [{"name": "示例股份有限公司", "credit_no": "company-001", "id": "candidate-1"}]}},
        ]):
            result = enterprise_info.query(args, "https://fixture.test", "client-fixture", "secret-fixture")
        candidate = result["evidenceReceipt"]["facts"][1]
        self.assertIn("not verified detail", candidate["textPreview"])
        self.assertIn({"name": "credit_no", "value": "company-001"}, candidate["fields"])

    def test_personnel_delivery_enumerates_every_registered_person(self) -> None:
        detail = {
            "name": "宝武共享服务有限公司",
            "credit_no": "91310113MAC0BM0A0G",
            "employees": [
                {"name": "张翠娥", "job_title": "财务负责人"},
                {"name": "张金涛", "job_title": "经理"},
                {"name": "陆怡梅", "job_title": "董事"},
                {"name": "王海", "job_title": "监事"},
            ],
        }

        delivery = enterprise_info.format_personnel_delivery(detail, "宝武共享服务有限公司")
        projection = enterprise_info.personnel_assessment_projection(detail)

        for name in ("张翠娥", "张金涛", "陆怡梅", "王海"):
            self.assertIn(name, delivery)
        self.assertNotIn("代表性示例", delivery)
        self.assertIn("4 条主要人员记录", delivery)
        self.assertEqual(projection["personnelCount"], 4)
        self.assertEqual(projection["sourceView"], "registered_personnel_records")

    def test_manifest_exposes_personnel_as_a_bound_action(self) -> None:
        manifest_path = Path(__file__).parents[1] / "agentloop.executors.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        actions = manifest["executors"][0]["actions"]
        personnel = next(action for action in actions if action["id"] == "personnel")

        self.assertEqual(personnel["args"][:2], ["--action", "personnel"])
        self.assertEqual(personnel["decisionBinding"]["identityRefInputs"], ["identity-ref"])
        self.assertEqual(personnel["producesEvidenceKinds"], ["source_summary", "record_counts"])

    def test_personnel_preserves_date_and_exact_title_without_claiming_current_president(self) -> None:
        detail = {"name": "示例公司", "check_date": "2026-10-08", "employees": [
            {"name": "张甲", "job_title": "董事长"},
            {"name": "李乙", "job_title": "董事兼总经理"},
        ]}
        delivery = enterprise_info.format_personnel_delivery(detail, "示例公司")
        projection = enterprise_info.personnel_assessment_projection(detail)
        self.assertIn("来源 check_date：2026-10-08", delivery)
        self.assertIn("总经理不能直接改称总裁", delivery)
        self.assertIn("| 李乙 | 董事兼总经理 |", delivery)
        self.assertNotIn("| 李乙 | 总裁 |", delivery)
        self.assertEqual(projection["checkDate"], "2026-10-08")
        self.assertIn("unverified", projection["scope"])
        self.assertEqual(enterprise_info.personnel_assessment_projection({})["checkDate"], "")


if __name__ == "__main__":
    unittest.main()
