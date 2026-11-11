import { Marked, Renderer, type Tokens } from "marked";

export interface PreviewArtifact {
  readonly id: string;
  readonly name: string;
  readonly path?: string;
  readonly bytes: number;
  readonly mimeType: string;
}

export type ArtifactPreviewMode = "html" | "image" | "pdf" | "audio" | "structured";

const AUDIO_EXTENSIONS = new Set([
  "aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "weba",
]);

// The host may re-render surrounding conversation state while a preview is
// active. Replacing identical markup would recreate browser-native media
// elements and reset their playback state, so remember what each host owns.
const mountedPreviewMarkup = new WeakMap<HTMLElement, string>();

export type StructuredArtifactPreview =
  | { readonly kind: "text"; readonly name: string; readonly mimeType: string; readonly text: string; readonly truncated: boolean }
  | { readonly kind: "docx"; readonly name: string; readonly paragraphs: readonly string[]; readonly truncated: boolean; readonly schema?: "agentloop.docxPreview/v2"; readonly page?: DocxPreviewPage; readonly blocks?: readonly DocxPreviewBlock[] }
  | { readonly kind: "xlsx"; readonly name: string; readonly sheets: readonly { readonly name: string; readonly rows: readonly (readonly string[])[]; readonly truncated: boolean }[]; readonly truncated?: boolean }
  | { readonly kind: "pptx"; readonly name: string; readonly slideCount: number; readonly width: number; readonly height: number; readonly slides: readonly PptxPreviewSlide[]; readonly truncated: boolean }
  | { readonly kind: "binary"; readonly name: string; readonly mimeType: string };

export interface DocxPreviewPage {
  readonly widthTwips: number;
  readonly heightTwips: number;
  readonly marginsTwips: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number };
}

export type DocxPreviewBlock = DocxPreviewParagraph | DocxPreviewTable | DocxPreviewImage;

export interface DocxPreviewParagraph {
  readonly type: "paragraph";
  readonly style?: string;
  readonly alignment?: "left" | "center" | "right" | "justify";
  readonly indentLeftTwips?: number;
  readonly indentRightTwips?: number;
  readonly firstLineTwips?: number;
  readonly spaceBeforeTwips?: number;
  readonly spaceAfterTwips?: number;
  readonly lineTwips?: number;
  readonly numbering?: { readonly level: number; readonly ordered: boolean };
  readonly runs: readonly DocxPreviewRun[];
}

export interface DocxPreviewRun {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
  readonly color?: string;
  readonly fontSizeHalfPoints?: number;
  readonly fontFamily?: string;
}

export interface DocxPreviewTable {
  readonly type: "table";
  readonly rows: readonly { readonly cells: readonly { readonly blocks: readonly DocxPreviewBlock[] }[] }[];
}

export interface DocxPreviewImage {
  readonly type: "image";
  readonly src: string;
  readonly alt?: string;
  readonly widthEmu?: number;
  readonly heightEmu?: number;
}

export interface PptxPreviewSlide {
  readonly index: number;
  readonly background?: string;
  readonly title?: string;
  readonly paragraphs: readonly string[];
  readonly elements: readonly PptxPreviewElement[];
}

export type PptxPreviewElement =
  | { readonly kind: "shape"; readonly preset?: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly fill: string; readonly opacity?: number; readonly stroke?: string; readonly strokeWidth?: number }
  | { readonly kind: "text"; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly text: string; readonly fontSize?: number; readonly color?: string; readonly fill?: string; readonly lines?: readonly (readonly PptxPreviewTextRun[])[] };

export interface PptxPreviewTextRun {
  readonly text: string;
  readonly fontSize?: number;
  readonly color?: string;
}

export interface OpenArtifactPreviewOptions {
  readonly artifact: PreviewArtifact;
  readonly fetchBytes: () => Promise<Blob>;
  readonly fetchStructuredPreview: () => Promise<StructuredArtifactPreview>;
  readonly renderMarkdown?: (text: string) => string;
  readonly document?: Document;
}

export interface ArtifactPreviewDialog {
  close(): void;
}

/**
 * Keeps the preview shell and its dialog on the same layout state. The
 * backdrop owns the safe-area gutter while the dialog fills that area.
 */
export function setArtifactPreviewMaximized(
  backdrop: HTMLElement,
  dialog: HTMLElement,
  maximize: HTMLButtonElement,
  maximized: boolean,
): void {
  backdrop.classList.toggle("maximized", maximized);
  dialog.classList.toggle("maximized", maximized);
  maximize.textContent = maximized ? "↙" : "⛶";
  maximize.setAttribute("aria-label", maximized ? "还原预览" : "最大化预览");
}

const SAFE_LINK_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
const SAFE_IMAGE_SCHEMES = new Set(["http", "https"]);

class AgentLoopMarkdownRenderer extends Renderer {
  override html({ text }: Tokens.HTML | Tokens.Tag): string {
    return escapeHtml(text);
  }

  override code({ text, lang }: Tokens.Code): string {
    const language = lang?.trim().split(/\s+/, 1)[0]?.replace(/[^a-z0-9_+-]/gi, "");
    const languageClass = language ? ` class="language-${escapeHtml(language)}"` : "";
    if (language?.toLowerCase() === "chart") {
      try {
        return renderMarkdownChart(text);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "无效图表";
        return `<div class="md-chart-error" role="status">图表未显示：${escapeHtml(reason)}</div><pre class="md-code"><code${languageClass}>${escapeHtml(text)}</code></pre>\n`;
      }
    }
    return `<pre class="md-code"><code${languageClass}>${escapeHtml(text)}</code></pre>\n`;
  }

  override codespan({ text }: Tokens.Codespan): string {
    return `<code class="md-inline">${escapeHtml(text)}</code>`;
  }

  override table(token: Tokens.Table): string {
    return `<div class="md-table-wrap">${super.table(token)}</div>\n`;
  }

  override link(token: Tokens.Link): string {
    const label = this.parser.parseInline(token.tokens);
    const href = safeMarkdownUrl(token.href, SAFE_LINK_SCHEMES);
    if (href === undefined) return label;
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${title}>${label}</a>`;
  }

  override image(token: Tokens.Image): string {
    const src = safeMarkdownUrl(token.href, SAFE_IMAGE_SCHEMES);
    if (src === undefined) return escapeHtml(token.text);
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
    return `<img class="md-image" src="${escapeHtml(src)}" alt="${escapeHtml(token.text)}" loading="lazy" decoding="async" referrerpolicy="no-referrer"${title}>`;
  }
}

const markdown = new Marked();
markdown.setOptions({
  async: false,
  breaks: false,
  gfm: true,
  pedantic: false,
  renderer: new AgentLoopMarkdownRenderer(),
});

/** Renders model- or artifact-supplied GFM while escaping embedded HTML. */
export function renderMarkdown(raw: unknown): string {
  return markdown.parse(String(raw ?? ""), { async: false });
}

/** A bounded declarative chart surface: no model-supplied markup or executable options. */
function renderMarkdownChart(source: string): string {
  if (source.length > 64_000) throw new Error("图表数据超过大小限制");
  const value = JSON.parse(source);
  const fail = (message: string): never => { throw new Error(message); };
  const label = (item: unknown, limit = 120): string => {
    if (typeof item !== "string" || item.length > limit) return fail("标题、标签或系列名称无效");
    return item;
  };
  if (!value || !["line", "bar", "pie"].includes(value.type)) fail("支持的图表类型为 line、bar、pie");
  const type: "line" | "bar" | "pie" = value.type;
  const title = label(value.title ?? "", 160);
  const xLabel = label(value.xLabel ?? "");
  const yLabel = label(value.yLabel ?? "");
  if (!Array.isArray(value.labels) || value.labels.length < 1 || value.labels.length > 48) fail("需要 1–48 个标签，请明确聚合或使用表格");
  const labels: string[] = value.labels.map((item: unknown) => label(item));
  if (!Array.isArray(value.series) || value.series.length < 1 || value.series.length > 6) fail("需要 1–6 个系列");
  const series: { name: string; values: (number | null)[] }[] = value.series.map((item: any) => {
    if (!item || !Array.isArray(item.values) || item.values.length !== labels.length) fail("每个系列的数值必须与标签一一对应");
    return {
      name: label(item.name ?? ""),
      values: item.values.map((number: unknown) => {
        if (number === null && type === "line") return null;
        if (typeof number !== "number" || !Number.isFinite(number) || Math.abs(number) > 1e100) return fail("数值必须有限；仅折线图允许用 null 表示缺失观测");
        return number;
      }),
    };
  });
  const colors = ["#2563eb", "#e76f00", "#008577", "#a13cc5", "#be3466", "#64748b"];
  const color = (index: number): string => colors[index] ?? `hsl(${(index * 137.508) % 360} 65% 42%)`;
  const numberText = (number: number | null): string => number === null ? "缺失" : String(number);
  const text = (x: number, y: number, content: string, extra = ""): string =>
    `<text x="${x}" y="${y}" ${extra}>${escapeHtml(content)}</text>`;
  const tip = (content: string): string => `<title>${escapeHtml(content)}</title>`;
  const caption = title || { line: "折线图", bar: "柱状图", pie: "饼图" }[type];
  let drawing = "";
  let width = 720;
  let height = 390;
  let pieTotal = 0;
  if (type === "pie") {
    if (series.length !== 1) fail("饼图只接受一个系列");
    const values = series[0]!.values as number[];
    const total = values.reduce((sum, number) => sum + number, 0);
    if (values.some((number) => number < 0) || total <= 0) fail("饼图需要非负数值且总和大于零");
    pieTotal = total;
    height = 350;
    let angle = -Math.PI / 2;
    values.forEach((number, index) => {
      const fraction = number / total;
      const next = angle + fraction * Math.PI * 2;
      const detail = `${labels[index]}: ${numberText(number)} (${(fraction * 100).toFixed(1)}%)`;
      if (fraction === 1) drawing += `<circle cx="360" cy="175" r="135" fill="${color(index)}">${tip(detail)}</circle>`;
      else if (fraction > 0) {
        const start = [360 + 135 * Math.cos(angle), 175 + 135 * Math.sin(angle)];
        const end = [360 + 135 * Math.cos(next), 175 + 135 * Math.sin(next)];
        drawing += `<path d="M360,175 L${start.join(",")} A135,135 0 ${fraction > .5 ? 1 : 0},1 ${end.join(",")} Z" fill="${color(index)}" stroke="var(--bg, white)">${tip(detail)}</path>`;
      }
      angle = next;
    });
  } else {
    const observed = series.flatMap((item) => item.values.filter((number): number is number => number !== null));
    if (!observed.length) fail("没有可绘制的观测值");
    let min = Math.min(...observed, ...(type === "bar" ? [0] : []));
    let max = Math.max(...observed, ...(type === "bar" ? [0] : []));
    if (min === max) { const padding = Math.abs(min) * .1 || 1; min -= padding; max += padding; }
    const longestLabel = Math.max(...labels.map((item) => [...item].reduce((sum, character) => sum + (character.charCodeAt(0) > 255 ? 12 : 7), 0)));
    const labelDepth = longestLabel * .6;
    height = Math.max(390, 320 + labelDepth);
    const left = Math.max(95, longestLabel * .83 + 20);
    width = Math.max(720, labels.length * 44 + left + 40);
    const right = width - 40, top = 35, bottom = 260;
    const y = (number: number): number => bottom - (number - min) / (max - min) * (bottom - top);
    const slot = (right - left) / labels.length;
    const x = (index: number): number => left + slot * (index + .5);
    drawing += `<g stroke="currentColor" opacity=".25">`;
    for (let tick = 0; tick <= 4; tick++) {
      const position = top + (bottom - top) * tick / 4;
      drawing += `<line x1="${left}" y1="${position}" x2="${right}" y2="${position}"/>`;
    }
    drawing += `</g>`;
    for (let tick = 0; tick <= 4; tick++) {
      const number = max - (max - min) * tick / 4;
      drawing += text(left - 10, top + (bottom - top) * tick / 4 + 4, Number(number.toPrecision(5)).toString(), 'text-anchor="end"');
    }
    labels.forEach((item, index) => {
      // Display every label; long/category-dense axes can scroll instead of silently dropping labels.
      drawing += text(x(index), bottom + 16, item, `text-anchor="end" transform="rotate(-35 ${x(index)} ${bottom + 16})"`);
    });
    series.forEach((item, seriesIndex) => {
      if (type === "line") {
        let segment: string[] = [];
        const flush = (): void => {
          if (segment.length) drawing += `<polyline points="${segment.join(" ")}" fill="none" stroke="${color(seriesIndex)}" stroke-width="2.5"/>`;
          segment = [];
        };
        item.values.forEach((number, index) => {
          if (number === null) { flush(); return; }
          segment.push(`${x(index)},${y(number)}`);
        });
        flush();
      }
      item.values.forEach((number, index) => {
        if (number === null) return;
        const detail = `${item.name} · ${labels[index]}: ${numberText(number)}`;
        if (type === "line") drawing += `<circle cx="${x(index)}" cy="${y(number)}" r="3.5" fill="${color(seriesIndex)}">${tip(detail)}</circle>`;
        else {
          const width = slot * .75 / series.length;
          drawing += `<rect x="${x(index) - slot * .375 + seriesIndex * width}" y="${Math.min(y(0), y(number))}" width="${width}" height="${Math.abs(y(number) - y(0))}" fill="${color(seriesIndex)}">${tip(detail)}</rect>`;
        }
      });
    });
    drawing += text(left, 18, yLabel);
    drawing += text(right, height - 12, xLabel, 'text-anchor="end"');
  }
  const legend = type === "pie"
    ? labels.map((item, index) => `<span><i style="background:${color(index)}"></i>${escapeHtml(item)}: ${numberText(series[0]!.values[index]!)} (${(series[0]!.values[index]! / pieTotal * 100).toFixed(1)}%)</span>`).join("")
    : series.map((item, index) => `<span><i style="background:${color(index)}"></i>${escapeHtml(item.name)}</span>`).join("");
  const head = `<tr><th>${escapeHtml(xLabel || "类别")}</th>${series.map((item) => `<th>${escapeHtml(item.name || yLabel || "数值")}</th>`).join("")}</tr>`;
  const rows = labels.map((item, index) => `<tr><th>${escapeHtml(item)}</th>${series.map((entry) => `<td>${numberText(entry.values[index]!)}</td>`).join("")}</tr>`).join("");
  return `<figure class="md-chart"><figcaption>${escapeHtml(caption)}</figcaption><div class="md-chart-scroll"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" style="min-width:${width}px" role="img" aria-label="${escapeHtml(caption)}" class="md-chart-svg">${drawing}</svg></div><div class="md-chart-legend">${legend}</div><details><summary>查看图表数据</summary><div class="md-table-wrap"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div></details></figure>\n`;
}

export function artifactMimeBase(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function artifactExtension(nameOrPath: string): string {
  const clean = nameOrPath.split(/[?#]/)[0] ?? "";
  const dot = clean.lastIndexOf(".");
  return dot < 0 ? "" : clean.slice(dot + 1).toLowerCase();
}

export function artifactPreviewMode(artifact: Pick<PreviewArtifact, "name" | "path" | "mimeType">): ArtifactPreviewMode {
  const mimeBase = artifactMimeBase(artifact.mimeType);
  const extension = artifactExtension(artifact.name || artifact.path || "");
  if (mimeBase === "text/html" || extension === "html" || extension === "htm") return "html";
  if (mimeBase.startsWith("image/")) return "image";
  if (mimeBase.startsWith("audio/") || AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (mimeBase === "application/pdf" || extension === "pdf") return "pdf";
  return "structured";
}

export function usesBlobPreview(artifact: Pick<PreviewArtifact, "name" | "path" | "mimeType">): boolean {
  return artifactPreviewMode(artifact) !== "structured";
}

/**
 * Updates a preview host only when its markup changed, preserving native
 * media playback and other browser-managed state across parent re-renders.
 */
export function updateArtifactPreviewMarkup(host: HTMLElement, markup: string): boolean {
  if (mountedPreviewMarkup.get(host) === markup) return false;
  host.innerHTML = markup;
  mountedPreviewMarkup.set(host, markup);
  return true;
}

/**
 * Opens the common presentation shell. Callers own only authenticated byte
 * and structured-preview retrieval; format routing and rendering stay here.
 */
export function openArtifactPreview(options: OpenArtifactPreviewOptions): ArtifactPreviewDialog {
  const document = options.document ?? globalThis.document;
  const window = document.defaultView ?? globalThis.window;
  let blobUrl: string | undefined;
  let closed = false;
  const backdrop = element(document, "div", "preview-backdrop");
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", "产物预览");
  const dialog = element(document, "div", "preview-dialog");
  const head = element(document, "div", "preview-head");
  const title = element(document, "div", "preview-title");
  title.innerHTML = `<strong>${escapeHtml(options.artifact.name)}</strong><span>${escapeHtml(formatBytes(options.artifact.bytes))} · ${escapeHtml(options.artifact.mimeType)}</span>`;
  const actions = element(document, "div", "preview-actions");
  const download = button(document, "下载", "artifact-open");
  const maximize = button(document, "⛶", "preview-maximize");
  maximize.setAttribute("aria-label", "最大化预览");
  const closeButton = button(document, "×", "preview-close");
  closeButton.setAttribute("aria-label", "关闭预览");
  actions.append(download, maximize, closeButton);
  head.append(title, actions);
  const body = element(document, "div", "preview-body");
  body.append(element(document, "div", "preview-empty", "正在载入预览…"));
  dialog.append(head, body);
  backdrop.append(dialog);
  document.body.append(backdrop);

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (blobUrl) window.URL.revokeObjectURL(blobUrl);
    backdrop.remove();
    window.removeEventListener("keydown", onKeyDown);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };
  closeButton.addEventListener("click", close);
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) close(); });
  maximize.addEventListener("click", () => {
    setArtifactPreviewMaximized(backdrop, dialog, maximize, !dialog.classList.contains("maximized"));
  });
  window.addEventListener("keydown", onKeyDown);
  download.addEventListener("click", () => {
    void options.fetchBytes().then((blob) => {
      if (closed) return;
      const url = window.URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: options.artifact.mimeType }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = options.artifact.name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(url), 60_000);
    }).catch(() => showError(body, "无法下载产物。"));
  });

  void loadPreview(options, body, (url) => { blobUrl = url; }, () => closed);
  return { close };
}

async function loadPreview(
  options: OpenArtifactPreviewOptions,
  body: HTMLElement,
  setBlobUrl: (url: string) => void,
  isClosed: () => boolean,
): Promise<void> {
  try {
    const mode = artifactPreviewMode(options.artifact);
    if (mode === "structured") {
      const preview = await options.fetchStructuredPreview();
      if (isClosed()) return;
      body.className = "preview-body";
      body.innerHTML = renderStructuredPreview(preview, options.renderMarkdown);
      return;
    }
    const blob = await options.fetchBytes();
    if (isClosed()) return;
    const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: options.artifact.mimeType }));
    setBlobUrl(url);
    body.className = mode === "image" ? "preview-body" : "preview-body frame-body";
    body.innerHTML = renderBlobPreview(mode, url, options.artifact.name);
  } catch (error) {
    if (!isClosed()) showError(body, error instanceof Error ? error.message : "无法生成预览。");
  }
}

export function renderBlobPreview(mode: Exclude<ArtifactPreviewMode, "structured">, url: string, name: string): string {
  const safeUrl = escapeHtml(url);
  const safeName = escapeHtml(name);
  if (mode === "html") return `<iframe class="preview-frame preview-html" src="${safeUrl}" title="${safeName}" sandbox="allow-scripts allow-forms allow-popups"></iframe>`;
  if (mode === "image") return `<img class="preview-image" src="${safeUrl}" alt="${safeName}" />`;
  if (mode === "audio") return `<audio class="preview-audio" controls src="${safeUrl}">无法播放该音频，请下载后用本地播放器打开。</audio>`;
  return `<object class="preview-frame" data="${safeUrl}" type="application/pdf"></object>`;
}

export function renderStructuredPreview(preview: StructuredArtifactPreview, markdownRenderer: (text: string) => string = renderMarkdown): string {
  if (preview.kind === "text") {
    const isMarkdown = /markdown/.test(preview.mimeType) || /\.md$/i.test(preview.name);
    const content = isMarkdown ? markdownRenderer(preview.text) : `<pre>${escapeHtml(preview.text)}</pre>`;
    return `<div class="preview-text md">${content}${truncatedNotice(preview.truncated)}</div>`;
  }
  if (preview.kind === "docx") {
    if (preview.schema === "agentloop.docxPreview/v2" || preview.blocks?.length) return renderDocxPreview(preview);
    const paragraphs = preview.paragraphs.length > 0
      ? preview.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")
      : '<p class="muted">该 DOCX 没有可抽取的正文段落。</p>';
    return `<div class="preview-doc">${paragraphs}${truncatedNotice(preview.truncated)}</div>`;
  }
  if (preview.kind === "xlsx") {
    const sheets = preview.sheets.length > 0
      ? preview.sheets.map((sheet) => `<section class="preview-sheet"><h4>${escapeHtml(sheet.name)}</h4><div class="preview-table-wrap"><table class="preview-table"><tbody>${sheet.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>${sheet.truncated ? '<p class="muted">该工作表只显示前 80 行。</p>' : ""}</section>`).join("")
      : '<p class="muted">该 XLSX 没有可抽取的工作表内容。</p>';
    return `<div class="preview-sheets">${sheets}</div>`;
  }
  if (preview.kind === "pptx") return renderPptxPreview(preview);
  return '<div class="preview-empty">该文件类型暂不能内嵌展示，请下载查看完整文件。</div>';
}

export function renderDocxPreview(preview: Extract<StructuredArtifactPreview, { kind: "docx" }>): string {
  const page = normalizeDocxPage(preview.page);
  const blocks = preview.blocks?.length ? preview.blocks : preview.paragraphs.map((text) => ({ type: "paragraph" as const, runs: [{ text }] }));
  const body = blocks.map(renderDocxBlock).join("") || '<p class="muted">该 DOCX 没有可抽取的正文内容。</p>';
  return `<div class="preview-docx-pages" style="--docx-page-width:${twipsToCss(page.widthTwips)};--docx-page-height:${twipsToCss(page.heightTwips)};--docx-page-top:${twipsToCss(page.marginsTwips.top)};--docx-page-right:${twipsToCss(page.marginsTwips.right)};--docx-page-bottom:${twipsToCss(page.marginsTwips.bottom)};--docx-page-left:${twipsToCss(page.marginsTwips.left)}"><article class="preview-docx-page">${body}</article>${truncatedNotice(preview.truncated)}</div>`;
}

function normalizeDocxPage(page: DocxPreviewPage | undefined): DocxPreviewPage {
  const finitePositive = (value: unknown, fallback: number): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  const margins = page?.marginsTwips;
  return {
    widthTwips: finitePositive(page?.widthTwips, 11906),
    heightTwips: finitePositive(page?.heightTwips, 16838),
    marginsTwips: {
      top: finitePositive(margins?.top, 1440),
      right: finitePositive(margins?.right, 1440),
      bottom: finitePositive(margins?.bottom, 1440),
      left: finitePositive(margins?.left, 1440),
    },
  };
}

function renderDocxBlock(block: DocxPreviewBlock): string {
  if (block.type === "table") {
    return `<table class="preview-docx-table"><tbody>${block.rows.map((row) => `<tr>${row.cells.map((cell) => `<td>${cell.blocks.map(renderDocxBlock).join("")}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }
  if (block.type === "image") {
    const dimensions = `${block.widthEmu ? ` width="${Math.max(1, Math.round(block.widthEmu / 9525))}"` : ""}${block.heightEmu ? ` height="${Math.max(1, Math.round(block.heightEmu / 9525))}"` : ""}`;
    return `<img class="preview-docx-image" src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt ?? "")}"${dimensions} loading="lazy" />`;
  }
  const style = [
    block.alignment ? `text-align:${block.alignment}` : "",
    block.indentLeftTwips ? `margin-left:${twipsToCss(block.indentLeftTwips)}` : "",
    block.indentRightTwips ? `margin-right:${twipsToCss(block.indentRightTwips)}` : "",
    block.firstLineTwips ? `text-indent:${twipsToCss(block.firstLineTwips)}` : "",
    block.spaceBeforeTwips ? `margin-top:${twipsToCss(block.spaceBeforeTwips)}` : "",
    block.spaceAfterTwips === undefined ? "" : `margin-bottom:${twipsToCss(block.spaceAfterTwips)}`,
    block.lineTwips ? `line-height:${Math.max(1, block.lineTwips / 240)}` : "",
  ].filter(Boolean).join(";");
  const marker = block.numbering ? `<span class="preview-docx-marker">${block.numbering.ordered ? "1." : "•"}</span>` : "";
  const className = block.style ? ` class="preview-docx-paragraph style-${escapeHtml(block.style)}"` : ' class="preview-docx-paragraph"';
  return `<p${className}${style ? ` style="${style}"` : ""}>${marker}${block.runs.map(renderDocxRun).join("")}</p>`;
}

function renderDocxRun(run: DocxPreviewRun): string {
  const style = [
    run.bold ? "font-weight:700" : "",
    run.italic ? "font-style:italic" : "",
    run.underline ? "text-decoration:underline" : "",
    run.strike ? "text-decoration:line-through" : "",
    run.color ? `color:#${run.color.replace(/^#/, "")}` : "",
    run.fontSizeHalfPoints ? `font-size:${run.fontSizeHalfPoints / 2}pt` : "",
    run.fontFamily ? `font-family:${escapeCssFontFamily(run.fontFamily)}` : "",
  ].filter(Boolean).join(";");
  return `<span${style ? ` style="${style}"` : ""}>${escapeHtml(run.text).replace(/\n/g, "<br />")}</span>`;
}

function twipsToCss(value: number): string {
  return `${Math.max(0, value) / 15}px`;
}

function escapeCssFontFamily(value: string): string {
  return `'${value.replace(/['\\]/g, "")}'`;
}

const EMU_PER_POINT = 12_700;

export function renderPptxPreview(preview: Extract<StructuredArtifactPreview, { kind: "pptx" }>): string {
  if (preview.slides.length === 0) return '<p class="muted">该 PPTX 没有可抽取的幻灯片文本。</p>';
  const width = preview.width / EMU_PER_POINT;
  const height = preview.height / EMU_PER_POINT;
  const slides = preview.slides.map((slide) => {
    const elements = slide.elements.length > 0 ? slide.elements : fallbackPptxElements(slide.paragraphs, preview.width, preview.height);
    return `<section class="preview-slide"><div class="preview-slide-number">Slide ${slide.index}</div><svg class="preview-slide-canvas" viewBox="0 0 ${width} ${height}" role="img" aria-label="Slide ${slide.index}" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="${width}" height="${height}" fill="${escapeHtml(slide.background ?? "#fff")}" />${elements.map(renderPptxElement).join("")}</svg></section>`;
  }).join("");
  return `<div class="preview-slides">${slides}${truncatedNotice(preview.truncated)}</div>`;
}

function renderPptxElement(element: PptxPreviewElement): string {
  const x = element.x / EMU_PER_POINT;
  const y = element.y / EMU_PER_POINT;
  const width = element.width / EMU_PER_POINT;
  const height = element.height / EMU_PER_POINT;
  if (element.kind === "shape") {
    const props = `fill="${escapeHtml(element.fill)}"${element.opacity === undefined ? "" : ` opacity="${element.opacity}"`}${element.stroke === undefined ? "" : ` stroke="${escapeHtml(element.stroke)}"`}${element.strokeWidth === undefined ? "" : ` stroke-width="${element.strokeWidth / EMU_PER_POINT}"`}`;
    if (element.preset === "ellipse") return `<ellipse cx="${x + width / 2}" cy="${y + height / 2}" rx="${width / 2}" ry="${height / 2}" ${props} />`;
    if (element.preset === "chevron") return `<polygon points="${chevronPoints(x, y, width, height)}" ${props} />`;
    if (element.preset === "parallelogram") return `<polygon points="${parallelogramPoints(x, y, width, height)}" ${props} />`;
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" ${props} />`;
  }
  const fontSize = Math.max(8, element.fontSize ?? 18);
  const padding = Math.max(fontSize * 0.12, 1.5);
  const lineHeight = fontSize * 1.22;
  const maxLines = Math.max(1, Math.floor((height - padding * 2) / lineHeight));
  const lines = (element.lines?.length ? element.lines : element.text.split(/\r?\n/).filter(Boolean).map((text) => [{ text, fontSize: element.fontSize, color: element.color }])).slice(0, maxLines);
  const fill = escapeHtml(element.color ?? "#1f2937");
  const background = element.fill === undefined ? "" : `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${escapeHtml(element.fill)}" />`;
  const text = lines.map((line, lineIndex) => line.map((run, runIndex) => `<tspan${runIndex === 0 ? ` x="${x + padding}" dy="${lineIndex === 0 ? 0 : lineHeight}"` : ""} fill="${escapeHtml(run.color ?? element.color ?? "#1f2937")}" font-size="${Math.max(8, run.fontSize ?? fontSize)}">${escapeHtml(run.text)}</tspan>`).join("")).join("");
  return `<g>${background}<text x="${x + padding}" y="${y + padding + fontSize}" fill="${fill}" font-family="Inter, system-ui, sans-serif" font-size="${fontSize}" xml:space="preserve">${text}</text></g>`;
}

function fallbackPptxElements(paragraphs: readonly string[], width: number, height: number): readonly PptxPreviewElement[] {
  return paragraphs.length === 0 ? [] : [{ kind: "text", x: width * 0.08, y: height * 0.1, width: width * 0.84, height: height * 0.8, text: paragraphs.join("\n"), fontSize: 20, color: "#1f2937" }];
}

function chevronPoints(x: number, y: number, width: number, height: number): string {
  const notch = width * 0.22;
  const point = width * 0.82;
  return [[x, y], [x + point, y], [x + width, y + height / 2], [x + point, y + height], [x, y + height], [x + notch, y + height / 2]].map((point) => point.join(",")).join(" ");
}

function parallelogramPoints(x: number, y: number, width: number, height: number): string {
  const skew = width * 0.15;
  return [[x + skew, y], [x + width, y], [x + width - skew, y + height], [x, y + height]].map((point) => point.join(",")).join(" ");
}

function truncatedNotice(truncated: boolean): string {
  return truncated ? '<p class="muted">预览已截断，请下载查看完整文件。</p>' : "";
}

function element(document: Document, tag: string, className: string, text?: string): HTMLElement {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function button(document: Document, text: string, className: string): HTMLButtonElement {
  const result = document.createElement("button");
  result.type = "button";
  result.className = className;
  result.textContent = text;
  return result;
}

function showError(body: HTMLElement, message: string): void {
  body.className = "preview-body";
  body.innerHTML = `<div class="preview-empty error">${escapeHtml(message)}</div>`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "大小未知";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function safeMarkdownUrl(value: string, allowedSchemes: ReadonlySet<string>): string | undefined {
  const trimmed = value.trim();
  const protocolProbe = decodeProtocolEntities(trimmed).replace(/[\u0000-\u0020\u007f]/g, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(protocolProbe)?.[1]?.toLowerCase();
  if (scheme !== undefined && !allowedSchemes.has(scheme)) return undefined;
  return trimmed;
}

function decodeProtocolEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);?/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&(colon|tab|newline);/gi, (_, entity: string) => ({ colon: ":", tab: "\t", newline: "\n" })[entity.toLowerCase()] ?? "");
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}
