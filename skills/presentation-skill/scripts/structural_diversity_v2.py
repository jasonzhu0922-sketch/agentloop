#!/usr/bin/env python3
"""Human-aligned, role-aware structural diversity evaluation for PPTX decks.

The evaluator deliberately ignores paint (color, fill, stroke) and shapes that
do not carry semantic content. Rendered pixels are used only for an edge-hash
diagnostic and for contact-sheet/skeleton proof artifacts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from dataclasses import asdict, dataclass
from itertools import combinations
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE


GRID_COLUMNS = 6
GRID_ROWS = 4
WHITESPACE_COLUMNS = 4
WHITESPACE_ROWS = 3
EDGE_HASH_SIZE = (24, 14)
GEOMETRY_QUANTUM = 1.0 / 48.0
FEATURE_GROUP_WEIGHTS = {
    "semantic_occupancy": 0.28,
    "topology": 0.22,
    "anchor_geometry": 0.23,
    "hierarchy_reading_order": 0.17,
    "whitespace_zoning": 0.10,
}


@dataclass(frozen=True)
class RolePolicy:
    distance_threshold: float
    minimum_clusters: int
    maximum_cluster_size: int
    maximum_largest_cluster_ratio: float
    minimum_normalized_entropy: float


DEFAULT_ROLE_POLICIES: dict[str, RolePolicy] = {
    "title": RolePolicy(0.060, 8, 2, 0.16, 0.78),
    "section": RolePolicy(0.060, 8, 2, 0.16, 0.78),
    "evidence": RolePolicy(0.020, 8, 2, 0.16, 0.78),
    "comparison": RolePolicy(0.010, 8, 2, 0.16, 0.78),
    "chart": RolePolicy(0.010, 8, 2, 0.16, 0.78),
    "table": RolePolicy(0.017, 8, 2, 0.16, 0.78),
    "decision": RolePolicy(0.018, 8, 2, 0.16, 0.78),
    "references": RolePolicy(0.005, 8, 2, 0.16, 0.78),
    "dense_title_evidence": RolePolicy(0.010, 8, 2, 0.16, 0.78),
}
DEFAULT_POLICY = RolePolicy(0.020, 8, 2, 0.16, 0.78)


@dataclass
class SemanticShape:
    kind: str
    x: float
    y: float
    w: float
    h: float
    font_size: float
    text_length: int
    placeholder: str
    name: str

    @property
    def area(self) -> float:
        return max(0.0, self.w) * max(0.0, self.h)

    @property
    def cx(self) -> float:
        return self.x + self.w / 2.0

    @property
    def cy(self) -> float:
        return self.y + self.h / 2.0


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return min(high, max(low, value))


def _quantize(value: float, quantum: float = GEOMETRY_QUANTUM) -> float:
    return round(_clamp(value) / quantum) * quantum


def _meaningful_text(value: str) -> str:
    return " ".join(str(value or "").split())


def _font_size(shape: Any) -> float:
    if not bool(getattr(shape, "has_text_frame", False)):
        return 0.0
    sizes: list[float] = []
    for paragraph in shape.text_frame.paragraphs:
        if paragraph.font.size:
            sizes.append(float(paragraph.font.size.pt))
        for run in paragraph.runs:
            if run.font.size:
                sizes.append(float(run.font.size.pt))
    return max(sizes, default=0.0)


def _placeholder_name(shape: Any) -> str:
    if not bool(getattr(shape, "is_placeholder", False)):
        return ""
    try:
        return str(shape.placeholder_format.type).split(".")[-1].upper()
    except (AttributeError, ValueError):
        return ""


def _group_has_semantics(shape: Any) -> bool:
    for child in getattr(shape, "shapes", []):
        if bool(getattr(child, "has_chart", False)) or bool(getattr(child, "has_table", False)):
            return True
        if getattr(child, "shape_type", None) == MSO_SHAPE_TYPE.PICTURE:
            return True
        if _meaningful_text(getattr(child, "text", "")):
            return True
    return False


def _base_kind(shape: Any, text: str, x: float, y: float, w: float, h: float) -> str:
    area = w * h
    placeholder = _placeholder_name(shape)
    if any(token in placeholder for token in ("FOOTER", "DATE", "SLIDE_NUMBER")):
        return ""
    if bool(getattr(shape, "has_chart", False)):
        return "chart"
    if bool(getattr(shape, "has_table", False)):
        return "table"
    shape_type = getattr(shape, "shape_type", None)
    if shape_type == MSO_SHAPE_TYPE.PICTURE:
        if area < 0.008 or area > 0.92:
            return ""
        return "image"
    if shape_type == MSO_SHAPE_TYPE.GROUP:
        return "group" if area >= 0.008 and _group_has_semantics(shape) else ""
    if not text or not re.search(r"[A-Za-z0-9]", text):
        return ""
    if y >= 0.925 and h <= 0.075:
        return ""
    if area < 0.0015 or (len(text) <= 2 and re.fullmatch(r"\d+", text)):
        return ""
    return "text"


def extract_semantic_shapes(slide: Any, slide_width: int, slide_height: int) -> list[SemanticShape]:
    """Return normalized semantic shapes, excluding paint-only decoration."""
    records: list[SemanticShape] = []
    for shape in slide.shapes:
        try:
            x = _clamp(float(shape.left) / float(slide_width))
            y = _clamp(float(shape.top) / float(slide_height))
            w = _clamp(float(shape.width) / float(slide_width), 0.0, 1.0 - x)
            h = _clamp(float(shape.height) / float(slide_height), 0.0, 1.0 - y)
        except (AttributeError, TypeError, ValueError, ZeroDivisionError):
            continue
        text = _meaningful_text(getattr(shape, "text", ""))
        kind = _base_kind(shape, text, x, y, w, h)
        if not kind:
            continue
        records.append(
            SemanticShape(
                kind=kind,
                x=_quantize(x),
                y=_quantize(y),
                w=_quantize(w),
                h=_quantize(h),
                font_size=_font_size(shape),
                text_length=len(text),
                placeholder=_placeholder_name(shape),
                name=str(getattr(shape, "name", "")),
            )
        )

    text_records = [record for record in records if record.kind == "text"]
    maximum_font = max((record.font_size for record in text_records), default=0.0)
    for record in text_records:
        title_placeholder = any(token in record.placeholder for token in ("TITLE", "CENTER_TITLE"))
        prominent_top_text = (
            maximum_font > 0
            and record.font_size >= maximum_font * 0.78
            and record.y <= 0.36
        )
        if title_placeholder or prominent_top_text:
            record.kind = "title"
    records.sort(key=lambda item: (item.y, item.x, -item.area, item.kind, item.name))
    return records


def _cell_coverage(shapes: Sequence[SemanticShape], columns: int, rows: int) -> list[float]:
    coverage: list[float] = []
    cell_w = 1.0 / columns
    cell_h = 1.0 / rows
    cell_area = cell_w * cell_h
    for row in range(rows):
        top = row * cell_h
        bottom = top + cell_h
        for column in range(columns):
            left = column * cell_w
            right = left + cell_w
            occupied = 0.0
            for shape in shapes:
                overlap_w = max(0.0, min(right, shape.x + shape.w) - max(left, shape.x))
                overlap_h = max(0.0, min(bottom, shape.y + shape.h) - max(top, shape.y))
                occupied += overlap_w * overlap_h
            coverage.append(round(_clamp(occupied / cell_area), 6))
    return coverage


def _cluster_axis(values: Sequence[float], tolerance: float = 0.10) -> int:
    if not values:
        return 0
    groups = [sorted(values)[0]]
    for value in sorted(values)[1:]:
        if abs(value - groups[-1]) > tolerance:
            groups.append(value)
        else:
            groups[-1] = (groups[-1] + value) / 2.0
    return len(groups)


def _rect_overlap(left: SemanticShape, right: SemanticShape) -> float:
    overlap_w = max(0.0, min(left.x + left.w, right.x + right.w) - max(left.x, right.x))
    overlap_h = max(0.0, min(left.y + left.h, right.y + right.h) - max(left.y, right.y))
    overlap = overlap_w * overlap_h
    denominator = min(left.area, right.area)
    return overlap / denominator if denominator else 0.0


def _rect_vector(shape: SemanticShape | None) -> list[float]:
    if shape is None:
        return [0.0, 0.0, 0.0, 0.0]
    return [shape.x, shape.y, shape.w, shape.h]


def _reading_order_vector(shapes: Sequence[SemanticShape]) -> list[float]:
    kind_codes = {
        "title": 0.0,
        "text": 0.2,
        "image": 0.4,
        "chart": 0.6,
        "table": 0.8,
        "group": 1.0,
    }
    text_sizes = sorted({round(shape.font_size, 1) for shape in shapes if shape.font_size > 0}, reverse=True)
    vector: list[float] = []
    for shape in list(shapes)[:6]:
        x_zone = min(2, int(shape.cx * 3)) / 2.0
        kind_code = kind_codes.get(shape.kind, 1.0)
        if shape.font_size > 0 and text_sizes:
            rank = text_sizes.index(round(shape.font_size, 1))
            size_rank = 1.0 - min(rank, 3) / 3.0
        else:
            size_rank = 0.0
        vector.extend((x_zone, kind_code, size_rank))
    while len(vector) < 18:
        vector.extend((0.0, 0.0, 0.0))
    return vector[:18]


def measure_slide(slide: Any, slide_width: int, slide_height: int) -> dict[str, Any]:
    shapes = extract_semantic_shapes(slide, slide_width, slide_height)
    occupancy = _cell_coverage(shapes, GRID_COLUMNS, GRID_ROWS)
    whitespace_occupancy = _cell_coverage(shapes, WHITESPACE_COLUMNS, WHITESPACE_ROWS)
    kinds = ("title", "text", "image", "chart", "table", "group")
    kind_areas = [min(1.0, sum(shape.area for shape in shapes if shape.kind == kind)) for kind in kinds]
    union_proxy = sum(1.0 for value in occupancy if value >= 0.25) / len(occupancy)
    title = max((shape for shape in shapes if shape.kind == "title"), key=lambda item: item.area, default=None)
    non_titles = [shape for shape in shapes if shape.kind != "title"]
    primary = max(non_titles, key=lambda item: item.area, default=None)
    if shapes:
        left = min(shape.x for shape in shapes)
        top = min(shape.y for shape in shapes)
        right = max(shape.x + shape.w for shape in shapes)
        bottom = max(shape.y + shape.h for shape in shapes)
        total_area = sum(shape.area for shape in shapes) or 1.0
        centroid_x = sum(shape.cx * shape.area for shape in shapes) / total_area
        centroid_y = sum(shape.cy * shape.area for shape in shapes) / total_area
    else:
        left = top = right = bottom = centroid_x = centroid_y = 0.0

    pairs = list(combinations(shapes, 2))
    horizontal_aligned = sum(abs(left_shape.cy - right_shape.cy) <= 0.065 for left_shape, right_shape in pairs)
    vertical_aligned = sum(abs(left_shape.cx - right_shape.cx) <= 0.065 for left_shape, right_shape in pairs)
    overlapping = sum(_rect_overlap(left_shape, right_shape) >= 0.08 for left_shape, right_shape in pairs)
    pair_count = max(1, len(pairs))
    left_area = sum(shape.area for shape in shapes if shape.cx < 0.5)
    right_area = sum(shape.area for shape in shapes if shape.cx >= 0.5)
    top_area = sum(shape.area for shape in shapes if shape.cy < 0.5)
    bottom_area = sum(shape.area for shape in shapes if shape.cy >= 0.5)
    area_sum = max(1e-9, left_area + right_area)
    vertical_area_sum = max(1e-9, top_area + bottom_area)

    text_shapes = [shape for shape in shapes if shape.kind in {"title", "text"}]
    font_levels = len({round(shape.font_size / 4.0) for shape in text_shapes if shape.font_size > 0})
    title_area = sum(shape.area for shape in shapes if shape.kind == "title")
    body_area = sum(shape.area for shape in shapes if shape.kind == "text")
    first_anchor_index = next(
        (index for index, shape in enumerate(shapes) if shape.kind in {"image", "chart", "table", "group"}),
        len(shapes),
    )

    groups = {
        "semantic_occupancy": occupancy + kind_areas + [union_proxy],
        "topology": [
            min(len(shapes), 16) / 16.0,
            min(_cluster_axis([shape.cx for shape in shapes]), 6) / 6.0,
            min(_cluster_axis([shape.cy for shape in shapes]), 6) / 6.0,
            horizontal_aligned / pair_count,
            vertical_aligned / pair_count,
            overlapping / pair_count,
            left_area / area_sum,
            right_area / area_sum,
            top_area / vertical_area_sum,
            bottom_area / vertical_area_sum,
        ],
        "anchor_geometry": (
            _rect_vector(title)
            + _rect_vector(primary)
            + [left, top, max(0.0, right - left), max(0.0, bottom - top), centroid_x, centroid_y]
        ),
        "hierarchy_reading_order": [
            min(font_levels, 5) / 5.0,
            title_area / max(1e-9, title_area + body_area),
            min(len(text_shapes), 12) / 12.0,
            min(first_anchor_index, 8) / 8.0,
        ] + _reading_order_vector(shapes),
        "whitespace_zoning": [round(1.0 - value, 6) for value in whitespace_occupancy]
        + [left, 1.0 - right, top, 1.0 - bottom],
    }
    return {
        "semantic_shape_count": len(shapes),
        "semantic_shapes": [asdict(shape) for shape in shapes],
        "feature_groups": {key: [round(float(value), 6) for value in values] for key, values in groups.items()},
        "feature_vector": [
            round(float(value), 6)
            for key in FEATURE_GROUP_WEIGHTS
            for value in groups[key]
        ],
    }


def _group_distance(left: Sequence[float], right: Sequence[float]) -> float:
    if len(left) != len(right):
        raise ValueError(f"Feature lengths differ: {len(left)} != {len(right)}")
    if not left:
        return 0.0
    return sum(abs(float(a) - float(b)) for a, b in zip(left, right)) / len(left)


def structural_distance(left: Mapping[str, Any], right: Mapping[str, Any]) -> tuple[float, dict[str, float]]:
    left_groups = left.get("feature_groups") or {}
    right_groups = right.get("feature_groups") or {}
    group_distances = {
        key: _group_distance(left_groups.get(key, []), right_groups.get(key, []))
        for key in FEATURE_GROUP_WEIGHTS
    }
    distance = sum(group_distances[key] * FEATURE_GROUP_WEIGHTS[key] for key in FEATURE_GROUP_WEIGHTS)
    return round(distance, 6), {key: round(value, 6) for key, value in group_distances.items()}


def _average_link_distance(
    left_cluster: Sequence[str],
    right_cluster: Sequence[str],
    distances: Mapping[tuple[str, str], float],
) -> float:
    values = []
    for left in left_cluster:
        for right in right_cluster:
            key = tuple(sorted((left, right)))
            values.append(float(distances[key]))
    return sum(values) / len(values)


def deterministic_clusters(ids: Sequence[str], distances: Mapping[tuple[str, str], float], threshold: float) -> list[list[str]]:
    """Agglomerative average-link clustering with stable lexical tie-breaking."""
    clusters = [[item] for item in sorted(ids)]
    while True:
        candidate: tuple[float, tuple[str, ...], int, int] | None = None
        for left_index in range(len(clusters)):
            for right_index in range(left_index + 1, len(clusters)):
                distance = _average_link_distance(clusters[left_index], clusters[right_index], distances)
                lexical = tuple(sorted(clusters[left_index] + clusters[right_index]))
                value = (round(distance, 12), lexical, left_index, right_index)
                if distance <= threshold and (candidate is None or value < candidate):
                    candidate = value
        if candidate is None:
            break
        _, _, left_index, right_index = candidate
        merged = sorted(clusters[left_index] + clusters[right_index])
        clusters = [cluster for index, cluster in enumerate(clusters) if index not in {left_index, right_index}]
        clusters.append(merged)
        clusters.sort(key=lambda cluster: tuple(cluster))
    return sorted(clusters, key=lambda cluster: (-len(cluster), tuple(cluster)))


def normalized_cluster_entropy(clusters: Sequence[Sequence[str]], population: int) -> float:
    if population <= 1:
        return 1.0
    entropy = 0.0
    for cluster in clusters:
        probability = len(cluster) / population
        if probability > 0:
            entropy -= probability * math.log2(probability)
    return entropy / math.log2(population)


def _edge_hash(path: Path) -> tuple[str, int]:
    with Image.open(path) as raw:
        gray = ImageOps.autocontrast(raw.convert("L"))
        edge = ImageOps.autocontrast(gray.filter(ImageFilter.FIND_EDGES))
        thumb = edge.resize(EDGE_HASH_SIZE, Image.Resampling.LANCZOS)
        values = [int(value) for value in thumb.getdata()]
    threshold = sum(values) / max(1, len(values))
    bits = "".join("1" if value >= threshold else "0" for value in values)
    return hex(int(bits, 2))[2:].zfill((len(bits) + 3) // 4), len(bits)


def _edge_hash_distance(left: str, right: str, bit_count: int) -> float:
    if not bit_count:
        return 0.0
    return bin(int(left, 16) ^ int(right, 16)).count("1") / bit_count


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


def _skeleton_overlay(measurement: Mapping[str, Any], render_path: Path | None, output: Path, label: str) -> None:
    if render_path and render_path.is_file():
        with Image.open(render_path) as raw:
            canvas = raw.convert("RGB")
    else:
        canvas = Image.new("RGB", (1280, 720), "white")
    draw = ImageDraw.Draw(canvas)
    colors = {
        "title": "#d62728",
        "text": "#2563eb",
        "image": "#16a34a",
        "chart": "#9333ea",
        "table": "#ea580c",
        "group": "#0891b2",
    }
    width, height = canvas.size
    for shape in measurement.get("semantic_shapes") or []:
        x0 = int(float(shape["x"]) * width)
        y0 = int(float(shape["y"]) * height)
        x1 = int((float(shape["x"]) + float(shape["w"])) * width)
        y1 = int((float(shape["y"]) + float(shape["h"])) * height)
        color = colors.get(str(shape.get("kind")), "#111827")
        draw.rectangle((x0, y0, x1, y1), outline=color, width=max(2, width // 500))
        draw.text((x0 + 4, y0 + 3), str(shape.get("kind")), fill=color, font=_font(max(11, width // 90), True))
    draw.rectangle((0, 0, width, max(28, height // 20)), fill="white")
    draw.text((8, 5), label, fill="#111827", font=_font(max(14, width // 65), True))
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output)


def _contact_sheet(items: Sequence[tuple[str, Path]], output: Path, title: str) -> None:
    if not items:
        return
    columns = min(4, len(items))
    tile_w, tile_h, label_h, gap, heading_h = 320, 180, 34, 14, 62
    rows = math.ceil(len(items) / columns)
    canvas = Image.new(
        "RGB",
        (
            columns * tile_w + (columns + 1) * gap,
            heading_h + rows * (tile_h + label_h + gap) + gap,
        ),
        "white",
    )
    draw = ImageDraw.Draw(canvas)
    draw.text((gap, 14), title, fill="#111827", font=_font(26, True))
    for index, (label, path) in enumerate(items):
        row, column = divmod(index, columns)
        x = gap + column * (tile_w + gap)
        y = heading_h + row * (tile_h + label_h + gap)
        draw.text((x, y), label, fill="#111827", font=_font(16, True))
        with Image.open(path) as raw:
            tile = ImageOps.fit(raw.convert("RGB"), (tile_w, tile_h), method=Image.Resampling.LANCZOS)
        canvas.paste(tile, (x, y + label_h))
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output)


def _resolve_path(base: Path, value: str | Path | None) -> Path | None:
    if not value:
        return None
    path = Path(value)
    return path if path.is_absolute() else (base / path).resolve()


def _policy_for(role: str, overrides: Mapping[str, Any]) -> RolePolicy:
    default = DEFAULT_ROLE_POLICIES.get(role, DEFAULT_POLICY)
    raw = overrides.get(role) if isinstance(overrides.get(role), Mapping) else {}
    return RolePolicy(
        distance_threshold=float(raw.get("distance_threshold", default.distance_threshold)),
        minimum_clusters=int(raw.get("minimum_clusters", default.minimum_clusters)),
        maximum_cluster_size=int(raw.get("maximum_cluster_size", default.maximum_cluster_size)),
        maximum_largest_cluster_ratio=float(
            raw.get("maximum_largest_cluster_ratio", default.maximum_largest_cluster_ratio)
        ),
        minimum_normalized_entropy=float(
            raw.get("minimum_normalized_entropy", default.minimum_normalized_entropy)
        ),
    )


def evaluate_manifest(
    manifest: Mapping[str, Any],
    *,
    manifest_base: Path,
    artifacts_dir: Path | None = None,
    repeated_pair_role_limit: int = 5,
) -> dict[str, Any]:
    deck_specs = manifest.get("decks")
    if not isinstance(deck_specs, list) or len(deck_specs) < 2:
        raise ValueError("manifest.decks must contain at least two deck entries")
    policies = manifest.get("role_policies") if isinstance(manifest.get("role_policies"), Mapping) else {}
    coherent_groups = (
        manifest.get("coherent_groups")
        if isinstance(manifest.get("coherent_groups"), Mapping)
        else {}
    )
    measurements_by_role: dict[str, dict[str, dict[str, Any]]] = {}
    render_paths: dict[tuple[str, str], Path] = {}
    source_records: list[dict[str, Any]] = []

    for deck_spec in deck_specs:
        if not isinstance(deck_spec, Mapping):
            raise ValueError("Each deck entry must be an object")
        deck_id = str(deck_spec.get("id") or "").strip()
        pptx_path = _resolve_path(manifest_base, deck_spec.get("pptx"))
        slide_specs = deck_spec.get("slides")
        if not deck_id or pptx_path is None or not pptx_path.is_file():
            raise ValueError(f"Invalid deck entry for {deck_id or '<missing id>'}: PPTX not found")
        if not isinstance(slide_specs, list) or not slide_specs:
            raise ValueError(f"Deck {deck_id} has no slide-role mappings")
        presentation = Presentation(str(pptx_path))
        seen_roles: set[str] = set()
        for slide_spec in slide_specs:
            if not isinstance(slide_spec, Mapping):
                raise ValueError(f"Deck {deck_id} has a non-object slide mapping")
            role = str(slide_spec.get("role") or "").strip()
            slide_index = int(slide_spec.get("index") or 0)
            if not role or role in seen_roles:
                raise ValueError(f"Deck {deck_id} has a missing or duplicate role: {role!r}")
            if slide_index < 1 or slide_index > len(presentation.slides):
                raise ValueError(f"Deck {deck_id} role {role} has invalid one-based slide index {slide_index}")
            seen_roles.add(role)
            measurement = measure_slide(
                presentation.slides[slide_index - 1], presentation.slide_width, presentation.slide_height
            )
            measurement["slide_index"] = slide_index
            measurements_by_role.setdefault(role, {})[deck_id] = measurement
            render_path = _resolve_path(manifest_base, slide_spec.get("render"))
            if render_path and render_path.is_file():
                render_paths[(deck_id, role)] = render_path
        source_records.append({"id": deck_id, "pptx": str(pptx_path), "roles": sorted(seen_roles)})

    expected_roles = set(measurements_by_role)
    deck_ids = sorted(record["id"] for record in source_records)
    for record in source_records:
        missing = sorted(expected_roles - set(record["roles"]))
        if missing:
            raise ValueError(f"Deck {record['id']} is missing roles: {', '.join(missing)}")

    failures: list[dict[str, Any]] = []
    role_reports: dict[str, Any] = {}
    co_clustered_counts: dict[tuple[str, str], list[str]] = {}
    edge_hashes: dict[tuple[str, str], tuple[str, int]] = {}
    for key, path in render_paths.items():
        edge_hashes[key] = _edge_hash(path)

    for role in sorted(expected_roles):
        role_measurements = measurements_by_role[role]
        structural_pairs: list[dict[str, Any]] = []
        distance_lookup: dict[tuple[str, str], float] = {}
        edge_pairs: list[dict[str, Any]] = []
        for left_id, right_id in combinations(deck_ids, 2):
            distance, group_distances = structural_distance(role_measurements[left_id], role_measurements[right_id])
            key = (left_id, right_id)
            distance_lookup[key] = distance
            structural_pairs.append(
                {
                    "left": left_id,
                    "right": right_id,
                    "distance": distance,
                    "group_distances": group_distances,
                }
            )
            if (left_id, role) in edge_hashes and (right_id, role) in edge_hashes:
                left_hash, bit_count = edge_hashes[(left_id, role)]
                right_hash, _ = edge_hashes[(right_id, role)]
                edge_pairs.append(
                    {
                        "left": left_id,
                        "right": right_id,
                        "normalized_distance": round(_edge_hash_distance(left_hash, right_hash, bit_count), 6),
                    }
                )
        structural_pairs.sort(key=lambda item: (item["distance"], item["left"], item["right"]))
        edge_pairs.sort(key=lambda item: (item["normalized_distance"], item["left"], item["right"]))
        policy = _policy_for(role, policies)
        clusters = deterministic_clusters(deck_ids, distance_lookup, policy.distance_threshold)
        entropy = normalized_cluster_entropy(clusters, len(deck_ids))
        largest_cluster = max((len(cluster) for cluster in clusters), default=0)
        largest_ratio = largest_cluster / len(deck_ids)
        role_failures: list[str] = []
        if len(clusters) < policy.minimum_clusters:
            role_failures.append(f"cluster_count={len(clusters)} below={policy.minimum_clusters}")
        if largest_ratio > policy.maximum_largest_cluster_ratio:
            role_failures.append(
                f"largest_cluster_ratio={largest_ratio:.4f} above={policy.maximum_largest_cluster_ratio:.4f}"
            )
        if largest_cluster > policy.maximum_cluster_size:
            role_failures.append(
                f"largest_cluster_size={largest_cluster} above={policy.maximum_cluster_size}"
            )
        if entropy < policy.minimum_normalized_entropy:
            role_failures.append(
                f"normalized_entropy={entropy:.4f} below={policy.minimum_normalized_entropy:.4f}"
            )
        cross_grammar_clusters: list[dict[str, Any]] = []
        if coherent_groups:
            for cluster in clusters:
                groups = sorted(
                    {
                        str(coherent_groups.get(deck_id) or "").strip()
                        for deck_id in cluster
                        if str(coherent_groups.get(deck_id) or "").strip()
                    }
                )
                if len(groups) > 1:
                    cross_grammar_clusters.append(
                        {"members": sorted(cluster), "coherent_groups": groups}
                    )
            if cross_grammar_clusters:
                role_failures.append(
                    f"cross_grammar_cluster_count={len(cross_grammar_clusters)}"
                )
        if role_failures:
            failures.append({"type": "role_policy", "role": role, "reasons": role_failures})
        for cluster in cross_grammar_clusters:
            failures.append({"type": "cross_grammar_cluster", "role": role, **cluster})
        for cluster in clusters:
            for pair in combinations(sorted(cluster), 2):
                co_clustered_counts.setdefault(pair, []).append(role)
        role_reports[role] = {
            "passed": not role_failures,
            "policy": asdict(policy),
            "cluster_count": len(clusters),
            "largest_cluster_size": largest_cluster,
            "largest_cluster_ratio": round(largest_ratio, 6),
            "normalized_entropy": round(entropy, 6),
            "clusters": [{"cluster_id": index + 1, "members": members} for index, members in enumerate(clusters)],
            "cross_grammar_clusters": cross_grammar_clusters,
            "pairwise_distances": structural_pairs,
            "edge_hash_diagnostic": {
                "used_for_gate": False,
                "hashes": {
                    deck_id: edge_hashes[(deck_id, role)][0]
                    for deck_id in deck_ids
                    if (deck_id, role) in edge_hashes
                },
                "pairwise_distances": edge_pairs,
            },
            "features": role_measurements,
            "failures": role_failures,
        }

    repeated_pairs = []
    for pair, roles in sorted(co_clustered_counts.items(), key=lambda item: (-len(item[1]), item[0])):
        same_coherent_group = bool(
            coherent_groups.get(pair[0])
            and coherent_groups.get(pair[0]) == coherent_groups.get(pair[1])
        )
        record = {
            "left": pair[0],
            "right": pair[1],
            "role_count": len(roles),
            "roles": sorted(roles),
            "same_coherent_group": same_coherent_group,
            "coherent_group": coherent_groups.get(pair[0]) if same_coherent_group else "",
        }
        repeated_pairs.append(record)
        if len(roles) >= repeated_pair_role_limit and not same_coherent_group:
            failures.append({"type": "repeated_pair", **record, "limit": repeated_pair_role_limit})

    artifacts: dict[str, Any] = {"skeleton_overlays": {}, "contact_sheets": {}}
    if artifacts_dir is not None:
        artifacts_dir.mkdir(parents=True, exist_ok=True)
        for role in sorted(expected_roles):
            contact_items: list[tuple[str, Path]] = []
            for deck_id in deck_ids:
                overlay = artifacts_dir / "skeletons" / role / f"{deck_id}.png"
                _skeleton_overlay(
                    measurements_by_role[role][deck_id],
                    render_paths.get((deck_id, role)),
                    overlay,
                    f"{deck_id} | {role}",
                )
                artifacts["skeleton_overlays"].setdefault(role, {})[deck_id] = str(overlay)
                contact_items.append((deck_id, overlay))
            contact = artifacts_dir / "contact_sheets" / f"{role}.jpg"
            _contact_sheet(contact_items, contact, f"Structural skeletons | {role}")
            artifacts["contact_sheets"][role] = str(contact)

    canonical_features = json.dumps(
        {role: role_reports[role]["features"] for role in sorted(role_reports)},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return {
        "schema_version": "structural-diversity-v2",
        "passed": not failures,
        "deck_count": len(deck_ids),
        "roles": sorted(expected_roles),
        "feature_groups": FEATURE_GROUP_WEIGHTS,
        "paint_features_ignored": ["color", "fill", "stroke", "decorative_only_shapes"],
        "clustering": {
            "algorithm": "deterministic_agglomerative_average_link",
            "repeated_pair_role_limit": repeated_pair_role_limit,
            "coherent_group_pair_exemption": bool(coherent_groups),
        },
        "feature_digest": hashlib.sha256(canonical_features).hexdigest(),
        "decks": source_records,
        "role_reports": role_reports,
        "repeated_co_clustered_pairs": repeated_pairs,
        "artifacts": artifacts,
        "failures": failures,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--artifacts-dir", type=Path)
    parser.add_argument("--repeated-pair-role-limit", type=int, default=5)
    args = parser.parse_args()
    manifest_path = args.manifest.resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    report = evaluate_manifest(
        manifest,
        manifest_base=manifest_path.parent,
        artifacts_dir=args.artifacts_dir.resolve() if args.artifacts_dir else None,
        repeated_pair_role_limit=args.repeated_pair_role_limit,
    )
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    summary = {
        "passed": report["passed"],
        "report": str(args.report.resolve()),
        "deck_count": report["deck_count"],
        "roles": report["roles"],
        "role_clusters": {
            role: report["role_reports"][role]["cluster_count"] for role in report["roles"]
        },
        "failure_count": len(report["failures"]),
    }
    print(json.dumps(summary, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
