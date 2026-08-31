from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from build_command_policy import default_build_command, repeat_build_command  # noqa: E402


class BuildCommandPolicyTests(unittest.TestCase):
    def test_default_build_command_keeps_warning_gates_optional(self) -> None:
        command = default_build_command("/tmp/workspace/deck", qa=True, skip_render=True)

        self.assertIn("--qa", command)
        self.assertIn("--skip-render", command)
        self.assertIn("--overwrite", command)
        self.assertNotIn("--fail-on-planning-warnings", command)
        self.assertNotIn("--fail-on-whitespace-warnings", command)

    def test_strict_warning_gates_are_explicit(self) -> None:
        command = default_build_command("/tmp/workspace/deck", qa=True, strict_warnings=True)

        self.assertIn("--fail-on-planning-warnings", command)
        self.assertIn("--fail-on-whitespace-warnings", command)

    def test_repeat_build_command_preserves_user_supplied_flags(self) -> None:
        command = repeat_build_command(
            {
                "qa": True,
                "skip_render": True,
                "fail_on_planning_warnings": True,
                "fail_on_whitespace_warnings": True,
                "overwrite": True,
                "renderer": "pptxgenjs",
            },
            "/tmp/workspace/deck",
        )

        self.assertIn("--fail-on-planning-warnings", command)
        self.assertIn("--fail-on-whitespace-warnings", command)
        self.assertIn("--renderer", command)
        self.assertIn("pptxgenjs", command)


if __name__ == "__main__":
    unittest.main()
