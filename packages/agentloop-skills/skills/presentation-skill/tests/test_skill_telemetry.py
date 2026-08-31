from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "log_skill_telemetry.py"
PACKAGE_LOG = ROOT / ".skill_telemetry" / "failures.jsonl"


def _stat_snapshot(path: Path) -> tuple[int, int] | None:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    return (stat.st_size, stat.st_mtime_ns)


class SkillTelemetryTests(unittest.TestCase):
    def test_default_log_stays_inside_workspace(self) -> None:
        before = _stat_snapshot(PACKAGE_LOG)

        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp).resolve()
            preflight = workspace / "preflight.json"
            preflight.write_text(
                json.dumps(
                    {
                        "issues": [
                            {
                                "rule": "content_text_density_high",
                                "severity": "warning",
                                "slide_index": 2,
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )

            completed = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--workspace",
                    str(workspace),
                    "--preflight-json",
                    str(preflight),
                ],
                cwd=ROOT,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            workspace_log = workspace / "build" / "skill_telemetry" / "failures.jsonl"
            self.assertTrue(workspace_log.exists())
            rows = [
                json.loads(line)
                for line in workspace_log.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["workspace"], str(workspace))
            self.assertEqual(rows[0]["phase"], "preflight")
            self.assertEqual(rows[0]["rule"], "content_text_density_high")

        self.assertEqual(_stat_snapshot(PACKAGE_LOG), before)


if __name__ == "__main__":
    unittest.main()
