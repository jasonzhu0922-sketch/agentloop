import assert from "node:assert/strict";
import { renderMarkdown } from "../web/markdown.js";

const markdown = [
  "# 经营概览", "", "- 累计收入 **298.34** 亿元", "- 净利润约 8.64 亿元", "",
  "```chart",
  JSON.stringify({ type: "line", title: "月度趋势", xLabel: "月份", yLabel: "金额", labels: ["1月", "2月"], series: [{ name: "收入", values: [10, 12] }] }),
  "```", "", "### 明细", "", "| 指标 | 数值 |", "| --- | ---: |", "| 收入 | 298.34 |",
].join("\n");
const html = renderMarkdown(markdown);
assert.equal((html.match(/<h[13][ >]/g) ?? []).length, 2);
assert.equal((html.match(/<li>/g) ?? []).length, 2);
assert.equal((html.match(/class="md-chart"/g) ?? []).length, 1);
assert.equal((html.match(/<svg[ >]/g) ?? []).length, 1);
assert.equal((html.match(/<table[ >]/g) ?? []).length, 2); // answer table plus chart data inspection table
assert.equal(html.includes("```chart"), false);
assert.match(renderMarkdown("```chart\n{broken\n```"), /图表未显示/);
assert.match(renderMarkdown("```chart\n{broken\n```"), /language-chart/);
console.log("Markdown rendering checks passed.");
