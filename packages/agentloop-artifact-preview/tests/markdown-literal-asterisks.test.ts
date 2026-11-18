import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown, renderStructuredPreview } from "../src/index.ts";

test("preserves source asterisks in final-answer and artifact-preview table cells", () => {
  // Run 25ec36c3 kept both stars in tool results and terminal output; the
  // renderer used to turn 0.8*1250*C into 0.8<em>1250</em>C.
  const values = ["0.8*1250*C", "1*1250*C", "1.2*1250*C", "2.5*1250*C", "2.75*1250*C", "3*1250*C", "3.5*1250*C"];
  const source = ["| 原值 |", "| --- |", ...values.map(value => `| ${value} |`)].join("\n");
  const preview = { kind: "text", name: "report.md", mimeType: "text/markdown", text: source, truncated: false } as const;
  for (const html of [renderMarkdown(source), renderStructuredPreview(preview)]) {
    for (const value of values) assert.ok(html.includes(`<td>${value}</td>`), value);
    assert.doesNotMatch(html, /<em>/);
  }
});

test("preserves intraword operators and identifiers without changing surrounding formatting", () => {
  for (const value of ["0.8*1250*C", "a*b*c", "厚度*宽度*C", "A*01*B", "𠮷*野*家"]) {
    assert.equal(renderMarkdown(value), `<p>${value}</p>\n`);
    assert.equal(renderMarkdown(`**${value}**`), `<p><strong>${value}</strong></p>\n`);
    assert.equal(renderMarkdown(`*${value}*`), `<p><em>${value}</em></p>\n`);
    assert.equal(renderMarkdown(`\`${value}\``), `<p><code class="md-inline">${value}</code></p>\n`);
    assert.equal(renderMarkdown(`${value} and *emphasis*`), `<p>${value} and <em>emphasis</em></p>\n`);
    assert.equal(renderMarkdown(`*emphasis* and ${value}`), `<p><em>emphasis</em> and ${value}</p>\n`);
  }
});

test("keeps Markdown emphasis, escaped stars, links and code syntax", () => {
  assert.equal(renderMarkdown("*斜体* **粗体** ***粗斜体*** _斜体_ __粗体__"), "<p><em>斜体</em> <strong>粗体</strong> <em><strong>粗斜体</strong></em> <em>斜体</em> <strong>粗体</strong></p>\n");
  assert.equal(renderMarkdown("a\\*b\\*c and *x*"), "<p>a*b*c and <em>x</em></p>\n");
  assert.equal(renderMarkdown("[a*b*c](https://example.com/a*b*c)"), '<p><a href="https://example.com/a*b*c" target="_blank" rel="noopener noreferrer">a*b*c</a></p>\n');
  assert.equal(renderMarkdown("```txt\na*b*c\n```"), '<pre class="md-code"><code class="language-txt">a*b*c</code></pre>\n');
});
