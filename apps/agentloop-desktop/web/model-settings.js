// Presentation/transport only. Credentials stay in transient password controls
// and POST bodies, never browser storage, model JSON, or previews.
const legacyThinkingKeys = ['reasoningEffort', 'thinkingMode', 'thinkingEffort', 'enableThinking', 'planningThinkingMode'];
function legacyThinkingLabel(model) {
  const values = legacyThinkingKeys.filter(key => model[key] !== undefined).map(key => `${key}=${model[key]}`);
  if (model.planningThinkingMode !== undefined) return `沿用已保存设置（${values.join('，')}）`;
  if (model.enableThinking === false || model.thinkingMode === 'disabled' || model.reasoningEffort === 'none') return '沿用已保存设置（关闭思考）';
  return `沿用已保存设置（${values.join('，')}）`;
}
const node = (tag, className = '', text) => {
  const element = document.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
function jsonObject(text, label) {
  let value;
  try { value = JSON.parse(text || '{}'); } catch { throw new Error(`${label}：JSON 格式无效，请检查括号、逗号和引号。`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是 JSON 对象。`);
  if (Object.keys(value).some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error(`${label}包含无效字段。`);
  return value;
}
function field(parent, key, title, input, hint = '', compact = false) {
  const label = node('label', 'model-field'); label.dataset.field = key;
  input.dataset.fieldInput = key; input.setAttribute('aria-label', title);
  label.append(node('span', 'model-field-title', title), input);
  if (hint && compact) { input.title = hint; input.setAttribute('aria-description', hint); }
  else if (hint) label.append(node('small', 'model-field-hint', hint));
  parent.append(label); return input;
}
function input(value, type = 'text') {
  const control = node('input'); control.type = type; control.value = value ?? '';
  control.autocomplete = 'off'; control.spellcheck = false; return control;
}
function select(options, value, emptyLabel) {
  const control = node('select');
  if (emptyLabel) { const option = node('option', '', emptyLabel); option.value = ''; control.append(option); }
  for (const { value: key, label } of options) { const option = node('option', '', label); option.value = key; control.append(option); }
  if (value !== undefined && value !== '' && !options.some(option => option.value === value)) {
    const option = node('option', '', `${value}（当前值，请核对）`); option.value = value; control.append(option);
  }
  control.value = value ?? ''; return control;
}
function required(value, label, validate) {
  value = value.trim(); if (validate && !value) throw new Error(`请填写${label}。`); return value;
}

/** Edits one model without losing provider extensions or omitted defaults. */
export function createModelParameterForm(model, definition, schema, { editable, onChange, preset, advancedOpen = false, onAdvancedToggle = () => {} }) {
  const root = node('div', 'model-parameter-form'); const basic = node('div', 'model-form-grid'); root.append(basic);
  const advanced = node('details', 'model-advanced'); advanced.open = advancedOpen; advanced.ontoggle = () => onAdvancedToggle(advanced.open); advanced.append(node('summary', '', '高级设置 · 标识、协议与扩展参数'));
  const advancedGrid = node('div', 'model-form-grid'); advanced.append(advancedGrid);
  const controls = new Map();
  for (const [key, title, hint] of [
    ['displayName', '模型显示名称', '用于对话中的模型选择。'],
    ['providerModel', '服务模型 ID', '填写服务商要求的准确 ID，区分大小写。'],
    ['key', '模型标识', '本机唯一的小写标识；修改后，原有模型引用需要重新选择。'],
  ]) controls.set(key, field(key === 'key' ? advancedGrid : basic, key, title, input(model[key]), hint, key !== 'key'));
  controls.get('key').maxLength = 100; controls.get('displayName').maxLength = 100; controls.get('providerModel').maxLength = 160;
  const defaultProtocol = preset?.defaultProtocol ?? definition.defaultProtocol;
  controls.set('protocol', field(advancedGrid, 'protocol', '调用协议', select(definition.protocols.map(value => ({ value, label: value === 'responses' ? 'Responses' : 'Chat Completions' })), model.protocol, `服务默认（${defaultProtocol}）`)));
  const toggleThinking = preset?.thinkingControl === 'toggle';
  const initialThinking = model.enableThinking === undefined ? '' : String(model.enableThinking);
  const hasLegacyThinking = legacyThinkingKeys.some(key => model[key] !== undefined);
  for (const spec of schema.fields) {
    if (spec.key === 'reasoning' && toggleThinking) {
      const control = select([{ value: 'provider-default', label: '服务默认' }, { value: 'true', label: '启用' }, { value: 'false', label: '关闭' }], initialThinking, model.reasoning !== undefined || hasLegacyThinking && model.enableThinking === undefined ? '沿用已保存思考设置' : '服务默认');
      field(basic, 'enableThinking', '启用思考', control, preset.hint, true);
      controls.set('enableThinking', control); continue;
    }
    const control = spec.type === 'select' ? select(spec.options, model[spec.key], spec.key === 'reasoning' && hasLegacyThinking ? legacyThinkingLabel(model) : '未指定（使用默认）') : input(model[spec.key], 'number');
    if (spec.type === 'number') { control.min = spec.min; control.max = spec.max; control.step = spec.step; control.placeholder = spec.placeholder ?? ''; }
    field(spec.group === 'common' ? basic : advancedGrid, spec.key, spec.label, control, spec.hint, spec.group === 'common');
    controls.set(spec.key, control);
    if (spec.key === 'reasoning' && hasLegacyThinking) {
      control.parentElement.append(node('small', 'model-field-hint', '直接选择档位即可替换原有思考参数；保存后生效。'));
    }
  }
  const effectiveProtocol = model.protocol ?? defaultProtocol;
  if (!toggleThinking && definition.id === 'openai-compatible' && effectiveProtocol === 'chat-completions') controls.get('reasoning').title = preset?.hint ?? '通用兼容服务发送标准 reasoning_effort；支持范围取决于所选模型。';
  for (const key of ['temperature', 'topP']) if (effectiveProtocol === 'responses') {
    const control = controls.get(key); control.disabled = true;
    control.parentElement.append(node('small', 'model-field-hint', '当前 Responses 调用不发送此项，已有值会保留。'));
  }
  if (toggleThinking && effectiveProtocol === 'responses') {
    controls.get('enableThinking').disabled = true;
    controls.get('enableThinking').parentElement.append(node('small', 'model-field-hint', '此平台使用 Chat Completions 思考开关；请在高级设置中核对协议。'));
  }
  const sdkOptions = node('textarea', 'desktop-json'); sdkOptions.rows = 4; sdkOptions.spellcheck = false;
  sdkOptions.value = JSON.stringify(model.providerOptions ?? {}, null, 2);
  field(advanced, 'providerOptions', 'Provider SDK 扩展参数', sdkOptions, `填写 ${definition.label} SDK 的选项，例如 SDK 文档中的 providerOptions.${definition.namespace} 对象内容；显式 SDK 选项优先于统一思考强度。`);
  const managed = new Set([...controls.keys(), 'providerOptions']);
  const extensions = node('textarea', 'desktop-json'); extensions.rows = 5; extensions.spellcheck = false;
  extensions.value = JSON.stringify(Object.fromEntries(Object.entries(model).filter(([key]) => !managed.has(key))), null, 2);
  field(advanced, 'extensions', '其他已保存参数 / 请求扩展', extensions, '原有参数完整保留。仅在需要厂商扩展或维护已有思考配置时编辑；服务地址和凭据请在连接区填写。');
  root.append(advanced);
  for (const control of [...controls.values(), sdkOptions, extensions]) {
    if (!editable) control.disabled = true;
    control.addEventListener('input', onChange); control.addEventListener('change', onChange);
  }
  function read(validate = false) {
    const extra = jsonObject(extensions.value, '其他参数');
    if (Object.keys(extra).some(key => managed.has(key) || ['apiKey', 'apiKeyEnv', 'baseUrl', 'kind', 'providerKey'].includes(key))) throw new Error('其他参数包含表单管理的字段，请在对应表单中编辑。');
    const result = { ...extra };
    // Selecting a portable level replaces the old controls in the submitted
    // draft. Other edits must preserve the exact saved thinking configuration.
    if (controls.get('reasoning')?.value) for (const key of legacyThinkingKeys) delete result[key];
    if (toggleThinking) {
      const choice = controls.get('enableThinking').value;
      if (choice !== initialThinking) {
        for (const key of [...legacyThinkingKeys, 'reasoning']) delete result[key];
      }
      if (choice === 'true' || choice === 'false') result.enableThinking = choice === 'true';
      else if (choice === 'provider-default') result.reasoning = 'provider-default';
    }
    for (const key of ['key', 'displayName', 'providerModel']) result[key] = required(controls.get(key).value, key === 'providerModel' ? '服务模型 ID' : key === 'key' ? '模型标识' : '模型显示名称', validate);
    if (validate && !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(result.key)) throw new Error('模型标识只能使用小写字母、数字、点和短横线。');
    const protocol = controls.get('protocol').value;
    if (protocol) result.protocol = protocol;
    if (validate && !definition.protocols.includes(protocol || defaultProtocol)) throw new Error('当前 Provider 不支持所选协议，请修改调用协议。');
    for (const spec of schema.fields) {
      if (spec.key === 'reasoning' && toggleThinking) continue;
      const control = controls.get(spec.key); const raw = control.value;
      if (control.validity?.badInput) throw new Error(`${spec.label}必须填写有效数字。`);
      if (raw === '') continue;
      const value = spec.type === 'number' ? Number(raw) : raw;
      if (validate && spec.type === 'number' && (!Number.isFinite(value) || value < spec.min || value > spec.max || (spec.step === 1 && !Number.isSafeInteger(value)))) throw new Error(`${spec.label}超出允许范围。`);
      if (validate && spec.type === 'select' && !spec.options.some(option => option.value === value)) throw new Error(`${spec.label}的选项无效。`);
      result[spec.key] = value;
    }
    const options = jsonObject(sdkOptions.value, 'SDK 扩展参数');
    if (Object.keys(options).some(key => schema.reservedProviderOptions.includes(key))) throw new Error('SDK 扩展参数不能覆盖服务连接、消息、工具或表单中的通用参数。');
    if (Object.keys(options).length || model.providerOptions !== undefined) result.providerOptions = options;
    if (validate && result.maxOutputTokens !== undefined && result.maxOutputTokens >= (result.contextWindowTokens ?? 128000)) throw new Error('最大输出必须小于上下文窗口。');
    if (validate && result.reasoning !== undefined && legacyThinkingKeys.some(key => result[key] !== undefined)) throw new Error('统一思考强度不能与原有思考参数同时使用。请先改用统一思考设置。');
    return result;
  }
  return { element: root, read, controls };
}

export function installModelSettings({ api, element, refreshModels, status, managed = false }) {
  const dialog = element('model-settings');
  let snapshot; let schema; let providers = []; let selected = -1; let selectedModel = -1; let dirty = false; let loading = false;
  let providerControls; let modelForm; let modelAdvancedOpen = false;
  const message = (text, error = false) => { element('model-settings-status').textContent = text; element('model-settings-status').classList.toggle('error', error); };
  const errors = {
    model_configuration_stale: '其他标签页已修改配置。请先重新读取，再重新编辑。',
    model_configuration_read_only: '模型由启动环境或宿主提供，当前配置只读。',
    model_configuration_invalid: '配置无效，请检查必填项、Provider 与协议、思考参数及唯一标识。更换地址时必须重新填写 API Key。',
    model_endpoint_invalid: '服务地址必须为 HTTP 或 HTTPS，不能包含账号、密码、查询参数或片段。',
    runtime_active_runs_prevent_reconfiguration: '仍有活动任务或本机读取，请等待任务退出后重试。',
    runtime_operation_in_progress: 'Runtime 正在执行管理操作，请稍后重试。',
  };
  const definition = () => schema.providers.find(entry => entry.id === (providers[selected]?.kind ?? 'openai-compatible'));
  const servicePreset = provider => schema.presets.find(entry => entry.id === provider?.preset);
  const defaultProtocol = provider => servicePreset(provider)?.defaultProtocol ?? schema.providers.find(entry => entry.id === (provider.kind ?? 'openai-compatible')).defaultProtocol;
  // Make an old implicit protocol explicit before changing service defaults.
  function preserveProtocols(provider) { for (const model of provider.models) model.protocol ??= defaultProtocol(provider); }
  function updateControls() {
    const readOnly = loading || !snapshot?.editable;
    element('provider-api-key').disabled = readOnly;
    element('provider-add').disabled = readOnly; element('provider-delete').disabled = readOnly || selected < 0;
    element('model-add').disabled = readOnly || selected < 0;
    element('model-settings-save').disabled = readOnly || !dirty;
    element('model-settings-discard').disabled = loading;
    element('model-test').disabled = readOnly || selectedModel < 0;
    element('model-delete').disabled = readOnly || selectedModel < 0;
    for (const control of element('provider-editors').querySelectorAll('input, select, textarea, button')) {
      if (loading || !snapshot?.editable) control.disabled = true;
    }
    for (const button of element('provider-list').querySelectorAll('button')) button.disabled = loading;
    for (const button of element('model-list').querySelectorAll('button')) button.disabled = loading;
  }
  function markDirty() { dirty = true; element('model-test-status').textContent = ''; updateControls(); }
  function flush(validate = false) {
    if (selected < 0 || !providerControls) return;
    const provider = providers[selected];
    provider.displayName = required(providerControls.displayName.value, '服务名称', validate);
    provider.key = required(providerControls.key.value, '服务标识', validate);
    provider.baseUrl = required(providerControls.baseUrl.value, '服务地址', validate);
    if (element('provider-api-key').value.trim()) provider.apiKey = element('provider-api-key').value.trim();
    if (selectedModel >= 0 && modelForm) provider.models[selectedModel] = modelForm.read(validate);
  }
  function renderProviderForm() {
    const container = element('provider-form'); container.replaceChildren(); providerControls = undefined;
    element('provider-api-key').value = '';
    if (selected < 0) return;
    const provider = providers[selected]; const grid = node('div', 'model-form-grid'); container.append(grid);
    const name = field(grid, 'provider.displayName', '服务名称', input(provider.displayName)); name.maxLength = 100;
    const preset = field(grid, 'provider.preset', '服务平台', select(schema.presets.map(entry => ({ value: entry.id, label: entry.label })), provider.preset, '自定义 / 沿用当前连接'));
    const baseUrl = field(container, 'provider.baseUrl', '服务地址', input(provider.baseUrl, 'url'), '更换平台地址后，请重新填写 API Key。', true);
    const advanced = node('details', 'model-advanced provider-advanced'); advanced.append(node('summary', '', '连接高级设置'));
    const advancedGrid = node('div', 'model-form-grid'); advanced.append(advancedGrid); container.append(advanced);
    const kind = field(advancedGrid, 'provider.kind', 'SDK 驱动', select(schema.providers.map(entry => ({ value: entry.id, label: entry.label })), provider.kind ?? 'openai-compatible'), definition().hint);
    const key = field(advancedGrid, 'provider.key', '服务标识', input(provider.key), '小写字母、数字和短横线；修改后需要重新填写凭据。'); key.maxLength = 80;
    providerControls = { displayName: name, preset, kind, baseUrl, key };
    for (const control of Object.values(providerControls)) { control.disabled = !snapshot?.editable; control.addEventListener('input', markDirty); }
    preset.onchange = () => {
      try {
        flush(); preserveProtocols(provider);
        const next = schema.presets.find(entry => entry.id === preset.value);
        if (next) {
          provider.preset = next.id; provider.kind = next.kind;
          if (next.baseUrl) provider.baseUrl = next.baseUrl;
          if (!provider.displayName || provider.displayName === '新服务') provider.displayName = next.label;
        } else delete provider.preset;
        markDirty(); render(); message('平台预设已应用；已有模型参数保留，请核对服务地址与凭据。');
      } catch (error) { message(error.message, true); }
    };
    kind.onchange = () => {
      try {
        flush(); preserveProtocols(provider); provider.kind = kind.value; delete provider.preset;
        if (!provider.baseUrl) provider.baseUrl = definition().baseUrl;
        markDirty(); render(); message('Provider 类型已修改，请核对模型协议和高级参数。');
      } catch (error) { message(error.message, true); }
    };
    const recommendedUrl = servicePreset(provider)?.baseUrl ?? definition().baseUrl;
    const recommended = node('button', 'model-address-reset', '使用推荐地址'); recommended.type = 'button'; recommended.disabled = !snapshot?.editable || !recommendedUrl;
    recommended.onclick = () => { baseUrl.value = recommendedUrl; markDirty(); };
    baseUrl.parentElement.append(recommended);
    const hint = servicePreset(provider)?.hint;
    if (hint) container.append(node('small', 'model-field-hint', hint));
    element('provider-connection-title').textContent = `服务连接 · ${servicePreset(provider)?.label ?? definition().label}`;
    element('provider-api-key').value = provider.apiKey ?? '';
    element('provider-key-hint').textContent = provider.credentialConfigured ? '凭据已保存；留空保留，更换地址或服务标识需重新填写' : '请填写此服务的 API Key';
  }
  function renderModels() {
    const list = element('model-list'); list.replaceChildren(); element('model-form').replaceChildren(); modelForm = undefined;
    const provider = providers[selected]; const model = provider?.models[selectedModel];
    element('model-empty').hidden = Boolean(provider?.models.length);
    element('model-editor').hidden = !model;
    if (!provider) return;
    provider.models.forEach((entry, index) => {
      const button = node('button', `model-choice${index === selectedModel ? ' selected' : ''}`); button.type = 'button'; button.setAttribute('aria-pressed', String(index === selectedModel));
      button.append(node('strong', '', entry.displayName || '未命名模型'), node('small', '', entry.providerModel || '待填写模型 ID'));
      button.onclick = () => { try { flush(); selectedModel = index; modelAdvancedOpen = false; element('model-test-status').textContent = ''; render(); } catch (error) { message(error.message, true); } };
      list.append(button);
    });
    if (model) {
      modelForm = createModelParameterForm(model, definition(), schema, { preset: servicePreset(provider), editable: snapshot?.editable, onChange: markDirty, advancedOpen: modelAdvancedOpen, onAdvancedToggle: value => { modelAdvancedOpen = value; } });
      element('model-form').append(modelForm.element);
      modelForm.controls.get('protocol').onchange = () => { try { flush(); markDirty(); render(); } catch (error) { message(error.message, true); } };
    }
  }
  function render() {
    const list = element('provider-list'); list.replaceChildren();
    providers.forEach((provider, index) => {
      const button = node('button', `desktop-provider-choice${index === selected ? ' selected' : ''}`); button.type = 'button'; button.setAttribute('aria-pressed', String(index === selected));
      button.append(node('strong', '', provider.displayName || '新服务'), node('small', '', `${provider.models.length} 个模型 · ${provider.apiKey ? '已填写凭据' : provider.credentialConfigured ? '凭据已保存' : '待填写凭据'}`));
      button.onclick = () => { try { flush(); selected = index; selectedModel = provider.models.length ? 0 : -1; modelAdvancedOpen = false; element('provider-connection').open = !provider.credentialConfigured; element('model-test-status').textContent = ''; render(); } catch (error) { message(error.message, true); } };
      list.append(button);
    });
    element('provider-empty').hidden = providers.length > 0; element('provider-editors').hidden = selected < 0;
    renderProviderForm(); renderModels(); updateControls();
  }
  async function load() {
    loading = true; snapshot = undefined; providers = []; selected = -1; selectedModel = -1; dirty = false; render(); message('正在读取本机配置…');
    try {
      [snapshot, schema] = await Promise.all([api('/api/model-configuration'), api('/api/model-configuration/schema')]);
      providers = structuredClone(snapshot.configuration.providers); selected = providers.length ? 0 : -1; selectedModel = providers[0]?.models.length ? 0 : -1;
      modelAdvancedOpen = false; element('provider-connection').open = !providers[0]?.credentialConfigured;
      message(!snapshot.editable ? errors.model_configuration_read_only : '选择服务和模型进行编辑；保存与测试调用分别操作。');
    } catch { snapshot = undefined; providers = []; selected = -1; selectedModel = -1; message('读取模型配置失败，请重新读取。', true); }
    finally { loading = false; render(); }
  }
  function validate(currentModelOnly = false) {
    flush(true);
    const targets = currentModelOnly ? [{ ...providers[selected], models: [providers[selected].models[selectedModel]] }] : providers;
    const providerKeys = new Set(); const modelKeys = new Set();
    for (const provider of targets) {
      if (!provider.displayName.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(provider.key) || providerKeys.has(provider.key)) throw new Error('请检查服务名称和标识；服务标识必须唯一且使用小写字母、数字和短横线。');
      providerKeys.add(provider.key);
      let url; try { url = new URL(provider.baseUrl); } catch { throw new Error(`“${provider.displayName}”的服务地址无效。`); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('服务地址必须为 HTTP 或 HTTPS，且不能包含账号、密码、查询参数或片段。');
      const providerDefinition = schema.providers.find(entry => entry.id === (provider.kind ?? 'openai-compatible'));
      if (providerDefinition.strictToolBasePathSuffix && !url.pathname.replace(/\/$/, '').endsWith(providerDefinition.strictToolBasePathSuffix)) throw new Error(providerDefinition.hint);
      for (const model of provider.models) {
        createModelParameterForm(model, providerDefinition, schema, { preset: servicePreset(provider), editable: false, onChange() {} }).read(true);
        if (modelKeys.has(model.key)) throw new Error(`模型标识“${model.key}”重复，请修改。`);
        modelKeys.add(model.key);
      }
    }
    return targets;
  }
  function close(event) {
    if (loading || dirty) { event?.preventDefault(); message(loading ? '正在处理，请稍候。' : '有未保存的更改，请先保存或放弃。', true); return; }
    dialog.close();
  }
  if (!managed) {
    const open = async () => { if (!dialog.open) { dialog.showModal(); await load(); } };
    element('model-settings-open').onclick = open; element('model-settings-mobile').onclick = open;
    element('model-settings-close').onclick = () => close(); dialog.addEventListener('cancel', close);
  }
  dialog.addEventListener('close', () => { providers = []; selected = -1; selectedModel = -1; snapshot = undefined; dirty = false; render(); });
  element('model-settings-discard').onclick = () => { if (!loading) void load(); };
  element('provider-api-key').addEventListener('input', markDirty);
  element('provider-add').onclick = () => {
    try {
      flush(); let count = 1; while (providers.some(provider => provider.key === `provider-${count}`)) count++;
      providers.push({ key: `provider-${count}`, displayName: '新服务', baseUrl: '', models: [] }); selected = providers.length - 1; selectedModel = -1; modelAdvancedOpen = false; element('provider-connection').open = true;
      markDirty(); render(); message('请选择服务平台，填写 API Key，然后添加模型。');
    } catch (error) { message(error.message, true); }
  };
  element('provider-delete').onclick = () => { if (loading || !snapshot?.editable || selected < 0) return; providers.splice(selected, 1); selected = providers.length ? 0 : -1; selectedModel = providers[0]?.models.length ? 0 : -1; markDirty(); render(); };
  element('model-add').onclick = () => {
    try {
      flush(); let count = 1; const keys = new Set(providers.flatMap(provider => provider.models.map(model => model.key))); while (keys.has(`model-${count}`)) count++;
      providers[selected].models.push({ key: `model-${count}`, displayName: '新模型', providerModel: '' }); selectedModel = providers[selected].models.length - 1; modelAdvancedOpen = false;
      markDirty(); render();
    } catch (error) { message(error.message, true); }
  };
  element('model-delete').onclick = () => {
    if (selectedModel < 0) return;
    const index = selectedModel; selectedModel = -1; flush(); providers[selected].models.splice(index, 1); selectedModel = providers[selected].models.length ? Math.min(index, providers[selected].models.length - 1) : -1;
    markDirty(); render();
  };
  element('model-test').onclick = async () => {
    if (loading || !snapshot?.editable || selectedModel < 0) return;
    let targets;
    try { targets = validate(true); } catch (error) { message(error.message, true); return; }
    loading = true; updateControls(); const feedback = element('model-test-status'); feedback.textContent = '正在使用当前编辑内容测试调用…';
    try {
      const result = await api('/api/model-configuration/test', { revision: snapshot.revision, configuration: { reuseCloudModels: false, providers: targets }, modelKey: providers[selected].models[selectedModel].key });
      feedback.textContent = `${result.ok ? '✓' : '×'} ${result.message}（${(result.durationMs / 1000).toFixed(1)} 秒）`;
      feedback.classList.toggle('error', !result.ok);
    } catch (error) { feedback.textContent = errors[error.message] ?? '测试未完成，请核对配置后重试。'; feedback.classList.toggle('error', true); }
    finally { loading = false; render(); }
  };
  element('model-settings-save').onclick = async () => {
    if (loading || !snapshot?.editable || !dirty) return;
    try { validate(); } catch (error) { message(error.message, true); return; }
    loading = true; updateControls(); message('正在保存本机配置…'); let saved = false;
    try {
      snapshot = await api('/api/model-configuration', { revision: snapshot.revision, configuration: { reuseCloudModels: false, providers } });
      saved = true; providers = structuredClone(snapshot.configuration.providers); dirty = false; element('provider-api-key').value = ''; element('model-test-status').textContent = '';
      await refreshModels(); message(snapshot.credentialCleanupPending ? '配置已保存，旧凭据清理未完成。' : '配置已保存并生效。基础调用和实际任务能力请分别验证。'); status('本机模型目录已更新，请选择执行模型。');
    } catch (error) { message(saved ? '配置已保存，但模型目录刷新失败，请刷新页面。' : errors[error.message] ?? '保存失败，请重新读取配置核对。', true); }
    finally { loading = false; render(); }
  };
  return { load, canLeave() { if (loading || dirty) { message(loading ? '正在处理，请稍候。' : '有未保存的模型更改，请先保存或放弃。', true); return false; } return true; } };
}
