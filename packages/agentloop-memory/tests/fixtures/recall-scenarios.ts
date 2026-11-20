/** Shared by deterministic contract tests and opt-in real-model evaluation.
 * These are method examples, not evidence of completed user tasks. */
export const RECALL_SCENARIOS = [
  {
    id: "document", title: "Generate a source-grounded document and visually verify the rendered deliverable",
    goals: ["根据项目材料制作一份 Word 汇报，检查版式和分页。", "根据另一项目的材料生成 Word 汇报，检查排版和分页。"],
    steps: ["Inspect current source material and requested audience", "Write the document with the current template", "Render every page and inspect layout before delivery"],
    verification: "Current rendered pages preserve the source facts and have no clipped content",
    parameters: [{ name: "source", description: "Current user-supplied source material" }, { name: "audience", description: "Current intended audience" }],
  },
  {
    id: "debugging", title: "Diagnose an intermittent software failure from persisted evidence and repair the first broken contract",
    goals: ["帮我定位文件上传偶发失败的根因，修复后验证。", "帮我定位支付回调偶发失败的根因，修复后验证。"],
    steps: ["Reconstruct the failed execution from durable events", "Locate the first violated shared contract", "Repair that boundary and reproduce the original failure path"],
    verification: "The regression exercises the original failure boundary and preserves required evidence",
    parameters: [{ name: "failure", description: "Current observed failure" }, { name: "component", description: "Current component under investigation" }],
  },
  {
    id: "spreadsheet", title: "Transform a spreadsheet while preserving formulas, units and totals",
    goals: ["整理这份预算 Excel，保留公式并核对汇总数。", "整理另一份成本 Excel，保留公式并核对汇总数。"],
    steps: ["Inspect workbook formulas, units and requested transformations", "Apply the current transformation without replacing formulas with historical values", "Recalculate and verify totals against the current workbook"],
    verification: "Current formulas remain valid and recalculated totals reconcile with current inputs",
    parameters: [{ name: "workbook", description: "Current input workbook" }, { name: "transformation", description: "Current requested transformation" }],
  },
] as const;

export const UNRELATED_RECALL_GOAL = "给我写一首描写秋天山林的短诗。";
