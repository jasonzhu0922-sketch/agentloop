import { installModelSettings } from './model-settings.js';

// Desktop-owned presentation and transport. No cloud/Router management client.
export function installCapabilitySettings({ api, element, refreshModels, status, currentRuntime, refreshCapabilities }) {
  const models = installModelSettings({ api, element, refreshModels, status, managed: true });
  const dialog = element('model-settings'), body = element('capability-body');
  let tab = 'general', target, runtimeDetail, runtimeDetailMode = 'view', dirty = false, working = false, snapshot, runtimeList = [], packages = [], mcpCatalog = [];
  const labels = { general: ['常规', '管理当前账号的本机存储与 Memory 配置。'], skills: ['Skill 管理', '上传和维护本机 Skill 包；安装后可在各个 Runtime 配置中分别选择。'], mcp: ['MCP 配置', '配置当前账号的 MCP Server；Runtime 只选择要启用的条目。'], runtimes: ['子 Runtime 管理', '新增、停止、重启、删除和查看各个本机 Runtime；每个 Runtime 独立选择扩展 Skill 与 MCP。'], connectors: ['Connector 配置', '个人 Connector 只保存在 Desktop；配置凭据不会上传到云端。'] };
  const errors = { account_storage_outside_scope: '存储位置必须位于当前账号的存储目录内，不能指向其他账号或外部目录。', runtime_must_be_stopped_for_configuration: '请先在 Runtime 页停止对应实例，再编辑配置。', runtime_active_runs_prevent_reconfiguration: '仍有活动任务，请等待任务结束。', runtime_configuration_stale: '配置已被其他页面修改，请重新读取后再编辑。', mcp_credential_required: '缺少凭据；更换地址或认证目标后，必须重新填写。', mcp_server_key_duplicate: '同一 Runtime 不能同时选择 key 相同的 MCP 条目。', mcp_server_referenced_by_runtime: '该 MCP 已被一个或多个 Runtime 选择，不能删除。请先在对应 Runtime 中解除勾选。', connector_connection_not_authorized: '不能使用其他账号的 Connector 连接。', skill_import_invalid: 'Skill 包无效：请检查 SKILL.md、归档路径、文件类型和大小限制。', runtime_default_cannot_be_removed: '不能删除默认 Runtime。' };
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
    [runtimeList, packages, mcpCatalog] = await Promise.all([api('/api/runtimes').then(r => r.runtimes), api('/api/skills').then(r => r.skills), api('/api/mcp').then(r => r.servers)]);
    if (!runtimeList.some(r => r.id === target)) target = currentRuntime() || runtimeList[0]?.id;
    if (tab === 'general') {
      await renderGeneral();
    } else if (tab === 'runtimes') {
      if (runtimeDetail !== undefined && runtimeList.some(runtime => runtime.id === runtimeDetail)) {
        target = runtimeDetail;
        snapshot = await api(`/api/runtimes/${target}/configuration`);
      } else runtimeDetail = undefined;
    } else if (!['skills', 'connectors'].includes(tab)) {
      const picker = el('select'); picker.dataset.runtimePicker = 'true'; picker.setAttribute('aria-label', '设置目标 Runtime');
      for (const r of runtimeList) { const option = el('option', `${r.displayName} · ${r.status}`); option.value = r.id; picker.append(option); }
      picker.value = target;
      picker.onchange = () => { if (!canLeave()) { picker.value = target; return; } target = picker.value; void perform(load); };
      body.append(field('目标 Runtime', picker));
      snapshot = await api(`/api/runtimes/${target}/configuration`);
    }
    if (tab === 'skills') await renderSkills();
    else if (tab === 'mcp') renderDeviceMcp();
    else if (tab === 'runtimes') renderRuntimes();
    else if (tab === 'connectors') await renderConnectors();
    if (tab !== 'general' && tab !== 'runtimes' && tab !== 'mcp') body.append(button('放弃更改并重新读取', load));
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
    body.append(detail([
      ['Agent', 'Desktop · 开发模式'],
      ['服务端', window.location.origin],
      ['当前账号工作目录', workspace],
      ['上传源文件目录', uploads],
      ['Skill 模式', 'Runtime 启动时统一加载'],
    ]), el('p', '保存目录后会在没有活动任务时重载本机 Runtime。原位置的数据不会自动迁移或删除；请输入当前账号存储目录内的绝对路径。', 'general-storage-note'));
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
  function stopped() { return runtimeList.find(r => r.id === target)?.status === 'stopped'; }
  function draft() { return { skillPackageIds: snapshot.configuration.skills.map(s => s.packageId), mcpServerIds: [...snapshot.configuration.mcpServerIds] }; }
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
    const copy = el('div'); copy.append(el('strong', '子 Runtime 管理'), el('p', '每个 Runtime 具有独立会话、扩展 Skill 与 MCP 配置。'));
    const add = button('＋ 新增', () => createPanel(false)); add.classList.add('runtime-create'); heading.append(copy, add); body.append(heading);
    const list = el('div', undefined, 'runtime-manager-list'); body.append(list);
    for (const runtime of runtimeList) {
      const item = el('section', undefined, `runtime-manager-card${runtime.id === currentRuntime() ? ' selected' : ''}`);
      const main = el('div', undefined, 'runtime-manager-main'); const title = el('div', undefined, 'runtime-manager-title'); title.append(el('strong', runtime.displayName));
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
      panel.append(el('strong', '新建 Runtime'), el('p', '新 Runtime 共享设备模型、Skill 库和 Connector，但拥有独立会话、Skill 绑定及 MCP 配置。'), field('名称', name));
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
    const heading = el('header', undefined, 'runtime-detail-modal-head'); const title = el('div'); title.append(el('strong', configuring ? `配置 ${runtime.displayName}` : runtime.displayName), el('p', configuring ? '此 Runtime 已停止。可单独选择扩展 Skill 与 MCP Server。' : `${runtime.isDefault ? '默认 · ' : ''}${runtime.status} · ${runtime.extensionSkillCount} 个扩展 Skill · ${runtime.mcpServerCount} 个 MCP`));
    const close = button('×', () => { runtimeDetail = undefined; target = undefined; dirty = false; return load(); }); close.classList.add('runtime-detail-close'); close.setAttribute('aria-label', '关闭 Runtime 详情'); heading.append(title, close); panel.append(heading);
    if (!configuring) { renderRuntimeReadOnly(panel, runtime); return; }
    const tabs = runtimeCapabilityTabs(panel, 'Runtime 扩展配置');
    const skills = cardInto(tabs.skills, '专属扩展 Skills', '只影响此 Runtime。取消勾选仅解除绑定，不删除当前账号的本机库文件。');
    const choices = []; const skillList = el('div', undefined, 'runtime-skill-options'); skills.append(skillList);
    if (!packages.length) skillList.append(el('p', '暂无可选的 Custom / 上传 Skill；此 Runtime 仍会使用内核 Skills。'));
    for (const pkg of packages) {
      const checkbox = input('', 'checkbox'); checkbox.checked = snapshot.configuration.skills.some(skill => skill.packageId === pkg.packageId); checkbox.disabled = pkg.validationStatus !== 'valid';
      const option = el('label', undefined, 'runtime-skill-option'); const copy = el('span'); copy.append(el('strong', pkg.displayName || pkg.skillName), el('small', pkg.description || '暂无描述。'));
      option.append(checkbox, copy); skillList.append(option); choices.push([pkg, checkbox]);
    }
    const mcp = renderRuntimeMcpBindings(tabs.mcp);
    const actions = el('footer', undefined, 'runtime-config-actions');
    actions.append(button('取消', () => { runtimeDetail = undefined; target = undefined; dirty = false; return load(); }), button('保存', async () => {
      const configuration = draft(); configuration.skillPackageIds = choices.filter(([, control]) => control.checked).map(([pkg]) => pkg.packageId); configuration.mcpServerIds = mcp.read();
      await api(`/api/runtimes/${target}/configuration`, { configuration, revision: snapshot.revision });
      runtimeDetail = undefined; target = undefined; dirty = false; await changed(); await load(); message('Runtime 配置已保存。');
    })); actions.lastElementChild.classList.add('primary'); panel.append(actions);
  }
  function renderRuntimeReadOnly(panel, runtime) {
    const tabs = runtimeCapabilityTabs(panel, 'Runtime 扩展详情');
    const enabledSkillIds = new Set(snapshot.configuration.skills.map(skill => skill.packageId));
    const selectedSkills = packages.filter(pkg => enabledSkillIds.has(pkg.packageId));
    const skills = cardInto(tabs.skills, '已选择的扩展 Skills', '内核 Skills 默认加载；以下为该 Runtime 专属启用的扩展包。');
    if (!selectedSkills.length) skills.append(el('p', '未选择扩展 Skill。'));
    else for (const pkg of selectedSkills) skills.append(el('div', `${pkg.displayName || pkg.skillName} · 已启用`, 'runtime-detail-choice'));
    const servers = snapshot.configuration.mcpServers;
    const mcp = cardInto(tabs.mcp, '已配置的 MCP Servers', '仅列出此 Runtime 使用的 MCP；凭据不会回显。');
    if (!servers.length) mcp.append(el('p', '未配置 MCP Server。'));
    else for (const server of servers) mcp.append(el('div', `${server.displayName} · ${server.key}${server.auth?.credentialConfigured ? ' · 凭据已配置' : ''}`, 'runtime-detail-choice'));
    if (runtime.status === 'stopped') {
      const actions = el('div', undefined, 'capability-actions runtime-detail-actions'); actions.append(button('配置扩展 Skill 与 MCP', () => openRuntimeDetail(runtime, 'configure'))); actions.lastElementChild.classList.add('primary'); panel.append(actions);
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
  function renderRuntimeMcpBindings(container) {
    const selected = new Set(snapshot.configuration.mcpServerIds);
    const card = cardInto(container, '可用 MCP Servers', '选择此 Runtime 要使用的 Desktop MCP 条目。这里不保存地址或凭据；请到“ MCP 配置 ”维护设备条目。');
    const list = el('div', undefined, 'runtime-skill-options'); card.append(list);
    if (!mcpCatalog.length) list.append(el('p', '尚无 Desktop MCP 条目。请先在 MCP 配置页添加。'));
    for (const server of mcpCatalog) {
      const checkbox = input('', 'checkbox'); checkbox.checked = selected.has(server.id);
      const option = el('label', undefined, 'runtime-skill-option'); const copy = el('span'); copy.append(el('strong', server.displayName), el('small', `${server.key}${server.auth?.credentialConfigured ? ' · 凭据已配置' : ' · 无凭据或凭据未配置'}`)); option.append(checkbox, copy); list.append(option);
      checkbox.onchange = () => { checkbox.checked ? selected.add(server.id) : selected.delete(server.id); dirty = true; };
    }
    return { read: () => [...selected] };
  }
  function renderDeviceMcp() {
    const card = card('Desktop MCP Servers', '这台 Desktop 的统一 MCP JSON 配置。所有 Runtime 都可以选择已有条目；删除已被 Runtime 引用的条目会被拒绝。凭据不会回显。');
    const choices = el('div', undefined, 'capability-actions'), editor = el('div', undefined, 'capability-editor'); card.append(choices, editor);
    let selected = -1, configEditor, authKind, authMeta, secret;
    function flush() {
      if (selected < 0) return;
      const config = JSON.parse(configEditor.value), meta = JSON.parse(authMeta.value || '{}');
      if (Object.keys(config).some(k => ['auth', 'credentialConfigured', 'secretStorageKey'].includes(k))) throw new Error('认证请使用独立字段');
      const auth = { ...meta, kind: authKind.value };
      if (secret.value) { if (auth.kind === 'bearer') auth.token = secret.value; else if (auth.kind === 'basic') auth.password = secret.value; else if (auth.kind === 'custom_headers') auth.headers = JSON.parse(secret.value); else if (auth.kind !== 'none') auth.value = secret.value; }
      mcpCatalog[selected] = { ...config, auth };
    }
    function renderEditor() {
      choices.replaceChildren(); editor.replaceChildren();
      mcpCatalog.forEach((server, index) => { const b = button(server.displayName, () => { flush(); selected = index; renderEditor(); }); b.classList.toggle('selected', index === selected); choices.append(b); });
      if (selected < 0) { editor.append(el('p', '选择一个服务进行编辑，或添加一个服务。')); return; }
      const { auth, ...config } = mcpCatalog[selected]; configEditor = jsonEditor(config, 12); authKind = el('select');
      for (const kind of ['none', 'bearer', 'api_key_header', 'basic', 'query_parameter', 'custom_headers']) { const o = el('option', kind); o.value = kind; authKind.append(o); } authKind.value = auth.kind;
      const { kind, credentialConfigured, ...publicAuth } = auth; authMeta = jsonEditor(publicAuth, 3); secret = input('', 'password'); secret.placeholder = '留空保留已保存凭据；更换认证目标需重填'; secret.autocomplete = 'new-password';
      authKind.onchange = () => { authMeta.value = JSON.stringify(({ api_key_header: { headerName: 'X-API-Key' }, basic: { username: '' }, query_parameter: { parameterName: 'api_key' }, custom_headers: { headerNames: [] } })[authKind.value] ?? {}, null, 2); secret.value = ''; };
      editor.append(field('服务配置 JSON（不含认证）', configEditor), field('认证方式', authKind), field('认证元数据（headerName / username / parameterName / headerNames）', authMeta), field('凭据（Custom Headers 填 JSON 对象）', secret));
      editor.append(button('保存当前 MCP', async () => { flush(); await api('/api/mcp', { server: mcpCatalog[selected] }); dirty = false; await load(); message('Desktop MCP 已保存；所有 Runtime 可选择该条目。'); }), button('探测当前服务', async () => { flush(); const result = await api('/api/mcp/test', { server: mcpCatalog[selected] }); message(result.ok ? `连接成功，发现 ${result.toolCount} 个可用工具；尚未保存。` : '探测失败，未保存。请检查服务、认证和协议。', !result.ok); }), button('删除此 MCP', async () => { const id = mcpCatalog[selected].id; if (!id) { mcpCatalog.splice(selected, 1); selected = -1; renderEditor(); return; } await api(`/api/mcp/${id}/remove`, {}); dirty = false; await load(); message('Desktop MCP 已删除。'); }, true));
    }
    card.append(button('＋ 添加 MCP', () => { mcpCatalog.push({ displayName: '新 MCP', key: `mcp-${Date.now()}`, transport: 'http', url: 'http://127.0.0.1:8000/mcp', auth: { kind: 'none' }, timeoutMs: 5000 }); selected = mcpCatalog.length - 1; renderEditor(); })); selected = mcpCatalog.length ? 0 : -1; renderEditor();
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
