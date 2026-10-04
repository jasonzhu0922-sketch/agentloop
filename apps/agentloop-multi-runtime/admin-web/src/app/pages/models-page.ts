import type { ResourceRelease } from "../../../../control-plane/contracts/index.ts";
import type { AdminModelSummary, AdminProviderSummary, RegisterModelInput } from "../../shared/api/admin-api-client.ts";
import { emptyRow, escape, permissionNote, statusPill, text } from "../page-helpers.ts";
import type { PageRenderContext } from "../page-context.ts";

export function renderModelsPage({ state, can }: PageRenderContext): string {
  const editing = state.modelEditingKey === undefined ? undefined : state.models.find((model) => model.key === state.modelEditingKey);
  const providers = state.providers.length === 0 ? `<div class="empty">暂无登记 Provider，请先新增 Provider，再在 Provider 下增加模型。</div>` : state.providers.map((provider) => renderProviderSection(provider, can("release.write"))).join("");
  return `<section class="page-grid models-page"><article class="panel wide"><div class="panel-title"><div><p>Provider / 模型目录</p><span>连接配置按 Provider 维护；每个 Provider 下可登记多个模型。保存后写入 Router，Runtime 会在下一次任务准入时读取该版本。</span></div>${can("release.write") ? `<div class="button-row"><button class="secondary" data-action="new-provider">新增 Provider</button><button class="primary" data-action="new-model" ${state.providers.length === 0 ? "disabled" : ""}>新增模型</button></div>` : ""}</div>${providers}</article>${can("release.write") && state.modelModal ? renderModelForm(state.providers, editing, state.modelProviderKey) : ""}${!can("release.write") ? permissionNote("当前角色没有 release.write，无法新增或修改模型。") : ""}${state.providerModal ? renderProviderForm(state.providers, state.providerEditingKey) : ""}</section>`;
}

function renderProviderForm(providers: readonly AdminProviderSummary[], editingKey?: string): string {
  const editing = editingKey === undefined ? undefined : providers.find((provider) => provider.key === editingKey);
  const isEditing = editing !== undefined;
  return `<div class="dialog-backdrop"><article class="dialog"><button class="dialog-close" data-action="cancel-provider" aria-label="关闭">×</button><p class="eyebrow">PROVIDER SETUP</p><h2>${isEditing ? "编辑 Provider" : "新增 Provider"}</h2><p>Provider 统一维护 Base URL、协议和 API Key；下方模型会继承这些连接配置。API Key 直接保存到 Provider 配置，不使用环境变量。</p><form id="provider-form" class="form-grid"><label>Provider Key<input name="providerKey" value="${escape(editing?.key ?? "")}" ${isEditing ? "readonly" : ""} required placeholder="例如 openai"></label><label>协议<select name="protocol"><option value="chat-completions" ${editing?.protocol !== "responses" ? "selected" : ""}>chat-completions</option><option value="responses" ${editing?.protocol === "responses" ? "selected" : ""}>responses</option></select></label><label class="span-2">Base URL<input name="baseUrl" type="url" value="${escape(editing?.baseUrl ?? "")}" required placeholder="https://api.example.com/v1"></label><label class="span-2">API Key<input name="apiKey" type="password" ${isEditing ? "" : "required"} placeholder="${isEditing ? "留空表示保持现有 Key，填写则覆盖" : "直接填入 Provider API Key"}"></label><label class="checkbox-label span-2"><input name="defaultProvider" type="checkbox" ${editing?.defaultProvider ? "checked" : ""}>设为默认 Provider</label><div class="button-row span-2"><button class="primary" type="submit">${isEditing ? "保存 Provider" : "新增 Provider"}</button><button class="secondary" type="button" data-action="cancel-provider">取消</button></div></form></article></div>`;
}

function renderProviderSection(provider: AdminProviderSummary, writable: boolean): string {
  return `<section class="provider-card"><div class="provider-card-head"><div><p class="panel-kicker">PROVIDER</p><h3>${escape(provider.key)} ${provider.defaultProvider ? `<span class="tag purple">默认 Provider</span>` : ""}</h3><small>${escape(provider.baseUrl)} · ${escape(provider.protocol)} · Key ${provider.apiKeyConfigured ? "已配置" : "未配置"}</small></div><div class="button-row"><span class="tag">${provider.models.length} 个模型</span>${writable ? `${provider.defaultProvider ? "" : `<button class="text-button" data-provider-default="${escape(provider.key)}">设为默认</button>`}<button class="secondary" data-provider-edit="${escape(provider.key)}">编辑 Provider</button><button class="secondary" data-provider-add-model="${escape(provider.key)}">新增模型</button>` : ""}</div></div><div class="table-wrap"><table><thead><tr><th>模型</th><th>上游模型</th><th>状态</th><th>默认</th><th>参数</th><th></th></tr></thead><tbody>${provider.models.length === 0 ? emptyRow(6, "该 Provider 暂无模型") : provider.models.map((model) => renderModelRow(model, writable)).join("")}</tbody></table></div></section>`;
}

function renderModelRow(model: AdminModelSummary, writable: boolean): string {
  const parameterCount = Object.keys(model.parameters).length + (model.contextWindowTokens === undefined ? 0 : 1) + (model.maxOutputTokens === undefined ? 0 : 1);
  return `<tr><td><strong>${escape(model.displayName)}</strong><small>${escape(model.key)}</small></td><td>${escape(model.providerModel)}</td><td>${statusPill(model.releaseState)}</td><td>${model.defaultModel ? "是" : "否"}</td><td><span class="tag">${parameterCount} 项</span>${parameterCount === 0 ? "" : `<small><code>${escape(JSON.stringify(model.parameters))}</code></small>`}</td><td class="actions">${writable ? `<button class="text-button" data-model-edit="${escape(model.key)}">编辑</button><button class="text-button danger-link" data-model-delete="${escape(model.key)}">删除</button>` : ""}</td></tr>`;
}

function renderModelForm(providers: readonly AdminProviderSummary[], editing?: AdminModelSummary, requestedProvider?: string): string {
  const selectedProvider = requestedProvider ?? editing?.providerKey ?? providers[0]?.key ?? "";
  const params = editing === undefined ? {} : { ...editing.parameters, ...(editing.contextWindowTokens === undefined ? {} : { contextWindowTokens: editing.contextWindowTokens }), ...(editing.maxOutputTokens === undefined ? {} : { maxOutputTokens: editing.maxOutputTokens }) };
  const parameterRows = Object.entries(params).map(([key, value]) => modelParameterRow(key, value)).join("");
  return `<div class="dialog-backdrop"><article class="dialog model-dialog"><button class="dialog-close" data-action="cancel-model" aria-label="关闭">×</button><p class="eyebrow">MODEL SETUP</p><h2>${editing === undefined ? "新增模型" : "编辑模型"}</h2><p>模型只挂在已有 Provider 下；Provider 的 Base URL、协议和 API Key 由 Provider 统一维护。</p><form id="model-form" class="form-grid"><label>所属 Provider<select name="providerKey" required>${providers.map((provider) => `<option value="${escape(provider.key)}" ${provider.key === selectedProvider ? "selected" : ""}>${escape(provider.key)} · ${escape(provider.baseUrl)}</option>`).join("")}</select></label><label>模型 Key<input name="modelKey" value="${escape(editing?.key ?? "")}" ${editing === undefined ? "" : "readonly"} required placeholder="例如 gpt-5.6-terra"></label><label>显示名称<input name="displayName" value="${escape(editing?.displayName ?? "")}" required placeholder="例如 GPT-5.6 Terra"></label><label>上游模型名<input name="providerModel" value="${escape(editing?.providerModel ?? "")}" required placeholder="例如 gpt-5.6-terra"></label><label class="checkbox-label span-2"><input name="defaultModel" type="checkbox" ${editing?.defaultModel ? "checked" : ""}>设为默认模型</label><div class="model-parameters span-2"><div class="parameter-header"><strong>模型差异参数（key-value）</strong><button class="ghost" type="button" data-action="add-model-parameter">添加参数</button></div><div id="model-parameters">${parameterRows || modelParameterRow()}</div><p class="form-help">值优先按 JSON 解析；字符串请直接输入，布尔值、数字、数组和对象可直接填写 JSON。</p></div><div class="button-row span-2"><button class="primary" type="submit">${editing === undefined ? "登记模型" : "保存模型"}</button><button class="secondary" type="button" data-action="cancel-model">取消</button></div></form></article></div>`;
}

function modelParameterRow(key = "", value: unknown = ""): string { const encoded = typeof value === "string" ? value : JSON.stringify(value); return `<div class="model-parameter-row"><input name="parameterKey" value="${escape(key)}" placeholder="参数名"><input name="parameterValue" value="${escape(encoded ?? "")}" placeholder='字符串或 JSON，例如 {"thinking":false}'><button class="text-button" type="button" data-action="remove-model-parameter" aria-label="删除参数">×</button></div>`; }

export function parseModelInput(data: FormData, providers: readonly AdminProviderSummary[]): RegisterModelInput {
  const parameters: Record<string, unknown> = {};
  const seen = new Set<string>();
  const keys = data.getAll("parameterKey").map(String);
  const values = data.getAll("parameterValue").map(String);
  keys.forEach((key, index) => { const trimmed = key.trim(); if (trimmed === "") return; if (seen.has(trimmed)) throw new Error(`模型参数 ${trimmed} 重复`); seen.add(trimmed); const raw = values[index]?.trim() ?? ""; try { parameters[trimmed] = raw === "" ? "" : JSON.parse(raw); } catch { parameters[trimmed] = raw; } });
  const providerKey = text(data, "providerKey");
  const provider = providers.find((item) => item.key === providerKey);
  if (provider === undefined) throw new Error("请选择一个已登记的 Provider");
  const contextWindowTokens = text(data, "contextWindowTokens");
  return { modelKey: text(data, "modelKey"), displayName: text(data, "displayName"), providerKey, providerModel: text(data, "providerModel"), baseUrl: provider.baseUrl, protocol: provider.protocol, defaultModel: data.get("defaultModel") === "on", ...(contextWindowTokens === "" ? {} : { contextWindowTokens: Number(contextWindowTokens) }), parameters };
}

export function modelCatalogNotice(result: ResourceRelease, label: string): string { return result.state === "active" ? `${label}已写入 Router 模型目录，Runtime 下次任务准入时会读取新配置` : `${label}已生成 Draft Release，请完成发布与目标分配`; }
