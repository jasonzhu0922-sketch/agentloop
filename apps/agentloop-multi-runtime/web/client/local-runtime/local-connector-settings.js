const bindingFieldId = (key) => `local-connector-binding-field-${key}`;

export function createLocalConnectorSettings({
  getElement: $,
  request,
  getRuntimeId,
  onSaved,
  notify,
}) {
  let connectors = [];
  let catalog = [];
  let pendingBinding;
  let pendingAuthorization;
  let bindingInputs = new Map();
  let busy = false;
  let loaded = false;
  let instanceButtons = [];

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
    $("local-connector-binding-save").disabled = busy || !loaded || pendingBinding === undefined;
    instanceButtons.forEach((button) => { button.disabled = busy || !loaded; });
  }

  function render() {
    renderCatalog();
    const list = $("local-connector-list");
    list.replaceChildren();
    instanceButtons = [];
    connectors.forEach((connector) => {
      const row = document.createElement("div");
      row.className = "local-connector-instance";
      const summary = document.createElement("div");
      summary.className = "local-connector-choice";
      const title = document.createElement("strong");
      title.textContent = connector.displayName || connector.connectorKey;
      const detail = document.createElement("small");
      detail.textContent = `${connector.connectorKey} · ${connector.enabled ? "已启用" : "已停用"} · ${connector.credentialConfigured ? "凭据已配置" : "待配置凭据"}`;
      summary.append(title, detail);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "local-connector-instance-delete danger";
      remove.textContent = "删除";
      remove.setAttribute("aria-label", `删除 ${connector.displayName || connector.connectorKey}`);
      remove.addEventListener("click", () => void deleteConnector(connector.id));
      instanceButtons.push(remove);
      row.append(summary, remove);
      list.append(row);
    });
    if (connectors.length === 0) {
      const empty = document.createElement("div");
      empty.className = "local-connector-empty";
      empty.textContent = "尚未配置本机 Connector";
      list.append(empty);
    }
    controls();
  }

  function renderCatalog() {
    const list = $("local-connector-catalog");
    list.replaceChildren();
    catalog.forEach((item) => {
      const card = document.createElement("article");
      card.className = "local-connector-catalog-card";
      const heading = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = item.displayName;
      const description = document.createElement("p");
      description.textContent = item.description;
      heading.append(title, description);
      const capabilities = document.createElement("small");
      capabilities.textContent = Array.isArray(item.capabilities) ? item.capabilities.join(" · ") : "";
      const hint = document.createElement("small");
      hint.className = "local-connector-catalog-hint";
      hint.textContent = item.setupHint;
      const add = document.createElement("button");
      add.type = "button";
      add.textContent = "+";
      add.title = `添加${item.displayName}`;
      add.setAttribute("aria-label", `添加${item.displayName}`);
      add.disabled = busy || !loaded || item.template === undefined;
      add.addEventListener("click", () => openBinding(item));
      card.append(heading, capabilities, hint, add);
      list.append(card);
    });
    if (catalog.length === 0) {
      const empty = document.createElement("div");
      empty.className = "local-connector-empty";
      empty.textContent = "暂时无法读取可添加的 Connector。";
      list.append(empty);
    }
  }

  function openBinding(item) {
    if (!item.template || !item.binding) return;
    pendingBinding = item;
    $("local-connector-binding-title").textContent = item.binding.title || `绑定${item.displayName}`;
    $("local-connector-binding-description").textContent = item.binding.description || item.setupHint || "";
    $("local-connector-binding-status").textContent = "";
    $("local-connector-binding").classList.toggle("oauth", item.binding.kind === "oauth");
    $("local-connector-binding").classList.toggle("manual", item.binding.kind !== "oauth");
    $("local-connector-binding-save").textContent = item.binding.kind === "oauth" ? "连接" : "绑定并保存";
    const brand = $("local-connector-binding-brand");
    brand.hidden = item.binding.kind !== "oauth";
    const examples = $("local-connector-binding-examples");
    examples.replaceChildren();
    (item.binding.examples || []).forEach((example) => {
      const row = document.createElement("div");
      row.textContent = `“${example}”`;
      examples.append(row);
    });
    const fields = $("local-connector-binding-fields");
    fields.replaceChildren();
    bindingInputs = new Map();
    (item.binding.fields || []).forEach((field) => {
      const label = document.createElement("label");
      label.className = "local-connector-binding-field";
      const caption = document.createElement("span");
      caption.textContent = field.label;
      const input = document.createElement("input");
      input.id = bindingFieldId(field.key);
      input.type = field.secret ? "password" : "text";
      input.autocomplete = field.secret ? "off" : "username";
      input.placeholder = field.placeholder || "";
      bindingInputs.set(field.key, input);
      label.append(caption, input);
      fields.append(label);
    });
    $("local-connector-binding").hidden = false;
    controls();
    const first = item.binding.fields?.[0];
    if (first) bindingInputs.get(first.key)?.focus();
  }

  function closeBinding() {
    pendingBinding = undefined;
    pendingAuthorization = undefined;
    $("local-connector-binding").hidden = true;
    $("local-connector-binding-fields").replaceChildren();
    bindingInputs = new Map();
    $("local-connector-binding-status").textContent = "";
    controls();
  }

  async function saveBinding() {
    const item = pendingBinding;
    if (busy || !loaded || item === undefined) return;
    if (item.binding.kind === "oauth") return authorize(item);
    const credentials = {};
    const config = { ...(item.template.config || {}) };
    for (const field of item.binding.fields || []) {
      const input = bindingInputs.get(field.key);
      const value = input?.value.trim() ?? "";
      if (!value) {
        $("local-connector-binding-status").textContent = `请填写${field.label}。`;
        input?.focus();
        return;
      }
      if (field.target === "credential") credentials[field.key] = value;
      else config[field.key] = value;
    }
    busy = true;
    controls();
    $("local-connector-binding-status").textContent = "正在保存本机连接…";
    try {
      const response = await request(`/v1/local-runtimes/${encodeURIComponent(runtimeId())}/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connector: { ...item.template, enabled: true, config, credentials } }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      await load();
      closeBinding();
      result(`${item.displayName}已绑定；重启本机 Runtime 后生效。`, "success");
      await onSaved?.();
    } catch (error) {
      $("local-connector-binding-status").textContent = `绑定失败：${error.message}`;
    } finally {
      busy = false;
      controls();
    }
  }

  async function authorize(item) {
    const authorizationWindow = typeof window.open === "function"
      ? window.open("about:blank", `agentloop-${item.key}-oauth`, "popup=yes,width=760,height=820")
      : undefined;
    busy = true;
    controls();
    $("local-connector-binding-status").textContent = `正在打开${item.displayName}授权页…`;
    try {
      const response = await request(`/v1/local-runtimes/${encodeURIComponent(runtimeId())}/connectors/${encodeURIComponent(item.key)}/authorization`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        authorizationWindow?.close?.();
        if (body.error === "wps_oauth_not_configured") throw new Error("本机尚未配置 WPS 开放平台应用。请由管理员在 Local Agent 的 .env 中配置 WPS_OAUTH_CLIENT_ID、WPS_OAUTH_CLIENT_SECRET 和已登记的回调地址。");
        if (body.error === "feishu_oauth_not_configured") throw new Error("本机尚未配置飞书开放平台应用。请由管理员在 Local Agent 的 .env 中配置 FEISHU_OAUTH_APP_ID、FEISHU_OAUTH_APP_SECRET 和已登记的回调地址。");
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      pendingAuthorization = body.attemptId;
      if (authorizationWindow !== undefined) authorizationWindow.location.assign(body.authorizationUrl);
      else window.location.assign(body.authorizationUrl);
      $("local-connector-binding-status").textContent = `请在打开的${item.displayName}页面确认授权…`;
    } catch (error) {
      $("local-connector-binding-status").textContent = `连接失败：${error.message}`;
      busy = false;
      controls();
    }
  }

  async function authorizationMessage(event) {
    if (event.origin !== new URL(window.location.href).origin) return;
    const value = event.data;
    if (value?.source !== `agentloop-${pendingBinding?.key}-oauth` || value.attemptId !== pendingAuthorization) return;
    busy = false;
    pendingAuthorization = undefined;
    if (value.status !== "completed") {
      $("local-connector-binding-status").textContent = `${pendingBinding?.displayName || "Connector"}未完成授权，请重试。`;
      controls();
      return;
    }
    const displayName = pendingBinding?.displayName || "Connector";
    await load();
    closeBinding();
    result(`${displayName}已绑定；重启本机 Runtime 后生效。`, "success");
    await onSaved?.();
  }

  async function load() {
    loaded = false;
    controls();
    status("正在读取本机 Connector 配置…");
    try {
      const [configurationResponse, catalogResponse] = await Promise.all([
        request(`/v1/local-runtimes/${encodeURIComponent(runtimeId())}/connectors`),
        request("/v1/local-connectors/catalog"),
      ]);
      const [configuration, available] = await Promise.all([configurationResponse.json(), catalogResponse.json()]);
      if (!configurationResponse.ok) throw new Error(configuration.error || `HTTP ${configurationResponse.status}`);
      if (!catalogResponse.ok) throw new Error(available.error || `HTTP ${catalogResponse.status}`);
      connectors = Array.isArray(configuration.connectors) ? configuration.connectors : [];
      catalog = Array.isArray(available.connectors) ? available.connectors : [];
      loaded = true;
      render();
      status("");
    } catch (error) {
      status(`读取配置失败：${error.message}`, true);
    }
  }

  async function deleteConnector(connectorId) {
    if (busy || !loaded) return;
    const index = connectors.findIndex((connector) => connector.id === connectorId);
    const connector = connectors[index];
    if (!connector) return;
    const name = connector.displayName || connector.connectorKey;
    if (!window.confirm(`确定删除“${name}”？\n将删除此实例的本机配置和已保存凭据，不能撤销；可重新绑定。不会删除服务中的邮件或文档。\n重启本机 Runtime 后生效。`)) return;
    busy = true;
    controls();
    status(`正在删除“${name}”…`);
    try {
      if (connector.id) {
        const response = await request(`/v1/local-runtimes/${encodeURIComponent(runtimeId())}/connectors/${encodeURIComponent(connector.id)}`, { method: "DELETE" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      }
      connectors.splice(index, 1);
      render();
      result(`“${name}”已删除；重启本机 Runtime 后生效。`, "success");
    } catch (error) {
      result(`删除失败：${error.message}`, "error");
      return;
    } finally {
      busy = false;
      controls();
    }
    try { await onSaved?.(); }
    catch (error) { result(`“${name}”已删除，但刷新 Runtime 状态失败：${error.message}`, "error"); }
  }

  $("local-connector-binding-close").addEventListener("click", closeBinding);
  $("local-connector-binding-cancel").addEventListener("click", closeBinding);
  $("local-connector-binding-save").addEventListener("click", () => void saveBinding());
  if (typeof window.addEventListener === "function") window.addEventListener("message", (event) => void authorizationMessage(event));

  controls();
  return {
    load,
    canClose() {
      return !busy;
    },
  };
}
