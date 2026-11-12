const GROUPS = {
  identity: ['基本信息', '名称和描述来自原始 Skill 包。'],
  activation: ['匹配规则', '标签帮助召回；请求示例说明哪些任务适合使用此 Skill。'],
  workflow: ['工作职责', '说明此 Skill 在任务中的职责、输入来源、交付形式和协作依赖。'],
  requirements: ['运行依赖', '系统会同时检查包内 requirements.txt。其他依赖文件按需启用；这里只填写需求，不填写凭据。'],
  execution: ['执行接口', '由包内执行接口提供，保留原值；普通指令 Skill 可以没有执行接口。'],
};
const FIELDS = {
  'identity.name': ['Skill 名称'], 'identity.description': ['用途描述'],
  'activation.semanticTags': ['语义标签', '从当前 Skill 和本机 Skill 库的已有标签中多选，可搜索筛选。'],
  'activation.intentExamples': ['典型请求（可选）', '每行一个请求，帮助系统匹配。保留现有内容即可。'],
  'workflow.roles': ['任务职责'], 'workflow.artifactKinds': ['交付形式'],
  'workflow.sourceKinds': ['输入来源'], 'workflow.qaKinds': ['检查能力'],
  'workflow.requiredSkills': ['依赖的 Skill', '从本机库选择；尚未安装的已有依赖会保留并标记。'],
  'requirements.python.version': ['Python 版本', '例如 >=3.10,<3.14；留空表示未限制。'],
  'requirements.python.packages': ['Python 软件包', '每行一个依赖，例如 pandas>=2.0 或 requests[socks]>=2.31。'],
  'requirements.python.files': ['额外依赖文件', '每行一个包内相对路径，例如 requirements-inference.txt；根目录 requirements.txt 自动检查。'],
  'requirements.commands': ['系统命令', '每行一个命令名，例如 ffmpeg 或 libreoffice。'],
  'requirements.environment': ['环境变量名称', '每行一个名称，例如 DATA_API_URL。凭据应通过对应连接配置。'],
  'requirements.mcpServers': ['MCP 服务', '每行一个已配置的 MCP key；服务是否在线需另做连接测试。'],
  'execution.manifest': ['执行接口文件'],
  'compatibility.executionProfiles': ['执行方式'], 'compatibility.producesEvidenceKinds': ['可产生的来源证据'],
};
const VALUES = {
  primary_builder: '主导任务', source_provider: '提供来源数据', support: '辅助处理', qa: '检查结果',
  html: 'HTML 页面', document: '文档', presentation: '演示文稿', spreadsheet: '表格', image: '图片', audio: '音频', code: '代码', none: '不直接生成文件',
  api: 'API', database: '数据库', dataset: '数据集', repository: '代码仓库', rubric: '评审标准', web: '网页',
  browser: '浏览器检查', content: '内容检查', openability: '文件可打开', playwright: 'Playwright', visual: '视觉检查', local_script: '本地脚本',
  source_summary: '来源摘要', source_urls: '来源链接', schema_summary: '结构摘要', record_counts: '记录数量', table_coverage: '表覆盖情况', structured_extraction_artifact: '结构化提取文件', explicit_caveats: '明确的限制说明',
};
const ORIGINS = { package: '包内声明', legacy: '包内历史声明', detected: '自动识别', suggested: '模型建议', user: '用户维护' };
const get = (value, path) => path.split('.').reduce((current, key) => current?.[key], value);
function set(value, path, next) { const keys = path.split('.'); let current = value; for (const key of keys.slice(0, -1)) current = current[key] ??= {}; current[keys.at(-1)] = next; }
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }

function createTagPicker(field, value, options, label) {
  const selected = new Set(value ?? []);
  const pattern = new RegExp(field.pattern);
  const choices = [...new Set([...(value ?? []), ...options])].filter(tag => typeof tag === 'string' && tag.length <= field.maxLength && pattern.test(tag));
  const picker = el('details', undefined, 'skill-tag-picker');
  const summary = el('summary'); summary.setAttribute('role', 'button'); summary.setAttribute('aria-label', label); summary.setAttribute('aria-expanded', 'false'); summary.dataset.fieldInput = field.path;
  const caption = el('span', undefined, 'skill-tag-caption');
  const count = el('small', undefined, 'skill-tag-count');
  summary.append(caption, count, el('span', '▾', 'skill-tag-arrow'));
  const panel = el('div', undefined, 'skill-tag-panel');
  const search = el('input'); search.type = 'search'; search.placeholder = '搜索已有标签'; search.setAttribute('aria-label', '搜索语义标签');
  const list = el('div', undefined, 'skill-tag-options'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', '可选语义标签');
  const empty = el('small', '', 'skill-field-help');
  const inputs = [];
  const refresh = () => {
    caption.textContent = selected.size ? [...selected].join('、') : '请选择语义标签';
    count.textContent = `${selected.size} 项`;
    summary.title = `已选 ${selected.size} 项${field.maxItems ? `，最多 ${field.maxItems} 项` : ''}`;
    let visible = 0;
    for (const { input, item } of inputs) {
      input.disabled = !input.checked && selected.size >= field.maxItems;
      item.hidden = !input.value.includes(search.value.trim().toLowerCase());
      if (!item.hidden) visible++;
    }
    empty.hidden = visible > 0;
    empty.textContent = choices.length ? '没有匹配的标签，请换个关键词。' : '暂无可选标签，请先在 Skill 包内声明标签。';
  };
  for (const tag of choices) {
    const item = el('label', undefined, 'skill-choice');
    const input = el('input'); input.type = 'checkbox'; input.value = tag; input.checked = selected.has(tag); input.setAttribute('aria-label', `${label}：${tag}`);
    input.onchange = () => { if (input.checked) selected.add(tag); else selected.delete(tag); refresh(); };
    item.append(input, el('span', tag)); list.append(item); inputs.push({ input, item });
  }
  search.oninput = event => { event.stopPropagation(); refresh(); };
  search.onchange = event => event.stopPropagation();
  picker.ontoggle = () => summary.setAttribute('aria-expanded', String(picker.open));
  picker.onkeydown = event => {
    if (event.key === 'Escape' && picker.open) { event.preventDefault(); event.stopPropagation(); picker.open = false; summary.focus(); }
  };
  picker.onfocusout = event => { if (event.relatedTarget && !picker.contains(event.relatedTarget)) picker.open = false; };
  panel.append(search, list, empty); picker.append(summary, panel); refresh();
  return { element: picker, control: summary, read: () => [...selected] };
}

/** The server supplies every field, enum and validation limit. */
export function createSkillMetadataForm(meta, packages) {
  const root = el('div', undefined, 'skill-metadata-form');
  const bindings = [];
  const identity = el('div', undefined, 'skill-form-identity');
  const primary = el('div', undefined, 'skill-form-primary');
  const disclosure = (label, id) => {
    const details = el('details', undefined, 'skill-form-details'); details.dataset.section = id;
    details.append(el('summary', label)); return details;
  };
  const advanced = disclosure('更多设置', 'advanced');
  const requirements = disclosure('手动补充依赖', 'requirements');
  requirements.append(el('p', '优先使用包内依赖并自动诊断，通常无需填写。', 'skill-field-help'));
  root.append(identity, primary, advanced, requirements);
  for (const group of meta.editorSchema.groups) {
    const section = el('section', undefined, `skill-form-section skill-form-${group.id}`);
    const [title, description] = GROUPS[group.id] ?? [group.id, ''];
    if (group.id === 'workflow' || group.id === 'execution') section.append(el('strong', title, 'skill-form-section-heading'));
    section.setAttribute('aria-label', title); section.title = description;
    const grid = el('div', undefined, 'skill-form-grid'); section.append(grid);
    for (const field of group.fields) {
      const value = get(meta.declaration, field.path), info = meta.fields[field.path];
      const readOnly = !meta.editable || field.readOnly || info?.editable === false;
      const [label, help] = FIELDS[field.path] ?? [field.path];
      const block = el('div', undefined, 'skill-form-field'); block.dataset.field = field.path;
      const title = el('span', label, 'skill-field-label'); if (field.minItems) title.append(el('small', '必选', 'skill-field-required'));
      const limits = [field.maxItems ? `最多 ${field.maxItems} 项` : '', field.maxLength ? `${field.type === 'list' ? '每项' : '最多'} ${field.maxLength} 字符` : ''].filter(Boolean).join(' · ');
      const origin = ORIGINS[info?.origin] ?? (value === undefined ? '未声明' : group.id === 'execution' ? '包内执行接口' : meta.source === 'package' ? ORIGINS.package : meta.source === 'legacy-frontmatter' ? ORIGINS.legacy : ORIGINS.detected);
      block.title = [origin, limits, ...(info?.evidence ?? [])].filter(Boolean).join(' · ');
      if (readOnly) {
        block.className += ' skill-field-readonly';
        const text = Array.isArray(value) ? value.map(item => VALUES[item] ?? item).join('、') : value;
        if (group.id !== 'identity') block.append(title);
        block.append(el(group.id === 'identity' && field.path === 'identity.description' ? 'p' : 'span', text || '未声明', 'skill-field-value'));
      } else block.append(title);
      if (readOnly) {
        (group.id === 'identity' ? identity : grid).append(block);
        continue;
      }
      let control, read, editor;
      if (field.path === 'activation.semanticTags') {
        const picker = createTagPicker(field, value, meta.semanticTagOptions ?? [], label);
        control = picker.control; read = picker.read; editor = picker.element;
      } else if (field.type === 'choices' || field.type === 'skills') {
        control = el('div', undefined, 'skill-choice-grid'); control.setAttribute('role', 'group'); control.setAttribute('aria-label', label); control.setAttribute('tabindex', '-1');
        const names = new Set(packages.filter(pkg => pkg.validationStatus === 'valid').map(pkg => pkg.skillName));
        const choices = field.type === 'skills' ? [...new Set([...names].filter(name => name !== meta.name).concat(value ?? []))] : field.values;
        const inputs = [];
        for (const choice of choices) {
          const item = el('label', undefined, 'skill-choice'); const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.value = choice; checkbox.checked = (value ?? []).includes(choice); checkbox.disabled = readOnly;
          checkbox.setAttribute('aria-label', `${label}：${VALUES[choice] ?? choice}`);
          item.append(checkbox, el('span', `${VALUES[choice] ?? choice}${field.type === 'skills' && !names.has(choice) ? '（未安装）' : ''}`)); control.append(item); inputs.push(checkbox);
        }
        if (!choices.length) control.append(el('small', '暂无其他已安装 Skill；可以先上传依赖的 Skill。'));
        read = () => inputs.filter(input => input.checked).map(input => input.value);
      } else {
        control = el(field.type === 'text' ? 'input' : 'textarea'); control.value = Array.isArray(value) ? value.join('\n') : value ?? '';
        if (readOnly && value === undefined) control.placeholder = '未声明';
        if (control.tagName === 'TEXTAREA') { control.rows = 3; control.spellcheck = false; }
        control.disabled = readOnly; control.setAttribute('aria-label', label); control.dataset.fieldInput = field.path;
        if (field.type !== 'list' && field.maxLength) control.maxLength = field.maxLength;
        read = () => field.type === 'list' ? [...new Set(control.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean))] : control.value.trim();
      }
      const error = el('small', '', 'skill-field-error'); error.setAttribute('role', 'alert');
      block.append(editor ?? control); if (help) block.append(el('small', help, 'skill-field-help'));
      const disclosure = group.id === 'requirements' ? requirements : advanced;
      const isPrimary = field.path === 'activation.intentExamples';
      block.append(error); (isPrimary ? primary : grid).append(block);
      bindings.push({ field, read, error, control, readOnly, disclosure: isPrimary ? undefined : disclosure });
    }
    if (group.id !== 'identity') (group.id === 'requirements' ? requirements : advanced).append(section);
  }
  const evidence = meta.generation?.packageEvidence;
  if (evidence) {
    const sources = el('section', undefined, 'skill-form-section');
    sources.append(el('strong', '识别依据', 'skill-form-section-heading'), el('p', evidence.documents.map(doc => `${doc.path}${doc.truncated ? '（节选）' : ''}`).join('、'), 'skill-field-help'));
    if (evidence.omitted.length) sources.append(el('p', `未读取：${evidence.omitted.map(item => `${item.path}（${({ private: '私密文件', budget: '超过读取范围', unreadable: '无法读取', binary: '非文本' })[item.reason]}）`).join('、')}`, 'skill-field-help'));
    advanced.append(sources);
  }
  const json = el('section', undefined, 'skill-form-section');
  json.append(el('strong', '声明 JSON（只读）', 'skill-form-section-heading'), el('pre', JSON.stringify(meta.declaration, null, 2), 'skill-install-log'));
  advanced.append(json);
  function read() {
    const declaration = structuredClone(meta.declaration); let valid = true;
    for (const binding of bindings) {
      if (binding.readOnly) continue;
      const { field, error, control } = binding, value = binding.read(); const items = Array.isArray(value) ? value : value ? [value] : [];
      let issue = '';
      if (items.length < (field.minItems ?? 0)) issue = `请至少选择 ${field.minItems} 项。`;
      else if (field.maxItems && items.length > field.maxItems) issue = `最多填写 ${field.maxItems} 项。`;
      else if (field.maxLength && items.some(item => item.length > field.maxLength)) issue = `每项不能超过 ${field.maxLength} 字符。`;
      else if (field.pattern && items.some(item => !new RegExp(field.pattern).test(item))) issue = '格式不正确，请按字段说明填写。';
      else if (field.path === 'requirements.python.files' && items.some(path => path.includes('\\') || path.includes(':') || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..'))) issue = '请填写包内相对路径，不能包含上级目录。';
      error.textContent = issue; control.setAttribute('aria-invalid', String(Boolean(issue)));
      if (issue) { if (binding.disclosure) binding.disclosure.open = true; if (valid) control.focus(); valid = false; }
      if (field.optional && !value) { const keys = field.path.split('.'); const parent = get(declaration, keys.slice(0, -1).join('.')); if (parent) delete parent[keys.at(-1)]; continue; }
      set(declaration, field.path, value);
    }
    const requirements = declaration.requirements;
    if (requirements?.python && !requirements.python.version && !requirements.python.packages?.length && !requirements.python.files?.length) delete requirements.python;
    if (requirements && !requirements.python && !requirements.commands?.length && !requirements.environment?.length && !requirements.mcpServers?.length && !meta.declaration.requirements) delete declaration.requirements;
    return { valid, declaration };
  }
  return { element: root, read };
}

const CHECK_STATES = { satisfied: '已满足', missing: '缺失', incompatible: '版本不符', unknown: '待核实', manual: '需手动处理', skipped: '当前环境不需要' };
const PHASES = { preparing: '准备共享环境', installing: '安装 Python 依赖', checking: '验证依赖', activating: '重载 Runtime', finished: '已结束' };
const INSTALL_ERRORS = {
  skill_requirements_plan_stale: '依赖或 Runtime 配置已变化，请重新诊断并查看安装方案。',
  runtime_active_runs_prevent_reconfiguration: '仍有活动任务，请等待任务结束后再安装。',
  runtime_operation_in_progress: 'Runtime 正在执行其他管理操作，请稍后重试。',
  skill_requirements_install_not_available: '当前依赖不能直接安装，请先处理诊断中的缺口。',
  skill_requirements_process_timeout: '安装超时，请检查网络和软件包是否可用后重试。',
  skill_requirements_process_unavailable: '解释器或安装工具不可用，请检查 Python 环境。',
  skill_requirements_process_failed: '安装进程未成功。请查看下方日志，检查版本冲突或是否缺少可用的二进制软件包。',
  skill_requirements_verification_failed: '安装后的依赖检查未通过，新共享环境未启用。',
  skill_requirements_runtime_reload_failed: 'Python 依赖已安装并通过检查，但本机 Runtime 重载失败。请到 Runtime 管理查看原因并重启。',
  skill_installation_interrupted: '上次安装因服务退出而中断，请重新诊断后重试。',
  skill_installation_record_failed: '安装操作已结束，但安装记录保存失败。请重新诊断确认当前环境。',
};

export async function renderSkillRequirements({ container, pkg, api, changed, back }) {
  const title = el('div', undefined, 'skill-metadata-heading'); title.append(el('strong', `${pkg.displayName || pkg.skillName} · 依赖诊断`));
  const content = el('div', undefined, 'skill-requirements-content'), actions = el('div', undefined, 'capability-actions');
  container.replaceChildren(title, el('p', '检查本机共享运行环境。依赖安装一次，供各 Runtime 使用；点击安装后才会下载软件包。'), actions, content);
  let busy = false;
  const button = (text, operation) => { const control = el('button', text); control.type = 'button'; control.onclick = () => void work(operation); return control; };
  const path = action => `/api/skills/${pkg.packageId}/requirements/${action}`;
  async function work(operation) {
    if (busy) return; busy = true;
    const controls = [...container.querySelectorAll('button')].filter(control => !control.disabled); controls.forEach(control => control.disabled = true);
    try { await operation(); }
    catch (error) { content.replaceChildren(el('p', INSTALL_ERRORS[error.message] ?? '依赖诊断未完成，请重新检查 Skill 和本机运行环境。', 'skill-field-error')); }
    finally { busy = false; controls.forEach(control => { if (control.isConnected) control.disabled = false; }); }
  }
  function showDiagnosis(report) {
    content.replaceChildren();
    const summary = report.status === 'satisfied' ? '已声明及已发现的依赖检查通过。' : '部分依赖需要处理；详见下方检查结果。';
    content.append(el('p', summary, `skill-diagnosis-summary ${report.status}`), el('small', `${report.environment === 'managed' ? '本机共享 Python 环境' : '宿主执行环境'} · ${new Date(report.checkedAt).toLocaleString()} · 元数据版本 ${report.metadataRevision}`));
    if (!report.checks.length) content.append(el('p', '未声明或发现可检查的依赖；此结果不代表业务执行已经验证。'));
    for (const check of report.checks) {
      const row = el('div', undefined, `skill-check-row ${check.status}`); const copy = el('div'); copy.append(el('strong', check.label), el('p', check.detail), el('small', check.origin));
      row.append(copy, el('span', CHECK_STATES[check.status], 'skill-check-state')); content.append(row);
    }
    if (report.canInstall) { const install = button('查看 Python 依赖安装方案', showPlan); install.classList.add('primary'); content.append(install); }
  }
  async function diagnose() {
    content.replaceChildren(el('p', '正在读取包声明并检查执行环境…'));
    const report = await api(path('diagnose'), {});
    if (!container.isConnected) return;
    showDiagnosis(report);
    if (report.installation?.status === 'running') await followInstallation(report.installation);
  }
  async function showPlan() {
    const plan = await api(path('plan'), {});
    content.replaceChildren(el('strong', '安装到本机共享环境'), el('p', '合并本机 Skill 库的 Python 依赖。安装并检查通过后，所有运行中的 Runtime 会使用新环境；已停止的 Runtime 保持停止。'));
    const list = el('pre', plan.packages.join('\n'), 'skill-install-packages'); content.append(list);
    content.append(el('p', '自动安装仅使用二进制软件包。系统命令、MCP 连接和凭据需按诊断说明配置。'));
    const controls = el('div', undefined, 'capability-actions'); controls.append(button('返回诊断', diagnose));
    if (plan.canInstall) { const install = button('安装 Python 依赖', async () => { const job = await api(path('install'), { fingerprint: plan.fingerprint }); await followInstallation(job); }); install.classList.add('primary'); controls.append(install); }
    else content.append(el('p', '当前存在无法自动安装的依赖，请先处理诊断中的缺口。', 'skill-field-error'));
    content.append(controls);
  }
  async function followInstallation(job) {
    const progress = el('p', '', 'skill-install-progress'), log = el('pre', '', 'skill-install-log'); content.replaceChildren(progress, log);
    const show = item => { progress.textContent = item.status === 'running' ? `正在${PHASES[item.phase]}…` : item.status === 'completed' ? 'Python 依赖已安装并通过检查。' : INSTALL_ERRORS[item.error] ?? `安装未完成（${item.error || '未知错误'}），请查看日志。`; log.textContent = item.log || '正在准备…'; };
    show(job);
    while (job.status === 'running' && container.isConnected) { await new Promise(resolve => setTimeout(resolve, 1000)); if (!container.isConnected) return; job = await api(`/api/skill-installations/${job.id}`); show(job); }
    if (!container.isConnected) return;
    if (job.status === 'completed') { await changed(); content.append(button('查看安装后诊断', diagnose)); }
    else content.append(button('重新诊断', diagnose));
  }
  if (back) actions.append(button('返回运行条件', back)); actions.append(button('重新诊断', diagnose));
  await work(diagnose);
}

/** Upload adds to the shared library; Runtime selection is maintained in Runtime settings. */
export async function renderSkillSetup({ container, pkg, api, changed, close, navigate }) {
  const title = el('div', undefined, 'skill-metadata-heading'); title.append(el('strong', pkg.displayName || pkg.skillName), el('span', '本机运行条件', 'skill-metadata-badge'));
  const content = el('div', undefined, 'skill-requirements-content'), actions = el('div', undefined, 'capability-actions');
  container.replaceChildren(title, el('p', pkg.description || '按包内说明使用此 Skill。'), el('p', '已加入本机 Skill 库，各 Runtime 可在自身配置中选择。运行资源在本机共享。', 'skill-field-help'), content, actions);
  let busy = false, report;
  const button = (text, operation) => { const node = el('button', text); node.type = 'button'; node.onclick = () => void work(operation); return node; };
  async function work(operation) {
    if (busy) return; busy = true;
    container.querySelectorAll('button').forEach(node => node.disabled = true);
    try { await operation(); }
    catch (error) { content.replaceChildren(el('p', INSTALL_ERRORS[error.message] ?? '读取运行条件未完成，请重新检查。', 'skill-field-error')); }
    finally { busy = false; container.querySelectorAll('button').forEach(node => node.disabled = false); }
  }
  function show() {
    content.replaceChildren(); actions.replaceChildren();
    const checks = report.requirements.checks, pending = checks.filter(check => !['satisfied', 'skipped'].includes(check.status));
    const satisfied = [report.modelsConfigured ? '已配置模型' : '', ...checks.filter(check => check.status === 'satisfied').map(check => check.label)].filter(Boolean);
    content.append(el('p', `已满足：${satisfied.length ? satisfied.join(' · ') : '暂无'}`, 'skill-setup-satisfied'));
    if (report.selectedBy.length) content.append(el('p', `已选择此 Skill：${report.selectedBy.map(runtime => runtime.displayName).join(' · ')}`, 'skill-field-help'));
    const gaps = [!report.modelsConfigured ? '尚未配置模型' : '', ...pending.map(check => `${check.label}：${check.detail}`)].filter(Boolean);
    if (gaps.length) {
      const list = el('div', undefined, 'skill-setup-gaps'); list.append(el('strong', '待补配置'));
      for (const gap of gaps.slice(0, 4)) list.append(el('p', gap));
      if (gaps.length > 4) list.append(el('small', `另有 ${gaps.length - 4} 项，可在依赖诊断中查看。`));
      content.append(list);
    } else content.append(el('p', checks.length ? '当前检查项均已满足。' : '未发现需要检查的额外依赖。', 'skill-field-help'));
    if (!report.modelsConfigured && navigate) actions.append(button('配置模型', () => navigate('models')));
    if (pending.some(check => check.kind === 'mcp') && navigate) actions.append(button('配置 MCP', () => navigate('mcp')));
    actions.append(button('依赖诊断', () => renderSkillRequirements({ container, pkg, api, changed,
      back: () => renderSkillSetup({ container, pkg, api, changed, close, navigate }) })));
    actions.append(button('重新检查', load)); if (close) actions.append(button('收起', close));
  }
  async function load() { content.replaceChildren(el('p', '正在检查本机运行条件…')); report = await api(`/api/skills/${pkg.packageId}/setup`, {}); if (container.isConnected) show(); }
  await work(load);
}
