#!/usr/bin/env python3
"""Build the rendered GPT-5.6 model-adaptive design proof deck."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTDIR = ROOT / "decks" / "model-adaptive-showcase-20260710"
DEFAULT_PROOF = ROOT / "examples" / "model_adaptive_showcase_contact_sheet.jpg"


def _run(args: list[str]) -> None:
    result = subprocess.run(args, cwd=ROOT, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(
            f"Command failed ({result.returncode}): {' '.join(args)}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _make_figures(workspace: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import numpy as np

    figures = workspace / "assets" / "figures"
    figures.mkdir(parents=True, exist_ok=True)
    x = np.arange(0, 16)

    fig, ax = plt.subplots(figsize=(8.8, 4.8), dpi=160)
    signal = np.array([0.5, 0.6, 0.7, 0.8, 1.0, 1.4, 2.1, 3.4, 4.8, 5.7, 5.2, 4.1, 3.0, 2.2, 1.6, 1.2])
    control = np.array([0.7, 0.7, 0.8, 0.7, 0.9, 1.0, 1.1, 1.2, 1.1, 1.3, 1.2, 1.1, 1.0, 0.9, 0.8, 0.8])
    ax.fill_between(x, control * 0.82, control * 1.20, color="#D5DEE8", alpha=0.75, label="sterile envelope")
    ax.plot(x, signal, color="#1493A4", linewidth=3.0, marker="o", markersize=4, label="sample channel")
    ax.plot(x, control, color="#475569", linewidth=1.6, linestyle="--", label="sterile control")
    ax.axvspan(7, 11, color="#F59E0B", alpha=0.12)
    ax.text(7.2, 5.95, "candidate window", color="#9A5B00", fontsize=10, weight="bold")
    ax.set_xlabel("Acquisition minute", fontsize=11)
    ax.set_ylabel("Normalized fluorescence", fontsize=11)
    ax.set_title("A coherent signal emerges above the control envelope", loc="left", fontsize=16, weight="bold")
    ax.spines[["top", "right"]].set_visible(False)
    ax.grid(axis="y", color="#E2E8F0", linewidth=0.8)
    ax.legend(frameon=False, ncol=3, fontsize=9, loc="upper right")
    fig.tight_layout(pad=0.7)
    fig.savefig(figures / "signal_profile.png", bbox_inches="tight", pad_inches=0.04, facecolor="white")
    plt.close(fig)

    panels = [
        ("depth_profile.png", np.array([1.0, 1.2, 1.4, 2.0, 3.1, 4.2, 4.8, 4.1]), "Signal by melt depth", "Depth bin", "Signal"),
        ("chemistry_profile.png", np.array([0.4, 0.7, 1.5, 2.4, 3.8, 3.6, 2.5, 1.4]), "Redox proxy", "Fraction", "Index"),
        ("control_profile.png", np.array([0.8, 0.9, 0.8, 1.0, 0.9, 1.1, 1.0, 0.9]), "Control stability", "Control", "Index"),
    ]
    for filename, values, title, xlabel, ylabel in panels:
        fig, ax = plt.subplots(figsize=(4.6, 3.1), dpi=160)
        color = "#1493A4" if "control" not in filename else "#475569"
        ax.plot(np.arange(len(values)), values, color=color, linewidth=2.5, marker="o", markersize=4)
        ax.fill_between(np.arange(len(values)), 0, values, color=color, alpha=0.10)
        ax.set_title(title, loc="left", fontsize=13, weight="bold")
        ax.set_xlabel(xlabel, fontsize=9)
        ax.set_ylabel(ylabel, fontsize=9)
        ax.spines[["top", "right"]].set_visible(False)
        ax.grid(axis="y", color="#E2E8F0", linewidth=0.7)
        fig.tight_layout(pad=0.5)
        fig.savefig(figures / filename, bbox_inches="tight", pad_inches=0.03, facecolor="white")
        plt.close(fig)

    fig, axes = plt.subplots(1, 3, figsize=(10.8, 3.4), dpi=160)
    for ax, (_, values, title, xlabel, ylabel) in zip(axes, panels):
        color = "#1493A4" if "Control" not in title else "#475569"
        ax.plot(np.arange(len(values)), values, color=color, linewidth=2.4, marker="o", markersize=3.5)
        ax.fill_between(np.arange(len(values)), 0, values, color=color, alpha=0.10)
        ax.set_title(title, loc="left", fontsize=12, weight="bold")
        ax.set_xlabel(xlabel, fontsize=8.5)
        ax.set_ylabel(ylabel, fontsize=8.5)
        ax.spines[["top", "right"]].set_visible(False)
        ax.grid(axis="y", color="#E2E8F0", linewidth=0.65)
        ax.tick_params(labelsize=8)
    fig.tight_layout(pad=0.6, w_pad=1.2)
    fig.savefig(figures / "triage_atlas.png", bbox_inches="tight", pad_inches=0.04, facecolor="white")
    plt.close(fig)


def _outline() -> dict[str, Any]:
    footer = "Synthetic mission-design study"
    sources = ["S1: synthetic instrument run"]
    return {
        "title": "Europa Signal Triage",
        "deck_style": {
            "style_seed": "europa-signal-triage-v1",
            "page_system": "clinical-rail",
            "title_layout": "light-atlas",
            "chart_treatment": "threshold-band",
            "table_treatment": "readout-sidecar",
            "image_sidebar_mode": "evidence-mosaic",
            "comparison_mode": "scorecard",
            "footer_mode": "source-line",
        },
        "compliance": {"auto_image_sources": False, "require_attribution": False},
        "slides": [
            {
                "slide_id": "s1",
                "type": "title",
                "title": "Europa Signal Triage",
                "subtitle": "A decision deck for the first 90 minutes below the ice",
                "kicker": "MISSION SCIENCE / SYNTHETIC PROOF DECK",
                "tags": ["signal", "control", "decision"],
            },
            {
                "slide_id": "s2",
                "type": "content",
                "variant": "kpi-hero",
                "title": "The candidate clears the sterile envelope",
                "subtitle": "First-pass evidence / not a life-detection claim",
                "value": "3.8x",
                "label": "median signal above matched sterile control",
                "context": "Four consecutive windows exceed the preregistered trigger.",
                "footer": footer,
                "sources": sources,
            },
            {
                "slide_id": "s3",
                "type": "content",
                "variant": "image-sidebar",
                "image_sidebar_mode": "evidence-mosaic",
                "title": "Coherence matters more than a single spike",
                "subtitle": "Signal, control, and timing align in one acquisition window",
                "assets": {"hero_image": "assets/figures/signal_profile.png"},
                "value": "4/4",
                "label": "windows above trigger",
                "context": "minutes 7-10",
                "sidebar_sections": [
                    {"title": "Readout", "body": "Smooth rise; controls remain flat."},
                    {"title": "Caveat", "body": "Confirm with chemistry and a fresh blank."},
                ],
                "caption": "Synthetic fluorescence trace; shaded region is the matched sterile-control envelope.",
                "takeaway": "Proceed to orthogonal confirmation; do not promote the event to a biological interpretation yet.",
                "footer": footer,
                "sources": sources,
            },
            {
                "slide_id": "s4",
                "type": "content",
                "variant": "comparison-2col",
                "comparison_mode": "scorecard",
                "comparison_body_font_size": 12,
                "page_system": "board-ledger",
                "title": "Protocol B buys confidence without losing the window",
                "subtitle": "Two sampling sequences / one time-constrained decision",
                "left": {
                    "title": "Protocol A",
                    "score": "71",
                    "score_label": "confidence index / 100",
                    "metrics": [
                        {"label": "Time", "value": "24 min", "note": "Fastest repeat"},
                        {"label": "Blank", "value": "1", "note": "One handling blank"},
                        {"label": "Orthogonal", "value": "No", "note": "Same optical channel"},
                    ],
                },
                "right": {
                    "title": "Protocol B",
                    "score": "89",
                    "score_label": "confidence index / 100",
                    "metrics": [
                        {"label": "Time", "value": "37 min", "note": "Inside decision window"},
                        {"label": "Blank", "value": "2", "note": "Fresh handling blank"},
                        {"label": "Orthogonal", "value": "Yes", "note": "Independent redox proxy"},
                    ],
                },
                "verdict": "Choose Protocol B: the additional 13 minutes materially improves attribution.",
                "footer": footer,
                "sources": sources,
            },
            {
                "slide_id": "s5",
                "type": "content",
                "variant": "image-sidebar",
                "image_sidebar_mode": "editorial-atlas",
                "page_system": "lab-plate",
                "title": "Three views tell the same provisional story",
                "subtitle": "Depth profile / redox proxy / stable controls",
                "assets": {"hero_image": "assets/figures/triage_atlas.png"},
                "sidebar_sections": [
                    {"title": "Depth", "body": "Signal rises across adjacent melt-depth bins."},
                    {"title": "Chemistry", "body": "The redox proxy peaks in the same interval."},
                    {"title": "Control", "body": "Matched controls remain inside tolerance."},
                ],
                "caption": "Synthetic instrument panels sized for slide-readable axes.",
                "footer": footer,
                "sources": sources,
            },
            {
                "slide_id": "s6",
                "type": "content",
                "variant": "chart",
                "chart_treatment": "threshold-band",
                "page_system": "editorial-field",
                "title": "Confidence rises only after the orthogonal check",
                "subtitle": "Synthetic evidence accumulation by workflow stage",
                "chart": {
                    "type": "bar",
                    "title": "Confidence index by stage",
                    "labels": ["Initial", "Repeat", "Fresh blank", "Redox"],
                    "values": [54, 71, 79, 89],
                    "notes": "Decision threshold is 80; only the orthogonal route clears it.",
                    "facts": [
                        {"value": "80", "label": "decision threshold", "detail": "preregistered"},
                        {"value": "+18", "label": "Protocol B gain", "detail": "vs initial repeat"},
                    ],
                    "options": {"catAxisLabelFontSize": 9, "valAxisLabelFontSize": 9, "showLegend": False},
                    "sources": sources,
                },
                "footer": footer,
                "sources": sources,
            },
            {
                "slide_id": "s7",
                "type": "content",
                "variant": "lab-run-results",
                "table_treatment": "readout-sidecar",
                "page_system": "board-ledger",
                "title": "The run is decision-ready, not claim-ready",
                "subtitle": "Compact ledger of pass states and open caveats",
                "tables": [
                    {
                        "title": "Run checks",
                        "headers": ["Check", "Result", "State"],
                        "rows": [
                            ["Optical repeat", "3.8x", "Pass"],
                            ["Fresh blank", "1.0x", "Pass"],
                            ["Redox proxy", "+2.4", "Pass"],
                            ["Carryover", "0.3x", "Watch"],
                            ["Thermal drift", "0.1x", "Pass"],
                            ["Clock sync", "<1 s", "Pass"],
                            ["Archive split", "50%", "Pass"],
                        ],
                        "column_weights": [1.5, 0.8, 0.8],
                    },
                    {
                        "title": "Decision ledger",
                        "headers": ["Question", "Call"],
                        "rows": [
                            ["Continue?", "Yes"],
                            ["Life claim?", "No"],
                            ["Archive aliquot?", "Yes"],
                            ["Repeat blank?", "Yes"],
                            ["Escalate crew?", "Hold"],
                        ],
                        "column_weights": [1.4, 0.7],
                    },
                ],
                "interpretation": "Advance and preserve the sample; keep the biological hypothesis provisional.",
                "footer": footer,
                "sources": sources,
            },
            {
                "slide_id": "s8",
                "type": "content",
                "variant": "matrix",
                "matrix_mode": "open-quadrants",
                "page_system": "editorial-field",
                "title": "Make the next decision reversible",
                "subtitle": "Protect sample integrity while confidence is still provisional",
                "quadrants": [
                    {"title": "Run", "body": "Execute Protocol B and a fresh handling blank."},
                    {"title": "Preserve", "body": "Archive half the aliquot before any destructive chemistry."},
                    {"title": "Report", "body": "Label the event candidate signal, not biosignature."},
                    {"title": "Escalate", "body": "Promote only after a second independent instrument agrees."},
                ],
                "takeaway": "The strongest decision increases information while keeping the sample and interpretation reversible.",
                "footer": footer,
                "sources": sources,
            },
        ],
    }


def _content_plan() -> dict[str, Any]:
    variants = ["title", "kpi-hero", "image-sidebar", "comparison-2col", "image-sidebar", "chart", "lab-run-results", "matrix"]
    roles = ["title", "evidence", "evidence", "comparison", "evidence", "evidence", "decision", "close"]
    return {
        "thesis": "A coherent synthetic signal warrants orthogonal confirmation, not a premature biological claim.",
        "audience": "mission science and instrument operations leads",
        "slide_plan": [
            {
                "slide_id": f"s{idx}",
                "role": roles[idx - 1],
                "message": "Advance the decision with a distinct evidence object.",
                "variant": variants[idx - 1],
                "visual_strategy": variants[idx - 1],
                "evidence_needs": [] if idx == 1 else ["S1"],
            }
            for idx in range(1, 9)
        ],
        "narrative_arc": [
            {"beat": "signal", "slide_ids": ["s2", "s3"]},
            {"beat": "protocol choice", "slide_ids": ["s4"]},
            {"beat": "concordance", "slide_ids": ["s5", "s6"]},
            {"beat": "decision", "slide_ids": ["s7", "s8"]},
        ],
    }


def _evidence_plan() -> dict[str, Any]:
    return {
        "source_policy": "source every factual claim",
        "items": [
            {
                "id": "S1",
                "claim": "All values are synthetic and demonstrate presentation workflow only.",
                "source": "Synthetic mission-design study",
                "used_on_slides": ["s2", "s3", "s4", "s5", "s6", "s7", "s8"],
            }
        ],
        "chart_candidates": [],
    }


def _asset_plan() -> dict[str, Any]:
    return {
        "title": "Europa Signal Triage",
        "images": [
            {
                "name": "signal-profile",
                "path": "assets/figures/signal_profile.png",
                "source": "Synthetic local figure",
                "license": "Synthetic local asset",
                "used_on_slides": ["s3"],
            },
            {
                "name": "triage-atlas",
                "path": "assets/figures/triage_atlas.png",
                "source": "Synthetic local figure",
                "license": "Synthetic local asset",
                "used_on_slides": ["s5"],
            },
        ],
        "backgrounds": [],
        "charts": [],
        "tables": [],
        "icons": [],
        "generated_images": [],
    }


def build(outdir: Path, proof: Path, overwrite: bool) -> dict[str, Any]:
    workspace = outdir.expanduser().resolve()
    if workspace.exists() and overwrite:
        shutil.rmtree(workspace)
    if workspace.exists() and any(workspace.iterdir()):
        raise FileExistsError(f"Output workspace already exists: {workspace}")
    _run([
        "python3",
        "scripts/init_deck_workspace.py",
        "--workspace",
        str(workspace),
        "--title",
        "Europa Signal Triage",
        "--style-preset",
        "executive-clinical",
    ])
    _make_figures(workspace)
    _write_json(workspace / "outline.json", _outline())
    _write_json(workspace / "content_plan.json", _content_plan())
    _write_json(workspace / "evidence_plan.json", _evidence_plan())
    _write_json(workspace / "asset_plan.json", _asset_plan())
    notes = workspace / "notes.md"
    notes.write_text(
        "# Europa Signal Triage\n\n"
        "Synthetic content and figures used only to demonstrate model-adaptive routing, page systems, and editable slide compositions.\n",
        encoding="utf-8",
    )
    _run([
        "python3",
        "scripts/build_workspace.py",
        "--workspace",
        str(workspace),
        "--qa",
        "--visual-review",
        "--fail-on-visual-review-warnings",
        "--fail-on-planning-warnings",
        "--fail-on-whitespace-warnings",
        "--overwrite",
    ])
    _run(["python3", "scripts/report_delivery_readiness.py", "--workspace", str(workspace)])
    contact_sheet = workspace / "build" / "qa" / "visual_review" / "contact_sheet.jpg"
    proof.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(contact_sheet, proof)
    report = json.loads((workspace / "build" / "build_workspace_report.json").read_text(encoding="utf-8"))
    delivery = json.loads((workspace / "build" / "delivery_readiness.json").read_text(encoding="utf-8"))
    return {
        "workspace": str(workspace),
        "pptx": str(workspace / "build" / "europa-signal-triage.pptx"),
        "contact_sheet": str(contact_sheet),
        "published_proof": str(proof),
        "build_status": report.get("run", {}).get("status"),
        "delivery_status": delivery.get("delivery_status"),
        "qa_counts": report.get("reports", {}).get("qa", {}).get("counts", {}),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the model-adaptive presentation proof deck.")
    parser.add_argument("--outdir", default=str(DEFAULT_OUTDIR))
    parser.add_argument("--proof", default=str(DEFAULT_PROOF))
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    print(json.dumps(build(Path(args.outdir), Path(args.proof), args.overwrite), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
