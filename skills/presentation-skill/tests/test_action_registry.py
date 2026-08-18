from __future__ import annotations

import copy
import sys
import tempfile
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SCRIPTS = REPO / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from action_registry import (  # noqa: E402
    ACTION_SCHEMA_VERSION,
    ActionRegistryError,
    materialize_registered_action,
    resolve_registered_action,
)


class ActionRegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.workspace = Path(self.tempdir.name).resolve()

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def _build_action(self) -> dict[str, object]:
        return {
            "kind": "run_final_delivery_build",
            "action_type": "run_command",
            "command": [
                "python3",
                "scripts/build_workspace.py",
                "--workspace",
                str(self.workspace),
                "--qa",
                "--fail-on-planning-warnings",
                "--overwrite",
            ],
        }

    def test_materialize_and_resolve_registered_build(self) -> None:
        record = materialize_registered_action(
            self._build_action(), repo=REPO, workspace=self.workspace
        )
        self.assertEqual(record["action_schema_version"], ACTION_SCHEMA_VERSION)
        self.assertEqual(record["action_id"], "run_final_delivery_build")
        self.assertEqual(record["parameters"]["workspace"], str(self.workspace))
        self.assertNotIn("command", record)
        command = resolve_registered_action(record, repo=REPO, workspace=self.workspace)
        self.assertEqual(command[0], sys.executable)
        self.assertEqual(Path(command[1]), REPO / "scripts" / "build_workspace.py")

        rematerialized = materialize_registered_action(
            record, repo=REPO, workspace=self.workspace
        )
        self.assertEqual(rematerialized, record)

    def test_rejects_unregistered_action(self) -> None:
        action = self._build_action()
        action["kind"] = "run_anything"
        with self.assertRaisesRegex(ActionRegistryError, "Unregistered"):
            materialize_registered_action(action, repo=REPO, workspace=self.workspace)

    def test_rejects_path_traversal(self) -> None:
        action = self._build_action()
        action["command"] = [
            "python3",
            "scripts/build_workspace.py",
            "--workspace",
            str(self.workspace),
            "--data-path",
            "../outside.csv",
            "--fast-first-pass",
        ]
        with self.assertRaisesRegex(ActionRegistryError, "escapes the workspace"):
            materialize_registered_action(action, repo=REPO, workspace=self.workspace)

    def test_rejects_legacy_report_during_execution(self) -> None:
        with self.assertRaisesRegex(ActionRegistryError, "Legacy or missing"):
            resolve_registered_action(self._build_action(), repo=REPO, workspace=self.workspace)

    def test_rejects_injected_command_and_display(self) -> None:
        record = materialize_registered_action(
            self._build_action(), repo=REPO, workspace=self.workspace
        )
        injected = copy.deepcopy(record)
        injected["command"] = ["bash", "-lc", "touch /tmp/injected"]
        with self.assertRaises(ActionRegistryError):
            resolve_registered_action(injected, repo=REPO, workspace=self.workspace)

        injected = copy.deepcopy(record)
        injected["display_command"] = "python3 harmless.py; touch /tmp/injected"
        with self.assertRaisesRegex(ActionRegistryError, "Display command"):
            resolve_registered_action(injected, repo=REPO, workspace=self.workspace)

    def test_rejects_malicious_parameters_even_with_registered_id(self) -> None:
        record = materialize_registered_action(
            self._build_action(), repo=REPO, workspace=self.workspace
        )
        malicious = copy.deepcopy(record)
        malicious["parameters"]["workspace"] = str(self.workspace.parent)
        with self.assertRaises(ActionRegistryError):
            resolve_registered_action(malicious, repo=REPO, workspace=self.workspace)

        malicious = copy.deepcopy(record)
        malicious["parameters"]["unknown_flag"] = "value"
        with self.assertRaisesRegex(ActionRegistryError, "Unknown action parameters"):
            resolve_registered_action(malicious, repo=REPO, workspace=self.workspace)


if __name__ == "__main__":
    unittest.main()
