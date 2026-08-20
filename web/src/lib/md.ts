import { escapeHtml, NL } from "./format";

const BT = String.fromCharCode(96);

function isOrderedLine(line: string): boolean {
  const dot = line.indexOf(". ");
  if (dot < 1) return false;
  for (let k = 0; k < dot; k++) {
    const c = line.charCodeAt(k);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

function inlineMd(text: string): string {
  let s = text;
  let guard = 0;
  while (guard++ < 400) {
    const a = s.indexOf(BT);
    if (a < 0) break;
    const b = s.indexOf(BT, a + 1);
    if (b < 0) break;
    s = s.slice(0, a) + '<code class="md-inline">' + s.slice(a + 1, b) + "</code>" + s.slice(b + 1);
  }
  guard = 0;
  while (guard++ < 400) {
    const a = s.indexOf("**");
    if (a < 0) break;
    const b = s.indexOf("**", a + 2);
    if (b < 0) break;
    s = s.slice(0, a) + "<strong>" + s.slice(a + 2, b) + "</strong>" + s.slice(b + 2);
  }
  guard = 0;
  while (guard++ < 400) {
    const a = s.indexOf("*");
    if (a < 0) break;
    const b = s.indexOf("*", a + 1);
    if (b < 0) break;
    s = s.slice(0, a) + "<em>" + s.slice(a + 1, b) + "</em>" + s.slice(b + 1);
  }
  guard = 0;
  while (guard++ < 400) {
    const close = s.indexOf("](");
    if (close < 0) break;
    const open = s.lastIndexOf("[", close);
    if (open < 0) break;
    const end = s.indexOf(")", close + 2);
    if (end < 0) break;
    const label = s.slice(open + 1, close);
    const url = s.slice(close + 2, end);
    if (url.indexOf("http") !== 0) break;
    s = s.slice(0, open) + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + "</a>" + s.slice(end + 1);
  }
  return s;
}

function mdBlocks(text: string): string {
  const lines = text.split(NL);
  const out: string[] = [];
  let para: string[] = [];
  const flushPara = (): void => {
    if (para.length) {
      out.push("<p>" + para.join("<br>") + "</p>");
      para = [];
    }
  };
  let listTag = "";
  let listItems: string[] = [];
  const flushList = (): void => {
    if (listTag) {
      out.push("<" + listTag + ">" + listItems.join("") + "</" + listTag + ">");
      listTag = "";
      listItems = [];
    }
  };
  for (const line of lines) {
    if (line.slice(0, 4) === "### ") {
      flushPara();
      flushList();
      out.push("<h3>" + inlineMd(line.slice(4)) + "</h3>");
    } else if (line.slice(0, 3) === "## ") {
      flushPara();
      flushList();
      out.push("<h2>" + inlineMd(line.slice(3)) + "</h2>");
    } else if (line.slice(0, 2) === "# ") {
      flushPara();
      flushList();
      out.push("<h1>" + inlineMd(line.slice(2)) + "</h1>");
    } else if (line.slice(0, 2) === "- " || line.slice(0, 2) === "* ") {
      flushPara();
      if (listTag !== "ul") {
        flushList();
        listTag = "ul";
      }
      listItems.push("<li>" + inlineMd(line.slice(2)) + "</li>");
    } else if (isOrderedLine(line)) {
      const n = line.indexOf(". ");
      flushPara();
      if (listTag !== "ol") {
        flushList();
        listTag = "ol";
      }
      listItems.push("<li>" + inlineMd(line.slice(n + 2)) + "</li>");
    } else if (line.slice(0, 5) === "&gt; ") {
      flushPara();
      flushList();
      out.push("<blockquote>" + inlineMd(line.slice(5)) + "</blockquote>");
    } else if (line.trim() === "") {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(inlineMd(line));
    }
  }
  flushPara();
  flushList();
  return out.join(NL);
}

/** Renders markdown text to sanitized HTML. */
export function renderMarkdown(raw: unknown): string {
  const s = escapeHtml(raw);
  const fence = BT + BT + BT;
  const parts = s.split(fence);
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      html += '<pre class="md-code"><code>' + parts[i].replace(new RegExp("^" + NL + "|" + NL + "$", "g"), "") + "</code></pre>";
    } else {
      html += mdBlocks(parts[i]);
    }
  }
  return html;
}