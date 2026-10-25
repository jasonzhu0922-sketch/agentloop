import importlib.util
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import redirect_stderr


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "enterprise_info.py"
SPEC = importlib.util.spec_from_file_location("enterprise_config_test", SCRIPT)
client = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(client)


class SkillConfigurationTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.file = Path(temporary.name) / ".env"
        setting = patch.object(client, "ENV_FILE", self.file)
        setting.start()
        self.addCleanup(setting.stop)

    def test_skill_file_is_the_only_source_with_conflicting_global_settings(self):
        self.file.write_text(
            "# Skill-owned configuration\n"
            "ENTERPRISE_INFO_API_BASE_URL='https://skill.example.test/eusc/'\n"
            'ENTERPRISE_INFO_API_CLIENT_ID="skill-client"\n'
            "ENTERPRISE_INFO_API_CLIENT_SECRET='skill&secret#value=1'\n"
            "UNRELATED_SETTING=ignored\n",
            encoding="utf-8",
        )
        with patch.dict(os.environ, {
            "ENTERPRISE_INFO_ENV_FILE": "/invalid/external.env",
            "ENTERPRISE_INFO_API_BASE_URL": "https://wrong.example.test",
            "ENTERPRISE_INFO_API_CLIENT_ID": "wrong-client",
            "ENTERPRISE_INFO_API_CLIENT_SECRET": "wrong-secret",
        }):
            self.assertEqual(client.read_config(), (
                "https://skill.example.test/eusc", "skill-client", "skill&secret#value=1",
            ))

    def test_missing_file_or_key_fails_without_using_global_settings(self):
        with patch.dict(os.environ, {
            "ENTERPRISE_INFO_API_BASE_URL": "https://wrong.example.test",
            "ENTERPRISE_INFO_API_CLIENT_ID": "wrong-client",
            "ENTERPRISE_INFO_API_CLIENT_SECRET": "wrong-secret",
        }):
            with self.assertRaisesRegex(client.SafeError, r"Skill root \.env is unavailable"):
                client.read_config()
            self.file.write_text("ENTERPRISE_INFO_API_BASE_URL=https://skill.example.test\n")
            with self.assertRaisesRegex(client.SafeError, r"Skill root \.env is incomplete"):
                client.read_config()

    def test_invalid_config_errors_do_not_expose_credentials(self):
        self.file.write_text(
            "ENTERPRISE_INFO_API_BASE_URL=https://user:private-password@skill.example.test\n"
            "ENTERPRISE_INFO_API_CLIENT_ID=private-client\n"
            "ENTERPRISE_INFO_API_CLIENT_SECRET=private-secret\n"
        )
        with self.assertRaises(client.SafeError) as caught:
            client.read_config()
        self.assertNotIn("private", str(caught.exception))

    def test_invalid_encoding_is_reported_as_a_safe_configuration_error(self):
        self.file.write_bytes(b"\xff\xfe")
        with self.assertRaisesRegex(client.SafeError, r"Skill root \.env is unavailable"):
            client.read_config()

    def test_main_reports_missing_skill_file_before_any_http_request(self):
        error = io.StringIO()
        with patch.object(client, "parse_arguments"), patch.object(client, "post_json") as http:
            with redirect_stderr(error), self.assertRaises(SystemExit) as caught:
                client.main()
        self.assertEqual(caught.exception.code, 1)
        self.assertEqual(error.getvalue(), "ERROR: Enterprise Info Skill root .env is unavailable\n")
        http.assert_not_called()


if __name__ == "__main__":
    unittest.main()
