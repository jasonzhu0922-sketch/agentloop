/** Edits the device-scoped Memory switch and settlement model. */
export function createLocalMemorySettings({ getElement: $, request, notify = () => undefined }) {
  let configuration = { enabled: false };
  let savedConfiguration = { enabled: false };
  let models = [];
  let dirty = false;
  let busy = false;
  let loaded = false;
  const enabledInput = $("local-memory-enabled");
  const modelSelect = $("local-memory-settlement-model");
  const saveButton = $("local-memory-save");
  const discardButton = $("local-memory-discard");

  function status(message, error = false) {
    const element = $("local-memory-save-status");
    element.textContent = message;
    element.classList.toggle("error", error);
  }
  function result(message, kind = "success") { status(message, kind === "error"); notify(message, kind); }
  function localModels() { return models.filter((model) => model?.source === "local" && typeof model.key === "string"); }
  function controls() {
    const hasModels = localModels().length > 0;
    // A stale enabled configuration must still be switchable off after its
    // model was removed; only prevent turning it on when no local model exists.
    enabledInput.disabled = busy || !loaded || (!hasModels && !enabledInput.checked);
    modelSelect.disabled = busy || !loaded || !hasModels || !enabledInput.checked;
    saveButton.disabled = busy || !loaded || !dirty;
    discardButton.disabled = busy || !loaded || !dirty;
    saveButton.textContent = busy ? "正在保存…" : "保存 Memory 配置";
    $("local-memory-no-models").hidden = hasModels;
  }
  function markDirty() { dirty = true; status("有未保存的更改，保存后应用到本机 Runtime。"); controls(); }
  function renderModels() {
    const available = localModels();
    const selected = configuration.settlementModelKey;
    modelSelect.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = available.length ? "请选择沉淀模型" : "暂无本机模型";
    modelSelect.append(placeholder);
    for (const model of available) {
      const option = document.createElement("option");
      option.value = model.key;
      option.textContent = `${model.displayName || model.key} · ${model.provider || "本机模型"}`;
      modelSelect.append(option);
    }
    if (selected && !available.some((model) => model.key === selected)) {
      const option = document.createElement("option");
      option.value = selected;
      option.textContent = `${selected}（当前不可用）`;
      modelSelect.append(option);
    }
    modelSelect.value = selected || "";
    enabledInput.checked = configuration.enabled === true;
    $("local-memory-current").textContent = configuration.enabled ? `已启用 · ${configuration.settlementModelKey || "未选择模型"}` : "已关闭";
    $("local-memory-model-hint").textContent = available.length ? "仅显示本机模型；云端模型不会用于本机 Memory 沉淀。" : "请先到“模型配置”添加至少一个本机模型。";
    controls();
  }
  async function readModels() {
    const response = await request("/v1/local-models");
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    models = Array.isArray(body.models) ? body.models : [];
  }
  async function load() {
    if (busy) return;
    loaded = false; controls(); status("正在读取 Memory 配置…");
    try {
      const [configurationResponse] = await Promise.all([request("/v1/local-memory/configuration"), readModels()]);
      const body = await configurationResponse.json().catch(() => ({}));
      if (!configurationResponse.ok || !body.memory) throw new Error(body.error || `HTTP ${configurationResponse.status}`);
      configuration = { enabled: body.memory.enabled === true, ...(body.memory.settlementModelKey ? { settlementModelKey: body.memory.settlementModelKey } : {}) };
      savedConfiguration = structuredClone(configuration); dirty = false; loaded = true; renderModels(); status("");
    } catch (error) { status(`读取 Memory 配置失败：${error instanceof Error ? error.message : String(error)}。请重新打开设置重试。`, true); }
  }
  async function refreshModels() {
    if (!loaded) return;
    try { await readModels(); renderModels(); }
    catch (error) { status(`刷新 Memory 模型失败：${error instanceof Error ? error.message : String(error)}`, true); }
  }
  async function save() {
    if (busy || !loaded || !dirty) return;
    const selectedModel = modelSelect.value.trim();
    if (enabledInput.checked && !selectedModel) { result("开启 Memory 前请选择沉淀模型。", "error"); modelSelect.focus(); return; }
    if (enabledInput.checked && !localModels().some((model) => model.key === selectedModel)) { result("所选沉淀模型不可用，请重新选择本机模型。", "error"); modelSelect.focus(); return; }
    busy = true; controls(); status("正在校验并保存 Memory 配置…");
    try {
      const payload = enabledInput.checked ? { enabled: true, settlementModelKey: selectedModel } : { enabled: false };
      const response = await request("/v1/local-memory/configuration", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.memory) throw new Error(body.error || `HTTP ${response.status}`);
      configuration = { enabled: body.memory.enabled === true, ...(body.memory.settlementModelKey ? { settlementModelKey: body.memory.settlementModelKey } : {}) };
      savedConfiguration = structuredClone(configuration); dirty = false; renderModels(); result("Memory 配置已保存，将用于后续新任务。", "success");
    } catch (error) { result(`保存失败：${error instanceof Error ? error.message : String(error)}。更改已保留，请修正后重试。`, "error"); }
    finally { busy = false; controls(); }
  }
  enabledInput.addEventListener("change", () => {
    if (enabledInput.checked && localModels().length === 0) { enabledInput.checked = false; result("当前没有本机模型，无法开启 Memory。请先在“模型配置”添加模型。", "error"); return; }
    markDirty();
  });
  modelSelect.addEventListener("change", () => { configuration.settlementModelKey = modelSelect.value || undefined; markDirty(); });
  saveButton.addEventListener("click", () => void save());
  discardButton.addEventListener("click", () => { if (!dirty) return; configuration = structuredClone(savedConfiguration); dirty = false; renderModels(); status("已恢复为上次保存的 Memory 配置。"); });
  controls();
  return {
    load,
    refreshModels,
    canClose() {
      if (busy) return false;
      if (dirty && !window.confirm("Memory 配置尚未保存，确定放弃更改并关闭？")) return false;
      configuration = structuredClone(savedConfiguration); dirty = false; renderModels(); return true;
    },
  };
}
