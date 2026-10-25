"""Regression tests for bounded OA document API access."""

import importlib.util
import json
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "oa_doc_data.py"
SPEC = importlib.util.spec_from_file_location("oa_doc_data", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

CONFIG = {
    "url": "https://example.invalid/oa/search",
    "app_id": "application",
    "acc_code": "secret-code",
}


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit=-1):
        return json.dumps(self.payload).encode("utf-8")


def valid_request(**overrides):
    return {
        "userId": "001234",
        "timeRange": {"rangeType": "0", "startTime": "20260101", "endTime": "20260131"},
        **overrides,
    }


class OaDocDataTests(unittest.TestCase):
    def test_reads_primary_configuration_without_exposing_unrelated_values(self):
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env"
            env_file.write_text("\n".join([
                "OA_DOC_API_URL=https://oa.example.test/search",
                "OA_DOC_APP_ID=oa-app",
                "OA_DOC_ACC_CODE=oa-secret",
                "IGNORED_SECRET=do-not-read",
            ]), encoding="utf-8")
            with mock.patch.dict(os.environ, {"OA_DOC_ENV_FILE": str(env_file)}, clear=False):
                self.assertEqual(MODULE.read_config(), {
                    "url": "https://oa.example.test/search",
                    "app_id": "oa-app",
                    "acc_code": "oa-secret",
                })

    def test_supports_baowu_configuration_aliases(self):
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env"
            env_file.write_text("\n".join([
                "DOC_GATEWAY_ES_URL=https://oa.example.test/search",
                "DOC_GATEWAY_APP_ID=legacy-app",
                "DOC_GATEWAY_ACC_CODE=legacy-secret",
            ]), encoding="utf-8")
            with mock.patch.dict(os.environ, {"OA_DOC_ENV_FILE": str(env_file)}, clear=False):
                self.assertEqual(MODULE.read_config()["app_id"], "legacy-app")

    def test_requires_explicit_string_user_id_and_preserves_leading_zeroes(self):
        parsed = MODULE.parse_request(json.dumps(valid_request()))
        self.assertEqual(parsed["userId"], "001234")
        with self.assertRaisesRegex(MODULE.SafeError, "userId"):
            MODULE.parse_request(json.dumps({"timeRange": valid_request()["timeRange"]}))
        with self.assertRaisesRegex(MODULE.SafeError, "userId"):
            MODULE.parse_request(json.dumps(valid_request(userId=1234)))

    def test_rejects_credentials_and_unknown_request_fields(self):
        with self.assertRaisesRegex(MODULE.SafeError, "unsupported fields"):
            MODULE.parse_request(json.dumps(valid_request(appId="model-controlled")))
        with self.assertRaisesRegex(MODULE.SafeError, "unsupported fields"):
            MODULE.parse_request(json.dumps(valid_request(accCode="model-controlled")))

    def test_validates_dates_filters_flags_and_pagination(self):
        parsed = MODULE.parse_request(json.dumps(valid_request(
            keyword={"fromLocation": "集团办公室", "emergencyLevel": "加急", "nodeName": None},
            text=["安全生产", "安全生产", "通知"],
            contentFlag="0",
            pageSize=100,
            pageNo=2,
        )))
        self.assertEqual(parsed["keyword"], {"fromLocation": "集团办公室", "emergencyLevel": "加急"})
        self.assertEqual(parsed["text"], ["安全生产", "通知"])
        self.assertEqual(parsed["contentFlag"], "0")
        self.assertEqual(parsed["pageNo"], 2)
        with self.assertRaisesRegex(MODULE.SafeError, "valid calendar date"):
            MODULE.parse_request(json.dumps(valid_request(
                timeRange={"rangeType": "0", "startTime": "20260230", "endTime": "20260301"},
            )))
        with self.assertRaisesRegex(MODULE.SafeError, "pageSize"):
            MODULE.parse_request(json.dumps(valid_request(pageSize=101)))

    def test_injects_deployment_credentials_and_nests_only_business_parameters(self):
        captured = {}

        def fake_urlopen(request, timeout):
            captured["url"] = request.full_url
            captured["timeout"] = timeout
            captured["body"] = json.loads(request.data.decode("utf-8"))
            return FakeResponse({"count": 1, "documents": [{"title": "安全通知"}], "pageNo": 0, "pageSize": 10})

        request = MODULE.parse_request(json.dumps(valid_request(
            keyword={"fromLocation": "安全管理部"},
            text=["安全生产"],
            reason="用户要求查询",
        )))
        with mock.patch.object(MODULE.urllib.request, "urlopen", side_effect=fake_urlopen):
            result = MODULE.search_documents(CONFIG, request)

        self.assertEqual(captured["url"], CONFIG["url"])
        self.assertEqual(captured["timeout"], 15)
        self.assertEqual(captured["body"], {
            "appId": "application",
            "accCode": "secret-code",
            "params": {
                "userId": "001234",
                "timeRange": {"rangeType": "0", "startTime": "20260101", "endTime": "20260131"},
                "keyword": {"fromLocation": "安全管理部"},
                "text": ["安全生产"],
            },
            "contentFlag": "1",
            "attachmentContentFlag": "1",
            "pageSize": 10,
            "pageNo": 0,
        })
        self.assertNotIn("reason", captured["body"])
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["returnedCount"], 1)
        self.assertEqual(result["documents"][0]["title"], "安全通知")
        self.assertNotIn("appId", result["request"])
        self.assertNotIn("accCode", json.dumps(result, ensure_ascii=False))

    def test_preserves_unknown_response_shape_with_explicit_caveat(self):
        with mock.patch.object(MODULE.urllib.request, "urlopen", return_value=FakeResponse({"status": "ok", "payload": {"x": 1}})):
            result = MODULE.search_documents(CONFIG, MODULE.parse_request(json.dumps(valid_request())))
        self.assertIsNone(result["count"])
        self.assertIsNone(result["returnedCount"])
        self.assertEqual(result["upstreamResponse"], {"status": "ok", "payload": {"x": 1}})
        self.assertEqual(result["dataAvailability"], "unknown_response_shape")
        self.assertTrue(any("response shape" in caveat for caveat in result["evidenceReceipt"]["caveats"]))

    def test_http_and_json_failures_are_sanitized(self):
        error = urllib.error.HTTPError(CONFIG["url"], 403, "denied", {}, None)
        with mock.patch.object(MODULE.urllib.request, "urlopen", side_effect=error):
            with self.assertRaisesRegex(MODULE.SafeError, "HTTP 403") as caught:
                MODULE.search_documents(CONFIG, MODULE.parse_request(json.dumps(valid_request())))
        self.assertNotIn(CONFIG["acc_code"], str(caught.exception))
        with mock.patch.object(MODULE.urllib.request, "urlopen", return_value=FakeResponse(["not", "an", "object"])):
            with self.assertRaisesRegex(MODULE.SafeError, "non-object"):
                MODULE.search_documents(CONFIG, MODULE.parse_request(json.dumps(valid_request())))

    def test_result_contains_agentloop_evidence_receipt(self):
        with mock.patch.object(MODULE.urllib.request, "urlopen", return_value=FakeResponse({"data": {"total": "12", "rows": [{"title": "A"}]}})):
            result = MODULE.search_documents(CONFIG, MODULE.parse_request(json.dumps(valid_request(pageNo=0, pageSize=10))))
        receipt = result["evidenceReceipt"]
        self.assertEqual(receipt["schema"], "agentloop.toolEvidenceReceipt/v1")
        self.assertEqual(receipt["sourceType"], "oa_document_api")
        self.assertEqual(result["count"], 12)
        self.assertTrue(result["hasMore"])
        self.assertIn("structured_extraction_artifact", receipt["evidenceKinds"]["satisfied"])


if __name__ == "__main__":
    unittest.main()
