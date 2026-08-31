import { createHash } from "node:crypto";
import { badRequest } from "../shared/errors.ts";
import { requireRecord, requireString } from "../shared/validation.ts";

const MAX_PAGES = 80;
const MAX_BULLETS = 12;
const MAX_SOURCE_REFS = 12;
const MAX_SPEC_CHARACTERS = 80_000;

export type PaginatedHtmlRenderMode = "slides";
export type PaginatedHtmlAcceptanceProfile = "html" | "html_ppt";

export interface PaginatedHtmlMaterializeInput {
  readonly path: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly renderMode: PaginatedHtmlRenderMode;
  readonly acceptanceProfile: PaginatedHtmlAcceptanceProfile;
  readonly theme?: {
    readonly accent?: string;
    readonly background?: string;
    readonly text?: string;
    readonly surface?: string;
  };
  readonly pages: readonly PaginatedHtmlPageSpec[];
  readonly overwrite: boolean;
}

export interface PaginatedHtmlPageSpec {
  readonly eyebrow?: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly body?: string;
  readonly bullets?: readonly string[];
  readonly callout?: string;
  readonly sourceRefs?: readonly string[];
}

export function parsePaginatedHtmlMaterializeInput(value: unknown): PaginatedHtmlMaterializeInput {
  const record = requireRecord(value, "materialize_paginated_html arguments");
  const pages = parsePages(record.pages);
  const input = {
    path: requireString(record.path, "path", { max: 4_000 }),
    title: requireString(record.title, "title", { max: 240 }),
    subtitle: optionalString(record.subtitle, "subtitle", 500),
    renderMode: parseRenderMode(record.renderMode),
    acceptanceProfile: parseAcceptanceProfile(record.acceptanceProfile),
    theme: parseTheme(record.theme),
    pages,
    overwrite: record.overwrite === true,
  };
  if (record.overwrite !== undefined && typeof record.overwrite !== "boolean") {
    throw badRequest("overwrite must be boolean");
  }
  const specCharacters = JSON.stringify(input).length;
  if (specCharacters > MAX_SPEC_CHARACTERS) {
    throw badRequest(`materialize_paginated_html spec must be at most ${MAX_SPEC_CHARACTERS} characters`);
  }
  return input;
}

export function renderPaginatedHtml(input: PaginatedHtmlMaterializeInput): {
  readonly content: string;
  readonly specSha256: string;
  readonly pageCount: number;
} {
  const specSha256 = createHash("sha256").update(JSON.stringify({
    title: input.title,
    subtitle: input.subtitle,
    renderMode: input.renderMode,
    acceptanceProfile: input.acceptanceProfile,
    theme: input.theme,
    pages: input.pages,
  })).digest("hex");
  return {
    content: renderSlideModeHtml(input),
    specSha256,
    pageCount: input.pages.length,
  };
}

function renderSlideModeHtml(input: PaginatedHtmlMaterializeInput): string {
  const theme = {
    accent: input.theme?.accent ?? "#11645a",
    background: input.theme?.background ?? "#edf2ef",
    text: input.theme?.text ?? "#15231f",
    surface: input.theme?.surface ?? "#fffdf8",
  };
  const pages = input.pages.map((page, index) => renderSlidePage(page, index, input.pages.length)).join("\n");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>
:root{--accent:${theme.accent};--bg:${theme.background};--ink:${theme.text};--surface:${theme.surface};--muted:#5f6f6a;--line:rgba(21,35,31,.18)}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{overflow:hidden;background:var(--bg);color:var(--ink);font-family:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",Arial,sans-serif}
.deck{height:100vh;position:relative}
.slide{display:none;height:100vh;padding:28px}
.slide.active{display:block}
.slide-inner{height:100%;position:relative;overflow:hidden;border:1px solid var(--line);border-radius:8px;background:var(--surface);padding:38px 42px 64px;box-shadow:0 16px 42px rgba(10,24,20,.10)}
.slide-inner:before{content:"";position:absolute;left:0;top:0;width:8px;height:100%;background:linear-gradient(180deg,var(--accent),rgba(17,100,90,.45))}
.eyebrow{margin:0 0 10px;color:var(--accent);font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}
h1,h2,p{letter-spacing:0}
h1{max-width:1000px;margin:0 0 16px;font-size:42px;line-height:1.14;color:var(--accent)}
h2{max-width:1000px;margin:0 0 18px;font-size:34px;line-height:1.18;color:var(--accent)}
.subtitle{max-width:920px;margin:0 0 24px;color:var(--muted);font-size:18px;line-height:1.65}
.body{max-width:980px;font-size:20px;line-height:1.72}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-top:20px}
.point{border:1px solid var(--line);border-radius:8px;padding:15px 16px;background:rgba(255,255,255,.52);font-size:17px;line-height:1.55}
.point:before{content:"";display:block;width:28px;height:3px;margin-bottom:10px;background:var(--accent);border-radius:2px}
.callout{margin-top:24px;max-width:980px;border-left:5px solid var(--accent);background:rgba(17,100,90,.08);padding:16px 18px;font-size:18px;line-height:1.62}
.sources{position:absolute;left:42px;right:180px;bottom:24px;color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pager{position:absolute;right:42px;bottom:20px;display:flex;align-items:center;gap:10px}
.pager button{width:36px;height:36px;border-radius:8px;border:1px solid var(--line);background:#fff;color:var(--accent);font-size:20px;font-weight:800;cursor:pointer}
.pager .count{min-width:72px;text-align:center;border:1px solid var(--line);border-radius:8px;background:#fff;padding:8px 10px;font-weight:700}
@media(max-width:720px){.slide{padding:14px}.slide-inner{padding:28px 24px 70px}h1{font-size:31px}h2{font-size:27px}.body{font-size:17px}.sources{right:24px;bottom:64px}.pager{right:24px}}
</style>
</head>
<body>
<main class="deck" aria-label="${escapeHtml(input.title)}" data-render-mode="${escapeAttribute(input.renderMode)}" data-acceptance-profile="${escapeAttribute(input.acceptanceProfile)}">
${pages}
</main>
<script>
const pages=[...document.querySelectorAll('.slide')];
let current=0;
function showPage(index){
  current=Math.max(0,Math.min(pages.length-1,index));
  pages.forEach((page,pageIndex)=>page.classList.toggle('active',pageIndex===current));
  document.title=pages[current]?.dataset.title||${JSON.stringify(input.title)};
}
function nextPage(){showPage(current+1)}
function prevPage(){showPage(current-1)}
function nextSlide(){nextPage()}
function prevSlide(){prevPage()}
document.addEventListener('keydown',event=>{if(event.key==='ArrowRight'||event.key==='PageDown')nextPage();if(event.key==='ArrowLeft'||event.key==='PageUp')prevPage();});
document.addEventListener('click',event=>{const action=event.target.closest('[data-action]')?.dataset.action;if(action==='next')nextPage();if(action==='prev')prevPage();});
showPage(0);
</script>
</body>
</html>
`;
}

function renderSlidePage(page: PaginatedHtmlPageSpec, index: number, total: number): string {
  const bullets = page.bullets === undefined || page.bullets.length === 0
    ? ""
    : `<div class="grid">${page.bullets.map((bullet) => `<div class="point">${escapeHtml(bullet)}</div>`).join("")}</div>`;
  const sources = page.sourceRefs === undefined || page.sourceRefs.length === 0
    ? ""
    : `<div class="sources">来源：${escapeHtml(page.sourceRefs.join(" | "))}</div>`;
  return `<section class="slide" data-slide="${index + 1}" data-page="${index + 1}" data-title="${escapeAttribute(page.title)}">
  <div class="slide-inner">
    ${page.eyebrow === undefined ? "" : `<p class="eyebrow">${escapeHtml(page.eyebrow)}</p>`}
    ${index === 0 ? `<h1>${escapeHtml(page.title)}</h1>` : `<h2>${escapeHtml(page.title)}</h2>`}
    ${page.subtitle === undefined ? "" : `<p class="subtitle">${escapeHtml(page.subtitle)}</p>`}
    ${page.body === undefined ? "" : `<p class="body">${escapeHtml(page.body)}</p>`}
    ${bullets}
    ${page.callout === undefined ? "" : `<div class="callout">${escapeHtml(page.callout)}</div>`}
    ${sources}
    <nav class="pager" aria-label="Page navigation">
      <button type="button" data-action="prev" aria-label="Previous page">‹</button>
      <span class="count">${index + 1} / ${total}</span>
      <button type="button" data-action="next" aria-label="Next page">›</button>
    </nav>
  </div>
</section>`;
}

function parsePages(value: unknown): PaginatedHtmlPageSpec[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PAGES) {
    throw badRequest(`pages must be an array with 1 to ${MAX_PAGES} entries`);
  }
  return value.map((item, index) => {
    const record = requireRecord(item, `pages[${index}]`);
    return {
      eyebrow: optionalString(record.eyebrow, `pages[${index}].eyebrow`, 120),
      title: requireString(record.title, `pages[${index}].title`, { max: 240 }),
      subtitle: optionalString(record.subtitle, `pages[${index}].subtitle`, 500),
      body: optionalString(record.body, `pages[${index}].body`, 2_000),
      bullets: optionalStringArray(record.bullets, `pages[${index}].bullets`, MAX_BULLETS, 500),
      callout: optionalString(record.callout, `pages[${index}].callout`, 1_000),
      sourceRefs: optionalStringArray(record.sourceRefs, `pages[${index}].sourceRefs`, MAX_SOURCE_REFS, 500),
    };
  });
}

function parseTheme(value: unknown): PaginatedHtmlMaterializeInput["theme"] {
  if (value === undefined) return undefined;
  const record = requireRecord(value, "theme");
  return {
    accent: optionalColor(record.accent, "theme.accent"),
    background: optionalColor(record.background, "theme.background"),
    text: optionalColor(record.text, "theme.text"),
    surface: optionalColor(record.surface, "theme.surface"),
  };
}

function parseRenderMode(value: unknown): PaginatedHtmlRenderMode {
  const mode = requireString(value, "renderMode", { max: 64 });
  if (mode === "slides") return mode;
  throw badRequest("renderMode must be slides");
}

function parseAcceptanceProfile(value: unknown): PaginatedHtmlAcceptanceProfile {
  const profile = requireString(value, "acceptanceProfile", { max: 64 });
  if (profile === "html" || profile === "html_ppt") return profile;
  throw badRequest("acceptanceProfile must be html or html_ppt");
}

function optionalString(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field, { max: maximum });
}

function optionalColor(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const color = requireString(value, field, { max: 32 });
  if (!/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/iu.test(color)) {
    throw badRequest(`${field} must be a hex color`);
  }
  return color;
}

function optionalStringArray(value: unknown, field: string, maximumItems: number, maximumStringLength: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw badRequest(`${field} must be an array with at most ${maximumItems} entries`);
  }
  return value.map((item, index) => requireString(item, `${field}[${index}]`, { max: maximumStringLength }));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]!);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/gu, "&#96;");
}
