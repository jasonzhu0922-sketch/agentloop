const modelExample = [{
  key: "my-model", displayName: "我的模型", providerModel: "model-name", protocol: "responses",
  contextWindowTokens: 128000, maxOutputTokens: 8192,
}];
const json = (value) => JSON.stringify(value, null, 2);

/** Edits one device-owned configuration; credentials are never read back. */
export function createLocalModelSettings({ getElement: $, request, onSaved, notify, confirm: confirmChange = (message) => window.confirm(message) }) {
  let configuration = { reuseCloudModels: false, providers: [] };
  let savedConfiguration;
  let selectedIndex = -1;
  let dirty = false;
  let busy = false;
  let loaded = false;
  let cloudRequest = 0;
  const providerEditor = $("local-provider-json");
  const modelsEditor = $("local-models-json");
  const reuseCloud = $("reuse-cloud-models");

  function status(message, error = false) {
    $("local-model-save-status").textContent = message;
    $("local-model-save-status").classList.toggle("error", error);
  }
  function result(message, kind) {
    status(message, kind !== "success");
    notify(message, kind);
  }
  function controls() {
    $("local-model-editable").inert = busy || !loaded;
    reuseCloud.disabled = busy || !loaded;
    $("local-model-save").disabled = busy || !loaded || !dirty;
    $("local-model-discard").disabled = busy || !loaded || !dirty;
    $("local-model-save").textContent = busy ? "正在保存…" : "保存配置";
  }
  function markDirty() {
    dirty = true;
    status("有未保存的更改，保存后应用到本机 Runtime。");
    controls();
  }
  function parseEditor(editor, label, array) {
    let value;
    try { value = JSON.parse(editor.value); }
    catch { editor.focus(); throw new Error(`${label} JSON 格式错误，请检查引号、逗号和括号。`); }
    if (array ? !Array.isArray(value) : value === null || typeof value !== "object" || Array.isArray(value)) {
      editor.focus(); throw new Error(`${label}必须是 JSON ${array ? "数组" : "对象"}。`);
    }
    return value;
  }
  function commitEditors() {
    if (selectedIndex < 0) return;
    const provider = parseEditor(providerEditor, "Provider 配置", false);
    const models = parseEditor(modelsEditor, "模型列表", true);
    const allowed = ["key", "displayName", "baseUrl", "apiKey"];
    const extra = Object.keys(provider).find((key) => !allowed.includes(key));
    if (extra) throw new Error(`Provider 不支持字段 ${extra}；模型与调用参数请填写在下方模型列表中。`);
    if (typeof provider.key !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(provider.key)) throw new Error("Provider key 请使用小写字母、数字和短横线。");
    if (configuration.providers.some((entry, index) => index !== selectedIndex && entry.key === provider.key)) throw new Error("Provider key 已存在，请使用唯一 ID。");
    if (typeof provider.displayName !== "string" || !provider.displayName.trim()) throw new Error("请填写 Provider displayName。");
    if (typeof provider.baseUrl !== "string" || !provider.baseUrl.trim()) throw new Error("请填写 Provider baseUrl。");
    if (provider.apiKey !== undefined && typeof provider.apiKey !== "string") throw new Error("Provider apiKey 必须是字符串。");
    const previous = configuration.providers[selectedIndex];
    configuration.providers[selectedIndex] = {
      ...provider, models,
      ...(previous.credentialConfigured ? { credentialConfigured: true } : {}),
    };
  }
  function guard(action) {
    try { action(); }
    catch (error) { result(error.message, "error"); }
  }
  function render() {
    const list = $("local-model-provider-list");
    list.replaceChildren();
    configuration.providers.forEach((provider, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `local-model-provider-choice${index === selectedIndex ? " selected" : ""}`;
      button.setAttribute("aria-pressed", String(index === selectedIndex));
      const title = document.createElement("strong");
      title.textContent = provider.displayName;
      const detail = document.createElement("small");
      detail.textContent = `${provider.key} · ${provider.models.length} 个模型`;
      button.append(title, detail);
      button.addEventListener("click", () => guard(() => {
        commitEditors();
        selectedIndex = index;
        render();
      }));
      list.append(button);
    });
    if (configuration.providers.length === 0) {
      const empty = document.createElement("div");
      empty.className = "local-model-empty";
      empty.textContent = "尚未添加本机 Provider";
      list.append(empty);
    }
    const provider = configuration.providers[selectedIndex];
    $("local-model-json-empty").hidden = Boolean(provider);
    $("local-model-json-editors").hidden = !provider;
    providerEditor.value = "";
    modelsEditor.value = "";
    if (provider) {
      const { models, credentialConfigured, ...connection } = provider;
      providerEditor.value = json(connection);
      modelsEditor.value = json(models);
      $("local-provider-key-hint").textContent = credentialConfigured
        ? "API Key 已加密保存，不会回显。省略 apiKey 可沿用密钥；修改 key 或 baseUrl 时须重新填写 apiKey。"
        : "填写 key、displayName、baseUrl 和 apiKey；密钥保存后不会回显。";
    }
    controls();
  }
  async function loadCloudModels() {
    const generation = ++cloudRequest;
    $("local-cloud-model-section").hidden = !reuseCloud.checked;
    if (!reuseCloud.checked) return;
    const list = $("local-cloud-model-table");
    list.textContent = "正在读取云端模型…";
    $("local-model-count").textContent = "";
    try {
      const response = await request("/v1/local-models?includeCloud=true");
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      if (generation !== cloudRequest) return;
      const models = (body.models || []).filter((model) => model.source === "cloud");
      $("local-model-count").textContent = `${models.length} 个模型`;
      list.replaceChildren();
      models.forEach((model) => {
        const row = document.createElement("div");
        row.className = "local-cloud-model-row";
        row.textContent = `${model.displayName || model.key} · ${model.key}`;
        list.append(row);
      });
      if (models.length === 0) list.textContent = "暂无可复用的云端模型。";
    } catch {
      if (generation === cloudRequest) list.textContent = "读取云端模型失败，请关闭后重新勾选以重试。";
    }
  }
  async function load() {
    if (busy) return;
    loaded = false;
    controls();
    status("正在读取本机配置…");
    try {
      const response = await request("/v1/local-models/configuration");
      const body = await response.json();
      if (!response.ok || !body.configuration) throw new Error(body.error || `HTTP ${response.status}`);
      configuration = body.configuration;
      savedConfiguration = structuredClone(configuration);
      selectedIndex = configuration.providers.length ? 0 : -1;
      reuseCloud.checked = configuration.reuseCloudModels;
      dirty = false;
      loaded = true;
      render();
      status("");
      void loadCloudModels();
    } catch (error) {
      status(`读取配置失败：${error.message}。请重新打开设置重试。`, true);
    }
  }
  async function save() {
    if (busy || !loaded || !dirty) return;
    try { commitEditors(); }
    catch (error) { result(`保存失败：${error.message}`, "error"); return; }
    busy = true;
    controls();
    status("正在校验并保存配置…");
    try {
      const response = await request("/v1/local-models/configuration", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...configuration, reuseCloudModels: reuseCloud.checked }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      configuration = body.configuration;
      savedConfiguration = structuredClone(configuration);
      dirty = false;
      render(); // Replace editor contents with redacted metadata from the Agent.
      result("配置已保存，将用于后续新任务。", "success");
    } catch (error) {
      result(`保存失败：${error.message}。更改已保留，请修正后重试。`, "error");
      return;
    } finally {
      busy = false;
      controls();
    }
    try { await onSaved(); }
    catch { result("配置已保存，但模型列表刷新失败，请重新打开设置。", "warning"); }
  }

  $("local-provider-add").addEventListener("click", () => guard(() => {
    commitEditors();
    let number = 1;
    while (configuration.providers.some((provider) => provider.key === `provider-${number}`)) number += 1;
    configuration.providers.push({ key: `provider-${number}`, displayName: "新 Provider", baseUrl: "https://api.example.com/v1", apiKey: "", models: [] });
    selectedIndex = configuration.providers.length - 1;
    markDirty();
    render();
    providerEditor.focus();
  }));
  $("local-provider-delete").addEventListener("click", () => {
    const provider = configuration.providers[selectedIndex];
    if (!provider || !confirmChange(`删除 Provider「${provider.displayName}」及其模型？保存配置后生效。`)) return;
    configuration.providers.splice(selectedIndex, 1);
    selectedIndex = Math.min(selectedIndex, configuration.providers.length - 1);
    markDirty();
    render();
  });
  for (const [id, editor, label, array] of [
    ["local-provider-format", providerEditor, "Provider 配置", false],
    ["local-model-format", modelsEditor, "模型列表", true],
  ]) {
    $(id).addEventListener("click", () => guard(() => { editor.value = json(parseEditor(editor, label, array)); }));
  }
  $("local-model-example").addEventListener("click", () => {
    if (modelsEditor.value.trim() !== "[]" && !confirmChange("用示例替换当前模型 JSON？现有编辑内容将被替换。")) return;
    modelsEditor.value = json(modelExample);
    markDirty();
    modelsEditor.focus();
  });
  providerEditor.addEventListener("input", markDirty);
  modelsEditor.addEventListener("input", markDirty);
  reuseCloud.addEventListener("change", () => { markDirty(); void loadCloudModels(); });
  $("local-model-save").addEventListener("click", () => void save());
  $("local-model-discard").addEventListener("click", () => {
    if (!dirty || !confirmChange("放弃所有尚未保存的模型配置更改？")) return;
    configuration = structuredClone(savedConfiguration);
    selectedIndex = configuration.providers.length ? 0 : -1;
    reuseCloud.checked = configuration.reuseCloudModels;
    dirty = false;
    render();
    status("已恢复为上次保存的配置。");
    void loadCloudModels();
  });
  controls();
  return {
    load,
    canClose() {
      if (busy) return false;
      if (dirty && !confirmChange("模型配置尚未保存，确定放弃更改并关闭？")) return false;
      // Clear unsaved plaintext keys when leaving the editor.
      configuration = savedConfiguration ? structuredClone(savedConfiguration) : { reuseCloudModels: false, providers: [] };
      providerEditor.value = "";
      modelsEditor.value = "";
      dirty = false;
      controls();
      return true;
    },
  };
}
