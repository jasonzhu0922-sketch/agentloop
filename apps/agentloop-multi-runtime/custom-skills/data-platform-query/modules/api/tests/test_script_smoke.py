import importlib.util
import json
import unittest
from pathlib import Path
from unittest import mock


def load_module(name, filename):
    path = Path(__file__).parents[1] / "scripts" / filename
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Response:
    def __init__(self, body):
        self.body = body

    def read(self):
        return self.body.encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class DirectHttpSmokeTest(unittest.TestCase):
    def setUp(self):
        self.client = load_module("query_api_test", "query_api.py")
        self.env = mock.patch.object(self.client, "load_config", return_value={"DAM_TEST_SQL_ENDPOINT": "https://sql.example.test/query", "DAM_TEST_CLIENT_ID": "1", "DAM_TEST_CLIENT_SECRET": "1"})
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def test_query_uses_shared_http_envelope(self):
        body = json.dumps({"__sys__": {"status": 1}, "resultCount": "1", "__blocks__": {"result": {"meta": {"columns": [{"name": "1"}]}, "rows": [["10018"]]}}})
        with mock.patch.object(self.client.urllib.request, "urlopen", return_value=Response(body)) as call:
            result = self.client.query("select count(*) from BSTAMOBWSD.T_ODS_TBEDG2101")
        self.assertEqual(result["columns"], ["1"])
        self.assertEqual(result["rows"], [["10018"]])
        payload = json.loads(call.call_args.args[0].data.decode("utf-8"))
        self.assertEqual(payload["clientId"], "1")
        self.assertEqual(payload["clientSecret"], "1")
        self.assertEqual(payload["showCount"], "true")
        self.assertEqual(payload["offset"], "0")
        self.assertEqual(payload["limit"], "10000")

    def test_query_rejects_write_sql(self):
        with self.assertRaises(self.client.ApiError):
            self.client.query("delete from T")


class ApiOrchestrationSmokeTest(unittest.TestCase):
    def test_search_uses_direct_client(self):
        api = load_module("api_query_orchestration_test", "api_query.py")
        sample = [{"API_ID": "API001", "API_DESC": "采购订单查询", "API_NAME": "procure_order"}]
        with mock.patch.object(api, "query_dicts", return_value=sample) as query:
            result = api.search("采购")
        self.assertEqual(result, sample)
        self.assertEqual(query.call_args.kwargs["limit"], 10000)

    def test_detail_not_found_returns_1(self):
        api = load_module("api_query_detail_test", "api_query.py")
        with mock.patch.object(api, "get_api", return_value=None):
            self.assertEqual(api.detail("NONEXIST"), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
