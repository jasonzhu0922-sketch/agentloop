import { installModelSettings } from './model-settings.js';
const RUNTIME_ICONS = [
  ['xuanwu', '玄武', '沉稳守护'], ['qinglong', '青龙', '生发探索'], ['baihu', '白虎', '迅捷执行'], ['zhuque', '朱雀', '创意表达'],
  ['qilin', '麒麟', '温和协作'], ['taotie', '饕餮', '深度吞吐'], ['yinglong', '应龙', '破局开拓'], ['pixiu', '貔貅', '聚势守财'],
].map(([key, name, description]) => ({ key, name, description }));
const RUNTIME_ICON_ASSETS = Object.freeze({ xuanwu: 'xuanwu-mascot-icon.png', qinglong: 'runtime-qinglong.png', baihu: 'runtime-baihu.png', zhuque: 'runtime-zhuque.png', qilin: 'runtime-qilin.png', taotie: 'runtime-taotie.png', yinglong: 'runtime-yinglong.png', pixiu: 'runtime-pixiu.png' });
const runtimeIconUrl = key => `/assets/${RUNTIME_ICON_ASSETS[key] || RUNTIME_ICON_ASSETS.xuanwu}`;

// Desktop-owned presentation and transport. No cloud/Router management client.
export function installCapabilitySettings({ api, element, refreshModels, status, currentRuntime, refreshCapabilities }) {
  const models = installModelSettings({ api, element, refreshModels, status, managed: true });
  const dialog = element('model-settings'), body = element('capability-body');
  let tab = 'general', target, runtimeDetail, runtimeDetailMode = 'view', dirty = false, working = false, snapshot, runtimeList = [], packages = [], mcpCatalog = [];
  const labels = { general: ['常规', '管理当前账号的本机存储与 Memory 配置。'], 'web-search': ['联网搜索', '配置 websearch 工具使用的端点和凭据；配置按当前账号加密保存在本机。'], skills: ['Skill 管理', '上传和维护本机 Skill 包；安装后可在各个 Runtime 配置中分别选择。'], mcp: ['MCP 配置', '配置当前账号的 MCP Server，供所有本机 Runtime 使用。'], runtimes: ['子 Runtime 管理', '新增、停止、重启、删除和查看各个本机 Runtime；每个 Runtime 独立选择扩展 Skill，共享当前账号的 MCP。'], connectors: ['Connector 配置', '个人 Connector 只保存在 Desktop；配置凭据不会上传到云端。'] };
  const errors = { account_storage_outside_scope: '此目录不适用于当前账号，请选择其他目录。', runtime_must_be_stopped_for_configuration: '请先在 Runtime 页停止对应实例，再编辑配置。', runtime_active_runs_prevent_reconfiguration: '仍有活动任务，请等待任务结束。', runtime_configuration_stale: '配置已被其他页面修改，请重新读取后再编辑。', mcp_json_invalid: 'JSON 格式无效，请检查引号、括号和逗号。', mcp_credential_required: '缺少凭据；更换地址或认证目标后，必须重新填写。', mcp_server_key_duplicate: '当前账号的 MCP key 不能重复。', mcp_server_referenced_by_runtime: '该 MCP 已被一个或多个 Runtime 选择，不能删除。请先在对应 Runtime 中解除勾选。', connector_connection_not_authorized: '不能使用其他账号的 Connector 连接。', skill_import_invalid: 'Skill 包无效：请检查 SKILL.md、归档路径、文件类型和大小限制。', runtime_default_cannot_be_removed: '不能删除默认 Runtime。', web_search_api_key_required: 'Bocha 搜索需要 API Key。', web_search_endpoint_required: 'Bocha 搜索需要搜索端点。', web_search_endpoint_invalid: '搜索端点必须为 HTTP 或 HTTPS，且不能包含凭据、查询参数或片段。', web_search_provider_invalid: '搜索服务类型无效。', web_search_credentials_missing: '搜索凭据缺失，请重新填写 API Key。' };
  const connectorBindings = {
    '126-mail': {
      title: '绑定 126 邮箱', displayName: '我的 126 邮箱', scopes: ['email:search', 'email:read'],
      description: '126 暂未提供可供第三方应用使用的扫码 OAuth 授权流程。请在网页版邮箱设置中开启 IMAP，并生成客户端授权码；该授权码仅保存在这台设备的加密 Secret Store 中。',
      fields: [
        { key: 'email', label: '126 邮箱账号', type: 'email', autocomplete: 'username', placeholder: 'name@126.com' },
        { key: 'authorizationCode', label: '客户端授权码', type: 'password', autocomplete: 'new-password', placeholder: '粘贴授权码，不是网页登录密码' },
      ],
    },
  };
  const message = (text, error = false) => { const e = element('capability-status'); e.textContent = text; e.classList.toggle('error', error); };
  function el(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
  function button(text, fn, danger = false) { const e = el('button', text, danger ? 'danger' : ''); e.type = 'button'; e.onclick = () => void perform(fn); return e; }
  function input(value = '', type = 'text') { const e = el('input'); e.type = type; e.value = value; e.autocomplete = 'off'; e.spellcheck = false; return e; }
  function field(title, control) { const e = el('label', undefined, 'capability-field'); e.append(el('span', title), control); return e; }
  function jsonEditor(value, rows = 8) { const e = el('textarea', undefined, 'desktop-json'); e.value = JSON.stringify(value, null, 2); e.rows = rows; e.spellcheck = false; return e; }
  function cardInto(container, title, description) { const e = el('section', undefined, 'capability-card'); e.append(el('strong', title)); if (description) e.append(el('p', description)); container.append(e); return e; }
  function card(title, description) { return cardInto(body, title, description); }
  function canLeave() { if (working || dirty) { message(working ? '正在执行操作，请稍候。' : '有未保存更改，请先保存或重新读取。', true); return false; } return tab !== 'models' || models.canLeave(); }
  async function perform(fn) {
    if (working) return; working = true;
    // Never echo submitted JSON, credentials, paths, or upstream exception text.
    const controls = [...body.querySelectorAll('button,input,textarea,select')].filter(e => !e.disabled); controls.forEach(e => e.disabled = true);
    try { await fn(); }
    catch (error) { message(errors[error.message] ?? `操作未完成（${/^[a-z][a-z0-9_]{1,100}$/.test(error.message) ? error.message : '输入格式或服务错误'}）。请重新读取核对，不要重复提交。`, true); }
    finally { working = false; controls.forEach(e => { if (e.isConnected) e.disabled = false; }); }
  }
  function markDirty() { dirty = true; }
  body.addEventListener('input', markDirty);
  body.addEventListener('change', e => { if (!e.target.dataset.runtimePicker) markDirty(); });
  function reset() { dirty = false; body.querySelector('.runtime-detail-modal')?.remove(); body.replaceChildren(); snapshot = undefined; }
  async function changed() { await refreshCapabilities(); }
  async function load() {
    reset(); message('正在读取本机配置…');
    if (tab === 'mcp') mcpCatalog = (await api('/api/mcp')).servers;
    else [runtimeList, packages, mcpCatalog] = await Promise.all([api('/api/runtimes').then(r => r.runtimes), api('/api/skills').then(r => r.skills), api('/api/mcp').then(r => r.servers)]);
    if (!runtimeList.some(r => r.id === target)) target = currentRuntime() || runtimeList[0]?.id;
    if (tab === 'general') {
      await renderGeneral();
    } else if (tab === 'web-search') {
      await renderWebSearch();
    } else if (tab === 'runtimes') {
      if (runtimeDetail !== undefined && runtimeList.some(runtime => runtime.id === runtimeDetail)) {
        target = runtimeDetail;
        snapshot = await api(`/api/runtimes/${target}/configuration`);
      } else runtimeDetail = undefined;
    }
    if (tab === 'skills') await renderSkills();
    else if (tab === 'mcp') renderDeviceMcp();
    else if (tab === 'runtimes') renderRuntimes();
    else if (tab === 'connectors') await renderConnectors();
    if (tab !== 'general' && tab !== 'web-search' && tab !== 'runtimes' && tab !== 'mcp') body.append(button('放弃更改并重新读取', load));
    if (tab === 'runtimes' && runtimeDetail !== undefined) renderRuntimeDetail();
    dirty = false; message(tab === 'general' ? '当前账号配置已读取。' : '配置已读取。凭据不会回显；导入和保存不代表真实执行已验收。');
  }
  function detail(rows) {
    const list = el('dl', undefined, 'capability-details');
    for (const [term, value] of rows) { const definition = el('dd'); if (value instanceof Node) definition.append(value); else definition.textContent = value; list.append(el('dt', term), definition); }
    return list;
  }
  async function renderGeneral() {
    const [memoryResult, modelResult, storageResult] = await Promise.all([api('/api/memory-configuration'), api('/api/model-configuration'), api('/api/device-storage')]);
    const workspace = input(storageResult.storage.workspaceRoot); workspace.className = 'general-storage-input'; workspace.setAttribute('aria-label', '当前账号工作目录');
    const uploads = input(storageResult.storage.uploadStorageRoot); uploads.className = 'general-storage-input'; uploads.setAttribute('aria-label', '上传源文件目录');
    function directoryControl(control, kind, label) {
      control.readOnly = true;
      const row = el('div', undefined, 'general-storage-row');
      const edit = button('编辑', async () => {
        const result = await api('/api/device-storage/pick', { kind });
        if (result.path && result.path !== control.value) { control.value = result.path; markDirty(); message('已选择目录，请保存目录配置。'); }
      });
      edit.setAttribute('aria-label', `编辑${label}`); row.append(control, edit); return row;
    }
    body.append(detail([
      ['Agent', 'Desktop · 开发模式'],
      ['服务端', window.location.origin],
      ['当前账号工作目录', directoryControl(workspace, 'workspace', '当前账号工作目录')],
      ['上传源文件目录', directoryControl(uploads, 'uploads', '上传源文件目录')],
      ['Skill 模式', 'Runtime 启动时统一加载'],
    ]), el('p', '选择的目录下会为当前账号创建独立存储目录。保存后将在没有活动任务时重载本机 Runtime；原位置的数据不会自动迁移或删除。', 'general-storage-note'));
    const storageActions = el('div', undefined, 'capability-actions general-storage-actions');
    storageActions.append(button('放弃更改', async () => { dirty = false; await load(); }), button('保存目录配置', async () => {
      await api('/api/device-storage', { workspaceRoot: workspace.value, uploadStorageRoot: uploads.value });
      dirty = false; await load(); message('目录配置已保存，本机 Runtime 已重载。');
    })); storageActions.lastElementChild.classList.add('primary'); body.append(storageActions);
    const memory = memoryResult.memory;
    const options = modelResult.configuration.providers.flatMap(provider => provider.models.map(model => ({ key: `local:${model.key}`, label: `${model.displayName || model.key} · ${provider.displayName || provider.key}` })));
    const section = el('section', undefined, 'capability-card local-memory-section'); body.append(section);
    const state = el('span', memory.enabled ? '已启用' : '已关闭', `memory-state${memory.enabled ? ' enabled' : ''}`);
    const heading = el('div', undefined, 'settings-section-title'); heading.append(el('strong', 'Memory 偏好与隐私沉淀'), state); section.append(heading);
    const enabled = input('', 'checkbox'); enabled.checked = memory.enabled === true;
    const model = el('select'); model.setAttribute('aria-label', 'Memory 沉淀模型');
    const placeholder = el('option', options.length ? '请选择沉淀模型' : '暂无本机模型'); placeholder.value = ''; model.append(placeholder);
    for (const option of options) { const choice = el('option', option.label); choice.value = option.key; model.append(choice); }
    if (memory.settlementModelKey && !options.some(option => option.key === memory.settlementModelKey)) { const unavailable = el('option', `${memory.settlementModelKey}（当前不可用）`); unavailable.value = memory.settlementModelKey; model.append(unavailable); }
    model.value = memory.settlementModelKey ?? '';
    const updateControls = () => { enabled.disabled = !options.length && !enabled.checked; model.disabled = !enabled.checked || !options.length; };
    updateControls();
    enabled.onchange = () => { if (enabled.checked && !options.length) { enabled.checked = false; message('当前没有本机模型，无法开启 Memory。请先到“模型配置”添加模型。', true); } markDirty(); updateControls(); };
    model.onchange = markDirty;
    const toggle = el('label', undefined, 'local-memory-toggle'); const toggleCopy = el('span'); toggleCopy.append(el('strong', '启用 Memory'), el('small', '启用后，本机 Runtime 会按当前用户范围沉淀可复用的偏好与经验。')); toggle.append(enabled, toggleCopy);
    const modelField = el('label', undefined, 'local-memory-model-field'); modelField.append(el('span', '沉淀模型'), model);
    section.append(toggle, modelField, el('p', options.length ? '仅显示本机模型；云端模型不会用于本机 Memory 沉淀。' : '当前没有本机模型，无法开启 Memory。请先到“模型配置”添加模型。'));
    const actions = el('div', undefined, 'capability-actions local-memory-actions');
    actions.append(button('放弃更改', async () => { dirty = false; await load(); }), button('保存 Memory 配置', async () => {
      const settlementModelKey = model.value.trim();
      if (enabled.checked && !settlementModelKey) throw new Error('开启 Memory 前请选择沉淀模型。');
      if (enabled.checked && !options.some(option => option.key === settlementModelKey)) throw new Error('所选沉淀模型不可用，请重新选择本机模型。');
      await api('/api/memory-configuration', enabled.checked ? { enabled: true, settlementModelKey } : { enabled: false });
      dirty = false; await load(); message('Memory 配置已保存，将用于后续新任务。');
    }));
    actions.lastElementChild.classList.add('primary');
    section.append(actions);
  }
  async function renderWebSearch() {
    const result = await api('/api/web-search-configuration');
    const config = result.webSearch;
    const section = card('联网搜索服务', '保存后会重载当前账号的本机 Runtime；API Key 只写入账号专属的加密 Secret Store，不会回显。'); section.classList.add('web-search-card');
    const enabled = input('', 'checkbox'); enabled.checked = config.enabled === true;
    const provider = el('select'); for (const [value, title] of [['bocha', 'Bocha'], ['baidu', 'Baidu'], ['bing', 'Bing']]) { const option = el('option', title); option.value = value; provider.append(option); } provider.value = config.searchProvider ?? 'bocha';
    const endpoint = input(config.searchEndpoint ?? ''); endpoint.maxLength = 4096; endpoint.placeholder = 'https://api.example.com/v1/web-search'; endpoint.autocomplete = 'url';
    const key = input('', 'password'); key.maxLength = 4096; key.placeholder = config.credentialConfigured ? '已配置，留空保持不变' : '粘贴搜索 API Key'; key.autocomplete = 'new-password';
    const update = () => { provider.disabled = endpoint.disabled = key.disabled = !enabled.checked; };
    enabled.onchange = update; update();
    const toggle = el('label', undefined, 'web-search-toggle'); const toggleCopy = el('span'); toggleCopy.append(el('strong', '启用联网搜索'), el('small', '允许本机 Runtime 使用 websearch 工具访问公开网页。')); toggle.append(enabled, toggleCopy);
    const fields = el('div', undefined, 'web-search-fields'); fields.append(field('搜索服务', provider), field('搜索端点', endpoint), field('API Key', key));
    section.append(toggle, fields, el('p', '端点不能包含账号、密码、查询参数或片段。Bocha 需要 API Key；Baidu/Bing 可使用默认服务端点。保存不代表真实搜索已验收，请发送任务验证。', 'capability-help'));
    const actions = el('div', undefined, 'capability-actions');
    actions.append(button('放弃更改', async () => { dirty = false; await load(); }), button('保存搜索配置', async () => {
      await api('/api/web-search-configuration', { enabled: enabled.checked, searchProvider: provider.value, searchEndpoint: endpoint.value, ...(key.value.trim() ? { searchApiKey: key.value.trim() } : {}) });
      key.value = ''; dirty = false; await load(); message('联网搜索配置已保存，本机 Runtime 已重载。');
    })); actions.lastElementChild.classList.add('primary'); section.append(actions);
  }
  function stopped() { return runtimeList.find(r => r.id === target)?.status === 'stopped'; }
  function draft() { return { iconKey: snapshot.configuration.iconKey || 'xuanwu', skillPackageIds: snapshot.configuration.skills.map(s => s.packageId), mcpServerIds: [...snapshot.configuration.mcpServerIds] }; }
  async function save(configuration) { snapshot = await api(`/api/runtimes/${target}/configuration`, { configuration, revision: snapshot.revision }); dirty = false; await load(); await changed(); message('配置已保存。请启动此 Runtime 后执行任务验证。'); }
  async function renderSkills() {
    const zip = input('', 'file'); zip.accept = '.zip'; zip.setAttribute('aria-label', '选择 Skill ZIP');
    const directory = input('', 'file'); directory.multiple = true; directory.setAttribute('webkitdirectory', ''); directory.setAttribute('aria-label', '选择 Skill 目录');
    async function encode(file) { const bytes = new Uint8Array(await file.arrayBuffer()); let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(s); }
    async function importFiles(files, isZip) {
      if (!files.length) throw new Error('请选择文件');
      if (files.length > 1000 || files.reduce((sum, f) => sum + f.size, 0) > (isZip ? 16 : 32) * 1024 * 1024 || (!isZip && files.some(f => f.size > 8 * 1024 * 1024))) throw new Error('文件超过大小限制');
      const payload = isZip ? { zipBase64: await encode(files[0]) } : { files: await Promise.all(files.map(async f => ({ path: f.webkitRelativePath || f.name, contentBase64: await encode(f) }))) };
      await api('/api/skills/import', payload); zip.value = ''; directory.value = ''; dirty = false; await load(); message('Skill 已导入当前账号的本机库。请在 Runtime 页勾选并保存后启动。');
    }
    zip.onchange = () => void perform(() => importFiles([...zip.files], true));
    directory.onchange = () => void perform(() => importFiles([...directory.files], false));
    const heading = el('section', undefined, 'skill-library-heading'); const copy = el('div'); copy.append(el('strong', '本机 Skill 包'), el('p', '内核 Skills 默认加载；此处管理 Custom / 上传 Skill。支持 ZIP 或目录，导入内容只保存在本机当前账号的本机库。'));
    // Opening a file chooser must happen before any import work disables the
    // hidden input. The import itself remains serialized by perform() above.
    const pickerButton = (title, picker) => { const control = el('button', title); control.type = 'button'; control.onclick = () => picker.click(); return control; };
    const actions = el('div', undefined, 'capability-actions'); actions.append(pickerButton('上传 ZIP', zip), pickerButton('上传目录', directory)); heading.append(copy, actions);
    const pickers = el('div', undefined, 'skill-upload-inputs'); pickers.append(zip, directory); body.append(heading, pickers);
    if (!packages.length) card('暂无本机 Skill 包', '可以上传 ZIP 或目录；导入后不会自动启用、不会上传到账号服务。请在 Runtime 管理中选择并绑定。');
    for (const p of packages) {
      const c = card(p.displayName || p.skillName, p.description || '暂无描述。'); c.classList.add('skill-package-card');
      const state = el('small', `${p.validationStatus === 'valid' ? (p.metadataNeedsReview ? '待维护元数据' : '元数据已确认') : 'Skill 包校验未通过'}`, `skill-package-state${p.validationStatus === 'valid' && !p.metadataNeedsReview ? ' confirmed' : ''}`);
      const actions = el('div', undefined, 'capability-actions skill-package-actions'); actions.append(button('维护元数据', async () => {
        if (dirty) throw new Error('请先保存或放弃更改');
        const meta = await api(`/api/skills/${p.packageId}/metadata`); const editor = jsonEditor(meta.declaration, 16);
        c.replaceChildren(el('strong', p.displayName || p.skillName), el('p', '编辑当前账号的本机库中的声明元数据，不改写原始 Skill 内容；保存后需重启使用此包的 Runtime。'), editor);
        editor.disabled = !meta.editable;
        c.append(button('保存声明', async () => { await api(`/api/skills/${p.packageId}/metadata`, { declaration: JSON.parse(editor.value) }); dirty = false; await load(); message('声明已保存，请重启使用此 Skill 的 Runtime。'); }));
      })); c.append(state, actions);
    }
  }
  function renderRuntimes() {
    const heading = el('section', undefined, 'runtime-manager-heading');
    const copy = el('div'); copy.append(el('strong', '子 Runtime 管理'), el('p', '每个 Runtime 具有独立会话和扩展 Skill，共享当前账号的 MCP 配置。'));
    const add = button('＋ 新增', () => createPanel(false)); add.classList.add('runtime-create'); heading.append(copy, add); body.append(heading);
    const list = el('div', undefined, 'runtime-manager-list'); body.append(list);
    for (const runtime of runtimeList) {
      const item = el('section', undefined, `runtime-manager-card${runtime.id === currentRuntime() ? ' selected' : ''}`);
      const main = el('div', undefined, 'runtime-manager-main'); const title = el('div', undefined, 'runtime-manager-title');
      const avatar = document.createElement('img'); avatar.className = 'runtime-manager-icon'; avatar.src = runtimeIconUrl(runtime.iconKey); avatar.alt = `${runtime.displayName} 图标`; title.append(avatar, el('strong', runtime.displayName));
      if (runtime.isDefault) title.append(el('span', '默认', 'runtime-tag default'));
      title.append(el('span', runtime.status === 'ready' ? '就绪' : runtime.status === 'stopped' ? '已停止' : runtime.status, `runtime-tag ${runtime.status}`));
      const activity = runtime.activeRunCount ? `当前 ${runtime.activeRunCount} 个活动任务` : '当前无活动任务';
      main.append(title, el('p', activity), el('small', `${runtime.extensionSkillCount} 个扩展 Skill · ${runtime.mcpServerCount} 个 MCP`));
      const actions = runtimeActionMenu(runtime);
      actions.prepend(button('查看', () => openRuntimeDetail(runtime, 'view')));
      item.append(main, actions); list.append(item);
    }
    function createPanel(open) {
      const existing = body.querySelector('.runtime-create-panel'); if (existing) { existing.hidden = !open; return; }
      const panel = el('section', undefined, 'capability-card runtime-create-panel'); const name = input(''); name.maxLength = 100;
      panel.append(el('strong', '新建 Runtime'), el('p', '新 Runtime 共享模型、Skill 库、MCP 和 Connector，但拥有独立会话及 Skill 绑定。'), field('名称', name));
      const actions = el('div', undefined, 'capability-actions'); actions.append(button('取消', () => panel.remove()), button('创建', async () => {
        const result = await api('/api/runtimes', { displayName: name.value }); runtimeDetail = result.runtime.id; target = result.runtime.id; dirty = false; await load(); await changed();
      })); actions.lastElementChild.classList.add('primary'); panel.append(actions); body.append(panel); name.focus();
    }
  }
  async function lifecycle(runtime, action) {
    if (dirty) throw new Error('请先保存或放弃更改');
    await api(`/api/runtimes/${runtime.id}/${action}`, {}); await load(); await changed(); message('生命周期操作已提交；有活动任务时会先排空，不强制中断。');
  }
  async function removeRuntime(runtime) {
    if (dirty || !confirm(`删除“${runtime.displayName}”及其本机对话、附件、产物和配置？设备共享 Skill 库、模型和 Connector 不受影响。`)) return;
    await api(`/api/runtimes/${runtime.id}/remove`, {}); runtimeDetail = undefined; target = undefined; await load(); await changed(); message('Runtime 及其专属数据已删除；此操作不能由设置页恢复。');
  }
  function runtimeActionMenu(runtime) {
    const actions = el('div', undefined, 'runtime-manager-actions');
    const menu = el('div', undefined, 'runtime-action-menu'); menu.hidden = true;
    const more = button('•••', () => { menu.hidden = !menu.hidden; }); more.classList.add('runtime-more'); more.setAttribute('aria-label', `操作 ${runtime.displayName}`);
    const operations = runtime.status === 'stopped'
      ? [['configure', '配置'], ['start', '启动']]
      : runtime.status === 'ready'
        ? [['stop', '停止'], ['drain', '排空'], ['restart', '重启']]
        : [['stop', '停止']];
    for (const [action, titleText] of operations) menu.append(button(titleText, () => action === 'configure' ? openRuntimeDetail(runtime, 'configure') : lifecycle(runtime, action)));
    if (!runtime.isDefault) menu.append(button('删除 Runtime', () => removeRuntime(runtime), true));
    actions.append(more, menu); return actions;
  }
  function openRuntimeDetail(runtime, mode) { runtimeDetail = runtime.id; runtimeDetailMode = mode; target = runtime.id; return load(); }
  function renderRuntimeDetail() {
    const runtime = runtimeList.find(item => item.id === runtimeDetail); if (!runtime || !snapshot) { runtimeDetail = undefined; void load(); return; }
    const configuring = runtimeDetailMode === 'configure';
    const modal = el('section', undefined, 'runtime-detail-modal'); const panel = el('div', undefined, 'runtime-detail-panel'); modal.append(panel); body.append(modal);
    const heading = el('header', undefined, 'runtime-detail-modal-head'); const title = el('div'); title.append(el('strong', configuring ? `配置 ${runtime.displayName}` : runtime.displayName), el('p', configuring ? '此 Runtime 已停止。可选择扩展 Skill；MCP 由当前账号共享。' : `${runtime.isDefault ? '默认 · ' : ''}${runtime.status} · ${runtime.extensionSkillCount} 个扩展 Skill · ${runtime.mcpServerCount} 个 MCP`));
    const close = button('×', () => { runtimeDetail = undefined; target = undefined; dirty = false; return load(); }); close.classList.add('runtime-detail-close'); close.setAttribute('aria-label', '关闭 Runtime 详情'); heading.append(title, close); panel.append(heading);
    if (!configuring) { renderRuntimeReadOnly(panel, runtime); return; }
    const tabs = runtimeCapabilityTabs(panel, 'Runtime 扩展配置');
    const iconCard = cardInto(tabs.skills, 'Runtime 形象', '选择一个中国上古神兽作为这个 Runtime 的身份标识。保存后会同步到会话历史和对话流。');
    const iconGrid = el('div', undefined, 'runtime-icon-grid');
    let selectedIcon = RUNTIME_ICONS.some(icon => icon.key === (snapshot.configuration.iconKey || runtime.iconKey)) ? (snapshot.configuration.iconKey || runtime.iconKey) : 'xuanwu';
    for (const icon of RUNTIME_ICONS) {
      const option = el('button', undefined, `runtime-icon-option${icon.key === selectedIcon ? ' selected' : ''}`); option.type = 'button'; option.dataset.runtimeIcon = icon.key; option.setAttribute('aria-pressed', String(icon.key === selectedIcon));
      const image = document.createElement('img'); image.src = runtimeIconUrl(icon.key); image.alt = icon.name;
      option.append(image, el('span', icon.name), el('small', icon.description));
      option.onclick = () => { selectedIcon = icon.key; for (const candidate of iconGrid.querySelectorAll('.runtime-icon-option')) { const active = candidate.dataset.runtimeIcon === selectedIcon; candidate.classList.toggle('selected', active); candidate.setAttribute('aria-pressed', String(active)); } markDirty(); };
      iconGrid.append(option);
    }
    iconCard.append(iconGrid);
    const skills = cardInto(tabs.skills, '专属扩展 Skills', '只影响此 Runtime。取消勾选仅解除绑定，不删除当前账号的本机库文件。');
    const choices = []; const skillList = el('div', undefined, 'runtime-skill-options'); skills.append(skillList);
    if (!packages.length) skillList.append(el('p', '暂无可选的 Custom / 上传 Skill；此 Runtime 仍会使用内核 Skills。'));
    for (const pkg of packages) {
      const checkbox = input('', 'checkbox'); checkbox.checked = snapshot.configuration.skills.some(skill => skill.packageId === pkg.packageId); checkbox.disabled = pkg.validationStatus !== 'valid';
      const option = el('label', undefined, 'runtime-skill-option'); const copy = el('span'); copy.append(el('strong', pkg.displayName || pkg.skillName), el('small', pkg.description || '暂无描述。'));
      option.append(checkbox, copy); skillList.append(option); choices.push([pkg, checkbox]);
    }
    renderSharedMcp(tabs.mcp);
    const actions = el('footer', undefined, 'runtime-config-actions');
    actions.append(button('取消', () => { runtimeDetail = undefined; target = undefined; dirty = false; return load(); }), button('保存', async () => {
      const configuration = draft(); configuration.iconKey = selectedIcon; configuration.skillPackageIds = choices.filter(([, control]) => control.checked).map(([pkg]) => pkg.packageId);
      await api(`/api/runtimes/${target}/configuration`, { configuration, revision: snapshot.revision });
      runtimeDetail = undefined; target = undefined; dirty = false; await changed(); await load(); message('Runtime 配置已保存。');
    })); actions.lastElementChild.classList.add('primary'); panel.append(actions);
  }
  function renderRuntimeReadOnly(panel, runtime) {
    const tabs = runtimeCapabilityTabs(panel, 'Runtime 扩展详情');
    const iconCard = cardInto(tabs.skills, 'Runtime 形象', '会话历史、输入框入口和对话流都会使用这个标识。');
    const icon = RUNTIME_ICONS.find(item => item.key === (runtime.iconKey || snapshot.configuration.iconKey)) || RUNTIME_ICONS[0];
    const image = document.createElement('img'); image.className = 'runtime-detail-icon'; image.src = runtimeIconUrl(icon.key); image.alt = icon.name;
    iconCard.append(image, el('strong', `${icon.name} · ${icon.description}`));
    const enabledSkillIds = new Set(snapshot.configuration.skills.map(skill => skill.packageId));
    const selectedSkills = packages.filter(pkg => enabledSkillIds.has(pkg.packageId));
    const skills = cardInto(tabs.skills, '已选择的扩展 Skills', '内核 Skills 默认加载；以下为该 Runtime 专属启用的扩展包。');
    if (!selectedSkills.length) skills.append(el('p', '未选择扩展 Skill。'));
    else for (const pkg of selectedSkills) skills.append(el('div', `${pkg.displayName || pkg.skillName} · 已启用`, 'runtime-detail-choice'));
    const servers = snapshot.configuration.mcpServers;
    const mcp = cardInto(tabs.mcp, '已配置的 MCP Servers', '当前账号共享的 MCP；凭据不会回显。');
    if (!servers.length) mcp.append(el('p', '未配置 MCP Server。'));
    else for (const server of servers) mcp.append(el('div', `${server.displayName} · ${server.key}${server.auth?.credentialConfigured ? ' · 凭据已配置' : ''}`, 'runtime-detail-choice'));
    if (runtime.status === 'stopped') {
      const actions = el('div', undefined, 'capability-actions runtime-detail-actions'); actions.append(button('配置扩展 Skill', () => openRuntimeDetail(runtime, 'configure'))); actions.lastElementChild.classList.add('primary'); panel.append(actions);
    }
  }
  function runtimeCapabilityTabs(panel, label) {
    const tablist = el('div', undefined, 'runtime-capability-tabs'); tablist.setAttribute('role', 'tablist'); tablist.setAttribute('aria-label', label);
    const tabButton = (title, name) => { const control = el('button', title); control.type = 'button'; control.onclick = () => activate(name); control.setAttribute('role', 'tab'); return control; };
    const skillsTab = tabButton('Skills', 'skills');
    const mcpTab = tabButton('MCP Servers', 'mcp');
    const skills = el('section', undefined, 'runtime-capability-tab-panel'); skills.setAttribute('role', 'tabpanel');
    const mcp = el('section', undefined, 'runtime-capability-tab-panel'); mcp.setAttribute('role', 'tabpanel');
    function activate(tabName) {
      const showSkills = tabName === 'skills'; skills.hidden = !showSkills; mcp.hidden = showSkills;
      skillsTab.classList.toggle('active', showSkills); mcpTab.classList.toggle('active', !showSkills);
      skillsTab.setAttribute('aria-selected', String(showSkills)); mcpTab.setAttribute('aria-selected', String(!showSkills));
    }
    tablist.append(skillsTab, mcpTab); panel.append(tablist, skills, mcp); activate('skills'); return { skills, mcp };
  }
  function renderSharedMcp(container) {
    const section = cardInto(container, '共享 MCP Servers', '当前账号的所有本机 Runtime 使用相同的 MCP；请在 MCP 配置中维护。');
    if (!mcpCatalog.length) section.append(el('p', '尚无 MCP 条目。'));
    for (const server of mcpCatalog) section.append(el('div', `${server.displayName} · ${server.key}`, 'runtime-detail-choice'));
  }
  // Some chat and document editors replace JSON delimiter quotes with curly
  // quotes. Normalize delimiters only; preserve curly quotes inside strings.
  function parseMcpJson(text) {
    let normalized = '', quote = '', escaped = false;
    for (const char of text) {
      if (escaped) { normalized += char; escaped = false; continue; }
      if (quote && char === '\\') { normalized += char; escaped = true; continue; }
      if (!quote && (char === '"' || char === '“')) { quote = char; normalized += '"'; continue; }
      if ((quote === '"' && char === '"') || (quote === '“' && char === '”')) { quote = ''; normalized += '"'; continue; }
      normalized += char;
    }
    return JSON.parse(normalized);
  }
  function renderDeviceMcp() {
    const header = el('section', undefined, 'mcp-list-heading');
    const copy = el('div'); copy.append(el('strong', 'MCP Servers'), el('p', '统一管理当前账号的 MCP 服务，供所有本机 Runtime 使用。'));
    const add = button('＋ 新增 MCP', () => openEditor()); add.classList.add('mcp-add');
    header.append(copy, add); body.append(header);
    const list = el('div', undefined, 'mcp-server-list'); body.append(list);
    if (!mcpCatalog.length) {
      const empty = el('div', undefined, 'mcp-empty'); empty.append(el('strong', '还没有 MCP 服务'), el('p', '添加服务后，可以在这里管理配置和探测连接。')); list.append(empty);
    }
    function withoutStatus(server) {
      const { credentialConfigured, ...auth } = server.auth;
      return { ...server, auth };
    }
    function allowAction() {
      if (!dirty) return true;
      message('有未保存更改，请先保存或取消编辑。', true); return false;
    }
    for (const server of mcpCatalog) {
      const row = el('section', undefined, 'mcp-server-row');
      const info = el('div', undefined, 'mcp-server-info');
      const title = el('div', undefined, 'mcp-server-title'); title.append(el('strong', server.displayName), el('span', server.auth?.credentialConfigured ? '凭据已保存' : server.auth?.kind === 'none' ? '无需凭据' : '凭据未配置', 'mcp-auth-badge'));
      let probeTimer;
      const probeStatus = el('div', undefined, 'mcp-probe-status'); probeStatus.hidden = true; probeStatus.setAttribute('role', 'status'); probeStatus.setAttribute('aria-live', 'polite');
      info.append(title, el('div', server.key, 'mcp-server-key'), el('div', server.url, 'mcp-server-url'), probeStatus);
      const actions = el('div', undefined, 'capability-actions mcp-server-actions');
      const probe = button('探测', async () => {
        if (!allowAction()) return;
        clearTimeout(probeTimer);
        message(''); probeStatus.hidden = false; probeStatus.className = 'mcp-probe-status pending';
        probeStatus.textContent = '正在探测连接…'; probe.textContent = '探测中…';
        try {
          const result = await api('/api/mcp/test', { server: withoutStatus(server) });
          probeStatus.className = `mcp-probe-status ${result.ok ? 'success' : 'failure'}`;
          probeStatus.textContent = result.ok ? `连接成功 · 发现 ${result.toolCount} 个可用工具` : '连接失败，请检查服务地址、认证和协议。';
        } catch (error) {
          probeStatus.className = 'mcp-probe-status failure';
          probeStatus.textContent = errors[error?.message] ? `探测失败：${errors[error.message]}` : '探测未完成，请检查服务连接后重试。';
        } finally {
          probe.textContent = '探测';
          probeTimer = setTimeout(() => { probeStatus.hidden = true; }, 10_000);
        }
      });
      const edit = button('编辑', () => { if (allowAction()) openEditor(server); });
      const remove = button('删除', async () => {
        if (!allowAction() || !confirm(`删除“${server.displayName}”及其本机凭据？`)) return;
        await api(`/api/mcp/${server.id}/remove`, {}); dirty = false; await load(); await changed(); message('MCP 已删除。');
      }, true);
      for (const [control, action] of [[probe, '探测'], [edit, '编辑'], [remove, '删除']]) control.setAttribute('aria-label', `${action} ${server.displayName}`);
      actions.append(probe, edit, remove); row.append(info, actions); list.append(row);
    }
    let editor;
    function openEditor(existing) {
      if (!allowAction()) return;
      editor?.remove(); editor = el('section', undefined, 'capability-card mcp-editor'); body.append(editor);
      const heading = el('div', undefined, 'mcp-editor-heading'); const headingCopy = el('div');
      headingCopy.append(el('strong', existing ? `编辑 ${existing.displayName}` : '新增 MCP'), el('p', '粘贴完整的 MCP JSON 配置，凭据填写在 auth 中。')); heading.append(headingCopy); editor.append(heading);
      const { id, ...config } = existing ?? { displayName: '新 MCP', key: `mcp-${Date.now()}`, transport: 'http', url: 'http://127.0.0.1:8000/mcp', auth: { kind: 'none' }, timeoutMs: 5000 };
      const json = jsonEditor(config, 14); json.setAttribute('aria-label', 'MCP 配置 JSON');
      editor.append(field('MCP 配置 JSON', json), el('p', '保存后凭据不会回显。编辑时省略凭据可保留原值；更换地址或认证目标时需重新填写。', 'mcp-editor-note'));
      function draft() {
        let value;
        try { value = parseMcpJson(json.value); } catch { throw new Error('mcp_json_invalid'); }
        if (!value || typeof value !== 'object' || Array.isArray(value) || !value.auth || typeof value.auth !== 'object' || Array.isArray(value.auth)) throw new Error('mcp_json_invalid');
        const { credentialConfigured, ...auth } = value.auth;
        const { id: ignoredId, ...fields } = value;
        return { ...fields, auth, ...(id ? { id } : {}) };
      }
      const actions = el('div', undefined, 'capability-actions mcp-editor-actions');
      const cancel = button('取消', () => { dirty = false; editor.remove(); editor = undefined; message('已取消编辑。'); });
      const save = button('保存 MCP', async () => { await api('/api/mcp', { server: draft() }); dirty = false; await load(); await changed(); message('MCP 已保存，所有本机 Runtime 已同步。'); }); save.classList.add('primary');
      actions.append(cancel, save); editor.append(actions);
      json.focus();
    }
  }
  async function renderConnectors() {
    const [{ connectors }, { connections }] = await Promise.all([api('/api/connectors/catalog'), api('/api/connectors')]);
    const availableHead = el('section', undefined, 'connector-section-heading'); availableHead.append(el('strong', '可添加的 Connectors'), el('p', 'Connector 会供这台 Desktop 上的全部 Runtime 使用；凭据仅加密保存在本机，不会上传到云端。')); body.append(availableHead);
    if (!connectors.length) { const empty = el('div', '尚无已加载的 Connector 模块', 'connector-empty'); empty.append(el('small', '请通过 AGENTLOOP_DESKTOP_CONNECTOR_MODULES_JSON 配置本机模块后重启 Desktop。网页不能安装或指定代码路径。')); body.append(empty); }
    const catalog = el('div', undefined, 'connector-catalog'); body.append(catalog);
    const capabilityNames = capabilities => capabilities.map(capability => typeof capability === 'string' ? capability : capability.displayName || capability.key || '已声明能力').join(' · ');
    for (const connector of connectors) {
      const item = el('section', undefined, 'connector-catalog-card'); const head = el('div', undefined, 'connector-card-head'); head.append(el('strong', connector.displayName));
      const add = button('＋', () => edit(undefined, connector.key)); add.classList.add('connector-add'); add.title = `添加 ${connector.displayName}`; add.setAttribute('aria-label', `添加 ${connector.displayName}`); head.append(add);
      item.append(head, el('p', connector.description || '由本机 Connector 模块提供。'), el('small', capabilityNames(connector.capabilities) || '能力由本机模块声明。')); catalog.append(item);
    }
    const addedHead = el('section', undefined, 'connector-section-heading'); addedHead.append(el('strong', '已添加的 Connectors'), el('p', '账号连接对全部 Runtime 生效；保存后会在没有活动任务时重载运行中的 Runtime。')); body.append(addedHead);
    if (!connections.length) body.append(el('div', '尚未配置本机 Connector', 'connector-empty'));
    for (const c of connections) {
      const section = el('section', undefined, 'connector-existing-card'); const head = el('div', undefined, 'connector-card-head'); head.append(el('strong', c.displayName));
      const actions = el('div', undefined, 'capability-actions'); const editButton = button('编辑', () => edit(c)); const removeButton = button('删除', async () => { if (!confirm('删除此账号的连接及本机凭据？')) return; await api(`/api/connectors/${c.id}/remove`, {}); dirty = false; await load(); await changed(); }, true); actions.append(editButton, removeButton); head.append(actions);
      section.append(head, el('p', `${c.connectorKey} · ${c.enabled ? '已启用' : '已停用'} · ${c.credentialConfigured ? '凭据已保存' : '无凭据'}${!c.moduleAvailable ? ' · 模块不可用' : ''}`)); body.append(section);
    }
    let editor;
    function edit(existing, connectorKey) {
      if (dirty) throw new Error('请先保存或放弃更改');
      if (!editor) { editor = el('section', undefined, 'capability-card connector-editor'); body.append(editor); }
      const key = existing?.connectorKey ?? connectorKey ?? connectors[0]?.key ?? '';
      const binding = connectorBindings[key];
      if (binding) { renderBinding(existing, key, binding); return; }
      renderGenericEditor(existing, key);
    }
    function renderBinding(existing, connectorKey, binding) {
      editor.classList.add('connector-binding'); editor.replaceChildren();
      const title = existing ? `编辑 ${existing.displayName}` : binding.title;
      const heading = el('div', undefined, 'connector-binding-head'); const copy = el('div'); copy.append(el('strong', title), el('p', binding.description));
      const close = button('×', () => { editor.replaceChildren(); editor.classList.remove('connector-binding'); }); close.classList.add('connector-binding-close'); close.setAttribute('aria-label', '关闭绑定面板'); heading.append(copy, close);
      const fields = el('div', undefined, 'connector-binding-fields'); const values = new Map();
      for (const definition of binding.fields) {
        const control = input('', definition.type); control.placeholder = definition.placeholder; control.autocomplete = definition.autocomplete;
        const label = field(definition.label, control); label.classList.add('connector-binding-field'); fields.append(label); values.set(definition.key, control);
      }
      const actions = el('div', undefined, 'capability-actions connector-binding-actions');
      actions.append(button('取消', () => { editor.replaceChildren(); editor.classList.remove('connector-binding'); }), button(existing ? '保存连接' : '绑定并保存', async () => {
        const credentials = {};
        let supplied = 0;
        for (const definition of binding.fields) {
          const value = values.get(definition.key).value.trim();
          if (!value) {
            if (existing) continue;
            throw new Error(`请填写${definition.label}。`);
          }
          supplied++;
          credentials[definition.key] = value;
        }
        if (existing && supplied > 0 && supplied !== binding.fields.length) throw new Error('如需更换凭据，请完整填写全部字段。');
        if (existing && !Object.keys(credentials).length) {
          await saveConnector({ id: existing.id, connectorKey, displayName: existing.displayName, enabled: existing.enabled, scopes: existing.scopes });
          return;
        }
        await saveConnector({ ...(existing ? { id: existing.id } : {}), connectorKey, displayName: existing?.displayName ?? binding.displayName, enabled: existing?.enabled ?? true, scopes: existing?.scopes ?? binding.scopes, credentials });
      })); actions.lastElementChild.classList.add('primary');
      editor.append(heading, fields, actions);
      values.get(binding.fields[0]?.key)?.focus();
    }
    function renderGenericEditor(existing, connectorKey) {
      editor.classList.remove('connector-binding');
      editor.replaceChildren(el('strong', existing ? '编辑连接' : '新建连接'));
      const module = el('select'); for (const c of connectors) { const o = el('option', c.displayName); o.value = c.key; module.append(o); } module.value = connectorKey;
      module.disabled = Boolean(existing || connectorKey);
      const name = input(existing?.displayName ?? ''), scopes = jsonEditor(existing?.scopes ?? [], 3), enabled = input('', 'checkbox'); enabled.checked = existing?.enabled ?? true;
      const credentials = input('', 'password'); credentials.autocomplete = 'new-password'; credentials.placeholder = 'JSON 对象，如 {"accessToken":"…"}；留空保留，{} 清除';
      editor.append(field('Connector 模块', module), field('显示名称', name), field('启用连接', enabled), field('Scopes（JSON 数组）', scopes), field('凭据（仅本次提交，留空保留）', credentials));
      const saveButton = button('保存连接', async () => {
        const connector = { ...(existing ? { id: existing.id } : {}), connectorKey: module.value, displayName: name.value, enabled: enabled.checked, scopes: JSON.parse(scopes.value), ...(credentials.value ? { credentials: JSON.parse(credentials.value) } : {}) };
        await saveConnector(connector); credentials.value = '';
      }); saveButton.disabled = !connectors.length; editor.append(saveButton);
    }
    async function saveConnector(connector) {
      const result = await api('/api/connectors', { connector }); dirty = false; await load(); await changed(); message(result.credentialCleanupPending ? '连接已保存，旧凭据清理未完成。' : '连接已保存，全部 Runtime 已同步；请在对话中勾选本轮授权。');
    }
  }
  async function show(next) {
    if (!canLeave()) return;
    tab = next; element('settings-models').hidden = tab !== 'models'; element('settings-capabilities').hidden = tab === 'models';
    for (const b of document.querySelectorAll('[data-settings-tab]')) { b.classList.toggle('active', b.dataset.settingsTab === tab); b.setAttribute('aria-pressed', String(b.dataset.settingsTab === tab)); }
    if (tab === 'models') await models.load();
    else { element('capability-title').textContent = labels[tab][0]; element('capability-description').textContent = labels[tab][1]; element('capability-scope').textContent = ['skills', 'mcp', 'connectors'].includes(tab) ? '跨 Runtime 共享' : '仅本机保存'; await load(); }
  }
  for (const b of document.querySelectorAll('[data-settings-tab]')) b.onclick = () => void perform(() => show(b.dataset.settingsTab));
  // show() checks canLeave before perform sets working.
  for (const b of document.querySelectorAll('[data-settings-tab]')) b.onclick = () => { if (canLeave()) { const next = b.dataset.settingsTab; void show(next).catch(() => message('设置读取失败。', true)); } };
  async function open() { if (dialog.open) return; target = currentRuntime(); tab = 'general'; dirty = false; dialog.showModal(); await show('general'); }
  element('model-settings-open').onclick = () => void open(); element('model-settings-mobile').onclick = () => void open();
  const close = event => { if (!canLeave()) { event?.preventDefault(); return; } dialog.close(); };
  element('model-settings-close').onclick = () => close(); dialog.addEventListener('cancel', close);
  element('model-settings-done').onclick = () => close();
  dialog.addEventListener('close', () => { reset(); target = undefined; });
}
