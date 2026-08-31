from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "report_delivery_readiness.py"


class DeliveryReadinessPolicyTests(unittest.TestCase):
    def test_missing_strict_warning_flags_are_metadata_not_delivery_warnings(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp).resolve()
            build_dir = workspace / "build"
            build_dir.mkdir(parents=True)
            outline = workspace / "outline.json"
            outline.write_text("{}", encoding="utf-8")
            outline_sha = hashlib.sha256(outline.read_bytes()).hexdigest()
            (workspace / "design_brief.json").write_text("{}", encoding="utf-8")
            (build_dir / "deck.pptx").write_bytes(b"pptx placeholder")
            (build_dir / "workspace_readiness.json").write_text(
                json.dumps({
                    "status": "ready",
                    "source_files": {
                        "outline": {
                            "path": "outline.json",
                            "exists": True,
                            "sha256": outline_sha,
                        },
                    },
                    "next_action": {},
                }),
                encoding="utf-8",
            )
            (build_dir / "build_workspace_report.json").write_text(
                json.dumps({
                    "run": {"status": "succeeded", "returncode": 0},
                    "options": {
                        "qa": True,
                        "skip_render": False,
                        "fast_first_pass": False,
                        "fail_on_planning_warnings": False,
                        "fail_on_whitespace_warnings": False,
                    },
                    "outputs": {
                        "pptx": {
                            "path": "build/deck.pptx",
                            "exists": True,
                            "sha256": "0" * 64,
                        },
                    },
                    "source_files": {
                        "outline": {
                            "path": "outline.json",
                            "exists": True,
                            "sha256": outline_sha,
                        },
                    },
                    "reports": {
                        "planning": {"error_count": 0, "warning_count": 0},
                        "preflight": {"error_count": 0, "warning_count": 0},
                        "qa": {
                            "overflow_count": 0,
                            "overlap_count": 0,
                            "geometry_error_count": 0,
                            "geometry_warning_count": 0,
                            "whitespace_warning_count": 0,
                            "design_error_count": 0,
                            "design_warning_count": 0,
                            "visual_warning_count": 0,
                            "visual_review_warning_count": 0,
                        },
                    },
                }),
                encoding="utf-8",
            )

            completed = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--workspace",
                    str(workspace),
                    "--no-refresh-readiness",
                ],
                cwd=ROOT,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            report = json.loads((build_dir / "delivery_readiness.json").read_text(encoding="utf-8"))
            self.assertEqual(report["delivery_status"], "ready")
            self.assertNotIn("planning_warnings_not_blocking", report["warning_reasons"])
            self.assertNotIn("whitespace_warnings_not_blocking", report["warning_reasons"])
            self.assertFalse(report["strict_warning_gate_metadata"]["planning_warnings_blocking"])
            self.assertFalse(report["strict_warning_gate_metadata"]["whitespace_warnings_blocking"])
            markdown = (build_dir / "delivery_readiness.md").read_text(encoding="utf-8")
            self.assertIn("`final_delivery_build`", markdown)
            self.assertIn("`strict_build`", markdown)
            self.assertLess(
                markdown.index("`final_delivery_build`"),
                markdown.index("`strict_build`"),
            )


if __name__ == "__main__":
    unittest.main()
