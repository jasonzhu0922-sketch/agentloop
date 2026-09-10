const BACKTICK = "`";

function renderInline(text) {
  return text
    .replace(/`([^`]+)`/g, '<code class="md-inline">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function splitTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const cells = [];
  let start = trimmed.startsWith("|") ? 1 : 0;
  let inCode = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === BACKTICK) inCode = !inCode;
    if (char === "|" && !inCode) {
      cells.push(trimmed.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tailEnd = trimmed.endsWith("|") ? trimmed.length - 1 : trimmed.length;
  if (start <= tailEnd) cells.push(trimmed.slice(start, tailEnd).trim());
  return cells.length > 1 ? cells : null;
}

function isTableSeparator(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function tableAlign(cell) {
  const value = cell.trim();
  if (value.startsWith(":")) return value.endsWith(":") ? "center" : "left";
  return value.endsWith(":") ? "right" : "left";
}

function renderTable(header, separator, rows) {
  const alignments = separator.map(tableAlign);
  const alignAttribute = (index) => alignments[index] && alignments[index] !== "left" ? ` style="text-align:${alignments[index]}"` : "";
  const head = `<thead><tr>${header.map((cell, index) => `<th${alignAttribute(index)}>${renderInline(cell)}</th>`).join("")}</tr></thead>`;
  const body = rows.map((row) => `<tr>${header.map((_, index) => `<td${alignAttribute(index)}>${renderInline(row[index] ?? "")}</td>`).join("")}</tr>`).join("");
  return `<div class="md-table-wrap"><table>${head}<tbody>${body}</tbody></table></div>`;
}

function renderBlocks(text) {
  const lines = text.split(/\r?\n/);
  const output = [];
  let paragraph = [];
  let listTag = "";
  let listItems = [];
  const flushParagraph = () => { if (paragraph.length) { output.push(`<p>${paragraph.map(renderInline).join("<br />")}</p>`); paragraph = []; } };
  const flushList = () => { if (listTag) { output.push(`<${listTag}>${listItems.join("")}</${listTag}>`); listTag = ""; listItems = []; } };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const header = splitTableRow(line);
    const separator = index + 1 < lines.length ? splitTableRow(lines[index + 1]) : null;
    if (header && separator && isTableSeparator(separator)) {
      flushParagraph();
      flushList();
      const rows = [];
      index += 2;
      while (index < lines.length) {
        const row = splitTableRow(lines[index]);
        if (!row || isTableSeparator(row)) break;
        rows.push(row);
        index += 1;
      }
      index -= 1;
      output.push(renderTable(header, separator, rows));
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    const unordered = /^(?:-|\*)\s+(.+)$/u.exec(line);
    const ordered = /^\d+\.\s+(.+)$/u.exec(line);
    if (heading) { flushParagraph(); flushList(); output.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`); }
    else if (unordered || ordered) { flushParagraph(); const nextListTag = unordered ? "ul" : "ol"; if (listTag !== nextListTag) { flushList(); listTag = nextListTag; } listItems.push(`<li>${renderInline((unordered || ordered)[1])}</li>`); }
    else if (/^&gt;\s+/.test(line)) { flushParagraph(); flushList(); output.push(`<blockquote>${renderInline(line.slice(5))}</blockquote>`); }
    else if (!line.trim()) { flushParagraph(); flushList(); }
    else { flushList(); paragraph.push(renderInline(line)); }
  }
  flushParagraph();
  flushList();
  return output.join("");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

/** Render escaped, model-supplied Markdown for completed messages. */
export function renderMarkdown(text) {
  const fence = "```";
  return escapeHtml(text).split(fence).map((part, index) => index % 2 ? `<pre class="md-code"><code>${part.replace(/^\n|\n$/g, "")}</code></pre>` : renderBlocks(part)).join("");
}
