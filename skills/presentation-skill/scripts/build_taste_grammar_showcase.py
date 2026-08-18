#!/usr/bin/env python3
"""Build eight same-topic decks that demonstrate distinct composition grammars."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont, ImageOps

from taste_grammar_catalog import COMPOSITION_GRAMMARS


ROOT = Path(__file__).resolve().parent.parent
TOPIC = "Neighborhood Heat Response"
GRAMMAR_PRESETS = {
    "consulting-answer-pyramid": "data-heavy-boardroom",
    "scientific-evidence-plate": "lab-report",
    "clinical-care-pathway": "executive-clinical",
    "editorial-spread": "editorial-minimal",
    "investor-thesis-stage": "bold-startup-narrative",
    "operations-grid": "lavender-ops",
    "policy-public-docket": "warm-terracotta",
    "technical-telemetry-canvas": "midnight-neon",
}


def _run(parts: list[str]) -> str:
    result = subprocess.run(parts, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if result.returncode:
        raise RuntimeError("Command failed:\n" + " ".join(parts) + "\n" + result.stdout)
    return result.stdout


def _font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Helvetica.ttc",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def _figure_assets(asset_dir: Path) -> dict[str, str]:
    asset_dir.mkdir(parents=True, exist_ok=True)
    assay = Image.new("RGB", (1100, 650), "white")
    draw = ImageDraw.Draw(assay)
    draw.text((46, 30), "A  Surface temperature by intervention", font=_font(28, True), fill="#0F172A")
    draw.line((90, 520, 1010, 520), fill="#94A3B8", width=3)
    draw.line((90, 100, 90, 520), fill="#94A3B8", width=3)
    points = [(130, 440), (300, 392), (470, 330), (640, 286), (810, 220), (970, 178)]
    draw.line(points, fill="#0F766E", width=8)
    for x, y in points:
        draw.ellipse((x - 12, y - 12, x + 12, y + 12), fill="#0F766E")
    draw.rectangle((720, 380, 1010, 492), outline="#CBD5E1", width=3)
    draw.text((748, 402), "Median change", font=_font(20), fill="#475569")
    draw.text((748, 438), "-3.8 C", font=_font(30, True), fill="#0F766E")
    assay_path = asset_dir / "assay_panel.png"
    assay.save(assay_path)

    map_image = Image.new("RGB", (1000, 700), "#F8FAFC")
    draw = ImageDraw.Draw(map_image)
    colors = ["#DBEAFE", "#BAE6FD", "#A7F3D0", "#FDE68A", "#FDBA74", "#FCA5A5"]
    for row in range(5):
        for col in range(7):
            x = 80 + col * 118 + (row % 2) * 24
            y = 80 + row * 108
            color = colors[(row * 2 + col) % len(colors)]
            draw.rounded_rectangle((x, y, x + 92, y + 72), radius=10, fill=color, outline="#FFFFFF", width=5)
    draw.text((80, 625), "Synthetic block-level heat exposure index", font=_font(22, True), fill="#334155")
    map_path = asset_dir / "heat_exposure_map.png"
    map_image.save(map_path)

    network = Image.new("RGB", (1100, 650), "#07111F")
    draw = ImageDraw.Draw(network)
    nodes = [(110, 250, "Sensors"), (350, 120, "Gateway"), (350, 380, "Weather"), (640, 250, "Scoring"), (900, 250, "Dispatch")]
    for left, top, label in nodes:
        draw.rounded_rectangle((left, top, left + 150, top + 82), radius=8, fill="#111827", outline="#22D3EE", width=3)
        draw.text((left + 18, top + 28), label, font=_font(20, True), fill="#F8FAFC")
    for start, end in [((260, 290), (350, 160)), ((260, 290), (350, 420)), ((500, 160), (640, 290)), ((500, 420), (640, 290)), ((790, 290), (900, 290))]:
        draw.line((*start, *end), fill="#F43F5E", width=5)
    network_path = asset_dir / "telemetry_network.png"
    network.save(network_path)
    return {"assay": str(assay_path), "map": str(map_path), "network": str(network_path)}


def _base(grammar_id: str, preset: str) -> dict[str, Any]:
    return {
        "title": TOPIC,
        "subtitle": "One topic, eight argument and design systems",
        "deck_style": {"composition_grammar": grammar_id},
        "metadata": {"showcase": "taste_grammar_showcase_v1", "grammar_id": grammar_id},
        "slides": [],
    }


def _outlines(assets: dict[str, str]) -> dict[str, dict[str, Any]]:
    footer = "Synthetic demonstration data | editable charts and tables"
    cases: dict[str, dict[str, Any]] = {}

    deck = _base("consulting-answer-pyramid", GRAMMAR_PRESETS["consulting-answer-pyramid"])
    deck["slides"] = [
        {"type": "title", "title": "Cool the highest-risk blocks first", "subtitle": "A decision brief for the 2027 neighborhood heat response", "footer": footer},
        {"type": "section", "section_number": "01", "title": "Where intervention changes outcomes", "subtitle": "Shade and cooling access explain most of the avoidable exposure gap."},
        {"type": "content", "variant": "chart", "title": "Three priority zones account for 61% of excess exposure", "subtitle": "Exposure index by zone", "chart": {"type": "bar", "labels": ["North", "Central", "East", "West"], "values": [82, 74, 63, 41], "facts": [{"value": "61%", "label": "Concentrated", "detail": "top 3 zones"}, {"value": "-4.1C", "label": "Target", "detail": "surface temp"}], "notes": "Prioritize the top three zones before expanding citywide."}, "footer": footer},
        {"type": "content", "variant": "comparison-2col", "title": "A targeted first wave beats uniform coverage", "subtitle": "Decision tradeoff", "left": {"title": "Targeted", "bullets": ["Highest-risk blocks first", "Faster measurable effect", "Clear owner sequence"]}, "right": {"title": "Uniform", "bullets": ["Broader early reach", "Slower visible effect", "More contractor coordination"]}, "verdict": "Fund a targeted first wave with a published expansion trigger.", "footer": footer},
        {"type": "content", "variant": "table", "title": "The recommendation is executable in ninety days", "subtitle": "Owner and milestone ledger", "headers": ["Action", "Owner", "Trigger", "Due"], "rows": [["Shade permits", "Public works", "3 priority zones", "Day 30"], ["Cooling hours", "Health dept", "Heat alert", "Day 14"], ["Resident grants", "Housing", "Index > 70", "Day 60"]], "footer": footer},
    ]
    cases["consulting-answer-pyramid"] = deck

    deck = _base("scientific-evidence-plate", GRAMMAR_PRESETS["scientific-evidence-plate"])
    deck["slides"] = [
        {"type": "title", "title": "Can reflective shade reduce block-scale heat load?", "subtitle": "Pilot HTR-07 | matched blocks | 21-day readout", "footer": footer},
        {"type": "section", "title": "Primary result", "subtitle": "Matched intervention blocks show a repeatable reduction after controlling for weather."},
        {"type": "content", "variant": "scientific-figure", "title": "The intervention shifts the full temperature distribution", "subtitle": "Matched-block surface temperature", "figures": [assets["assay"], assets["assay"]], "metrics": [{"value": "-3.8C", "label": "median delta"}, {"value": "n=24", "label": "blocks"}], "caption": "Synthetic matched-block analysis; panels remain linked to the source script.", "footer": footer},
        {"type": "content", "variant": "lab-run-results", "title": "Controls and data quality support the primary result", "subtitle": "Run-level quality register", "tables": [{"title": "QC", "headers": ["Check", "Observed", "Gate"], "rows": [["Sensor uptime", "98.7%", ">95%"], ["Weather balance", "0.3C", "<0.5C"], ["Missing blocks", "1", "<=2"]]}, {"title": "Effect", "headers": ["Cohort", "Delta", "95% interval"], "rows": [["Intervention", "-3.8C", "-4.4 to -3.1"], ["Control", "-0.6C", "-1.0 to -0.2"]]}], "footer": footer},
        {"type": "content", "variant": "table", "title": "Advance to a larger test with one unresolved subgroup", "subtitle": "Next experiment", "headers": ["Question", "Design", "Decision gate"], "rows": [["Durability", "8-week follow-up", ">=2.5C retained"], ["Low-canopy blocks", "stratified sample", "interval excludes zero"], ["Maintenance", "cost log", "<10% annualized"]], "footer": footer},
    ]
    cases["scientific-evidence-plate"] = deck

    deck = _base("clinical-care-pathway", GRAMMAR_PRESETS["clinical-care-pathway"])
    deck["slides"] = [
        {"type": "title", "title": "Protect heat-sensitive residents before escalation", "subtitle": "Clinical operations review | 1,240 enrolled residents", "footer": footer},
        {"type": "section", "title": "Care threshold", "subtitle": "The intervention window opens before symptoms become emergency demand.", "status": "REVIEW"},
        {"type": "content", "variant": "chart", "title": "Outreach before the second alert cuts urgent visits", "subtitle": "Urgent visits per 1,000 residents", "chart": {"type": "line", "labels": ["Baseline", "Alert 1", "Alert 2", "Alert 3"], "values": [19, 18, 12, 11], "facts": [{"value": "37%", "label": "Reduction", "detail": "urgent visits"}, {"value": "82%", "label": "Reached", "detail": "within 24h"}], "notes": "Synthetic care-pathway cohort; threshold set before the second alert."}, "footer": footer},
        {"type": "content", "variant": "comparison-2col", "title": "Benefit is strongest when outreach precedes symptom reporting", "subtitle": "Benefit-risk review", "left": {"title": "Benefit", "bullets": ["Fewer urgent visits", "Higher medication continuity", "Earlier cooling access"]}, "right": {"title": "Risk", "bullets": ["False-positive outreach", "Staff capacity pressure", "Language coverage gaps"]}, "verdict": "Trigger outreach at Alert 1 for residents with two or more risk factors.", "footer": footer},
        {"type": "content", "variant": "table", "title": "The care action includes monitoring and escalation", "subtitle": "Clinical owner plan", "headers": ["Action", "Owner", "Monitor", "Escalate when"], "rows": [["Call high-risk list", "Nurse team", "Reach rate", "<75%"], ["Arrange transport", "Care navigator", "No-show rate", ">10%"], ["Review symptoms", "Clinician", "Urgent flags", "Any red flag"]], "footer": footer},
    ]
    cases["clinical-care-pathway"] = deck

    deck = _base("editorial-spread", GRAMMAR_PRESETS["editorial-spread"])
    deck["slides"] = [
        {"type": "title", "title": "The block that stays hot after sunset", "subtitle": "A neighborhood field note on shade, pavement, and uneven relief", "footer": footer},
        {"type": "section", "title": "Heat has an address", "subtitle": "On the same evening, two streets one mile apart can experience different nights."},
        {"type": "content", "variant": "image-sidebar", "title": "A street-level pattern emerges before the citywide average moves", "subtitle": "Synthetic block exposure map", "assets": {"hero_image": assets["map"]}, "body": "Hot blocks combine dark pavement, low canopy, and limited cooling access.", "highlights": ["Exposure persists after sunset", "Relief follows shade and access"], "footer": footer},
        {"type": "content", "variant": "chart", "title": "The average hides the evening hours that matter", "subtitle": "Evening exposure index", "chart": {"type": "line", "labels": ["18:00", "20:00", "22:00", "00:00"], "values": [81, 78, 69, 58], "notes": "Citywide averages hide block-level exposure."}, "footer": footer},
        {"type": "content", "variant": "standard", "title": "A cooler city is built one lived route at a time", "body": "Measure the walk to transit, the apartment after sunset, and the hours when public cooling is actually open.", "highlights": ["Design around lived exposure, not only daytime averages"], "footer": footer},
    ]
    cases["editorial-spread"] = deck

    deck = _base("investor-thesis-stage", GRAMMAR_PRESETS["investor-thesis-stage"])
    deck["slides"] = [
        {"type": "title", "title": "Neighborhood cooling becomes an operating layer", "subtitle": "A deployable system for sensing, prioritization, and response", "footer": footer},
        {"type": "section", "title": "From heat map to action in one shift", "subtitle": "The thesis is not better sensing; it is faster local response."},
        {"type": "content", "variant": "kpi-hero", "title": "The first deployments convert signal into measurable relief", "value": "4.6x", "label": "faster response", "context": "One operating layer connects sensing, contractors, and resident response.", "footer": footer},
        {"type": "content", "variant": "chart", "title": "Usage grows as cities add response workflows", "subtitle": "Active response actions per month", "chart": {"type": "line", "labels": ["Q1", "Q2", "Q3", "Q4"], "values": [18, 41, 76, 128], "facts": [{"value": "3.1x", "label": "Expansion", "detail": "within cohort"}], "notes": "Synthetic adoption curve; proof is workflow expansion, not sensor count."}, "footer": footer},
        {"type": "content", "variant": "timeline", "title": "The ask funds three proof milestones", "subtitle": "18-month use of funds", "timeline": [{"label": "01", "title": "Deploy", "body": "10 cities"}, {"label": "02", "title": "Integrate", "body": "3 response systems"}, {"label": "03", "title": "Prove", "body": "cooling outcome"}, {"label": "04", "title": "Scale", "body": "repeatable sales"}], "footer": footer},
    ]
    cases["investor-thesis-stage"] = deck

    deck = _base("operations-grid", GRAMMAR_PRESETS["operations-grid"])
    deck["slides"] = [
        {"type": "title", "title": "Heat response operating review", "subtitle": "Week 29 | citywide service window", "footer": footer},
        {"type": "section", "title": "Exceptions before expansion", "subtitle": "Two workstreams are outside tolerance and have named recovery owners."},
        {"type": "content", "variant": "stats", "title": "The system is stable except for contractor capacity", "facts": [{"value": "94%", "label": "Sensor freshness", "detail": "target 95%"}, {"value": "86%", "label": "Dispatch SLA", "detail": "target 90%"}, {"value": "17", "label": "Open actions", "detail": "5 overdue"}, {"value": "2", "label": "Escalations", "detail": "owner assigned"}], "footer": footer},
        {"type": "content", "variant": "chart", "title": "Dispatch volume rose faster than available crews", "subtitle": "Weekly requests and closures", "chart": {"type": "bar", "labels": ["W26", "W27", "W28", "W29"], "series": [{"name": "Requests", "labels": ["W26", "W27", "W28", "W29"], "values": [44, 53, 66, 79]}, {"name": "Closed", "labels": ["W26", "W27", "W28", "W29"], "values": [42, 51, 58, 62]}], "facts": [{"value": "17", "label": "Gap", "detail": "this week"}, {"value": "Priya", "label": "Owner", "detail": "crew recovery"}], "notes": "Capacity variance is now the operating constraint."}, "footer": footer},
        {"type": "content", "variant": "table", "title": "Every exception has an owner and due date", "headers": ["Exception", "Variance", "Owner", "Due"], "rows": [["Crew capacity", "-17 closures", "Priya", "Wed"], ["East sensors", "91% fresh", "Jon", "Tue"], ["Translation", "2 languages", "Maya", "Fri"]], "footer": footer},
    ]
    cases["operations-grid"] = deck

    deck = _base("policy-public-docket", GRAMMAR_PRESETS["policy-public-docket"])
    deck["slides"] = [
        {"type": "title", "title": "Who receives cooling protection first?", "subtitle": "Public docket 2027-04 | neighborhood heat response", "footer": footer},
        {"type": "section", "section_number": "02", "title": "Distribution and access", "subtitle": "The public question is not only where heat is highest, but who can reach relief."},
        {"type": "content", "variant": "image-sidebar", "title": "Exposure and access overlap in six priority districts", "subtitle": "Synthetic public-impact map", "assets": {"hero_image": assets["map"]}, "body": "Priority combines exposure, age, housing, and walking access.", "highlights": ["6 priority districts", "42,000 residents"], "footer": footer},
        {"type": "content", "variant": "matrix", "title": "Options differ most on equity and delivery", "subtitle": "Public option docket", "quadrants": [{"title": "Targeted grants", "body": "High equity | Medium speed"}, {"title": "Shade corridors", "body": "High reach | Slow build"}, {"title": "Extended hours", "body": "Medium reach | Fast start"}, {"title": "Uniform rebates", "body": "Low targeting | Medium speed"}], "footer": footer},
        {"type": "content", "variant": "timeline", "title": "Implementation includes a public measurement cycle", "timeline": [{"label": "30d", "title": "Publish", "body": "priority method"}, {"label": "60d", "title": "Launch", "body": "first actions"}, {"label": "90d", "title": "Report", "body": "reach and gaps"}, {"label": "180d", "title": "Adjust", "body": "funding mix"}], "footer": footer},
    ]
    cases["policy-public-docket"] = deck

    deck = _base("technical-telemetry-canvas", GRAMMAR_PRESETS["technical-telemetry-canvas"])
    deck["slides"] = [
        {"type": "title", "title": "Heat response telemetry review", "subtitle": "From sensor signal to verified dispatch", "status": "OBSERVE", "environment": "PROD", "window": "24H", "severity": "WATCH", "footer": footer},
        {"type": "section", "title": "Diagnose the dispatch delay", "subtitle": "The signal path is healthy until contractor assignment.", "status": "DIAGNOSE"},
        {"type": "content", "variant": "flow", "title": "The bottleneck sits between scoring and dispatch", "subtitle": "System dependency trace", "assets": {"diagram": assets["network"]}, "sidebar_sections": [{"title": "Signal", "body": "Score generated in 4 min"}, {"title": "Failure", "body": "Queue waits 38 min"}, {"title": "Action", "body": "Pre-allocate crews"}], "footer": footer},
        {"type": "content", "variant": "chart", "title": "Queue delay breaches threshold in the afternoon", "subtitle": "Median dispatch latency", "chart": {"type": "line", "labels": ["08", "10", "12", "14", "16", "18"], "values": [11, 13, 16, 29, 42, 38], "facts": [{"value": "42m", "label": "Peak", "detail": "threshold 20m"}, {"value": "14:00", "label": "Breach", "detail": "first observed"}], "notes": "Synthetic telemetry; event log aligns the latency shift with crew assignment."}, "footer": footer},
        {"type": "content", "variant": "table", "title": "The remediation gate verifies recovery, not deployment", "headers": ["Action", "Signal", "Pass gate", "Owner"], "rows": [["Pre-allocate crews", "Queue age", "<15 min", "Dispatch"], ["Backpressure", "Open jobs", "<25", "Platform"], ["Verify", "End-to-end latency", "<20 min", "SRE"]], "footer": footer},
    ]
    cases["technical-telemetry-canvas"] = deck
    return cases


def _contact_sheet(records: list[dict[str, Any]], output: Path) -> None:
    thumb_w, thumb_h = 220, 124
    gap, label_h, heading_h = 16, 58, 108
    block_w = thumb_w * 4 + gap * 5
    block_h = thumb_h + label_h + gap
    cols = 2
    rows = 4
    canvas = Image.new("RGB", (block_w * cols + gap, heading_h + block_h * rows + gap), "white")
    draw = ImageDraw.Draw(canvas)
    draw.text((gap, 16), "One topic, eight composition grammars", font=_font(30, True), fill="#111827")
    draw.text((gap, 58), "Cover, section, evidence, and decision shown. Palette is secondary to reading path and proof structure.", font=_font(15), fill="#475569")
    for index, record in enumerate(records):
        row, col = divmod(index, cols)
        x0 = gap + col * block_w
        y0 = heading_h + row * block_h
        draw.text((x0, y0), record["name"], font=_font(17, True), fill="#111827")
        draw.text((x0, y0 + 24), record["grammar_id"], font=_font(11), fill="#475569")
        indices = [0, 1, 2, 4]
        for tile_index, slide_index in enumerate(indices):
            with Image.open(record["images"][slide_index]) as raw:
                tile = ImageOps.fit(raw.convert("RGB"), (thumb_w, thumb_h), method=Image.Resampling.LANCZOS)
            canvas.paste(tile, (x0 + tile_index * (thumb_w + gap), y0 + label_h))
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--outdir", type=Path, default=Path("/tmp/presentation-skill-taste-grammar-showcase"))
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--proof-output", type=Path)
    args = parser.parse_args()
    outdir = args.outdir.expanduser().resolve()
    outdir.mkdir(parents=True, exist_ok=True)
    assets = _figure_assets(outdir / "assets")
    outlines = _outlines(assets)
    records: list[dict[str, Any]] = []
    failures: list[str] = []

    for grammar_id in COMPOSITION_GRAMMARS:
        preset = GRAMMAR_PRESETS[grammar_id]
        case_dir = outdir / grammar_id
        case_dir.mkdir(parents=True, exist_ok=True)
        outline_path = case_dir / "outline.json"
        pptx_path = case_dir / f"{grammar_id}.pptx"
        render_dir = case_dir / "renders"
        qa_dir = case_dir / "qa"
        visual_dir = case_dir / "visual-review"
        outline_path.write_text(json.dumps(outlines[grammar_id], indent=2), encoding="utf-8")
        try:
            _run(["node", "scripts/build_deck_pptxgenjs.js", "--outline", str(outline_path), "--output", str(pptx_path), "--style-preset", preset])
            _run(["python3", "scripts/render_slides.py", "--input", str(pptx_path), "--outdir", str(render_dir), "--dpi", "110", "--format", "jpeg"])
            qa_report = qa_dir / "report.json"
            _run(["python3", "scripts/qa_gate.py", "--input", str(pptx_path), "--outdir", str(qa_dir), "--style-preset", preset, "--skip-render", "--skip-manual-review", "--outline", str(outline_path), "--report", str(qa_report)])
            visual_report = visual_dir / "visual_review.json"
            _run(["python3", "scripts/visual_review.py", "--input", str(pptx_path), "--outline", str(outline_path), "--renders-dir", str(render_dir), "--outdir", str(visual_dir), "--report", str(visual_report)])
            qa = json.loads(qa_report.read_text(encoding="utf-8"))
            visual = json.loads(visual_report.read_text(encoding="utf-8"))
            images = sorted(render_dir.glob("slide-*.jpg"))
            if len(images) != 5:
                failures.append(f"{grammar_id}: rendered_slide_count={len(images)} expected=5")
            blocking = sum(int(qa.get(key) or 0) for key in ("overflow_count", "overlap_count", "design_error_count"))
            if blocking:
                failures.append(f"{grammar_id}: blocking_qa={blocking}")
            if int(visual.get("warning_count") or 0):
                failures.append(f"{grammar_id}: visual_warnings={visual.get('warning_count')}")
            records.append({
                "grammar_id": grammar_id,
                "name": str(COMPOSITION_GRAMMARS[grammar_id]["description"]).split(".")[0],
                "preset": preset,
                "pptx": str(pptx_path),
                "images": images,
                "qa": {"blocking": blocking, "visual_warnings": int(visual.get("warning_count") or 0)},
            })
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{grammar_id}: {exc}")

    sheet = outdir / "taste_grammar_showcase_contact_sheet.jpg"
    if len(records) == 8 and all(len(record["images"]) >= 5 for record in records):
        _contact_sheet(records, sheet)
        if args.proof_output:
            proof_output = args.proof_output.expanduser().resolve()
            proof_output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(sheet, proof_output)
    report = {
        "passed": not failures,
        "topic": TOPIC,
        "grammar_count": len(records),
        "contact_sheet": str(sheet) if sheet.is_file() else "",
        "records": [{**record, "images": [str(path) for path in record["images"]]} for record in records],
        "failures": failures,
    }
    report_path = outdir / "taste_grammar_showcase_report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({**report, "records": [{k: v for k, v in record.items() if k != "images"} for record in report["records"]]}, indent=2))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
