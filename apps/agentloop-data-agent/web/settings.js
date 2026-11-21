const $ = selector => document.querySelector(selector);
const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const labels = { connection: '数据连接', server: 'Server', workflow: '工作流', tables: '数据表', metrics: '指标定义', terms: '业务术语', skills: '分析 Skills', sample_questions: '案例问题', semantic_objects: '语义对象', relationships: '语义关系', period_formats: '时间格式变体', semantic_gaps: '语义缺口', model: '模型管理' };
let catalog, models, modelSchema, connection, status, current, epoch = 0, saving = false;
async function request(path, data, method = 'PUT') {
  const endpoint = path.startsWith('/') ? path : `/api/settings/${path}`;
  const response = await fetch(endpoint, { method: data === undefined ? 'GET' : method,
    headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '请求失败');
  return value;
}
function mcpEventReader(stream) {
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  return {
    async next() {
      for (;;) {
        const split = pending.indexOf('\n\n');
        if (split >= 0) {
          const frame = pending.slice(0, split); pending = pending.slice(split + 2);
          let event = 'message', data = '';
          for (const line of frame.replaceAll('\r\n', '\n').split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          try { data = JSON.parse(data); } catch { /* endpoint is a relative URL */ }
          return { event, data };
        }
        const chunk = await reader.read();
        if (chunk.done) return undefined;
        pending += decoder.decode(chunk.value, { stream: true });
      }
    },
    cancel() { return reader.cancel(); },
  };
}
async function mcpPost(endpoint, message) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
  if (!response.ok) throw new Error(`MCP 消息发送失败（HTTP ${response.status}）`);
}
async function runMcpVerification(tool, args, onEvent) {
  const stream = await fetch('/mcp/sse', { headers: { Accept: 'text/event-stream' } });
  if (!stream.ok || !stream.body) throw new Error(`MCP SSE 连接失败（HTTP ${stream.status}）`);
  const events = mcpEventReader(stream);
  const emit = event => { if (event) onEvent(event); return event; };
  try {
    const endpointEvent = emit(await events.next());
    if (!endpointEvent || endpointEvent.event !== 'endpoint' || typeof endpointEvent.data !== 'string') throw new Error('MCP SSE 未返回消息端点');
    const endpoint = new URL(endpointEvent.data, location.href).toString();
    const receiveMessage = async () => {
      for (;;) {
        const event = emit(await events.next());
        if (!event) throw new Error('MCP SSE 连接提前关闭');
        if (event.event === 'message') return event.data;
      }
    };
    await mcpPost(endpoint, { jsonrpc: '2.0', id: 'settings-initialize', method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    const initialize = await receiveMessage();
    await mcpPost(endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' });
    await mcpPost(endpoint, { jsonrpc: '2.0', id: 'settings-tools', method: 'tools/list' });
    const listed = await receiveMessage();
    await mcpPost(endpoint, { jsonrpc: '2.0', id: 'settings-call', method: 'tools/call', params: { name: tool, arguments: args, _meta: { progressToken: `settings_${Date.now()}` } } });
    let call;
    for (;;) {
      const message = await receiveMessage();
      if (message && message.id === 'settings-call') { call = message; break; }
    }
    return { ok: Boolean(call && !call.error && call.result?.isError !== true), verified_at: Date.now(), initialize, tools: listed?.result?.tools || [], call };
  } finally {
    await events.cancel().catch(() => {});
  }
}
function feedback(message, error = false) { const node = $('#feedback'); node.hidden = !message; node.textContent = message; node.classList.toggle('error', error); }
function header(title, description, add = false) {
  return `<div class="content-header"><div><span class="eyebrow">KNOWLEDGE &amp; DATA</span><h2>${esc(title)}</h2><p>${esc(description)}</p></div>${add ? '<button class="action-btn" id="add-record">＋ 新增</button>' : ''}</div>`;
}
function counts() { if (catalog) for (const key of ['tables', 'metrics', 'terms', 'skills', 'sample_questions', 'relationships', 'period_formats', 'semantic_gaps']) $(`#${key}-count`).textContent = catalog[key]?.length ?? 0; if (catalog) $('#semantic_objects-count').textContent = catalog.entities?.length ?? 0; }
function field(name, label, value = '', type = 'text', extra = '') { return `<label>${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`; }
function area(name, label, value = '', extra = '') { return `<label>${esc(label)}<textarea name="${name}" ${extra}>${esc(value)}</textarea></label>`; }
function actions(label = '保存', cancel = false) { return `<p class="editor-feedback" role="status"></p><div class="form-actions">${cancel ? '<button class="secondary-btn" type="button" id="cancel-editor">取消</button>' : ''}<button class="action-btn" type="submit">${esc(label)}</button></div>`; }
function modal(title, fields, submit) {
  const dialog = $('#editor-dialog');
  $('#editor-content').innerHTML = `<form class="form-card" id="editor-form"><h3 id="editor-title">${esc(title)}</h3><fieldset>${fields}</fieldset>${actions('保存', true)}</form>`;
  $('#cancel-editor').onclick = () => dialog.close();
  bindForm($('#editor-form'), async form => { await submit(new FormData(form)); await show(current); dialog.close(); feedback('配置已保存，将用于下一次分析。'); });
  dialog.showModal();
}
$('#editor-dialog').addEventListener('cancel', event => { if (saving) event.preventDefault(); });
function bindForm(form, submit) {
  form.onsubmit = async event => {
    event.preventDefault(); if (saving) return;
    const buttons = [...form.querySelectorAll('button')];
    saving = true; buttons.forEach(b => { b.disabled = true; });
    const message = form.querySelector('.editor-feedback'); if (message) message.textContent = '正在处理…';
    try { await submit(form); }
    catch (error) { if (message) message.textContent = error.message; feedback(error.message, true); }
    finally { saving = false; buttons.forEach(b => { b.disabled = false; }); }
  };
}
async function saveChanges(changes) {
  catalog = await request('catalog', { revision: catalog.revision, changes }); counts();
}
async function show(panel) {
  if (!labels[panel]) panel = 'connection';
  const version = ++epoch; current = panel;
  document.querySelectorAll('[data-panel]').forEach(button => { button.classList.toggle('active', button.dataset.panel === panel); button.setAttribute('aria-current', button.dataset.panel === panel ? 'page' : 'false'); });
  const root = $('#knowledge-panel'); root.setAttribute('aria-busy', 'true'); root.innerHTML = '<p role="status">正在读取配置…</p>'; feedback('');
  try {
    let loaded;
    if (panel === 'model') {
      const response = await fetch('/api/model-configuration/schema');
      if (!response.ok) throw new Error('无法读取模型配置定义');
      modelSchema = await response.json(); loaded = await request('models');
    }
    else if (panel === 'connection') loaded = await request('connection');
    else if (['server', 'workflow'].includes(panel)) loaded = await request('status');
    else loaded = await request(`catalog${panel === 'tables' ? '?inspect=true' : ''}`);
    if (version !== epoch) return;
    if (panel === 'model') { models = loaded; renderModels(root); }
    else if (panel === 'connection') { connection = loaded; renderConnection(root); }
    else if (['server', 'workflow'].includes(panel)) { status = loaded; renderStatus(root, panel); }
    else {
      catalog = loaded; counts();
      if (panel === 'tables') connected(true);
      if (panel === 'sample_questions') renderCases(root); else renderRecords(root, panel);
    }
  } catch (error) {
    if (version !== epoch) return;
    root.innerHTML = header(labels[panel], '暂时无法读取配置。') + '<button class="secondary-btn" id="reload-panel">重新加载</button>';
    $('#reload-panel').onclick = () => show(panel); feedback(error.message, true);
  } finally { if (version === epoch) root.setAttribute('aria-busy', 'false'); }
}
function connected(ok) { const node = $('#database-status'); node.dataset.state = ok ? 'ok' : 'error'; node.textContent = ok ? '● TiDB 已验证' : '● 连接检测失败'; }
function renderConnection(root) {
  const inputs = (name, title) => `<h4>${title}</h4><div class="field-grid">${field(`${name}_host`, '主机', connection[name].host, 'text', 'required')}${field(`${name}_port`, '端口', connection[name].port, 'number', 'required min="1" max="65535"')}${field(`${name}_user`, '用户名', connection[name].user, 'text', 'required autocomplete="off"')}${field(`${name}_database`, '数据库', connection[name].database, 'text', 'required')}${field(`${name}_password`, connection[name].password_configured ? '密码（已配置，留空保持不变）' : '密码', '', 'password', 'autocomplete="new-password"')}</div>`;
  root.innerHTML = header('数据连接', '配置集团经营分析的数据源与业务目录。') + `<form id="connection-form" class="form-card"><h3>TiDB 数据连接</h3><fieldset>${inputs('query', '业务查询数据库')}${area('allowed_relations', '授权实体表（每行一个 schema.table）', connection.allowed_relations.join('\n'), 'required rows="7" class="code"')}${inputs('catalog', '知识与配置数据库')}</fieldset><p class="form-hint">保存前会验证目录和全部授权表。业务查询继续使用受控只读 SQL。修改连接前，请先完成或停止当前分析。</p><p class="editor-feedback" role="status"></p><div class="form-actions"><button class="secondary-btn" id="test-connection" type="button">测试连接</button><button class="action-btn" type="submit">验证并保存连接</button></div></form>`;
  const payload = form => {
    const data = new FormData(form), result = { revision: connection.revision, allowed_relations: lines(data.get('allowed_relations')) };
    for (const prefix of ['query', 'catalog']) result[prefix] = Object.fromEntries(['host', 'port', 'user', 'database', 'password'].map(key => [key, key === 'port' ? Number(data.get(`${prefix}_${key}`)) : data.get(`${prefix}_${key}`)]));
    return result;
  };
  const form = $('#connection-form');
  $('#test-connection').onclick = async () => {
    if (!form.reportValidity() || saving) return;
    const button = $('#test-connection'); button.disabled = true;
    try { const result = await request('connection/test', payload(form), 'POST'); connected(true); feedback(`连接成功，已验证 ${result.table_count} 张授权表。`); }
    catch (error) { connected(false); feedback(error.message, true); } finally { button.disabled = false; }
  };
  bindForm(form, async () => {
    const result = await request('connection', payload(form));
    await show('connection'); connected(true); feedback(`连接已保存，已验证 ${result.table_count} 张表，将用于下一次分析。`);
  });
}
function renderStatus(root, panel) {
  if (panel === 'workflow') {
    root.innerHTML = header('工作流', '应用固定主 Skill，当前模型在分析步骤内完成领域推理。') + `<div class="workflow-list">${status.workflow.map((node, i) => `<article class="workflow-node"><span>${String(i + 1).padStart(2, '0')}</span><div><b>${esc(node.name)}</b><p>${esc(node.description)}</p></div></article>`).join('')}</div>`;
    return;
  }
  const tools = status.mcp?.tools || [];
  root.innerHTML = header('Server', '本机问数服务与持久化状态。') + `<section class="form-card"><h3>${esc(status.service)}</h3><dl class="server-details"><dt>服务地址</dt><dd>${esc(status.url)}</dd><dt>MCP SSE</dt><dd><code>${esc(status.mcp?.endpoint || '未配置')}</code></dd><dt>MCP 工具</dt><dd>${esc(tools.map(tool => tool.name).join('、') || '—')}</dd><dt>状态存储</dt><dd>${esc(status.storage)}</dd><dt>固定能力</dt><dd>${esc(status.skill.name)}</dd><dt>能力版本</dt><dd><code>${esc(status.skill.contentHash)}</code></dd><dt>数据场景</dt><dd>集团经营分析</dd></dl><p class="form-hint">通过分析工作台或 MCP 发起查询。会话、执行进度、澄清与结果由 AgentLoop 内核持久化。</p><a class="secondary-btn" href="/">打开分析工作台 →</a></section><section class="form-card mcp-verify-card"><h3>调用验证</h3><p class="form-hint">验证会走 initialize、tools/list 和 tools/call 流程。默认调用 <code>search_tables</code>，不会触发模型问数。</p><form id="mcp-verify-form"><div class="field-grid"><label>工具<select name="tool">${tools.map(tool => `<option value="${esc(tool.name)}">${esc(tool.name)}</option>`).join('')}</select></label>${field('question', '验证问题', '验证 MCP Server')}</div>${area('arguments', '调用参数（JSON）', '{\n  "question": "验证 MCP Server"\n}', 'rows="7" class="code" required')}<p class="editor-feedback" id="mcp-verify-feedback" role="status"></p><div class="form-actions"><button class="action-btn" type="submit">发起调用验证</button></div></form><div id="mcp-verify-events" class="mcp-event-log" hidden></div><pre id="mcp-verify-result" class="mcp-verify-result" hidden></pre></section>`;
  const form = $('#mcp-verify-form');
  const tool = form.elements.tool;
  const question = form.elements.question;
  const argumentsField = form.elements.arguments;
  const syncArguments = () => {
    try {
      const value = JSON.parse(argumentsField.value);
      if (value && typeof value === 'object' && !Array.isArray(value) && 'question' in value) value.question = question.value;
      argumentsField.value = JSON.stringify(value, null, 2);
    } catch { /* bindForm reports malformed JSON on submit */ }
  };
  question.oninput = syncArguments;
  tool.onchange = () => { if (tool.value === 'query') question.value = '验证 MCP Server（仅用于连通性验证）'; syncArguments(); };
  bindForm(form, async currentForm => {
    let args;
    try { args = JSON.parse(new FormData(currentForm).get('arguments')); } catch { throw new Error('调用参数需要有效 JSON'); }
    if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('调用参数必须是 JSON 对象');
    const eventLog = $('#mcp-verify-events'); eventLog.hidden = false; eventLog.replaceChildren();
    const result = await runMcpVerification(new FormData(currentForm).get('tool'), args, event => {
      const item = document.createElement('article'); item.className = 'mcp-event';
      const kind = document.createElement('b'); kind.textContent = event.event;
      const payload = document.createElement('pre'); payload.textContent = typeof event.data === 'string' ? event.data : JSON.stringify(event.data, null, 2);
      item.append(kind, payload); eventLog.append(item); eventLog.scrollTop = eventLog.scrollHeight;
    });
    const output = $('#mcp-verify-result'); output.hidden = false; output.textContent = JSON.stringify(result, null, 2);
    const message = $('#mcp-verify-feedback'); message.textContent = result.ok ? 'MCP 调用成功，服务端工具链可用。' : 'MCP 请求已到达服务端，但工具调用失败，请查看返回详情。';
    message.classList.toggle('error', !result.ok); feedback(result.ok ? 'MCP 调用验证成功。' : 'MCP 调用返回错误。', !result.ok);
  });
}
function renderModels(root) {
  const items = [...models.models].sort((a, b) => Number(b.key === models.defaultModelKey) - Number(a.key === models.defaultModelKey));
  root.innerHTML = header('模型管理', '配置当前 Agent 使用的模型与 API Key。', true) + items.map((model, i) => `<form class="form-card model-form" ${i === 0 ? 'id="model-form"' : ''} data-model-key="${esc(model.key)}"><h3>${esc(model.displayName)}${model.key === models.defaultModelKey ? ' · 默认模型' : ''}</h3><fieldset>${modelFields(model)}</fieldset>${actions('保存模型配置')}</form>`).join('');
  $('#add-record').onclick = () => {
    modal('新增模型', modelFields(), async data => { models = await request('models', modelPayload(data)); });
    wireModelForm($('#editor-form'));
  };
  root.querySelectorAll('.model-form').forEach(form => bindForm(form, async () => {
    models = await request('models', modelPayload(new FormData(form), form.dataset.modelKey));
    await show('model'); feedback('模型配置已保存，将用于下一次分析。');
  }));
  root.querySelectorAll('.model-form').forEach(form => wireModelForm(form, models.models.find(m => m.key === form.dataset.modelKey)));
  root.querySelectorAll('[data-remove-model]').forEach(button => { button.onclick = () => modal('删除模型', `<p>确认删除此模型？</p>`, async () => { models = await request('models', { revision: models.revision, key: button.dataset.removeModel, remove: true }); }); });
}
function modelFields(model = {}) {
  const select = (name, label, entries, value) => `<label>${label}<select name="${name}">${entries.map(entry => `<option value="${esc(entry.value)}" ${entry.value === value ? 'selected' : ''}>${esc(entry.label)}</option>`).join('')}</select></label>`;
  const provider = modelSchema.providers.find(p => p.id === model.kind) ?? modelSchema.providers[0];
  const defaults = { reasoning: 'provider-default', contextWindowTokens: 128000, maxOutputTokens: 8192, reasoningVisibility: 'visible' };
  const control = key => {
    const spec = modelSchema.fields.find(field => field.key === key);
    const value = model[key] ?? defaults[key] ?? '';
    return spec.type === 'select' ? select(key, spec.label, spec.options, value)
      : field(key, spec.label, value, 'number', `min="${spec.min}" max="${spec.max}" step="${spec.step}" ${key === 'temperature' ? 'placeholder="服务默认"' : 'required'}`);
  };
  return `<div class="field-grid">${field('displayName', '展示名称', model.displayName || '', 'text', 'required')}${field('providerModel', '服务模型 ID', model.providerModel || '', 'text', 'required')}${field('baseUrl', 'Base URL', model.baseUrl || provider.baseUrl, 'url', 'required')}${field('apiKey', model.apiKeyConfigured ? 'API Key（已配置，留空保持不变）' : 'API Key', '', 'password', 'autocomplete="new-password"')}</div><div class="field-grid">${select('kind', '接入服务', modelSchema.providers.map(p => ({ value: p.id, label: p.label })), provider.id)}${select('protocol', '调用协议', provider.protocols.map(p => ({ value: p, label: p })), model.protocol || provider.defaultProtocol)}</div><div class="field-grid">${control('temperature')}${control('reasoning')}${control('contextWindowTokens')}${control('maxOutputTokens')}</div><p class="form-hint">思考强度由所选模型服务转换，百炼托管的模型请选择百炼接入服务。</p><details><summary>高级参数</summary>${area('providerOptions', '服务商 SDK 扩展参数（JSON）', JSON.stringify(model.providerOptions || {}, null, 2), 'class="code" rows="4"')}<p class="form-hint">显式 SDK 思考选项优先于统一思考强度。思考过程展示仅影响界面，不会关闭思考。</p>${control('reasoningVisibility')}</details><label class="check"><input type="checkbox" name="isDefault" ${!model.key || model.key === models.defaultModelKey ? 'checked' : ''}> 设为默认模型</label><p class="form-hint">密钥仅保存在服务端。更换接入服务或地址时请重新填写密钥。</p>${model.key && model.key !== models.defaultModelKey ? `<button class="secondary-btn" type="button" data-remove-model="${esc(model.key)}">删除此模型</button>` : ''}`;
}
function wireModelForm(form, model = {}) {
  const credentials = () => { form.elements.apiKey.required = !model.apiKeyConfigured || form.elements.kind.value !== model.kind || form.elements.baseUrl.value !== model.baseUrl; };
  form.elements.kind.onchange = () => {
    const provider = modelSchema.providers.find(p => p.id === form.elements.kind.value);
    form.elements.protocol.innerHTML = provider.protocols.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    form.elements.protocol.value = provider.defaultProtocol;
    form.elements.baseUrl.value = provider.baseUrl;
    form.elements.providerOptions.value = '{}';
    credentials();
  };
  form.elements.baseUrl.oninput = credentials;
  credentials();
}
function modelPayload(data, key) {
  let providerOptions;
  try { providerOptions = JSON.parse(data.get('providerOptions')); } catch { throw new Error('服务商扩展参数需要有效 JSON'); }
  if (!providerOptions || Array.isArray(providerOptions) || typeof providerOptions !== 'object') throw new Error('SDK 扩展参数必须为 JSON 对象');
  if (Object.keys(providerOptions).some(key => modelSchema.reservedProviderOptions.includes(key))) throw new Error('SDK 扩展参数不能覆盖连接、消息、工具和通用字段');
  return { revision: models.revision, ...(key ? { key } : {}), ...Object.fromEntries(data), providerOptions,
    temperature: data.get('temperature') === '' ? null : Number(data.get('temperature')),
    contextWindowTokens: Number(data.get('contextWindowTokens')), maxOutputTokens: Number(data.get('maxOutputTokens')), isDefault: data.has('isDefault') };
}
function renderCases(root) {
  root.innerHTML = header('案例问题', '维护当前 Agent 的提问示例，每行填写一个问题。') + `<form id="cases-form" class="form-card">${area('questions', '案例问题', (catalog.sample_questions || []).map(q => q.question).join('\n'), 'rows="15"')}${actions('保存案例')}</form>`;
  bindForm($('#cases-form'), async form => {
    const existing = new Map((catalog.sample_questions || []).map(q => [q.question, q]));
    await saveChanges({ sample_questions: lines(new FormData(form).get('questions')).map(question => existing.get(question) || { category: '自定义案例', question }) });
    feedback('案例已保存，将显示在分析工作台。');
  });
}
function renderRecords(root, panel) {
  if (panel === 'semantic_objects') return renderSemanticObjects(root);
  const descriptions = { tables: '展示数据库中的授权实体表，维护字段说明、值域与业务知识。', metrics: '为模型提供可复用的指标表达式与通用属性。', terms: '维护人员可读的业务术语、含义、别名和证据；语义图中的 term 节点由这里自动投影。', skills: '维护供 data-analysis 使用的专业分析提示。', semantic_objects: '维护来源绑定的可执行对象定义；系统自动生成 ID、类型、层级和父对象。', relationships: '维护来源之间或对象之间的显式关系。关系谓词、基数和证据都属于目录数据。', period_formats: '维护同一来源字段的时间格式、粒度、选择条件与证据。探查样本保持 observed_only，不会成为全局定义。', semantic_gaps: '维护定义缺口、阻塞状态与证据；缺口不能通过删除绑定绕过。' };
  const records = catalog[panel] || [];
  root.innerHTML = header(labels[panel], descriptions[panel], panel !== 'tables') + (panel === 'tables' ? '<form class="knowledge-search" id="search-form"><input name="query" aria-label="检索表知识" placeholder="输入业务问题，检索相关数据表与业务知识" required><button class="secondary-btn">检索比对</button><button class="secondary-btn" id="clear-search" type="button">全部</button></form>' : '') + `<div class="record-list">${records.length ? records.map((record, index) => `<article class="record" data-record="${index}"><div class="record-main"><b>${esc(record.label || record.name || record.term || record.object_id || record.id || record.kind)}</b><small>${esc(record.description || record.meaning || record.expression || record.prompt || record.predicate || '')}</small><div class="record-tags">${(record.tags || record.aliases || record.labels || record.columns || []).slice(0, 8).map(tag => `<span class="tag">${esc(typeof tag === 'string' ? tag : tag.name)}</span>`).join('')}</div>${panel === 'tables' ? understanding(record.name) : ''}</div><div class="record-actions"><button data-edit="${index}">编辑</button>${panel === 'tables' ? `<button data-knowledge="${index}">编辑表知识</button>` : `<button class="danger" data-delete="${index}">删除</button>`}</div></article>`).join('') : '<div class="empty-record">还没有配置记录</div>'}</div>`;
  if ($('#add-record')) $('#add-record').onclick = () => editRecord(panel);
  root.querySelectorAll('[data-edit]').forEach(button => { button.onclick = () => panel === 'tables' ? editTable(Number(button.dataset.edit)) : editRecord(panel, Number(button.dataset.edit)); });
  root.querySelectorAll('[data-knowledge]').forEach(button => { button.onclick = () => editKnowledge(Number(button.dataset.knowledge)); });
  root.querySelectorAll('[data-delete]').forEach(button => { button.onclick = () => {
    const index = Number(button.dataset.delete);
    modal(`删除${labels[panel]}`, `<p>确认删除 ${esc(records[index].label || records[index].name || records[index].term)}？</p>`, async () => { await saveChanges({ [panel]: records.filter((_, i) => i !== index) }); });
  }; });
  if ($('#search-form')) {
    $('#clear-search').onclick = () => renderRecords(root, panel);
    $('#search-form').onsubmit = async event => {
      event.preventDefault();
      try {
        const result = await request('search?query=' + encodeURIComponent(new FormData(event.currentTarget).get('query')));
        const matches = result.tables.filter(t => t.score > 0).map(t => t.source_id);
        root.querySelectorAll('[data-record]').forEach(node => { node.hidden = !matches.includes(records[Number(node.dataset.record)].name); });
        feedback(matches.length ? `找到 ${matches.length} 张相关表。` : '暂无匹配线索，请尝试其他业务词。');
      } catch (error) { feedback(error.message, true); }
    };
  }
}
function renderSemanticObjects(root) {
  const records = catalog.entities || [];
  const projectionCounts = (catalog.semantic_objects || []).reduce((counts, row) => { const layer = row.layer || row.kind || 'other'; counts[layer] = (counts[layer] || 0) + 1; return counts; }, {});
  const layerPanels = { source: 'tables', object: 'semantic_objects', attribute: 'tables', measure: 'metrics', time: 'period_formats', term: 'terms', relation: 'relationships' };
  const layerLabels = { source: '来源', object: '对象', attribute: '属性', measure: '度量', time: '期间', term: '术语', relation: '关系' };
  const projection = Object.entries(projectionCounts).map(([layer, count]) => `<button type="button" class="semantic-layer-chip projection" data-layer-panel="${esc(layerPanels[layer] || 'semantic_objects')}" title="查看${esc(layerLabels[layer] || layer)}定义"><b>${count}</b><span>${esc(layerLabels[layer] || layer)}投影</span></button>`).join('');
  root.innerHTML = header('语义对象定义', '人员维护可筛选对象的名称、来源字段和适用范围；对象 ID、类型、层级和父对象由系统自动生成。', true) + `<div class="semantic-layer-summary"><button type="button" class="semantic-layer-chip" data-layer-panel="semantic_objects"><b>${records.length}</b><span>可维护对象</span></button>${projection}</div><div class="form-hint"><b>维护边界：</b>“业务术语”维护自然语言定义；这里维护可执行对象与物理字段绑定。语义图中的 source / measure / time / term 节点都是系统投影，请到数据表、指标、时间格式或业务术语面板修改。</div><div class="record-list">${records.length ? records.map((record, index) => `<article class="record" data-record="${index}"><div class="record-main"><b>${esc(record.label || record.id)}</b><small>${esc(`${record.source_id} · 编码字段：${record.key_field} · 名称字段：${(record.name_fields || []).join('、')}`)}</small><div class="record-tags">${[record.status, ...(record.recall_terms || []), ...Object.keys(record.aliases || {})].filter(Boolean).slice(0, 8).map(tag => `<span class="tag">${esc(tag)}</span>`).join('')}</div><small>${esc(record.description || '尚未填写对象说明')}</small></div><div class="record-actions"><button data-edit="${index}">编辑定义</button><button data-retire="${index}">停用</button></div></article>`).join('') : '<div class="empty-record">还没有对象定义，请新增一个可筛选对象。</div>'}</div>`;
  root.querySelectorAll('[data-layer-panel]').forEach(button => { button.onclick = () => { const panel = button.dataset.layerPanel; location.hash = panel; if (current === panel) void show(panel); }; });
  $('#add-record').onclick = () => editEntityDefinition();
  root.querySelectorAll('[data-edit]').forEach(button => { button.onclick = () => editEntityDefinition(Number(button.dataset.edit)); });
  root.querySelectorAll('[data-retire]').forEach(button => { button.onclick = () => { const index = Number(button.dataset.retire); const next = structuredClone(records); next[index] = { ...next[index], status: 'stale' }; modal('停用语义对象', `<p>停用后对象定义和历史证据会保留，后续查询不再把它作为当前对象使用。</p>`, async () => { await saveChanges({ entities: next }); }); }; });
}
function understanding(source) {
  const summary = catalog.table_summaries?.find(s => s.source_id === source);
  if (!summary) return '<small>尚未维护表知识档案</small>';
  return `<details class="table-understanding"><summary>表知识档案 · ${esc(summary.business_domain || source)}</summary><p>${esc(summary.purpose)}</p><p><b>一行含义</b> ${esc(summary.record_semantics)}</p><p><b>业务粒度</b> ${esc((summary.row_grain || []).join(' × '))}</p><p><b>适用问题</b> ${esc((summary.query_scenarios || []).join('；'))}</p><pre>${esc(JSON.stringify(summary, null, 2))}</pre></details>`;
}
function lines(value) { return String(value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean); }
function entityId(source, key, scopeField = '') { return source && key ? `entity:${source}:${key}${scopeField ? `:scope:${scopeField}` : ''}` : ''; }
function entitySelect(name, label, entries, selected, extra = '') {
  return `<label>${esc(label)}<select name="${esc(name)}" ${extra}>${entries.map(entry => `<option value="${esc(entry.value)}" ${entry.selected || entry.value === selected ? 'selected' : ''}>${esc(entry.label)}</option>`).join('')}</select></label>`;
}
function entityDefinitionFields(prior = {}) {
  const tables = catalog.tables || [];
  const source = prior.source_id || tables[0]?.name || '';
  const table = tables.find(item => item.name === source) || tables[0] || { columns: [] };
  const columns = table.columns || [];
  const selectedNames = new Set(prior.name_fields || []);
  const columnEntries = columns.map(column => ({ value: column.name, label: `${column.label || column.name} · ${column.name}` }));
  const scopeField = prior.scope_filter?.field || '';
  const aliases = Object.keys(prior.aliases || {});
  return `<p class="form-hint"><b>填写说明：</b>先选择数据来源，再选择真实的编码字段和名称字段。对象 ID、通用类型、层级和父对象会自动生成；“人、组织、账套、基地”等业务词填写在对象名称、别名和召回词中。</p>${field('label', '对象名称', prior.label, 'text', 'required placeholder="例如：统计组织"')}${area('description', '对象说明', prior.description || '', 'rows="3" placeholder="说明这个对象在当前来源中代表什么，以及不适用哪些口径"')}<div class="field-grid">${entitySelect('source_id', '数据来源', tables.map(item => ({ value: item.name, label: `${item.label || item.name} · ${item.name}` })), source, 'required')}${entitySelect('key_field', '编码字段', columnEntries, prior.key_field, 'required')}</div><label>名称字段<select name="name_fields" multiple size="4" required>${columnEntries.map(entry => `<option value="${esc(entry.value)}" ${selectedNames.has(entry.value) ? 'selected' : ''}>${esc(entry.label)}</option>`).join('')}</select><small class="form-hint">按住 Command/Ctrl 可选择多个名称字段，查询会按精确名称查证。</small></label><div class="field-grid">${entitySelect('scope_field', '适用范围字段（可选）', [{ value: '', label: '整张来源表' }, ...columnEntries], scopeField)}${entitySelect('status', '状态', [{ value: 'confirmed', label: '已确认' }, { value: 'provisional', label: '待确认' }, { value: 'unresolved', label: '未解决' }, { value: 'stale', label: '已过期' }], prior.status || 'provisional')}</div>${area('scope_patterns', '适用范围值（每行一项）', (prior.scope_filter?.patterns || []).join('\n'), 'rows="3" placeholder="只有选择适用范围字段时填写，例如：%制造基地%"')}${entitySelect('semantic_role', '对象角色', [{ value: 'dimension', label: '维度对象（可筛选）' }, { value: 'hierarchy', label: '层级对象' }, { value: 'value_set', label: '值集对象' }, { value: 'reference', label: '引用对象' }], prior.semantic_role || 'dimension')}${area('aliases', '别名（每行一项）', aliases.join('\n'), 'rows="3" placeholder="例如：组织、统计组织"')}${area('recall_terms', '召回词（每行一项）', (prior.recall_terms || []).join('\n'), 'rows="3" placeholder="用于检索命中的自然语言表达"')}${area('evidence', '证据（每行一项）', (prior.evidence || []).join('\n'), 'rows="3"')}${field('system_id', '系统标识（自动生成）', entityId(source, prior.key_field || columns[0]?.name || '', scopeField), 'text', 'readonly')}${area('advanced', '高级 JSON（可选，仅补充扩展字段）', JSON.stringify(prior, null, 2), 'class="json-field" rows="8"')}`;
}
function wireEntityDefinitionForm(form, prior = {}) {
  const source = form.elements.source_id;
  const key = form.elements.key_field;
  const names = form.elements.name_fields;
  const scope = form.elements.scope_field;
  const refresh = () => {
    const table = (catalog.tables || []).find(item => item.name === source.value) || { columns: [] };
    const entries = table.columns || [];
    const selectedKey = key.value || prior.key_field || entries[0]?.name || '';
    const selectedNames = new Set([...names.selectedOptions].map(option => option.value));
    if (!selectedNames.size) (prior.name_fields || []).forEach(value => selectedNames.add(value));
    const selectedScope = scope.value || prior.scope_filter?.field || '';
    const options = entries.map(column => `<option value="${esc(column.name)}">${esc(`${column.label || column.name} · ${column.name}`)}</option>`).join('');
    key.innerHTML = options; key.value = entries.some(column => column.name === selectedKey) ? selectedKey : entries[0]?.name || '';
    names.innerHTML = options; [...names.options].forEach(option => { option.selected = selectedNames.has(option.value); });
    scope.innerHTML = `<option value="">整张来源表</option>${options}`; scope.value = entries.some(column => column.name === selectedScope) ? selectedScope : '';
    form.elements.system_id.value = entityId(source.value, key.value, scope.value);
  };
  source.onchange = refresh; key.onchange = refresh; scope.onchange = refresh; refresh();
}
function editEntityDefinition(index) {
  const prior = index == null ? {} : (catalog.entities || [])[index];
  modal(`${index == null ? '新增' : '编辑'}语义对象定义`, entityDefinitionFields(prior), async data => {
    let base = prior;
    if (data.has('advanced')) {
      try { base = JSON.parse(data.get('advanced') || '{}'); } catch { throw new Error('高级 JSON 需要有效对象'); }
      if (!base || Array.isArray(base) || typeof base !== 'object') throw new Error('高级 JSON 必须是对象');
    }
    const source = String(data.get('source_id') || '').trim();
    const keyField = String(data.get('key_field') || '').trim();
    const nameFields = data.getAll('name_fields').map(value => String(value).trim()).filter(Boolean);
    const scopeField = String(data.get('scope_field') || '').trim();
    if (!source || !keyField || !nameFields.length) throw new Error('请选择来源、编码字段和至少一个名称字段');
    const patterns = lines(data.get('scope_patterns'));
    if (scopeField && !patterns.length) throw new Error('选择适用范围字段后，请填写至少一个适用范围值');
    const aliasValues = lines(data.get('aliases'));
    const entity = { ...base, label: String(data.get('label') || '').trim(), description: String(data.get('description') || '').trim(), source_id: source, key_field: keyField, name_fields: nameFields, semantic_role: String(data.get('semantic_role') || 'dimension'), status: String(data.get('status') || 'provisional'), id: entityId(source, keyField, scopeField), aliases: Object.fromEntries(aliasValues.map(value => [value, []])), recall_terms: lines(data.get('recall_terms')), evidence: lines(data.get('evidence')) };
    if (!entity.label) throw new Error('请填写对象名称');
    if (scopeField) entity.scope_filter = { field: scopeField, operator: 'like_any', patterns };
    else delete entity.scope_filter;
    const next = structuredClone(catalog.entities || []); if (index == null) next.push(entity); else next[index] = entity;
    await saveChanges({ entities: next });
  });
  wireEntityDefinitionForm($('#editor-form'), prior);
}
function editRecord(panel, index) {
  if (panel === 'semantic_objects') return editEntityDefinition(index);
  const prior = index == null ? {} : catalog[panel][index];
  let fields;
  if (panel === 'metrics') fields = `<div class="field-grid">${field('name', '指标名称', prior.name, 'text', 'required')}${field('label', '展示名称', prior.label, 'text', 'required')}</div>${field('expression', 'SQL 表达式', prior.expression, 'text', 'required')}<label>所属数据表<select name="table" required>${catalog.tables.map(t => `<option value="${esc(t.name)}" ${prior.table === t.name ? 'selected' : ''}>${esc(t.label || t.name)} · ${esc(t.name)}</option>`).join('')}</select></label><div class="field-grid">${field('measure_kind', '度量类型', prior.measure_kind)}${field('observation_type', '观测类型', prior.observation_type)}${field('frequency', '频率', prior.frequency)}${field('aggregation', '聚合方式', prior.aggregation)}${field('unit', '单位', prior.unit)}${field('time_field', '时间字段', prior.time_field)}${field('time_format', '时间格式', prior.time_format)}</div>${area('grain', '粒度字段（每行一项）', (prior.grain || []).join('\n'), 'rows="3"')}${area('description', '说明', prior.description)}`;
  if (panel === 'terms') fields = `<p class="form-hint"><b>维护边界：</b>这里的“业务术语”就是人员维护的自然语言定义入口；语义图中的 <code>term</code> 节点由系统自动投影，不能在“语义对象”面板单独编辑。只有明确选择来源时才建立来源绑定，留空表示跨来源术语。</p><div class="field-grid">${field('term', '业务术语', prior.term, 'text', 'required')}<label>来源（可选）<select name="source_id"><option value="">跨来源 / 未绑定</option>${(catalog.tables || []).map(t => `<option value="${esc(t.name)}" ${prior.source_id === t.name ? 'selected' : ''}>${esc(t.label || t.name)} · ${esc(t.name)}</option>`).join('')}</select></label></div>${area('aliases', '别名（每行一项）', (prior.aliases || []).join('\n'), 'rows="3" placeholder="一个自然语言叫法一行"')}${area('meaning', '业务含义', prior.meaning, 'required rows="4"')}${area('evidence_ids', '定义证据（每行一项）', (prior.evidence_ids || prior.evidence || []).join('\n'), 'rows="3" placeholder="目录记录、人工确认或探查证据引用"')}<div class="field-grid">${entitySelect('status', '状态', [{ value: 'confirmed', label: '已确认' }, { value: 'provisional', label: '待确认' }, { value: 'unresolved', label: '未解决' }, { value: 'stale', label: '已过期' }], prior.status || 'provisional')}</div>`;
  if (panel === 'skills') fields = `<div class="field-grid">${field('id', 'Skill ID', prior.id, 'text', 'required')}${field('name', '名称', prior.name, 'text', 'required')}</div>${field('description', '适用场景说明', prior.description)}${field('tags', '领域匹配标签（逗号分隔）', (prior.tags || []).join(','))}${area('prompt', '专业分析提示', prior.prompt, 'required rows="10"')}`;
  if (panel === 'relationships') fields = `<p class="form-hint">关系只表示有证据支持的连接。predicate、cardinality、subject、object 和 evidence 使用当前来源的实际定义。</p><div class="field-grid">${field('id', '关系 ID', prior.id, 'text', 'required')}${field('predicate', '关系谓词', prior.predicate || prior.relation, 'text', 'required')}${field('cardinality', '基数', prior.cardinality, 'text')}</div>${area('left', '左端 JSON', JSON.stringify(prior.left || prior.subject || {}, null, 2), 'class="json-field" rows="5"')}${area('right', '右端 JSON', JSON.stringify(prior.right || prior.object || {}, null, 2), 'class="json-field" rows="5"')}${area('evidence', '证据（每行一项）', (prior.evidence || []).join('\n'), 'rows="3"')}<details><summary>高级 JSON（可选）</summary>${area('advanced', '语义关系 JSON', JSON.stringify(prior, null, 2), 'class="json-field" rows="10"')}</details>`;
  if (panel === 'period_formats') fields = `<div class="field-grid"><label>来源<select name="source_id" required>${catalog.tables.map(t => `<option value="${esc(t.name)}" ${prior.source_id === t.name ? 'selected' : ''}>${esc(t.label || t.name)} · ${esc(t.name)}</option>`).join('')}</select></label>${field('variant_id', '变体 ID', prior.variant_id, 'text', 'required')}${field('field', '物理字段', prior.field, 'text', 'required')}${field('format', '格式', prior.format, 'text', 'required')}${field('granularity', '粒度', prior.granularity, 'text', 'required')}${field('status', '状态', prior.status || prior.definition_status || 'confirmed')}</div>${area('selector', '选择条件 JSON（绑定真实字段和值）', JSON.stringify(prior.selector || {}, null, 2), 'class="json-field" rows="5"')}${area('evidence', '证据（每行一项）', (prior.evidence || []).join('\n'), 'rows="3"')}`;
  if (panel === 'semantic_gaps') fields = `<div class="field-grid">${field('gap_id', '缺口 ID', prior.gap_id, 'text', 'required')}${field('code', '缺口代码', prior.code, 'text', 'required')}${field('term', '触发术语', prior.term, 'text')}${field('status', '状态', prior.status || 'unresolved')}${field('blocking', '阻塞（true/false）', String(prior.blocking ?? true))}</div>${area('trigger_terms', '触发词（每行一项）', (prior.trigger_terms || []).join('\n'), 'rows="3"')}${area('meaning', '含义', prior.meaning, 'required')}${area('source_ids', '来源（每行一项）', (prior.source_ids || []).join('\n'), 'rows="3"')}${area('affected_refs', '影响定义（每行一项）', (prior.affected_refs || []).join('\n'), 'rows="3"')}${area('evidence', '证据（每行一项）', (prior.evidence || []).join('\n'), 'rows="3"')}`;
  if (!['semantic_objects', 'relationships', 'period_formats', 'semantic_gaps'].includes(panel) && Object.keys(prior).some(key => !['name', 'label', 'expression', 'table', 'description', 'term', 'aliases', 'meaning', 'id', 'tags', 'prompt', 'measure_kind', 'observation_type', 'frequency', 'aggregation', 'unit', 'time_field', 'time_format', 'grain'].includes(key))) fields += `<details><summary>完整定义（保留来源、证据及高级口径）</summary>${area('advanced', 'JSON 定义', JSON.stringify(prior, null, 2), 'class="json-field"')}</details>`;
  modal(`${index == null ? '新增' : '编辑'}${labels[panel]}`, fields, async data => {
    let base = prior;
    if (data.has('advanced')) { try { base = JSON.parse(data.get('advanced')); } catch { throw new Error('完整定义需要有效 JSON'); } if (!base || Array.isArray(base) || typeof base !== 'object') throw new Error('完整定义必须为 JSON 对象'); }
    const value = { ...base, ...Object.fromEntries([...data.entries()].filter(([key]) => key !== 'advanced')) };
    for (const key of ['aliases', 'tags']) if (key in value && data.has(key)) value[key] = String(data.get(key)).split(/[,，]/).map(s => s.trim()).filter(Boolean);
    if (panel === 'metrics' && data.has('grain')) value.grain = lines(data.get('grain'));
    if (panel === 'terms') {
      value.aliases = lines(data.get('aliases'));
      value.evidence_ids = lines(data.get('evidence_ids'));
      value.status = String(data.get('status') || 'provisional');
      if (String(data.get('source_id') || '').trim()) value.source_id = String(data.get('source_id')).trim();
      else delete value.source_id;
    }
    if (panel === 'relationships') { try { if (data.has('left')) value.left = JSON.parse(data.get('left') || '{}'); if (data.has('right')) value.right = JSON.parse(data.get('right') || '{}'); } catch { throw new Error('关系端点需要有效 JSON'); } value.predicate = String(data.get('predicate') || value.predicate || '').trim(); value.evidence = lines(data.get('evidence')); }
    if (panel === 'period_formats') { try { value.selector = JSON.parse(data.get('selector') || '{}'); } catch { throw new Error('选择条件需要有效 JSON'); } value.evidence = lines(data.get('evidence')); }
    if (panel === 'semantic_gaps') { value.trigger_terms = lines(data.get('trigger_terms')); value.source_ids = lines(data.get('source_ids')); value.affected_refs = lines(data.get('affected_refs')); value.evidence = lines(data.get('evidence')); value.blocking = String(data.get('blocking')).toLowerCase() === 'true'; }
    const next = structuredClone(catalog[panel] || []); if (index == null) next.push(value); else next[index] = value;
    await saveChanges({ [panel]: next });
  });
}
function editTable(index) {
  const table = catalog.tables[index];
  const fields = `<div class="field-grid">${field('name', '英文表名', table.name, 'text', 'readonly')}${field('label', '中文表名', table.label)}</div>${area('description', '表说明', table.description)}<p class="form-hint">英文名、物理类型和长度来自数据库。存储格式属于字段定义：字符串日期请明确填写 YYYYMMDD、YYYY-MM-DD 等；留空表示尚未确认，需探查后再绑定期间。值域与编码含义用于分析理解；字段输出设置不代替数据库访问权限。</p><div class="table-scroll"><table class="table-fields"><thead><tr><th>英文名 / 类型</th><th>中文名</th><th>存储格式</th><th>粒度</th><th>值域与编码含义</th><th>字段说明</th><th>结果字段</th></tr></thead><tbody>${table.columns.map((column, i) => `<tr><td><code>${esc(column.name)}</code><code class="type">${esc(column.type)}</code></td><td><input name="label_${i}" aria-label="${esc(column.name)} 中文名" value="${esc(column.label)}"></td><td><input name="format_${i}" aria-label="${esc(column.name)} 存储格式" placeholder="YYYYMMDD / YYYY-MM-DD" value="${esc(column.format || '')}">${column.format_status ? `<small class="form-hint">${esc(column.format_status === 'ambiguous' ? '格式冲突，待确认' : column.format_status)}</small>` : ''}</td><td><input name="granularity_${i}" aria-label="${esc(column.name)} 时间粒度" placeholder="day / month / year" value="${esc(column.granularity || '')}"></td><td><textarea name="domain_${i}" aria-label="${esc(column.name)} 值域">${esc(column.value_domain)}</textarea></td><td><input name="description_${i}" aria-label="${esc(column.name)} 字段说明" value="${esc(column.description)}"></td><td><input type="checkbox" name="output_${i}" aria-label="${esc(column.name)} 允许输出" ${column.allow_output !== false ? 'checked' : ''}></td></tr>`).join('')}</tbody></table></div>`;
  modal('编辑数据表', fields, async data => {
    const next = structuredClone(catalog.tables);
    next[index] = { ...table, label: data.get('label'), description: data.get('description'), columns: table.columns.map((column, i) => ({ ...column, label: data.get(`label_${i}`), format: data.get(`format_${i}`), granularity: data.get(`granularity_${i}`), format_status: data.get(`format_${i}`) ? 'confirmed' : column.format_status, format_observed_shapes: data.get(`format_${i}`) ? undefined : column.format_observed_shapes, description: data.get(`description_${i}`), value_domain: data.get(`domain_${i}`), allow_output: data.has(`output_${i}`) })) };
    await saveChanges({ tables: next });
  });
}
function editKnowledge(index) {
  const table = catalog.tables[index], prior = catalog.table_summaries?.find(s => s.source_id === table.name) || { source_id: table.name };
  const definitions = [['business_domain', '业务领域'], ['purpose', '业务主题'], ['record_semantics', '一行含义'], ['business_objects', '业务对象', true], ['business_terms', '检索词', true], ['row_grain', '业务粒度（真实字段名）', true], ['time_semantics', '时间口径'], ['entity_semantics', '组织口径'], ['query_scenarios', '适用问题', true], ['retrieval_hints', '检索线索', true], ['not_suitable_for', '不适用范围', true], ['limitations', '待确认与数据疑点', true]];
  modal(`编辑表知识 · ${table.label || table.name}`, '<p class="form-hint">列表每行填写一项。修改业务粒度后，需要重新核实唯一性。</p>' + definitions.map(([key, label, list]) => area(key, label + (list ? '（每行一项）' : ''), list ? (prior[key] || []).join('\n') : prior[key], 'rows="2"')).join(''), async data => {
    const summary = { ...prior, ...Object.fromEntries(definitions.map(([key, , list]) => [key, list ? lines(data.get(key)) : String(data.get(key)).trim()])), provenance: { ...prior.provenance, kind: 'manual', updated_at: new Date().toISOString() } };
    const next = structuredClone(catalog.table_summaries || []), at = next.findIndex(s => s.source_id === table.name);
    if (at < 0) next.push(summary); else next[at] = summary;
    await saveChanges({ table_summaries: next });
  });
}
document.querySelectorAll('[data-panel]').forEach(button => { button.onclick = () => { if (!saving) { location.hash = button.dataset.panel; if (current === button.dataset.panel) void show(current); } }; });
window.addEventListener('hashchange', () => { if (!saving) void show(location.hash.slice(1)); });
await show(location.hash.slice(1) || 'connection');
void request('catalog').then(value => { if (!catalog) { catalog = value; counts(); } }).catch(() => {});
