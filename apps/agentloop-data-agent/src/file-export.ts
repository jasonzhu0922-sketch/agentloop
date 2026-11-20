export const DATA_AGENT_FILE_SKILL_NAMES = [
  "xlsx",
  "docx",
  "pdf",
  "pptx",
  "build-dashboard",
] as const;

export type DataAgentFileSkillName = typeof DATA_AGENT_FILE_SKILL_NAMES[number];

export interface DataAgentFileExport {
  readonly kind: "spreadsheet" | "document" | "presentation" | "html";
  readonly format: string;
  readonly skillName?: DataAgentFileSkillName;
}

const FILE_ACTION = /(?:导出|下载|生成|创建|制作|输出|保存|做(?:一份|一个|成)?|整理成|转成|转为|给我(?:一份|一个)?)/iu;
const FILE_TOKEN = /(?:excel|xlsx|csv|电子表格|表格文件|报表|word|docx|文档|报告|pdf|pptx|ppt|幻灯片|演示文稿|markdown|\.md\b|html|网页|看板|dashboard|附件|下载链接|文件)/iu;
const EXPLICIT_FILE = /(?:\.(?:xlsx|csv|docx|pdf|pptx|md|markdown|html?)\b|excel\s*文件|word\s*文档|pdf\s*文件|pptx?\s*文件|markdown\s*文件|电子表格|表格文件|下载链接|作为附件)/iu;

/** Detect only explicit file delivery requests; ordinary data questions stay conversational. */
export function detectDataAgentFileExport(input: string): DataAgentFileExport | undefined {
  const value = input.trim();
  if (!value || (!(FILE_ACTION.test(value) && FILE_TOKEN.test(value)) && !EXPLICIT_FILE.test(value))) return undefined;
  if (/(?:pptx|powerpoint|幻灯片|演示文稿|\bppt\b)/iu.test(value)) {
    return { kind: "presentation", format: "pptx", skillName: "pptx" };
  }
  if (/(?:pdf|便携式文档)/iu.test(value)) return { kind: "document", format: "pdf", skillName: "pdf" };
  if (/(?:markdown|\.md\b|md\s*文件)/iu.test(value)) return { kind: "document", format: "markdown" };
  if (/(?:html|网页|看板|dashboard)/iu.test(value)) return { kind: "html", format: "html", skillName: "build-dashboard" };
  if (/(?:csv)/iu.test(value)) return { kind: "spreadsheet", format: "csv", skillName: "xlsx" };
  if (/(?:excel|xlsx|电子表格|表格文件|报表)/iu.test(value)) return { kind: "spreadsheet", format: "xlsx", skillName: "xlsx" };
  if (/(?:word|docx|文档|报告|备忘录)/iu.test(value)) return { kind: "document", format: "docx", skillName: "docx" };
  return { kind: "spreadsheet", format: "xlsx", skillName: "xlsx" };
}

export function fileExportForTarget(target: { readonly kind: string; readonly format?: string; readonly surface: string }): DataAgentFileExport | undefined {
  if (target.surface !== "workspace_artifact" || target.kind === "none") return undefined;
  const format = target.format?.toLowerCase();
  if (target.kind === "spreadsheet") return { kind: "spreadsheet", format: format === "csv" ? "csv" : "xlsx", skillName: "xlsx" };
  if (target.kind === "presentation") return { kind: "presentation", format: "pptx", skillName: "pptx" };
  if (target.kind === "html") return { kind: "html", format: "html", skillName: "build-dashboard" };
  if (target.kind === "document" && format === "pdf") return { kind: "document", format: "pdf", skillName: "pdf" };
  if (target.kind === "document" && ["markdown", "md", "text", "txt"].includes(format ?? "")) {
    return { kind: "document", format: format === "md" ? "markdown" : format ?? "markdown" };
  }
  if (target.kind === "document") return { kind: "document", format: "docx", skillName: "docx" };
  return undefined;
}
