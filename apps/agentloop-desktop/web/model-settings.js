// Presentation/transport only. Credential values remain in this transient
// editor and the POST body; never browser storage, URLs, or rendered JSON.
export function installModelSettings({ api, element, refreshModels, status }) {
  const dialog = element('model-settings'); let snapshot; let providers = []; let selected = -1; let dirty = false; let loading = false;
  const message = (text, error = false) => { element('model-settings-status').textContent = text; element('model-settings-status').classList.toggle('error', error); };
  const errors = {
    model_configuration_stale: '其他标签页已修改配置。请先放弃本次更改并重新读取，再重新编辑。',
    model_configuration_read_only: '当前由启动环境或宿主提供模型，设置只读。移除环境变量并重启后可编辑本机配置。',
    model_configuration_invalid: '配置无效：请检查必填字段、凭据、模型参数和唯一 ID。更换服务地址时必须重新填写 API Key。',
    model_endpoint_invalid: '服务地址必须为 HTTP 或 HTTPS，不能包含账号、密码、查询参数或片段。HTTP 不加密传输 API Key 和推理内容，请仅用于可信网络。',
    runtime_active_runs_prevent_reconfiguration: '仍有活动任务或本机读取，请等待任务完全退出后再保存。',
    runtime_operation_in_progress: 'Runtime 正在执行管理操作，请稍后重试。',
  };
  function updateControls() {
    const readOnly = loading || !snapshot?.editable;
    for (const id of ['provider-add', 'provider-json', 'models-json', 'provider-api-key', 'provider-format', 'models-format', 'provider-delete']) element(id).disabled = readOnly;
    element('model-settings-save').disabled = readOnly || !dirty;
    element('model-settings-discard').disabled = loading;
  }
  function markDirty() { dirty = true; updateControls(); }
  function parse(text) {
    try { return JSON.parse(text); } catch { throw new Error('JSON 格式无效，请检查括号、逗号和引号。'); }
  }
  function flush() {
    if (selected < 0) return;
    const provider = parse(element('provider-json').value); const models = parse(element('models-json').value);
    if (!provider || Array.isArray(provider) || typeof provider !== 'object' || Object.keys(provider).some(key => !['key', 'displayName', 'baseUrl'].includes(key)) || !Array.isArray(models)) throw new Error('Provider 只填写 key、displayName、baseUrl；模型列表必须为 JSON 数组。API Key 请填写在独立密码框中。');
    providers[selected] = { ...provider, credentialConfigured: providers[selected].credentialConfigured, models,
      ...(element('provider-api-key').value.trim() ? { apiKey: element('provider-api-key').value.trim() } : {}) };
  }
  function render() {
    element('provider-list').replaceChildren();
    providers.forEach((provider, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = `desktop-provider-choice${index === selected ? ' selected' : ''}`;
      const title = document.createElement('strong'); title.textContent = provider.displayName || provider.key || '新 Provider';
      const detail = document.createElement('small'); detail.textContent = `${provider.models.length} 个模型 · ${provider.apiKey ? '本次已填写凭据' : provider.credentialConfigured ? '凭据已保存' : '待填写凭据'}`;
      button.append(title, detail); button.disabled = loading; button.setAttribute('aria-pressed', String(index === selected));
      button.onclick = () => { if (loading || index === selected) return; try { flush(); selected = index; render(); } catch (error) { message(error.message, true); } };
      element('provider-list').append(button);
    });
    element('provider-empty').hidden = providers.length > 0; element('provider-editors').hidden = selected < 0;
    if (selected >= 0) {
      const provider = providers[selected];
      element('provider-json').value = JSON.stringify({ key: provider.key, displayName: provider.displayName, baseUrl: provider.baseUrl }, null, 2);
      element('models-json').value = JSON.stringify(provider.models, null, 2);
      element('provider-api-key').value = provider.apiKey ?? '';
      element('provider-key-hint').textContent = provider.credentialConfigured ? '凭据已保存；留空保留，更换地址需重新填写' : '请填写此服务的 API Key';
    } else { element('provider-json').value = ''; element('models-json').value = ''; element('provider-api-key').value = ''; }
    updateControls();
  }
  async function load() {
    loading = true; snapshot = undefined; providers = []; selected = -1; dirty = false; render(); message('正在读取本机配置…');
    try {
      snapshot = await api('/api/model-configuration'); providers = structuredClone(snapshot.configuration.providers); selected = providers.length ? 0 : -1;
      message(!snapshot.editable ? errors.model_configuration_read_only : snapshot.credentialCleanupPending ? '当前配置已保存，但旧凭据清理未完成；不会回滚已生效的配置。' : '配置仅本机保存。保存后请在对话中显式选择模型并验证任务。');
    } catch { message('读取本机配置失败；请检查服务与会话后重新读取。', true); }
    finally { loading = false; render(); }
  }
  async function open() { if (dialog.open) return; dialog.showModal(); await load(); }
  function close(event) {
    if (loading || dirty) { event?.preventDefault(); message(loading ? '正在保存或读取，请稍候。' : '有未保存的更改，请先保存或放弃更改后关闭。', true); return; }
    dialog.close();
  }
  element('model-settings-open').onclick = open; element('model-settings-mobile').onclick = open;
  element('model-settings-close').onclick = () => close(); dialog.addEventListener('cancel', close);
  dialog.addEventListener('close', () => { providers = []; selected = -1; snapshot = undefined; dirty = false; render(); });
  element('model-settings-discard').onclick = () => { if (!loading) void load(); };
  for (const id of ['provider-json', 'models-json', 'provider-api-key']) element(id).addEventListener('input', markDirty);
  element('provider-add').onclick = () => {
    if (loading || !snapshot?.editable) return;
    try {
      flush(); let count = 1; while (providers.some(provider => provider.key === `provider-${count}`)) count++;
      providers.push({ key: `provider-${count}`, displayName: '新 Provider', baseUrl: 'https://api.example.com/v1', models: [] });
      selected = providers.length - 1; markDirty(); render(); message('请填写你实际使用的服务地址、API Key 和模型列表。示例地址不会被自动调用。');
    } catch (error) { message(error.message, true); }
  };
  element('provider-delete').onclick = () => { if (loading || !snapshot?.editable || selected < 0) return; providers.splice(selected, 1); selected = providers.length ? 0 : -1; markDirty(); render(); message('删除尚未保存。保存后移除此 Provider 及其本机凭据。'); };
  for (const [button, editor] of [['provider-format', 'provider-json'], ['models-format', 'models-json']]) element(button).onclick = () => {
    try { element(editor).value = JSON.stringify(parse(element(editor).value), null, 2); markDirty(); } catch (error) { message(error.message, true); }
  };
  element('model-settings-save').onclick = async () => {
    if (loading || !snapshot?.editable || !dirty) return;
    try { flush(); } catch (error) { message(error.message, true); return; }
    loading = true; updateControls(); message('正在保存本机配置…');
    let saved = false;
    try {
      snapshot = await api('/api/model-configuration', { revision: snapshot.revision, configuration: { reuseCloudModels: false, providers } });
      saved = true; providers = structuredClone(snapshot.configuration.providers); dirty = false;
      // Drop all entered credentials immediately after the acknowledged commit,
      // even if refreshing the public catalog subsequently fails.
      element('provider-api-key').value = '';
      await refreshModels();
      message(snapshot.credentialCleanupPending ? '配置已保存并生效，但旧凭据清理未完成。' : '配置已保存。请选择模型并发送任务；保存不代表连接或模型调用已验证。');
      status('本机模型目录已更新，请显式选择执行模型。');
    } catch (error) { message(saved ? '配置已保存，但模型目录刷新失败。请刷新页面，不要重复提交。' : errors[error.message] ?? '本机保存失败；未确认保存结果，请重新读取配置核对。', true); }
    finally { loading = false; render(); }
  };
}
