import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PptxGraphicPreview } from "../DetailsPanel";
import type { ArtifactPreview } from "../../lib/types";

describe("PptxGraphicPreview", () => {
  it("renders PPTX geometry in SVG points without scaling font size to EMUs", () => {
    const preview: Extract<ArtifactPreview, { kind: "pptx" }> = {
      kind: "pptx",
      name: "deck.pptx",
      slideCount: 1,
      width: 12_192_000,
      height: 6_858_000,
      slides: [{
        index: 1,
        background: "#0F2A43",
        title: "封面标题",
        paragraphs: ["封面标题"],
        elements: [
          {
            kind: "shape",
            preset: "ellipse",
            x: -457_200,
            y: -228_600,
            width: 914_400,
            height: 914_400,
            fill: "#1D3E58",
            opacity: 0.6,
            stroke: "#8FC7B6",
            strokeWidth: 12_700,
          },
          {
            kind: "shape",
            preset: "chevron",
            x: 914_400,
            y: 685_800,
            width: 9_144_000,
            height: 1_371_600,
            fill: "#F8FAFC",
          },
          {
            kind: "text",
            x: 914_400,
            y: 685_800,
            width: 9_144_000,
            height: 1_371_600,
            text: "封面标题",
            fontSize: 32,
            color: "#FFFFFF",
            lines: [[
              { text: "封面", fontSize: 32, color: "#FFFFFF" },
              { text: "标题", fontSize: 32, color: "#8FC7B6" },
            ]],
          },
        ],
      }],
      truncated: false,
    };

    const markup = renderToStaticMarkup(createElement(PptxGraphicPreview, { preview }));

    expect(markup).toContain('viewBox="0 0 960 540"');
    expect(markup).toContain("<ellipse");
    expect(markup).toContain('cx="0"');
    expect(markup).toContain('opacity="0.6"');
    expect(markup).toContain("<polygon");
    expect(markup).toContain('points="72,54 662.4,54 792,108 662.4,162 72,162 230.4,108"');
    expect(markup).toContain('x="75.84"');
    expect(markup).toContain('y="89.84"');
    expect(markup).toContain('font-size="32"');
    expect(markup).toContain('fill="#8FC7B6" font-size="32">标题');
    expect(markup).not.toContain('font-size="406400"');
  });
});
