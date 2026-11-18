const SERVER_FIELDS = ['id', 'displayName', 'key', 'transport', 'url', 'protocolVersion', 'timeoutMs', 'auth', 'toolAllowlist', 'toolBlocklist', 'trust', 'aliases', 'capabilities'];
const AUTH_FIELDS = { none: [], bearer: ['token'], api_key_header: ['headerName', 'value'], basic: ['username', 'password'], query_parameter: ['parameterName', 'value'], custom_headers: ['headers', 'headerNames'] };
const CAPABILITY_FIELDS = ['id', 'category', 'label', 'description', 'producesEvidenceKinds', 'sourceKinds'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const lines = value => value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);

// Normalize only JSON delimiters. Quotes within string values remain untouched.
export function parseMcpJson(text) {
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

/** One editable configuration for every HTTP MCP; saved secrets are never loaded. */
export function createMcpServerForm({ document, config, onDirty = () => {} }) {
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function button(text, action) {
    const node = el('button', text); node.type = 'button'; node.onclick = action; return node;
  }
  function control(name, value = '', type = 'text') {
    const node = el(type === 'textarea' ? 'textarea' : 'input');
    if (type !== 'textarea') node.type = type;
    else node.rows = 3;
    node.value = value; node.autocomplete = type === 'password' ? 'new-password' : 'off'; node.spellcheck = false;
    node.dataset.mcpField = name; return node;
  }
  function field(title, node, help) {
    const label = el('label', undefined, 'capability-field'); node.setAttribute('aria-label', title);
    label.append(el('span', title), node);
    if (help) label.append(el('small', help));
    return label;
  }
  function select(name, options, value) {
    const node = el('select'); node.dataset.mcpField = name;
    for (const [key, label] of options) { const option = el('option', label); option.value = key; node.append(option); }
    node.value = value; return node;
  }
  function section(parent, title, description, collapsible = false) {
    const node = el(collapsible ? 'details' : 'section', undefined, 'mcp-form-section');
    node.append(el(collapsible ? 'summary' : 'h3', title));
    if (description) node.append(el('p', description, 'mcp-form-help'));
    parent.append(node); return node;
  }
  const root = el('div', undefined, 'mcp-configuration-form');
  const modes = el('div', undefined, 'mcp-editor-modes');
  const form = el('div', undefined, 'mcp-form-fields');
  const jsonPanel = el('div', undefined, 'mcp-json-panel'); jsonPanel.hidden = true;
  const json = control('json', '', 'textarea'); json.className = 'desktop-json'; json.rows = 18;
  jsonPanel.append(field('MCP 配置 JSON', json), el('p', '可粘贴一个完整的服务配置。切回表单后可逐项检查；已保存的凭据不会回显。', 'mcp-form-help'));
  const feedback = el('p', '', 'mcp-form-feedback'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  let mode = 'form', readForm, focusForm;
  function fail(message) { feedback.textContent = message; throw new Error('mcp_form_invalid'); }
  function validateShape(value) {
    if (!record(value) || Object.keys(value).some(key => !SERVER_FIELDS.includes(key)) || value.transport !== 'http') fail('请输入一个 HTTP MCP 服务配置；包含不支持的字段或连接方式。');
    if (!record(value.auth) || !Object.hasOwn(AUTH_FIELDS, value.auth.kind)) fail('请选择有效的认证方式。');
    if (Object.keys(value.auth).some(key => !['kind', 'credentialConfigured', ...AUTH_FIELDS[value.auth.kind]].includes(key))) fail('认证配置包含不支持的字段，请检查认证方式。');
    for (const name of ['displayName', 'key', 'url', 'protocolVersion']) if (value[name] !== undefined && typeof value[name] !== 'string') fail('名称、标识、地址和协议版本必须是文本。');
    for (const name of ['aliases', 'toolAllowlist', 'toolBlocklist']) if (value[name] !== undefined && (!Array.isArray(value[name]) || value[name].some(item => typeof item !== 'string'))) fail('别名和工具列表必须是文本数组。');
    if (value.timeoutMs !== undefined && (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 60000)) fail('超时时间应为 100–60000 毫秒的整数。');
    if (value.trust !== undefined && !['trusted', 'untrusted'].includes(value.trust)) fail('请选择有效的信任级别。');
    for (const name of AUTH_FIELDS[value.auth.kind].filter(name => !['headers', 'headerNames'].includes(name))) if (value.auth[name] !== undefined && typeof value.auth[name] !== 'string') fail('认证名称和凭据必须是文本。');
    if (value.auth.headerNames !== undefined && (!Array.isArray(value.auth.headerNames) || value.auth.headerNames.some(name => typeof name !== 'string'))) fail('请求头名称必须是文本数组。');
    if (value.auth.headers !== undefined && (!record(value.auth.headers) || Object.values(value.auth.headers).some(item => typeof item !== 'string'))) fail('请求头必须是名称与文本值的对应关系。');
    if (value.capabilities !== undefined && (!Array.isArray(value.capabilities) || value.capabilities.length > 30)) fail('能力声明必须是数组，最多 30 项。');
    for (const capability of value.capabilities ?? []) {
      if (!record(capability) || Object.keys(capability).some(key => !CAPABILITY_FIELDS.includes(key))) fail('能力声明包含不支持的字段。');
      for (const name of ['id', 'category', 'label', 'description']) if (capability[name] !== undefined && typeof capability[name] !== 'string') fail('能力标识、类别、名称和描述必须是文本。');
      for (const name of ['producesEvidenceKinds', 'sourceKinds']) if (capability[name] !== undefined && (!Array.isArray(capability[name]) || capability[name].some(item => typeof item !== 'string'))) fail('证据类型和来源类型必须是文本数组。');
    }
    return value;
  }
  function sanitize(value) {
    const { id, ...server } = value;
    const { credentialConfigured, ...auth } = value.auth;
    return { ...server, auth };
  }
  function fromJson() {
    let value;
    try { value = parseMcpJson(json.value); } catch { fail('JSON 格式无效，请检查引号、括号和逗号。'); }
    return sanitize(validateShape(value));
  }
  function switchMode(next) {
    if (mode === next) return;
    try {
      if (next === 'json') json.value = JSON.stringify(readForm(), null, 2);
      else renderForm(fromJson());
      mode = next; form.hidden = next !== 'form'; jsonPanel.hidden = next !== 'json'; feedback.textContent = '';
      formMode.setAttribute('aria-pressed', String(next === 'form')); jsonMode.setAttribute('aria-pressed', String(next === 'json'));
    } catch { /* Keep the invalid draft visible for correction. */ }
  }
  const formMode = button('表单配置', () => switchMode('form'));
  const jsonMode = button('JSON 配置', () => switchMode('json'));
  formMode.setAttribute('aria-pressed', 'true'); jsonMode.setAttribute('aria-pressed', 'false');
  modes.append(formMode, jsonMode); root.append(modes, form, jsonPanel, feedback);

  function renderForm(value) {
    form.replaceChildren();
    const base = section(form, '基础连接'); const grid = el('div', undefined, 'mcp-form-grid'); base.append(grid);
    const name = control('displayName', value.displayName ?? '');
    const key = control('key', value.key ?? '');
    const url = control('url', value.url ?? '', 'url'); url.placeholder = 'https://example.com/mcp';
    const transport = select('transport', [['http', 'HTTP / HTTPS']], 'http');
    const timeout = control('timeoutMs', value.timeoutMs === undefined ? '' : String(value.timeoutMs), 'number'); timeout.min = '100'; timeout.max = '60000'; timeout.step = '1'; timeout.placeholder = '使用默认值';
    grid.append(field('显示名称', name), field('服务标识', key, '用于识别此服务，应保持唯一。'), field('连接方式', transport), field('超时时间（毫秒）', timeout));
    base.append(field('服务地址', url, '凭据请填写在下方认证区域。'));

    const authSection = section(form, '认证配置');
    const kind = select('auth.kind', [['none', '无需认证'], ['custom_headers', '自定义请求头'], ['query_parameter', 'URL 参数'], ['api_key_header', 'API Key 请求头'], ['bearer', 'Bearer Token'], ['basic', '用户名与密码']], value.auth.kind);
    authSection.append(field('认证方式', kind));
    const authBody = el('div', undefined, 'mcp-auth-fields'); authSection.append(authBody);
    const authDrafts = new Map([[value.auth.kind, value.auth]]); let readAuth;
    const secretPlaceholder = config.auth?.credentialConfigured ? '留空保留已保存的凭据' : '请输入凭据';
    function secret(name, value, label) { const node = control(name, value ?? '', 'password'); node.placeholder = secretPlaceholder; authBody.append(field(label, node)); return node; }
    function renderAuth(auth) {
      authBody.replaceChildren();
      if (auth.kind === 'none') { readAuth = () => ({ kind: 'none' }); return; }
      if (auth.kind === 'custom_headers') {
        const rows = el('div', undefined, 'mcp-header-list'); authBody.append(rows); let entries = [];
        function addHeader(headerName = '', headerValue = '') {
          const row = el('div', undefined, 'mcp-header-row');
          const name = control('auth.headerName', headerName), value = control('auth.headerValue', headerValue, 'password');
          name.placeholder = '例如 X-API-Key'; value.placeholder = secretPlaceholder;
          const entry = { name, value }; entries.push(entry);
          const remove = button('移除', () => { entries = entries.filter(item => item !== entry); row.remove(); onDirty(); });
          row.append(field('请求头名称', name), field('请求头凭据', value), remove); rows.append(row);
        }
        const names = [...new Set([...(auth.headerNames ?? []), ...Object.keys(auth.headers ?? {})])];
        for (const name of names.length ? names : ['']) addHeader(name, auth.headers?.[name] ?? '');
        const add = button('＋ 添加请求头', () => { addHeader(); onDirty(); }); authBody.append(add);
        readAuth = () => {
          const names = entries.map(entry => entry.name.value.trim());
          const provided = entries.filter(entry => entry.value.value !== '');
          if (new Set(names.map(name => name.toLowerCase())).size !== names.length) fail('请求头名称不能重复。');
          if (provided.length && provided.length !== entries.length) fail('修改请求头凭据时，请填写所有请求头的值；全部留空可保留原凭据。');
          return { kind: 'custom_headers', headerNames: names, ...(provided.length ? { headers: Object.fromEntries(entries.map(entry => [entry.name.value.trim(), entry.value.value])) } : {}) };
        };
        return;
      }
      const authKind = auth.kind;
      let target, credential;
      if (authKind === 'query_parameter' || authKind === 'api_key_header') {
        const targetKey = authKind === 'query_parameter' ? 'parameterName' : 'headerName';
        target = control(`auth.${targetKey}`, auth[targetKey] ?? ''); target.placeholder = authKind === 'query_parameter' ? '例如 key' : '例如 X-API-Key';
        authBody.append(field(authKind === 'query_parameter' ? '参数名称' : '请求头名称', target));
        credential = secret('auth.value', auth.value, 'API Key');
        readAuth = () => ({ kind: authKind, [targetKey]: target.value.trim(), ...(credential.value ? { value: credential.value } : {}) });
      } else if (authKind === 'bearer') {
        credential = secret('auth.token', auth.token, 'Token');
        readAuth = () => ({ kind: authKind, ...(credential.value ? { token: credential.value } : {}) });
      } else {
        target = control('auth.username', auth.username ?? ''); authBody.append(field('用户名', target));
        credential = secret('auth.password', auth.password, '密码');
        readAuth = () => ({ kind: 'basic', username: target.value.trim(), ...(credential.value ? { password: credential.value } : {}) });
      }
    }
    renderAuth(value.auth);
    let activeKind = value.auth.kind;
    kind.onchange = () => {
      try { authDrafts.set(activeKind, readAuth()); } catch { kind.value = activeKind; return; }
      activeKind = kind.value; renderAuth(authDrafts.get(activeKind) ?? { kind: activeKind }); feedback.textContent = ''; onDirty();
    };
    authSection.append(el('p', '凭据仅加密保存在本机。编辑时留空保留原值；更换地址、认证方式或认证名称后需重新填写。', 'mcp-form-help'));

    const policy = section(form, '高级配置与工具访问', '列表每行填写一项。', true);
    const protocol = control('protocolVersion', value.protocolVersion ?? ''); protocol.placeholder = '留空使用默认协议版本';
    const trust = select('trust', [['', '使用默认值'], ['untrusted', '不受信任（untrusted）'], ['trusted', '受信任（trusted）']], value.trust ?? '');
    const policyGrid = el('div', undefined, 'mcp-form-grid'); policy.append(policyGrid);
    policyGrid.append(field('协议版本', protocol), field('信任级别', trust));
    const aliases = control('aliases', (value.aliases ?? []).join('\n'), 'textarea');
    const allowlist = control('toolAllowlist', (value.toolAllowlist ?? []).join('\n'), 'textarea');
    const blocklist = control('toolBlocklist', (value.toolBlocklist ?? []).join('\n'), 'textarea');
    policy.append(field('服务别名', aliases), field('允许调用的工具', allowlist, '留空不设置允许列表；填写后仅允许列出的工具。'), field('禁止调用的工具', blocklist, '禁止列表中的工具不会被加载。'));

    const capabilities = section(form, '能力声明', '描述此服务的用途，以及可产出的证据和数据来源。', true);
    const cards = el('div', undefined, 'mcp-capability-list'); capabilities.append(cards); let capabilityEntries = [];
    function addCapability(capability = {}) {
      const card = el('section', undefined, 'mcp-capability-card'); const inputs = {};
      const heading = el('div', undefined, 'mcp-capability-heading');
      const entry = { inputs }; capabilityEntries.push(entry);
      heading.append(el('strong', '能力项'), button('移除能力', () => { capabilityEntries = capabilityEntries.filter(item => item !== entry); card.remove(); onDirty(); })); card.append(heading);
      const grid = el('div', undefined, 'mcp-form-grid'); card.append(grid);
      for (const [name, title, multiline] of [['id', '能力标识'], ['category', '能力类别'], ['label', '能力名称'], ['description', '能力描述', true], ['producesEvidenceKinds', '产出证据类型', true], ['sourceKinds', '来源类型', true]]) {
        const list = ['producesEvidenceKinds', 'sourceKinds'].includes(name);
        inputs[name] = control(`capability.${name}`, list ? (capability[name] ?? []).join('\n') : capability[name] ?? '', multiline ? 'textarea' : 'text');
        (multiline ? card : grid).append(field(title, inputs[name], list ? '每行填写一项。' : undefined));
      }
      cards.append(card);
    }
    for (const capability of value.capabilities ?? []) addCapability(capability);
    capabilities.append(button('＋ 添加能力', () => { addCapability(); onDirty(); }));
    readForm = () => {
      const server = { displayName: name.value.trim(), key: key.value.trim(), transport: 'http', url: url.value.trim(), auth: readAuth() };
      if (timeout.value !== '') server.timeoutMs = Number(timeout.value);
      if (protocol.value.trim()) server.protocolVersion = protocol.value.trim();
      if (trust.value) server.trust = trust.value;
      for (const [name, node] of [['aliases', aliases], ['toolAllowlist', allowlist], ['toolBlocklist', blocklist]]) {
        const values = lines(node.value); if (values.length) server[name] = values;
      }
      if (capabilityEntries.length) server.capabilities = capabilityEntries.map(({ inputs }) => {
        const result = { id: inputs.id.value.trim(), category: inputs.category.value.trim() };
        for (const name of ['label', 'description']) if (inputs[name].value.trim()) result[name] = inputs[name].value.trim();
        for (const name of ['producesEvidenceKinds', 'sourceKinds']) { const values = lines(inputs[name].value); if (values.length) result[name] = values; }
        return result;
      });
      return server;
    };
    focusForm = () => name.focus();
  }
  renderForm(sanitize(validateShape(config)));
  return {
    element: root,
    focus: () => focusForm(),
    draft() {
      feedback.textContent = '';
      const server = validateShape(mode === 'json' ? fromJson() : readForm());
      if (!server.displayName?.trim() || !server.key?.trim() || !server.url?.trim()) fail('请填写显示名称、服务标识和服务地址。');
      let url; try { url = new URL(server.url); } catch { fail('请输入有效的 HTTP 或 HTTPS 服务地址。'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('服务地址应为 HTTP 或 HTTPS，且不能包含凭据、查询参数或片段。');
      const auth = server.auth;
      for (const name of ['headerName', 'parameterName']) if (auth.kind === (name === 'headerName' ? 'api_key_header' : 'query_parameter') && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(auth[name] ?? '')) fail('请填写有效的认证名称。');
      if (auth.kind === 'basic' && !auth.username?.trim()) fail('请填写用户名。');
      if (auth.kind === 'custom_headers') {
        const names = auth.headerNames ?? Object.keys(auth.headers ?? {});
        if (!names.length || names.some(name => !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name))) fail('请填写有效的请求头名称。');
        if (auth.headers && (!Object.keys(auth.headers).length || Object.values(auth.headers).some(value => !value.trim()))) fail('请填写所有请求头的凭据。');
      }
      const ids = new Set();
      for (const capability of server.capabilities ?? []) {
        if (!capability.id?.trim() || !capability.category?.trim()) fail('每个能力项都需要填写能力标识和类别。');
        if (ids.has(capability.id)) fail('能力标识不能重复。'); ids.add(capability.id);
      }
      return sanitize(server);
    },
  };
}
