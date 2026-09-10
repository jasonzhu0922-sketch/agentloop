import assert from "node:assert/strict";
import test from "node:test";
import { artifactPreviewMode, renderPptxPreview, renderStructuredPreview, usesBlobPreview } from "../src/index.ts";

test("routes browser-native formats to byte previews and Office formats to structured previews", () => {
  assert.equal(artifactPreviewMode({ name: "deck.html", mimeType: "text/html; charset=utf-8" }), "html");
  assert.equal(artifactPreviewMode({ name: "poster.png", mimeType: "image/png" }), "image");
  assert.equal(artifactPreviewMode({ name: "report.pdf", mimeType: "application/pdf" }), "pdf");
  assert.equal(artifactPreviewMode({ name: "notes.md", mimeType: "text/markdown" }), "structured");
  assert.equal(artifactPreviewMode({ name: "deck.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }), "structured");
  assert.equal(usesBlobPreview({ name: "deck.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }), false);
});

test("renders PPTX geometry in SVG points rather than EMUs", () => {
  const markup = renderPptxPreview({
    kind: "pptx", name: "deck.pptx", slideCount: 1, width: 12_192_000, height: 6_858_000, truncated: false,
    slides: [{ index: 1, background: "#0F2A43", title: "封面标题", paragraphs: ["封面标题"], elements: [
      { kind: "shape", preset: "ellipse", x: -457_200, y: -228_600, width: 914_400, height: 914_400, fill: "#1D3E58", opacity: 0.6, stroke: "#8FC7B6", strokeWidth: 12_700 },
      { kind: "shape", preset: "chevron", x: 914_400, y: 685_800, width: 9_144_000, height: 1_371_600, fill: "#F8FAFC" },
      { kind: "text", x: 914_400, y: 685_800, width: 9_144_000, height: 1_371_600, text: "封面标题", fontSize: 32, color: "#FFFFFF", lines: [[{ text: "封面", fontSize: 32, color: "#FFFFFF" }, { text: "标题", fontSize: 32, color: "#8FC7B6" }]] },
    ] }],
  });
  assert.match(markup, /viewBox="0 0 960 540"/);
  assert.match(markup, /<ellipse cx="0"/);
  assert.match(markup, /points="72,54 662\.4,54 792,108 662\.4,162 72,162 230\.4,108"/);
  assert.match(markup, /fill="#8FC7B6" font-size="32">标题/);
  assert.doesNotMatch(markup, /406400/);
});

test("escapes extracted content while allowing the caller's markdown renderer", () => {
  const markup = renderStructuredPreview({ kind: "docx", name: "unsafe.docx", paragraphs: ["<script>"], truncated: false });
  assert.match(markup, /&lt;script&gt;/);
  assert.doesNotMatch(markup, /<script>/);
});
