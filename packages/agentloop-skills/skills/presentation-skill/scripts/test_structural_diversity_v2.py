#!/usr/bin/env python3
"""Focused regression tests for structural_diversity_v2.py."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.util import Inches, Pt

from structural_diversity_v2 import (
    deterministic_clusters,
    evaluate_manifest,
    measure_slide,
    structural_distance,
)


def _add_semantic_slide(presentation: Presentation, jitter: float = 0.0, decorated: bool = False) -> None:
    slide = presentation.slides.add_slide(presentation.slide_layouts[6])
    title = slide.shapes.add_textbox(Inches(0.7 + jitter), Inches(0.45), Inches(8.8), Inches(0.75))
    title.text_frame.paragraphs[0].text = "Controlled evidence title"
    title.text_frame.paragraphs[0].runs[0].font.size = Pt(28)
    body = slide.shapes.add_textbox(Inches(0.8), Inches(1.7 + jitter), Inches(4.2), Inches(2.5))
    body.text_frame.paragraphs[0].text = "Evidence remains editable and semantically anchored."
    body.text_frame.paragraphs[0].runs[0].font.size = Pt(16)
    anchor = slide.shapes.add_textbox(Inches(6.6 + jitter), Inches(2.0), Inches(2.7), Inches(1.5))
    anchor.text_frame.paragraphs[0].text = "78% Complete"
    anchor.text_frame.paragraphs[0].runs[0].font.size = Pt(22)
    if decorated:
        title.fill.solid()
        title.fill.fore_color.rgb = RGBColor(240, 10, 120)
        title.line.color.rgb = RGBColor(10, 220, 90)
        background = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, presentation.slide_width, presentation.slide_height)
        background.fill.solid()
        background.fill.fore_color.rgb = RGBColor(25, 25, 25)
        background.line.color.rgb = RGBColor(255, 200, 0)
        slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(11.8), Inches(0.1), Inches(0.12), Inches(0.12))


def _presentation(path: Path, *, slides: int = 1, jitter: float = 0.0, decorated: bool = False) -> None:
    presentation = Presentation()
    presentation.slide_width = Inches(13.333)
    presentation.slide_height = Inches(7.5)
    for _ in range(slides):
        _add_semantic_slide(presentation, jitter=jitter, decorated=decorated)
    presentation.save(path)


class StructuralDiversityV2Tests(unittest.TestCase):
    def test_paint_decoration_and_small_jitter_do_not_change_structure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base_path = Path(temporary) / "base.pptx"
            styled_path = Path(temporary) / "styled.pptx"
            _presentation(base_path)
            _presentation(styled_path, jitter=0.04, decorated=True)
            base = Presentation(base_path)
            styled = Presentation(styled_path)
            left = measure_slide(base.slides[0], base.slide_width, base.slide_height)
            right = measure_slide(styled.slides[0], styled.slide_width, styled.slide_height)
            distance, groups = structural_distance(left, right)
            self.assertLessEqual(distance, 0.01)
            self.assertEqual(left["semantic_shape_count"], right["semantic_shape_count"])
            self.assertLessEqual(max(groups.values()), 0.03)

    def test_clustering_is_deterministic_and_repeated_pair_gate_fails(self) -> None:
        distances = {
            ("a", "b"): 0.02,
            ("a", "c"): 0.40,
            ("b", "c"): 0.41,
        }
        expected = [["a", "b"], ["c"]]
        self.assertEqual(deterministic_clusters(["c", "a", "b"], distances, 0.10), expected)
        self.assertEqual(deterministic_clusters(["b", "c", "a"], distances, 0.10), expected)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            decks = []
            for deck_id in ("a", "b", "c"):
                pptx_path = root / f"{deck_id}.pptx"
                _presentation(pptx_path, slides=5)
                decks.append(
                    {
                        "id": deck_id,
                        "pptx": str(pptx_path),
                        "slides": [{"role": f"role_{index}", "index": index} for index in range(1, 6)],
                    }
                )
            permissive_policy = {
                "distance_threshold": 0.20,
                "minimum_clusters": 1,
                "maximum_largest_cluster_ratio": 1.0,
                "minimum_normalized_entropy": 0.0,
            }
            report = evaluate_manifest(
                {
                    "decks": decks,
                    "role_policies": {f"role_{index}": permissive_policy for index in range(1, 6)},
                },
                manifest_base=root,
                repeated_pair_role_limit=5,
            )
            repeated = [failure for failure in report["failures"] if failure["type"] == "repeated_pair"]
            self.assertFalse(report["passed"])
            self.assertEqual(len(repeated), 3)
            self.assertTrue(all(failure["role_count"] == 5 for failure in repeated))


if __name__ == "__main__":
    unittest.main()
