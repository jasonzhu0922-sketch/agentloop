import type { AdminSkillDetail, AdminSkillPage } from "../../shared/api/admin-api-client.ts";
import { buildSkillFileTree, type SkillFileTreeNode } from "../skill-file-tree.ts";
import { escape, formatBytes } from "../page-helpers.ts";
import type { PageRenderContext } from "../page-context.ts";

export function renderSkillsPage({ state }: PageRenderContext): string {
  const page = state.skills;
  return `<section class="skill-layout"><article class="panel skill-list-panel"><div class="panel-title"><div><p>custom-skills</p><span>只读展示配置目录中的 Skill；点击名称查看 SKILL.md、AgentLoop 元数据与文件结构。</span></div><span class="count">${page.total}</span></div><div class="skill-list">${page.items.length === 0 ? `<div class="empty">当前 custom-skills 没有可展示的 Skill</div>` : page.items.map((skill) => skillListRow(state.skillDetail?.name === skill.name, skill)).join("")}</div><div class="pagination"><button class="ghost" data-action="skill-page-prev" ${page.page <= 1 ? "disabled" : ""}>上一页</button><span>第 ${page.page} / ${page.pageCount} 页 · 共 ${page.total} 个</span><button class="ghost" data-action="skill-page-next" ${page.page >= page.pageCount ? "disabled" : ""}>下一页</button></div></article><article class="panel skill-detail-panel">${state.skillDetail === undefined ? `<div class="skill-empty-detail"><p class="panel-kicker">SKILL INSPECTOR</p><h3>选择一个 Skill</h3><p>左侧列表按分页加载 custom-skills。详情只返回包内相对路径，不暴露服务器目录。</p></div>` : skillDetailView(state.skillDetail)}</article></section>`;
}

function skillListRow(selected: boolean, skill: AdminSkillPage["items"][number]): string { return `<button class="skill-list-row${selected ? " selected" : ""}" data-skill-name="${escape(skill.name)}"><span class="skill-row-main"><strong>${escape(skill.name)}</strong><small>${escape(skill.description)}</small></span><span class="skill-row-meta"><b>${escape(skill.version ?? "未声明版本")}</b><small>${skill.fileCount} 个文件</small></span></button>`; }

function skillDetailView(skill: AdminSkillDetail): string {
  return `<div class="skill-detail-head"><div><p class="panel-kicker">CUSTOM SKILL</p><h2>${escape(skill.name)}</h2><p>${escape(skill.description)}</p></div><span class="tag purple">v${escape(skill.version ?? "未声明")}</span></div><div class="skill-facts"><span><b>Package Hash</b><code>${escape(skill.packageHash)}</code></span><span><b>文件</b>${skill.fileCount}</span><span><b>大小</b>${formatBytes(skill.totalBytes)}</span></div><section class="skill-section"><div class="skill-section-title"><h3>AgentLoop 元数据</h3><span>专项字段</span></div>${agentLoopMetadata(skill.agentLoop)}</section><section class="skill-section"><div class="skill-section-title"><h3>SKILL.md 关键内容</h3><span>敏感值已脱敏</span></div><pre class="skill-markdown">${escape(skill.skillMd)}</pre></section><section class="skill-section"><div class="skill-section-title"><h3>文件结构</h3><span>scripts / references / assets 等</span></div><div class="skill-tree">${skillFileTree(skill.files)}</div></section></div>`;
}

function agentLoopMetadata(metadata: AdminSkillDetail["agentLoop"]): string {
  if (metadata === undefined) return `<p class="muted-text">未声明 agentloop 元数据。</p>`;
  const fields: Array<[string, readonly string[] | undefined]> = [["roles", metadata.roles], ["artifactKinds", metadata.artifactKinds], ["sourceKinds", metadata.sourceKinds], ["qaKinds", metadata.qaKinds], ["executionProfiles", metadata.executionProfiles], ["semanticTags", metadata.semanticTags], ["producesEvidenceKinds", metadata.producesEvidenceKinds], ["requiredSkillNames", metadata.requiredSkillNames]];
  return `<div class="metadata-grid">${fields.filter(([, values]) => values !== undefined && values.length > 0).map(([label, values]) => `<div><b>${escape(label)}</b><span>${values!.map((value) => `<em>${escape(value)}</em>`).join("")}</span></div>`).join("")}${metadata.intentExamples === undefined || metadata.intentExamples.length === 0 ? "" : `<div class="metadata-wide"><b>intentExamples</b><span>${metadata.intentExamples.map((value) => `<em>${escape(value)}</em>`).join("")}</span></div>`}</div>`;
}

function skillFileTree(files: readonly string[]): string { return `<ul class="skill-tree-branch">${buildSkillFileTree(files).map(skillFileTreeNode).join("")}</ul>`; }
function skillFileTreeNode(node: SkillFileTreeNode): string { return node.kind === "file" ? `<li class="skill-tree-file"><span aria-hidden="true">·</span><code title="${escape(node.path)}">${escape(node.name)}</code></li>` : `<li class="skill-tree-directory"><details open><summary><strong>${escape(node.name)}</strong><small>${node.fileCount} 个文件</small></summary><ul class="skill-tree-branch">${node.children.map(skillFileTreeNode).join("")}</ul></details></li>`; }
