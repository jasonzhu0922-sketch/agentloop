import { installModelSettings } from './model-settings.js';

// Desktop-owned presentation and transport. No cloud/Router management client.
export function installCapabilitySettings({ api, element, refreshModels, status, currentRuntime, refreshCapabilities }) {
  const models = installModelSettings({ api, element, refreshModels, status, managed: true });
  const dialog = element('model-settings'), body = element('capability-body');
  let tab = 'models', target, dirty = false, working = false, snapshot, runtimeList = [], packages = [];
  const labels = { skills: ['Skills', '导入本机 Skill 包，在 Runtime 中选择启用。内置 Skill 不在扩展包列表中。'], runtimes: ['Runtime', '管理独立的本机执行环境、生命周期和扩展 Skill。'], connectors: ['Connector', '本机模块由启动配置加载；连接和凭据按账号隔离。修改前先停止 Runtime。'], mcp: ['MCP', '每个 Runtime 独立配置 HTTP MCP。修改前先停止 Runtime，保存后启动加载。'] };
  const errors = { runtime_must_be_stopped_for_configuration: '请先在 Runtime 页停止对应实例，再编辑配置。', runtime_active_runs_prevent_reconfiguration: '仍有活动任务，请等待任务结束。', runtime_configuration_stale: '配置已被其他页面修改，请重新读取后再编辑。', mcp_credential_required: '缺少凭据；更换地址或认证目标后，必须重新填写。', connector_connection_not_authorized: '不能使用其他账号的 Connector 连接。', skill_import_invalid: 'Skill 包无效：请检查 SKILL.md、归档路径、文件类型和大小限制。', runtime_default_cannot_be_removed: '不能删除默认 Runtime。' };
  const message = (text, error = false) => { const e = element('capability-status'); e.textContent = text; e.classList.toggle('error', error); };
  function el(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
  function button(text, fn, danger = false) { const e = el('button', text, danger ? 'danger' : ''); e.type = 'button'; e.onclick = () => void perform(fn); return e; }
  function input(value = '', type = 'text') { const e = el('input'); e.type = type; e.value = value; e.autocomplete = 'off'; e.spellcheck = false; return e; }
  function field(title, control) { const e = el('label', undefined, 'capability-field'); e.append(el('span', title), control); return e; }
  function jsonEditor(value, rows = 8) { const e = el('textarea', undefined, 'desktop-json'); e.value = JSON.stringify(value, null, 2); e.rows = rows; e.spellcheck = false; return e; }
  function card(title, description) { const e = el('section', undefined, 'capability-card'); e.append(el('strong', title)); if (description) e.append(el('p', description)); body.append(e); return e; }
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
  function reset() { dirty = false; body.replaceChildren(); snapshot = undefined; }
  async function changed() { await refreshCapabilities(); }
  async function load() {
    reset(); message('正在读取本机配置…');
    [runtimeList, packages] = await Promise.all([api('/api/runtimes').then(r => r.runtimes), api('/api/skills').then(r => r.skills)]);
    if (!runtimeList.some(r => r.id === target)) target = currentRuntime() || runtimeList[0]?.id;
    if (tab !== 'skills') {
      const picker = el('select'); picker.dataset.runtimePicker = 'true'; picker.setAttribute('aria-label', '设置目标 Runtime');
      for (const r of runtimeList) { const option = el('option', `${r.displayName} · ${r.status}`); option.value = r.id; picker.append(option); }
      picker.value = target;
      picker.onchange = () => { if (!canLeave()) { picker.value = target; return; } target = picker.value; void perform(load); };
      body.append(field('目标 Runtime', picker));
      snapshot = await api(`/api/runtimes/${target}/configuration`);
    }
    if (tab === 'skills') await renderSkills();
    else if (tab === 'runtimes') renderRuntimes();
    else if (tab === 'mcp') renderMcp();
    else if (tab === 'connectors') await renderConnectors();
    body.append(button('放弃更改并重新读取', load)); dirty = false; message('配置已读取。凭据不会回显；导入和保存不代表真实执行已验收。');
  }
  function stopped() { return runtimeList.find(r => r.id === target)?.status === 'stopped'; }
  function draft() { return { skillPackageIds: snapshot.configuration.skills.map(s => s.packageId), mcpServers: snapshot.configuration.mcpServers.map(s => ({ ...s, auth: Object.fromEntries(Object.entries(s.auth).filter(([k]) => k !== 'credentialConfigured')) })) }; }
  async function save(configuration) { snapshot = await api(`/api/runtimes/${target}/configuration`, { configuration, revision: snapshot.revision }); dirty = false; await load(); await changed(); message('配置已保存。请启动此 Runtime 后执行任务验证。'); }
  async function renderSkills() {
    const upload = card('导入 Skill', '支持 ZIP 或目录，单文件 ≤ 8 MiB，总解压大小 ≤ 32 MiB，最多 1000 个文件。只接受普通文件，不执行导入脚本。');
    const zip = input('', 'file'); zip.accept = '.zip'; zip.setAttribute('aria-label', '选择 Skill ZIP');
    const directory = input('', 'file'); directory.multiple = true; directory.setAttribute('webkitdirectory', ''); directory.setAttribute('aria-label', '选择 Skill 目录');
    async function encode(file) { const bytes = new Uint8Array(await file.arrayBuffer()); let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(s); }
    async function importFiles(files, isZip) {
      if (!files.length) throw new Error('请选择文件');
      if (files.length > 1000 || files.reduce((sum, f) => sum + f.size, 0) > (isZip ? 16 : 32) * 1024 * 1024 || (!isZip && files.some(f => f.size > 8 * 1024 * 1024))) throw new Error('文件超过大小限制');
      const payload = isZip ? { zipBase64: await encode(files[0]) } : { files: await Promise.all(files.map(async f => ({ path: f.webkitRelativePath || f.name, contentBase64: await encode(f) }))) };
      await api('/api/skills/import', payload); zip.value = ''; directory.value = ''; dirty = false; await load(); message('Skill 已导入设备库。请在 Runtime 页勾选并保存后启动。');
    }
    upload.append(field('ZIP 文件', zip), button('导入 ZIP', () => importFiles([...zip.files], true)), field('本机目录', directory), button('导入目录', () => importFiles([...directory.files], false)));
    if (!packages.length) card('暂无扩展 Skill', '可以导入 Skill 包；不会自动启用或上传到账号服务。');
    for (const p of packages) {
      const c = card(p.displayName || p.skillName, `${p.description} · ${p.validationStatus}${p.metadataNeedsReview ? ' · 元数据待检查' : ''}`);
      c.append(button('查看 / 编辑声明', async () => {
        if (dirty) throw new Error('请先保存或放弃更改');
        const meta = await api(`/api/skills/${p.packageId}/metadata`); const editor = jsonEditor(meta.declaration, 16);
        c.replaceChildren(el('strong', p.displayName), el('p', '编辑设备库中的声明元数据，不改写原始 Skill 内容；保存后需重启使用此包的 Runtime。'), editor);
        editor.disabled = !meta.editable;
        c.append(button('保存声明', async () => { await api(`/api/skills/${p.packageId}/metadata`, { declaration: JSON.parse(editor.value) }); dirty = false; await load(); message('声明已保存，请重启使用此 Skill 的 Runtime。'); }));
      }));
    }
  }
  function renderRuntimes() {
    const r = runtimeList.find(r => r.id === target); const c = card(r.displayName, `${r.isDefault ? '默认 · ' : ''}${r.status} · 活动任务 ${r.activeRunCount}${r.pendingAction ? ` · 等待 ${r.pendingAction}` : ''}`);
    const name = input(r.displayName); name.maxLength = 100;
    c.append(field('显示名称', name), button('重命名', async () => { await api(`/api/runtimes/${target}/rename`, { displayName: name.value }); dirty = false; await load(); await changed(); }));
    const actions = el('div', undefined, 'capability-actions');
    for (const [action, title] of [['start', '启动'], ['stop', '停止'], ['drain', '排空'], ['restart', '重启']]) actions.append(button(title, async () => {
      if (dirty) throw new Error('请先保存或放弃更改');
      await api(`/api/runtimes/${target}/${action}`, {}); await load(); await changed(); message('生命周期操作已提交；有活动任务时会先排空，不强制中断。');
    }));
    if (!r.isDefault) actions.append(button('删除此 Runtime', async () => {
      if (dirty || !confirm('删除此 Runtime 及其本机对话、附件、产物和配置？设备共享 Skill 库和模型不受影响。')) return;
      await api(`/api/runtimes/${target}/remove`, {}); target = undefined; await load(); await changed(); message('Runtime 及其专属数据已删除；此操作不能由设置页恢复。');
    }, true));
    c.append(actions);
    const skills = card('启用扩展 Skills', '停止 Runtime 后编辑。取消勾选仅解除绑定，不删除设备库文件。');
    const choices = [];
    for (const p of packages) { const checkbox = input('', 'checkbox'); checkbox.checked = snapshot.configuration.skills.some(s => s.packageId === p.packageId); checkbox.disabled = !stopped() || p.validationStatus !== 'valid'; choices.push([p, checkbox]); skills.append(field(p.displayName, checkbox)); }
    const saveButton = button('保存 Skill 绑定', async () => { const config = draft(); config.skillPackageIds = choices.filter(([, e]) => e.checked).map(([p]) => p.packageId); await save(config); }); saveButton.disabled = !stopped(); skills.append(saveButton);
    const create = card('新建 Runtime', '独立会话与执行环境；共享设备模型和 Skill 库。'); const newName = input(''); newName.maxLength = 100;
    create.append(field('名称', newName), button('创建并启动', async () => { const result = await api('/api/runtimes', { displayName: newName.value }); target = result.runtime.id; dirty = false; await load(); await changed(); }));
  }
  function renderMcp() {
    let servers = draft().mcpServers;
    const list = card('HTTP MCP 服务', '支持无认证、Bearer、API Key Header、Basic、Query Parameter、Custom Headers。HTTP 为明文传输，请仅用于可信网络。URL 不允许携带凭据、查询参数或片段。');
    const choices = el('div', undefined, 'capability-actions'); list.append(choices);
    const editorArea = el('div', undefined, 'capability-editor'); list.append(editorArea);
    let selected = -1, configEditor, authKind, authMeta, secret;
    function flush() {
      if (selected < 0) return;
      const config = JSON.parse(configEditor.value), meta = JSON.parse(authMeta.value || '{}');
      if (Object.keys(config).some(k => ['auth', 'credentialConfigured', 'secretStorageKey'].includes(k))) throw new Error('认证请使用独立字段');
      const auth = { ...meta, kind: authKind.value };
      if (secret.value) {
        if (auth.kind === 'bearer') auth.token = secret.value;
        else if (auth.kind === 'basic') auth.password = secret.value;
        else if (auth.kind === 'custom_headers') auth.headers = JSON.parse(secret.value);
        else if (auth.kind !== 'none') auth.value = secret.value;
      }
      servers[selected] = { ...config, auth };
    }
    function renderEditor() {
      choices.replaceChildren(); editorArea.replaceChildren();
      servers.forEach((s, i) => { const b = button(s.displayName, () => { flush(); selected = i; renderEditor(); }); b.classList.toggle('selected', i === selected); choices.append(b); });
      if (selected < 0) { editorArea.append(el('p', '选择服务进行编辑，或添加一个服务。')); return; }
      const { auth, ...config } = servers[selected]; configEditor = jsonEditor(config, 12); authKind = el('select');
      for (const kind of ['none', 'bearer', 'api_key_header', 'basic', 'query_parameter', 'custom_headers']) { const o = el('option', kind); o.value = kind; authKind.append(o); } authKind.value = auth.kind;
      const { kind, token, password, value, headers, ...publicAuth } = auth; authMeta = jsonEditor(publicAuth, 3);
      secret = input(token ?? password ?? value ?? (headers ? JSON.stringify(headers) : ''), 'password'); secret.placeholder = '留空保留已保存凭据；更换地址或认证目标需重填'; secret.autocomplete = 'new-password';
      authKind.onchange = () => { authMeta.value = JSON.stringify(({ api_key_header: { headerName: 'X-API-Key' }, basic: { username: '' }, query_parameter: { parameterName: 'api_key' }, custom_headers: { headerNames: [] } })[authKind.value] ?? {}, null, 2); secret.value = ''; };
      editorArea.append(field('服务配置 JSON（不含认证）', configEditor), field('认证方式', authKind), field('认证元数据（headerName / username / parameterName / headerNames）', authMeta), field('凭据（Custom Headers 填 JSON 对象）', secret));
      editorArea.append(button('探测当前服务', async () => { flush(); const result = await api(`/api/runtimes/${target}/mcp/test`, { server: servers[selected] }); message(result.ok ? `连接成功，发现 ${result.toolCount} 个可用工具；尚未保存。` : '探测失败，未保存。请检查服务、认证和协议。', !result.ok); }));
      const remove = button('移除此服务', () => { servers.splice(selected, 1); selected = -1; dirty = true; renderEditor(); }); remove.disabled = !stopped(); editorArea.append(remove);
      for (const e of editorArea.querySelectorAll('input,textarea,select')) e.disabled = !stopped();
    }
    list.append(button('添加服务', () => { if (!stopped()) throw new Error('runtime_must_be_stopped_for_configuration'); flush(); servers.push({ displayName: '新 MCP', key: `mcp-${Date.now()}`, transport: 'http', url: 'http://127.0.0.1:8000/mcp', auth: { kind: 'none' }, timeoutMs: 5000 }); selected = servers.length - 1; dirty = true; renderEditor(); }));
    selected = servers.length ? 0 : -1; renderEditor();
    const saveButton = button('保存 MCP 配置', async () => { flush(); const config = draft(); config.mcpServers = servers; await save(config); }); saveButton.disabled = !stopped(); list.append(saveButton);
  }
  async function renderConnectors() {
    const [{ connectors }, { connections }] = await Promise.all([api('/api/connectors/catalog'), api(`/api/runtimes/${target}/connectors`)]);
    card('设备模块与账号连接', '只有启动时显式批准的本机模块可配置。凭据加密保存在本机，不回显、不发送给账号服务。保存后启动 Runtime；在对话区勾选本轮授权的连接。');
    if (!connectors.length) card('尚无已加载的 Connector 模块', '请通过 AGENTLOOP_DESKTOP_CONNECTOR_MODULES_JSON 配置本机模块后重启 Desktop。网页不能安装或指定代码路径。');
    for (const c of connections) {
      const section = card(c.displayName, `${c.connectorKey} · ${c.enabled ? '已启用' : '已停用'} · ${c.credentialConfigured ? '凭据已保存' : '无凭据'}${!c.moduleAvailable ? ' · 模块不可用' : ''}`);
      section.append(button('编辑连接', () => edit(c)), button('删除连接', async () => { if (!confirm('删除此账号的连接及本机凭据？')) return; await api(`/api/runtimes/${target}/connectors/${c.id}/remove`, {}); dirty = false; await load(); await changed(); }, true));
    }
    const editor = card('连接编辑器');
    function edit(existing) {
      if (dirty) throw new Error('请先保存或放弃更改');
      editor.replaceChildren(el('strong', existing ? '编辑连接' : '新建连接'));
      const module = el('select'); for (const c of connectors) { const o = el('option', c.displayName); o.value = c.key; module.append(o); } if (existing) module.value = existing.connectorKey;
      module.disabled = Boolean(existing) || !stopped();
      const name = input(existing?.displayName ?? ''), scopes = jsonEditor(existing?.scopes ?? [], 3), enabled = input('', 'checkbox'); enabled.checked = existing?.enabled ?? true;
      const credentials = input('', 'password'); credentials.autocomplete = 'new-password'; credentials.placeholder = 'JSON 对象，如 {"accessToken":"…"}；留空保留，{} 清除';
      editor.append(field('Connector 模块', module), field('显示名称', name), field('启用连接', enabled), field('Scopes（JSON 数组）', scopes), field('凭据（仅本次提交，留空保留）', credentials));
      const saveButton = button('保存连接', async () => {
        const connector = { ...(existing ? { id: existing.id } : {}), connectorKey: module.value, displayName: name.value, enabled: enabled.checked, scopes: JSON.parse(scopes.value), ...(credentials.value ? { credentials: JSON.parse(credentials.value) } : {}) };
        const result = await api(`/api/runtimes/${target}/connectors`, { connector }); credentials.value = ''; dirty = false; await load(); await changed(); message(result.credentialCleanupPending ? '连接已保存，旧凭据清理未完成。' : '连接已保存；请启动 Runtime 后在对话中勾选授权。');
      }); saveButton.disabled = !stopped() || !connectors.length; editor.append(saveButton);
      for (const e of [name, scopes, enabled, credentials]) e.disabled = !stopped();
    }
    edit();
  }
  async function show(next) {
    if (!canLeave()) return;
    tab = next; element('settings-models').hidden = tab !== 'models'; element('settings-capabilities').hidden = tab === 'models';
    for (const b of document.querySelectorAll('[data-settings-tab]')) { b.classList.toggle('active', b.dataset.settingsTab === tab); b.setAttribute('aria-pressed', String(b.dataset.settingsTab === tab)); }
    if (tab === 'models') await models.load();
    else { element('capability-title').textContent = labels[tab][0]; element('capability-description').textContent = labels[tab][1]; await load(); }
  }
  for (const b of document.querySelectorAll('[data-settings-tab]')) b.onclick = () => void perform(() => show(b.dataset.settingsTab));
  // show() checks canLeave before perform sets working.
  for (const b of document.querySelectorAll('[data-settings-tab]')) b.onclick = () => { if (canLeave()) { const next = b.dataset.settingsTab; void show(next).catch(() => message('设置读取失败。', true)); } };
  async function open() { if (dialog.open) return; target = currentRuntime(); tab = 'models'; dirty = false; dialog.showModal(); await show('models'); }
  element('model-settings-open').onclick = () => void open(); element('model-settings-mobile').onclick = () => void open();
  const close = event => { if (!canLeave()) { event?.preventDefault(); return; } dialog.close(); };
  element('model-settings-close').onclick = () => close(); dialog.addEventListener('cancel', close);
  dialog.addEventListener('close', () => { reset(); target = undefined; });
}
