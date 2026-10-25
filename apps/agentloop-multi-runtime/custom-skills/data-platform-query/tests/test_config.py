import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import data_platform_config as config


def load_client(family, filename):
    path = ROOT / "modules" / family / "scripts" / filename
    spec = importlib.util.spec_from_file_location(f"config_test_{family}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SkillConfigurationTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.env_file = Path(temporary.name) / ".env"
        patch = mock.patch.object(config, "ENV_FILE", self.env_file)
        patch.start()
        self.addCleanup(patch.stop)

    def write_config(self):
        self.env_file.write_text(
            "# Skill-owned configuration\n"
            "DAM_TEST_SQL_ENDPOINT='https://skill.example.test/sql'\n"
            "DAM_TEST_CLIENT_ID=skill-client # comment\n"
            'DAM_TEST_CLIENT_SECRET="skill#secret=value"\n'
            "UNRELATED_SETTING=not-exported\n",
            encoding="utf-8",
        )

    def test_skill_file_is_the_only_source_even_with_conflicting_global_settings(self):
        self.write_config()
        with mock.patch.dict(os.environ, {
            "DAM_TEST_ENV_FILE": "/invalid/external.env",
            "DAM_TEST_SQL_ENDPOINT": "https://wrong.example.test/sql",
            "DAM_TEST_CLIENT_ID": "wrong-client",
            "DAM_TEST_CLIENT_SECRET": "wrong-secret",
        }):
            self.assertEqual(config.load_config(), {
                "DAM_TEST_SQL_ENDPOINT": "https://skill.example.test/sql",
                "DAM_TEST_CLIENT_ID": "skill-client",
                "DAM_TEST_CLIENT_SECRET": "skill#secret=value",
            })

    def test_missing_file_and_missing_or_duplicate_keys_fail_without_defaults(self):
        with mock.patch.dict(os.environ, {
            "DAM_TEST_SQL_ENDPOINT": "https://wrong.example.test/sql",
            "DAM_TEST_CLIENT_ID": "wrong-client",
            "DAM_TEST_CLIENT_SECRET": "wrong-secret",
        }):
            with self.assertRaisesRegex(ValueError, r"\.env 不存在或不可读"):
                config.load_config()
            self.env_file.write_text("DAM_TEST_CLIENT_ID=one\n")
            with self.assertRaisesRegex(ValueError, "缺少配置 DAM_TEST_SQL_ENDPOINT, DAM_TEST_CLIENT_SECRET"):
                config.load_config()
            self.env_file.write_text("DAM_TEST_CLIENT_ID=one\nDAM_TEST_CLIENT_ID=two\n")
            with self.assertRaisesRegex(ValueError, "重复配置 DAM_TEST_CLIENT_ID"):
                config.load_config()

    def test_invalid_values_are_not_included_in_configuration_errors(self):
        for content in [
            "DAM_TEST_CLIENT_SECRET='private-unclosed\n",
            "private-malformed-line\n",
        ]:
            self.env_file.write_text(content)
            with self.assertRaises(ValueError) as caught:
                config.load_config()
            self.assertNotIn("private", str(caught.exception))

    def test_all_five_direct_clients_use_the_skill_file_and_fail_before_http_when_missing(self):
        self.write_config()
        for family, filename in [
            ("api", "query_api.py"), ("model", "model_query.py"),
            ("table", "table_query.py"), ("standard", "standard_query.py"),
            ("quality", "quality_query.py"),
        ]:
            with self.subTest(family=family):
                module = load_client(family, filename)
                with mock.patch.object(module.urllib.request, "urlopen") as http:
                    http.return_value.__enter__.return_value.read.return_value = (
                        b'{"__sys__":{"status":1},"__blocks__":{"result":{"rows":[]}}}'
                    )
                    with mock.patch.dict(os.environ, {
                        "DAM_TEST_SQL_ENDPOINT": "https://wrong.example.test/sql",
                        "DAM_TEST_CLIENT_SECRET": "wrong-secret",
                    }):
                        module.query("SELECT 1")
                    request = http.call_args.args[0]
                    self.assertEqual(request.full_url, "https://skill.example.test/sql")
                    payload = json.loads(request.data)
                    self.assertEqual(payload["clientId"], "skill-client")
                    self.assertEqual(payload["clientSecret"], "skill#secret=value")
                    http.reset_mock()
                    with mock.patch.object(config, "ENV_FILE", self.env_file.parent / "missing.env"):
                        error = module.ApiError if family == "api" else module.QueryError
                        with self.assertRaisesRegex(error, r"\.env 不存在或不可读"):
                            module.query("SELECT 1")
                    http.assert_not_called()


if __name__ == "__main__":
    unittest.main()
