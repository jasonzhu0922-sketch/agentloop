import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "scripts" / "data_platform_query.py"
SPEC = importlib.util.spec_from_file_location("data_platform_query_test", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class DataPlatformQueryRouterTest(unittest.TestCase):
    def deployment_file(self, content: str) -> str:
        handle = tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False)
        self.addCleanup(lambda: os.unlink(handle.name))
        handle.write(content)
        handle.close()
        return handle.name

    def test_routes_an_immutable_request_only_to_a_package_owned_module(self):
        request = self.deployment_file(
            '{"schema":"agentloop.dataPlatformQuery/v1","family":"table","operation":"search","query":"采购订单"}'
        )
        with mock.patch.object(MODULE.subprocess, "run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = '{"tables":[]}'
            run.return_value.stderr = ""
            self.assertEqual(MODULE.main(["router", "--request", request]), 0)
        command = run.call_args.args[0]
        self.assertEqual(command[0], os.sys.executable)
        self.assertTrue(command[1].endswith("modules/table/scripts/table_query.py"))
        self.assertEqual(command[2:], ["search", "采购订单"])
        self.assertNotIn("env", run.call_args.kwargs)

    def test_rejects_a_request_with_an_unsupported_route(self):
        request = self.deployment_file(
            '{"schema":"agentloop.dataPlatformQuery/v1","family":"table","operation":"drop","query":"采购订单"}'
        )
        with self.assertRaisesRegex(ValueError, "unsupported operation"):
            MODULE.module_arguments(MODULE.read_request(request))


if __name__ == "__main__":
    unittest.main()
