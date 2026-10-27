import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).with_name("server-operations.py")
spec = importlib.util.spec_from_file_location("single_host_operations", str(SOURCE))
operations = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operations)


class SingleHostOperationsTests(unittest.TestCase):
    def test_provider_env_preserves_values_and_rejects_unsafe_lines(self):
        self.assertEqual(operations.parse_env('KEY=abc=def\nQUOTED="one\\"two"\n'),
                         {"KEY": "abc=def", "QUOTED": 'one"two'})
        self.assertEqual(operations.env_bytes({"KEY": "abc=def"}), b"KEY=abc=def\n")
        with self.assertRaises(ValueError):
            operations.env_bytes({"KEY": "line\nbreak"})
        with self.assertRaises(ValueError):
            operations.parse_env("KEY=one\nKEY=two\n")

    def test_recreated_runtime_preserves_image_alias_mounts_and_environment(self):
        recorded = []
        runtime = {
            "Config": {
                "Image": "agentloop-multi-runtime:pinned",
                "Cmd": ["npm", "run", "start:runtime-host"],
                "Labels": {"org.opencontainers.image.revision": "revision"},
                "User": "",
                "WorkingDir": "/app/apps/agentloop-multi-runtime",
            },
            "HostConfig": {"RestartPolicy": {"Name": "unless-stopped"}},
            "NetworkSettings": {"Networks": {"agentloop-mr": {"Aliases": ["runtime-general-01", "old-id"]}}},
            "Mounts": [{"Type": "bind", "Source": "/config/models.json",
                        "Destination": "/run/config/llm-providers.json", "RW": False}],
        }
        with patch.object(operations, "command", side_effect=lambda *args: recorded.append(args) or b""), \
                patch.object(operations, "wait_ready"):
            operations.create_runtime("agentloop-mr-runtime-01", runtime, Path("/private/env"))
        create = recorded[0]
        self.assertIn("runtime-general-01", create)
        self.assertIn("/config/models.json:/run/config/llm-providers.json:ro", create)
        self.assertIn("agentloop-multi-runtime:pinned", create)
        self.assertEqual(recorded[1], ("docker", "start", "agentloop-mr-runtime-01"))

    def test_invalid_candidate_fails_before_touching_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "llm-providers.json"
            provider = root / "providers.env"
            skills = root / "skills"
            config.write_text('{"providers":{},"models":{}}')
            provider.write_text("KEY=old\n")
            skills.mkdir()
            job = root / "job"
            job.mkdir()
            (job / "llm-providers.json").write_text('{"providers":{},"models":{}}')
            runtime = {"Config": {"Image": "image:pinned", "Env": ["KEY=old", "PORT=8791"]}}
            with patch.object(operations, "ROOT", root), patch.object(operations, "CONFIG", config), \
                    patch.object(operations, "PROVIDER_ENV", provider), patch.object(operations, "SKILLS", skills), \
                    patch.object(operations, "validate_models", side_effect=ValueError("invalid candidate")), \
                    patch.object(operations, "command") as docker:
                with self.assertRaisesRegex(ValueError, "invalid candidate"):
                    operations.apply("llm", job, ["agentloop-mr-runtime-01"], [runtime])
                docker.assert_not_called()
            self.assertEqual(config.read_text(), '{"providers":{},"models":{}}')
            self.assertEqual(provider.read_text(), "KEY=old\n")

    def test_failed_recreation_restores_configuration_and_old_container(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "llm-providers.json"
            provider = root / "providers.env"
            skills = root / "skills"
            config.write_text('{"providers":{},"models":{"old":{}}}')
            provider.write_text("KEY=old\n")
            skills.mkdir()
            (root / "backups").mkdir()
            job = root / "job"
            job.mkdir()
            (job / "llm-providers.json").write_text('{"providers":{},"models":{"new":{}}}')
            runtime = {
                "Config": {
                    "Image": "image:pinned", "Env": ["KEY=old", "PORT=8791"],
                    "Cmd": ["npm", "run", "start:runtime-host"], "Labels": {},
                    "User": "", "WorkingDir": "/app",
                },
                "HostConfig": {"RestartPolicy": {"Name": "unless-stopped"}},
                "NetworkSettings": {"Networks": {"agentloop-mr": {"Aliases": ["runtime-general-01"]}}},
                "Mounts": [],
            }
            recorded = []

            def fake_command(*args, **_kwargs):
                recorded.append(args)
                if args[:2] == ("docker", "create"):
                    raise RuntimeError("create failed")
                return b""

            name = "agentloop-mr-runtime-01"
            with patch.object(operations, "ROOT", root), patch.object(operations, "CONFIG", config), \
                    patch.object(operations, "PROVIDER_ENV", provider), patch.object(operations, "SKILLS", skills), \
                    patch.object(operations, "validate_models"), patch.object(operations, "ensure_idle"), \
                    patch.object(operations, "command", side_effect=fake_command), \
                    patch.object(operations, "wait_ready"), patch.object(operations.subprocess, "run"):
                with self.assertRaisesRegex(RuntimeError, "create failed"):
                    operations.apply("llm", job, [name], [runtime])
            self.assertEqual(config.read_text(), '{"providers":{},"models":{"old":{}}}')
            self.assertEqual(provider.read_text(), "KEY=old\n")
            self.assertTrue(any(args[:3] == ("docker", "rename", name) for args in recorded))
            self.assertTrue(any(args[:2] == ("docker", "start") and args[-1] == name for args in recorded))


if __name__ == "__main__":
    unittest.main()
