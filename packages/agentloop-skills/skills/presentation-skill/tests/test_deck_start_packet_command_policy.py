from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from emit_deck_start_packet import build_packet  # noqa: E402


STRICT_WARNING_FLAGS = {
    "--fail-on-planning-warnings",
    "--fail-on-whitespace-warnings",
}


def _flatten_commands(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        flattened: list[str] = []
        for item in value:
            flattened.extend(_flatten_commands(item))
        return flattened
    if isinstance(value, dict):
        flattened = []
        for item in value.values():
            flattened.extend(_flatten_commands(item))
        return flattened
    return []


class DeckStartPacketCommandPolicyTests(unittest.TestCase):
    def test_default_start_packet_commands_do_not_require_strict_warning_gates(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp).resolve() / "deck"
            packet = build_packet(
                workspace=workspace,
                user_prompt="生成一个普通培训PPTX",
                mode="concise",
            )

        kickoff = packet["agent_kickoff_brief"]
        command_ladder_text = "\n".join(_flatten_commands(kickoff["command_ladder"]))
        required_commands_text = "\n".join(
            _flatten_commands(packet["slide_quality_contract"]["qa_gates"]["required_commands"])
        )

        for flag in STRICT_WARNING_FLAGS:
            self.assertNotIn(flag, command_ladder_text)
            self.assertNotIn(flag, required_commands_text)

        qa_gates = packet["slide_quality_contract"]["qa_gates"]
        self.assertIn("planning_warnings", qa_gates["record_warnings"])
        self.assertIn("whitespace_warnings", qa_gates["record_warnings"])
        self.assertIn("strict_warning_gates", qa_gates)


if __name__ == "__main__":
    unittest.main()
