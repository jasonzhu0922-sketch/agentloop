import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown, renderStructuredPreview } from "../src/index.ts";

const fence = (value: unknown): string => `\n\`\`\`chart\n${JSON.stringify(value)}\n\`\`\`\n`;
const line = {
  type: "line", title: "月度收入", xLabel: "月份", yLabel: "万元",
  labels: ["1月", "2月", "3月", "4月"],
  series: [{ name: "收入", values: [10, null, 30, 40] }],
};

test("final-answer Markdown and Markdown artifacts display charts with exact inspectable data", () => {
  const answer = `收入在有观测的期间上升。\n${fence(line)}\n来源：query_123，单位万元。`;
  for (const markup of [renderMarkdown(answer), renderStructuredPreview({ kind: "text", name: "report.md", mimeType: "text/markdown", text: answer, truncated: false })]) {
    assert.match(markup, /<figure class="md-chart">/);
    assert.match(markup, /<svg[^>]+role="img"/);
    assert.match(markup, /<figcaption>月度收入<\/figcaption>/);
    assert.match(markup, /万元/);
    assert.match(markup, /query_123/);
    assert.match(markup, /<tr><th>2月<\/th><td>缺失<\/td><\/tr>/);
    assert.equal((markup.match(/<circle /g) ?? []).length, 3);
    assert.equal((markup.match(/<polyline /g) ?? []).length, 2, "a missing observation must break the line, not imply interpolation");
    assert.doesNotMatch(markup, /language-chart/);
  }
});

test("pie and grouped bar charts preserve category values, negatives, zero and units", () => {
  const pie = renderMarkdown(fence({ type: "pie", labels: ["甲", "乙", "丙"], series: [{ name: "占比", values: [1, 3, 0] }] }));
  assert.equal((pie.match(/<path /g) ?? []).length, 2);
  assert.match(pie, /甲: 1 \(25.0%\)/);
  assert.match(pie, /乙: 3 \(75.0%\)/);
  assert.match(pie, /丙: 0 \(0.0%\)/);
  const single = renderMarkdown(fence({ type: "pie", labels: ["全部"], series: [{ values: [5] }] }));
  assert.match(single, /<circle /, "a 100% slice needs a full circle");
  const bar = renderMarkdown(fence({ type: "bar", labels: ["甲", "乙"], yLabel: "万元", series: [{ name: "本期", values: [-2, 0] }, { name: "上期", values: [3, 1] }] }));
  assert.equal((bar.match(/<rect /g) ?? []).length, 4);
  assert.match(bar, /<td>-2<\/td>/);
  assert.doesNotMatch(bar, /NaN|Infinity|height="-/);
});

test("malformed, mismatched, partial and unsupported charts report the error with source intact", () => {
  for (const value of [
    { ...line, series: [{ values: [1] }] },
    { ...line, series: [{ values: [null, null, null, null] }] },
    { ...line, type: "pie" },
    { type: "pie", labels: ["甲"], series: [{ values: [0] }] },
    { type: "pie", labels: ["甲", "乙"], series: [{ values: [-1, 2] }] },
    { ...line, type: "script" },
    { ...line, labels: Array(49).fill("类别") },
    { ...line, series: [{ values: [1, "2", 3, 4] }] },
  ]) {
    const markup = renderMarkdown(fence(value));
    assert.match(markup, /图表未显示/);
    assert.match(markup, /language-chart/);
    assert.doesNotMatch(markup, /<svg/);
  }
  assert.match(renderMarkdown("```chart\n{broken\n```"), /图表未显示/);
});

test("chart titles and labels are data, never executable HTML, URLs or SVG options", () => {
  const attack = '<img src=x onerror="alert(1)">';
  const markup = renderMarkdown(fence({ type: "bar", title: attack, labels: [attack], series: [{ name: attack, values: [2] }], onclick: "alert(1)", fill: "url(https://unsafe.test)" }));
  assert.match(markup, /&lt;img/);
  assert.doesNotMatch(markup, /<img|onclick=|fill="url|https:\/\/unsafe/);
  assert.match(renderMarkdown("```js\nalert(1)\n```"), /<pre class="md-code"><code class="language-js">alert\(1\)/);
});
