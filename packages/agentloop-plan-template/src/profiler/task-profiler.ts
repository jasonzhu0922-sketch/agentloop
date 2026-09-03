import type { PlanningExtensionInput } from "@zhujun/agentloop";
import type {
  TaskArtifactKind,
  TaskFingerprint,
  TaskSideEffectKind,
  TaskSourceNeed,
} from "../types.ts";

export function profileTask(input: PlanningExtensionInput): TaskFingerprint {
  const text = input.input.toLowerCase();
  const sourceTypes = unique(input.sources.map((source) => source.extension.replace(/^\./, "").toLowerCase()).filter(Boolean));
  const sourceNeed = inferSourceNeed(input, text);
  const artifactKind = inferArtifactKind(text);
  const sideEffectKind = inferSideEffectKind(text);
  const intentHints = inferIntentHints(text, artifactKind, sourceNeed, sideEffectKind);
  const requiredCapabilities = inferRequiredCapabilities(input.availableToolNames, artifactKind, sourceNeed, sideEffectKind);
  return {
    schema: "agentloop.taskFingerprint/v1",
    language: inferLanguage(input.input),
    intentHints,
    sourceNeed,
    sourceTypes,
    artifactKind,
    sideEffectKind,
    requiredCapabilities,
    skillHints: inferSkillHints(input, text),
    outputConstraints: inferOutputConstraints(text),
    riskLevel: sideEffectKind === "none" || sideEffectKind === "write_file" ? "low" : "medium",
    confidence: sourceNeed === "none" && artifactKind === "none" && sideEffectKind === "none" ? 0.62 : 0.82,
  };
}

function inferLanguage(value: string): TaskFingerprint["language"] {
  const hasCjk = /[\u3400-\u9fff]/u.test(value);
  const hasAsciiWords = /[A-Za-z]{3,}/.test(value);
  if (hasCjk && hasAsciiWords) return "mixed";
  if (hasCjk) return "zh";
  return "en";
}

function inferSourceNeed(input: PlanningExtensionInput, text: string): TaskSourceNeed {
  if (input.sources.length > 0) return "uploaded_file";
  if (input.visibleDirectories.length > 0) return "visible_directory";
  if (/(联网|搜索|查询|调研|最新|官网|web|http|https|research|search|lookup)/i.test(text)) return "web_research";
  if (input.conversationWorkingSet !== undefined) return "existing_conversation_context";
  return "none";
}

function inferArtifactKind(text: string): TaskArtifactKind {
  if (/(pptx|ppt|powerpoint|幻灯片|演示文稿)/i.test(text)) return "pptx";
  if (/(pdf)/i.test(text)) return "pdf";
  if (/(docx|word|文档)/i.test(text)) return "docx";
  if (/(html|网页|页面|网站|report page)/i.test(text)) return "html";
  if (/(xlsx|excel|表格)/i.test(text)) return "xlsx";
  if (/(图片|海报|image|poster|png|jpg|jpeg)/i.test(text)) return "image";
  if (/(代码|源码|实现|修复|code|typescript|python)/i.test(text)) return "code";
  return "none";
}

function inferSideEffectKind(text: string): TaskSideEffectKind {
  if (/(发邮件|发送邮件|email|mail|收件人|@[\w.-]+)/i.test(text)) return "send_email";
  if (/(调用接口|external api|api 调用)/i.test(text)) return "external_api";
  if (/(浏览器|点击|登录|browser|chrome)/i.test(text)) return "browser_operation";
  if (/(写入|生成|创建|保存|write|create|generate)/i.test(text)) return "write_file";
  return "none";
}

function inferIntentHints(
  text: string,
  artifactKind: TaskArtifactKind,
  sourceNeed: TaskSourceNeed,
  sideEffectKind: TaskSideEffectKind,
): readonly string[] {
  const hints: string[] = [];
  if (/(分析|analy[sz]e|analysis)/i.test(text)) hints.push("analyze");
  if (/(报告|简报|report|brief)/i.test(text)) hints.push("report");
  if (/(总结|summary|summari[sz]e)/i.test(text)) hints.push("summarize");
  if (/(转换|convert)/i.test(text)) hints.push("convert");
  if (sourceNeed === "web_research") hints.push("research");
  if (artifactKind !== "none") hints.push("artifact");
  if (sideEffectKind === "send_email") hints.push("send_email");
  if (hints.length === 0) hints.push("direct_answer");
  return unique(hints);
}

function inferRequiredCapabilities(
  availableToolNames: readonly string[],
  artifactKind: TaskArtifactKind,
  sourceNeed: TaskSourceNeed,
  sideEffectKind: TaskSideEffectKind,
): readonly string[] {
  const available = new Set(availableToolNames);
  const capabilities: string[] = [];
  if (sourceNeed === "uploaded_file") capabilities.push("source_read");
  if (sourceNeed === "visible_directory") capabilities.push("visible_directory_read");
  if (sourceNeed === "web_research") capabilities.push("web_research");
  if (artifactKind !== "none") capabilities.push("artifact_write");
  if (available.has("verify_artifact_acceptance") && artifactKind !== "none") capabilities.push("artifact_acceptance");
  if (sideEffectKind !== "none") capabilities.push(sideEffectKind);
  return unique(capabilities);
}

function inferOutputConstraints(text: string): readonly string[] {
  const constraints: string[] = [];
  if (/(正式|专业|汇报|presentation|executive)/i.test(text)) constraints.push("professional");
  if (/(中文|chinese)/i.test(text)) constraints.push("chinese");
  if (/(英文|english)/i.test(text)) constraints.push("english");
  if (/(自包含|无 cdn|no cdn|self-contained)/i.test(text)) constraints.push("self_contained");
  return unique(constraints);
}

function mentions(text: string, value: string): boolean {
  return value.trim().length > 0 && text.includes(value.toLowerCase());
}

function inferSkillHints(input: PlanningExtensionInput, text: string): readonly string[] {
  const skillNameById = new Map(input.availableSkills.map((skill) => [skill.id, skill.name]));
  return unique([
    ...input.selectedSkillRoles.map((selection) => skillNameById.get(selection.skillId) ?? selection.skillId),
    ...input.availableSkills.map((skill) => skill.name).filter((name) => mentions(text, name)),
  ]);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}
