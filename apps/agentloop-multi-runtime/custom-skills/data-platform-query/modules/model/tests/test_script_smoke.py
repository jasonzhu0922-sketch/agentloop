import importlib.util
import unittest
from pathlib import Path
from unittest import mock


def load_module():
    path = Path(__file__).parents[1] / "scripts" / "model_query.py"
    spec = importlib.util.spec_from_file_location("model_query_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Response:
    def __init__(self, body): self.body = body
    def read(self): return self.body.encode("utf-8")
    def __enter__(self): return self
    def __exit__(self, *args): return False


class ModelQuerySmokeTest(unittest.TestCase):
    def setUp(self):
        self.module = load_module()
        self.env = mock.patch.object(self.module, "load_config", return_value={"DAM_TEST_SQL_ENDPOINT": "https://sql.example.test/query", "DAM_TEST_CLIENT_ID": "test", "DAM_TEST_CLIENT_SECRET": "test"})
        self.env.start()

    def tearDown(self): self.env.stop()

    def test_search_queries_only_the_three_supported_model_tables(self):
        body = '{"__sys__":{"status":1},"__blocks__":{"result":{"meta":{"columns":[{"name":"UUID"},{"name":"MODEL_CNAME"}]},"rows":[["m1","采购事实模型"]]}}}'
        with mock.patch.object(self.module.urllib.request, "urlopen", return_value=Response(body)) as call:
            rows = self.module.search("采购")
        self.assertEqual(len(rows), 3)
        self.assertEqual({row["MODEL_TYPE"] for row in rows}, {"dimension", "fact", "er"})
        requests = [item.args[0].data.decode("utf-8") for item in call.call_args_list]
        self.assertTrue(all("TBEDF520" in request for request in requests))

    def test_rejects_non_read_only_sql(self):
        with self.assertRaises(self.module.QueryError): self.module.query("UPDATE T SET X=1")


if __name__ == "__main__": unittest.main()
