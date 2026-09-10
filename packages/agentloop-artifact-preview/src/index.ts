export interface PreviewArtifact {
  readonly id: string;
  readonly name: string;
  readonly path?: string;
  readonly bytes: number;
  readonly mimeType: string;
}

export type ArtifactPreviewMode = "html" | "image" | "pdf" | "structured";

export type StructuredArtifactPreview =
  | { readonly kind: "text"; readonly name: string; readonly mimeType: string; readonly text: string; readonly truncated: boolean }
  | { readonly kind: "docx"; readonly name: string; readonly paragraphs: readonly string[]; readonly truncated: boolean }
  | { readonly kind: "xlsx"; readonly name: string; readonly sheets: readonly { readonly name: string; readonly rows: readonly (readonly string[])[]; readonly truncated: boolean }[]; readonly truncated?: boolean }
  | { readonly kind: "pptx"; readonly name: string; readonly slideCount: number; readonly width: number; readonly height: number; readonly slides: readonly PptxPreviewSlide[]; readonly truncated: boolean }
  | { readonly kind: "binary"; readonly name: string; readonly mimeType: string };

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
  if (mimeBase === "application/pdf" || extension === "pdf") return "pdf";
  return "structured";
}

export function usesBlobPreview(artifact: Pick<PreviewArtifact, "name" | "path" | "mimeType">): boolean {
  return artifactPreviewMode(artifact) !== "structured";
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
    const isMaximized = dialog.classList.toggle("maximized");
    maximize.textContent = isMaximized ? "↙" : "⛶";
    maximize.setAttribute("aria-label", isMaximized ? "还原预览" : "最大化预览");
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
  return `<object class="preview-frame" data="${safeUrl}" type="application/pdf"></object>`;
}

export function renderStructuredPreview(preview: StructuredArtifactPreview, renderMarkdown?: (text: string) => string): string {
  if (preview.kind === "text") {
    const isMarkdown = /markdown/.test(preview.mimeType) || /\.md$/i.test(preview.name);
    const content = isMarkdown && renderMarkdown ? renderMarkdown(preview.text) : `<pre>${escapeHtml(preview.text)}</pre>`;
    return `<div class="preview-text md">${content}${truncatedNotice(preview.truncated)}</div>`;
  }
  if (preview.kind === "docx") {
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

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}
