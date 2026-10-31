const json = (value) => JSON.stringify(value, null, 2);

export function createLocalConnectorSettings({
  getElement: $,
  request,
  getRuntimeId,
  onSaved,
  notify,
}) {
  let connectors = [];
  let saved = [];
  let selectedIndex = -1;
  let dirty = false;
  let busy = false;
  let loaded = false;

  const editor = $("local-connector-json");

  function runtimeId() {
    const value = getRuntimeId();
    if (!value) throw new Error("请先选择本机 Runtime。");
    return value;
  }

  function status(message, error = false) {
    $("local-connector-save-status").textContent = message;
    $("local-connector-save-status").classList.toggle("error", error);
  }

  function result(message, kind) {
    status(message, kind === "error");
    notify(message, kind);
  }

  function controls() {
    $("local-connector-editable").inert = busy || !loaded;
    $("local-connector-save").disabled = busy || !loaded || !dirty;
    $("local-connector-discard").disabled = busy || !loaded || !dirty;
    $("local-connector-save").textContent = busy ? "正在保存…" : "保存配置";
  }

  function markDirty() {
    dirty = true;
    status("有未保存的更改，保存后用于本机 Runtime。");
    controls();
  }

  function parseEditor() {
    let value;
    try { value = JSON.parse(editor.value); }
    catch { editor.focus(); throw new Error("Connector 配置 JSON 格式错误。"); }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      editor.focus();
      throw new Error("Connector 配置必须是 JSON 对象。");
    }
    return value;
  }

  function commitEditor() {
    if (selectedIndex < 0) return;
    const value = parseEditor();
    const current = connectors[selectedIndex];
    if (typeof value.displayName !== "string" || !value.displayName.trim()) throw new Error("请填写 displayName。");
    if (typeof value.connectorKey !== "string" || !value.connectorKey.trim()) throw new Error("请填写 connectorKey。");
    if (typeof value.modulePath !== "string" || !value.modulePath.trim()) throw new Error("请填写 modulePath。");
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("enabled 必须是布尔值。");
    connectors[selectedIndex] = {
      ...current,
      ...value,
      ...(value.credentials === undefined ? {} : { credentials: value.credentials }),
    };
  }

  function render() {
    const list = $("local-connector-list");
    list.replaceChildren();
    connectors.forEach((connector, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `local-connector-choice${index === selectedIndex ? " selected" : ""}`;
      button.setAttribute("aria-pressed", String(index === selectedIndex));
      const title = document.createElement("strong");
      title.textContent = connector.displayName || connector.connectorKey;
      const detail = document.createElement("small");
      detail.textContent = `${connector.connectorKey} · ${connector.enabled ? "已启用" : "已停用"} · ${connector.credentialConfigured ? "凭据已配置" : "待配置凭据"}`;
      button.append(title, detail);
      button.addEventListener("click", () => {
        try {
          commitEditor();
          selectedIndex = index;
          render();
        } catch (error) {
          result(error.message, "error");
        }
      });
      list.append(button);
    });
    if (connectors.length === 0) {
      const empty = document.createElement("div");
      empty.className = "local-connector-empty";
      empty.textContent = "尚未配置本机 Connector";
      list.append(empty);
    }
    const connector = connectors[selectedIndex];
    $("local-connector-json-empty").hidden = Boolean(connector);
    $("local-connector-json-editor").hidden = !connector;
    editor.value = connector ? json({
      id: connector.id,
      connectorKey: connector.connectorKey,
      displayName: connector.displayName,
      modulePath: connector.modulePath,
      ...(connector.exportName === undefined ? {} : { exportName: connector.exportName }),
      enabled: connector.enabled,
      config: connector.config || {},
      ...(connector.externalAccountId === undefined ? {} : { externalAccountId: connector.externalAccountId }),
      scopes: connector.scopes || [],
      ...(connector.credentialConfigured ? { credentialConfigured: true } : {}),
    }) : "";
    controls();
  }

  async function load() {
    loaded = false;
    controls();
    status("正在读取本机 Connector 配置…");
    try {
      const response = await request(`/v1/local-runtimes/${encodeURIComponent(runtimeId())}/connectors`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      connectors = Array.isArray(body.connectors) ? body.connectors : [];
      saved = structuredClone(connectors);
      selectedIndex = connectors.length ? 0 : -1;
      dirty = false;
      loaded = true;
      render();
      status("");
    } catch (error) {
      status(`读取配置失败：${error.message}`, true);
    }
  }

  async function save() {
    if (busy || !loaded || !dirty) return;
    try { commitEditor(); }
    catch (error) { result(`保存失败：${error.message}`, "error"); return; }
    busy = true;
    controls();
    try {
      const response = await request(`/v1/local-runtimes/${encodeURIComponent(runtimeId())}/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connector: connectors[selectedIndex] }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      await load();
      result("Connector 配置已保存；重启本机 Runtime 后生效。", "success");
      await onSaved?.();
    } catch (error) {
      result(`保存失败：${error.message}`, "error");
    } finally {
      busy = false;
      controls();
    }
  }

  $("local-connector-add").addEventListener("click", () => {
    connectors.push({
      connectorKey: "feishu",
      displayName: "我的 Connector",
      modulePath: "",
      enabled: false,
      config: {},
      scopes: [],
    });
    selectedIndex = connectors.length - 1;
    dirty = true;
    render();
    editor.focus();
  });

  $("local-connector-delete").addEventListener("click", async () => {
    const connector = connectors[selectedIndex];
    if (!connector) return;
    try {
      if (connector.id) {
        const response = await request(`/v1/local-runtimes/${encodeURIComponent(runtimeId())}/connectors/${encodeURIComponent(connector.id)}`, { method: "DELETE" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      }
      connectors.splice(selectedIndex, 1);
      selectedIndex = Math.min(selectedIndex, connectors.length - 1);
      saved = structuredClone(connectors);
      dirty = false;
      render();
      result("Connector 已删除。", "success");
    } catch (error) {
      result(`删除失败：${error.message}`, "error");
    }
  });

  $("local-connector-format").addEventListener("click", () => {
    try { editor.value = json(parseEditor()); markDirty(); }
    catch (error) { result(error.message, "error"); }
  });
  editor.addEventListener("input", markDirty);
  $("local-connector-save").addEventListener("click", () => void save());
  $("local-connector-discard").addEventListener("click", () => {
    connectors = structuredClone(saved);
    selectedIndex = connectors.length ? 0 : -1;
    dirty = false;
    render();
    status("已恢复为上次保存的配置。");
  });

  controls();
  return {
    load,
    canClose() {
      if (busy) return false;
      if (dirty && !window.confirm("Connector 配置尚未保存，确定放弃更改并关闭？")) return false;
      editor.value = "";
      dirty = false;
      controls();
      return true;
    },
  };
}
