import assert from "node:assert/strict";
import test from "node:test";
import { artifactPreviewMode, renderBlobPreview, renderMarkdown, renderPptxPreview, renderStructuredPreview, setArtifactPreviewMaximized, updateArtifactPreviewMarkup, usesBlobPreview } from "../src/index.ts";

test("routes browser-native formats to byte previews and Office formats to structured previews", () => {
  assert.equal(artifactPreviewMode({ name: "deck.html", mimeType: "text/html; charset=utf-8" }), "html");
  assert.equal(artifactPreviewMode({ name: "poster.png", mimeType: "image/png" }), "image");
  assert.equal(artifactPreviewMode({ name: "report.pdf", mimeType: "application/pdf" }), "pdf");
  assert.equal(artifactPreviewMode({ name: "southern_station.wav", mimeType: "audio/wav" }), "audio");
  assert.equal(artifactPreviewMode({ name: "voice.mp3", mimeType: "audio/mpeg" }), "audio");
  assert.equal(artifactPreviewMode({ name: "recording.m4a", mimeType: "application/octet-stream" }), "audio");
  assert.equal(artifactPreviewMode({ name: "stream.bin", mimeType: "audio/ogg; codecs=opus" }), "audio");
  assert.equal(artifactPreviewMode({ name: "notes.md", mimeType: "text/markdown" }), "structured");
  assert.equal(artifactPreviewMode({ name: "deck.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }), "structured");
  assert.equal(usesBlobPreview({ name: "deck.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }), false);
});

test("renders all recognized audio artifacts with native playback, pause, and volume controls", () => {
  const markup = renderBlobPreview("audio", "blob:audio-preview", "voice.mp3");

  assert.match(markup, /<audio\b/);
  assert.match(markup, /\bcontrols\b/);
  assert.match(markup, /src="blob:audio-preview"/);
  assert.match(markup, /无法播放该音频/);
});

test("preserves a mounted native audio player when parent state re-renders without preview changes", () => {
  let markup = "";
  let writes = 0;
  const host = {
    get innerHTML() { return markup; },
    set innerHTML(value: string) { markup = value; writes += 1; },
  } as unknown as HTMLElement;
  const audio = renderBlobPreview("audio", "blob:morning-stroll", "morning_stroll.wav");

  assert.equal(updateArtifactPreviewMarkup(host, audio), true);
  assert.equal(updateArtifactPreviewMarkup(host, audio), false);
  assert.equal(writes, 1);
  assert.equal(markup, audio);
  assert.equal(updateArtifactPreviewMarkup(host, ""), true);
  assert.equal(writes, 2);
});

test("maximizing keeps the backdrop safe area and dialog layout state in sync", () => {
  const classes = (initial: readonly string[] = []) => {
    const values = new Set(initial);
    return {
      contains: (value: string) => values.has(value),
      toggle: (value: string, force?: boolean) => {
        const enabled = force ?? !values.has(value);
        if (enabled) values.add(value); else values.delete(value);
        return enabled;
      },
    };
  };
  const backdrop = { classList: classes() } as unknown as HTMLElement;
  const dialog = { classList: classes() } as unknown as HTMLElement;
  const attributes = new Map<string, string>();
  const maximize = {
    textContent: "⛶",
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  } as unknown as HTMLButtonElement;

  setArtifactPreviewMaximized(backdrop, dialog, maximize, true);
  assert.equal(backdrop.classList.contains("maximized"), true);
  assert.equal(dialog.classList.contains("maximized"), true);
  assert.equal(maximize.textContent, "↙");
  assert.equal(attributes.get("aria-label"), "还原预览");

  setArtifactPreviewMaximized(backdrop, dialog, maximize, false);
  assert.equal(backdrop.classList.contains("maximized"), false);
  assert.equal(dialog.classList.contains("maximized"), false);
  assert.equal(maximize.textContent, "⛶");
  assert.equal(attributes.get("aria-label"), "最大化预览");
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

test("escapes extracted content and uses the shared renderer for Markdown previews", () => {
  const markup = renderStructuredPreview({ kind: "docx", name: "unsafe.docx", paragraphs: ["<script>"], truncated: false });
  assert.match(markup, /&lt;script&gt;/);
  assert.doesNotMatch(markup, /<script>/);

  const markdown = renderStructuredPreview({
    kind: "text",
    name: "score.md",
    mimeType: "text/markdown",
    text: "#### I03 有/无余热利用项目\n\n---",
    truncated: false,
  });
  assert.match(markdown, /<h4>I03 有\/无余热利用项目<\/h4>/);
  assert.match(markdown, /<hr>/);
  assert.doesNotMatch(markdown, /####|<p>---<\/p>/);
});

test("renders DOCX/v2 blocks with page geometry, run styles, lists, and tables", () => {
  const markup = renderStructuredPreview({
    kind: "docx",
    name: "report.docx",
    paragraphs: [],
    truncated: false,
    schema: "agentloop.docxPreview/v2",
    page: { widthTwips: 12240, heightTwips: 15840, marginsTwips: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
    blocks: [
      { type: "paragraph", style: "Heading1", alignment: "center", runs: [{ text: "季度报告", bold: true, fontSizeHalfPoints: 32 }] },
      { type: "paragraph", numbering: { level: 0, ordered: false }, runs: [{ text: "关键结论", italic: true }] },
      { type: "table", rows: [{ cells: [{ blocks: [{ type: "paragraph", runs: [{ text: "指标" }] }] }, { blocks: [{ type: "paragraph", runs: [{ text: "结果" }] }] }] }] },
    ],
  });
  assert.match(markup, /preview-docx-page/);
  assert.match(markup, /--docx-page-width:816px/);
  assert.match(markup, /font-weight:700/);
  assert.match(markup, /preview-docx-marker/);
  assert.match(markup, /preview-docx-table/);
});

test("DOCX preview keeps a visible fallback when structured page data is incomplete", () => {
  const markup = renderStructuredPreview({ kind: "docx", name: "legacy.docx", paragraphs: ["正文"], truncated: false, schema: "agentloop.docxPreview/v2", blocks: [], page: undefined });
  assert.match(markup, /preview-docx-page/);
  assert.match(markup, /正文/);
  assert.match(markup, /--docx-page-width:793\.7333333333333px/);
});

test("renders complete GFM structures instead of exposing Markdown tags", () => {
  const markup = renderMarkdown([
    "#### 四级标题",
    "",
    "---",
    "",
    "- [x] 已完成",
    "- [ ] 待处理",
    "",
    "~~旧结论~~",
    "",
    "> 引用",
    "",
    "| API_ID | 状态 |",
    "|:---|---:|",
    "| `M_ADS_FACT` | 已发布 |",
  ].join("\n"));

  assert.match(markup, /<h4>四级标题<\/h4>/);
  assert.match(markup, /<hr>/);
  assert.match(markup, /type="checkbox"/);
  assert.match(markup, /<del>旧结论<\/del>/);
  assert.match(markup, /<blockquote>/);
  assert.match(markup, /<div class="md-table-wrap"><table>/);
  assert.match(markup, /<code class="md-inline">M_ADS_FACT<\/code>/);
});

test("escapes embedded HTML and rejects executable Markdown URLs", () => {
  const markup = renderMarkdown([
    "<script>alert('xss')</script>",
    "",
    "[unsafe](javascript:alert(1))",
    "",
    "[obfuscated](java&#x73;cript:alert(1))",
    "",
    "[safe](https://example.com/report)",
    "",
    "![unsafe image](data:image/svg+xml;base64,PHN2Zz4=)",
  ].join("\n"));

  assert.doesNotMatch(markup, /<script>|javascript:|data:image/);
  assert.match(markup, /&lt;script&gt;/);
  assert.match(markup, /<p>unsafe<\/p>/);
  assert.match(markup, /<p>obfuscated<\/p>/);
  assert.match(markup, /href="https:\/\/example\.com\/report" target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(markup, /<img/);
});
