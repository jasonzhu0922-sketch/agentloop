from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "scripts" / "apply_deck_intake_answers.py"


class DeckIntakeDefaultsTests(unittest.TestCase):
    def test_missing_answers_can_be_resolved_with_recommended_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp).resolve()
            (workspace / "design_brief.json").write_text("{}", encoding="utf-8")
            (workspace / "content_plan.json").write_text("{}", encoding="utf-8")
            (workspace / "evidence_plan.json").write_text("{}", encoding="utf-8")
            (workspace / "asset_plan.json").write_text("{}", encoding="utf-8")
            packet = {
                "workflow": "deck_start_packet_v1",
                "recommended_style_seed": "seed-defaults",
                "request_user_input": {
                    "questions": [
                        {
                            "id": "style_density",
                            "options": [
                                {"label": "Figure-first report (Recommended)"},
                                {"label": "Conference talk"},
                            ],
                        },
                        {
                            "id": "visual_source_policy",
                            "options": [
                                {"label": "Best judgment (Recommended)"},
                                {"label": "Strict sources"},
                            ],
                        },
                    ],
                },
            }
            (workspace / "deck_start_packet.json").write_text(
                json.dumps(packet),
                encoding="utf-8",
            )
            answers_path = workspace / "intake_answers.json"
            report_path = workspace / "intake_apply_report.json"

            completed = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--workspace",
                    str(workspace),
                    "--packet",
                    str(workspace / "deck_start_packet.json"),
                    "--answers",
                    str(answers_path),
                    "--answered-by",
                    "best_judgment",
                    "--use-recommended-defaults",
                    "--report",
                    str(report_path),
                ],
                cwd=REPO,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertTrue(answers_path.exists())
            answers = json.loads(answers_path.read_text(encoding="utf-8"))
            self.assertEqual(answers["answered_by"], "best_judgment")
            self.assertIn(
                {"id": "style_density", "answer": "Figure-first report"},
                answers["answers"],
            )
            self.assertIn(
                {"id": "visual_source_policy", "answer": "Best judgment"},
                answers["answers"],
            )

            design = json.loads((workspace / "design_brief.json").read_text(encoding="utf-8"))
            intake = design.get("user_intake", {})
            self.assertEqual(intake.get("answered_by"), "best_judgment")
            self.assertEqual(intake.get("density"), "dense report/leave-behind")
            self.assertEqual(intake.get("source_policy"), "cite key claims")
            self.assertEqual(intake.get("stable_prompt_id"), "seed-defaults")

            report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(report.get("answered_by"), "best_judgment")
            answers_snapshot = report.get("answers_snapshot", {})
            self.assertEqual(answers_snapshot.get("path"), "intake_answers.json")
            self.assertTrue(answers_snapshot.get("exists"))
            self.assertIn(str(workspace / "design_brief.json"), report.get("changed_files", []))


if __name__ == "__main__":
    unittest.main()
