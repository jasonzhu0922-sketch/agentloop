// Table definitions have one editing surface; observations remain read-only.
export function createTableSettings({ getCatalog, esc, field, area, actions, bindForm, modal, saveChanges, request, feedback }) {
  let selected, active = 'definition';
  const names = { current: '结构匹配', stale: '结构或旧定义待核对', invalid: '字段引用无效', not_prepared: '未维护表语义', unverified: '待验证', provisional: '待确认', confirmed: '已确认', ambiguous: '存在冲突', unresolved: '未确认', verified: '已验证', multiple_rows: '存在重复', observed_only: '仅为观测', scoped: '按条件定义' };
  const state = value => names[value] || value || '未确认';
  const lines = value => String(value || '').split(/\r?\n/).map(v => v.trim()).filter(Boolean);
  const list = (value = []) => value.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join('\n');
  const select = (name, label, entries, value = '', extra = '') => `<label>${esc(label)}<select name="${name}" ${extra}>${entries.map(([v, text]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`;
  const columnSelect = (name, label, table, values = [], multiple = false) => select(name, label, [['', '未指定'], ...table.columns.map(c => [c.name, `${c.label || c.name} · ${c.name}`])], multiple ? undefined : values, multiple ? 'multiple size="3"' : '');
  const chips = values => values.filter(Boolean).map(v => `<span class="tag">${esc(v)}</span>`).join('');
  const summaryOf = table => getCatalog().table_summaries?.find(s => s.source_id === table.name) || { source_id: table.name };
  const variantsOf = (table, column) => (getCatalog().period_formats || []).filter(p => p.source_id === table.name && p.field === column.name);
  function issues(table) {
    const summary = summaryOf(table), output = [];
    if (!summary.record_semantics) output.push('未定义一行含义');
    if (!summary.row_grain?.length) output.push('未定义记录粒度');
    if (['stale', 'invalid'].includes(table.understanding_status)) output.push(state(table.understanding_status));
    const pending = table.columns.filter(c => c.format_status && !['confirmed', 'scoped'].includes(c.format_status));
    if (pending.length) output.push(`${pending.length} 个字段格式待确认`);
    return output;
  }
  function roles(table, column) {
    const catalog = getCatalog(), result = [], summary = summaryOf(table);
    for (const e of catalog.entities || []) if (e.source_id === table.name) {
      if (e.key_field === column.name) result.push('对象编码');
      if (e.name_fields?.includes(column.name)) result.push('对象名称');
    }
    if (summary.row_grain?.includes(column.name)) result.push('粒度');
    if (summary.time_fields?.includes(column.name) || variantsOf(table, column).length || ['date', 'datetime', 'period'].includes(column.logical_type)) result.push('时间');
    if (summary.metric_fields?.includes(column.name)) result.push('度量');
    if (summary.dimension_fields?.includes(column.name)) result.push('维度');
    if ((catalog.relationships || []).some(r => r.joinable !== false && ['left', 'right'].some(k => r[k]?.source_id === table.name && r[k]?.fields?.includes(column.name)))) result.push('关联键');
    return [...new Set(result)];
  }
  function render(root) {
    const catalog = getCatalog(), table = catalog.tables.find(t => t.name === selected);
    if (table) return detail(root, table);
    selected = undefined;
    root.innerHTML = `<div class="content-header"><div><h2>数据表</h2><p>维护表与字段定义，核对实际数据和适用范围。</p></div><span class="table-count">${catalog.tables.length} 张表</span></div><form class="knowledge-search" id="table-search"><input name="query" aria-label="搜索数据表" placeholder="表名、字段名或业务问题"><button class="secondary-btn">检索比对</button><button class="secondary-btn" type="reset">全部</button></form><div class="table-catalog">${catalog.tables.map(t => {
      const s = summaryOf(t);
      return `<article class="table-row" data-source="${esc(t.name)}"><div><b>${esc(t.label || t.name)}</b><code>${esc(t.schema)}.${esc(t.name)}</code><p>${esc(s.record_semantics || t.description || '尚未填写表说明')}</p><div class="record-tags">${chips([`${t.columns.length} 个字段`, ...issues(t)])}</div></div><button class="secondary-btn" data-open-table="${esc(t.name)}">查看与维护</button></article>`;
    }).join('')}</div>`;
    root.querySelectorAll('[data-open-table]').forEach(b => b.onclick = () => { selected = b.dataset.openTable; active = 'definition'; render(root); });
    const form = root.querySelector('#table-search');
    const filter = predicate => root.querySelectorAll('[data-source]').forEach(node => { node.hidden = !predicate(catalog.tables.find(t => t.name === node.dataset.source)); });
    form.elements.query.oninput = () => { const q = form.elements.query.value.toLowerCase(); filter(t => JSON.stringify([t.name, t.label, t.columns.map(c => [c.name, c.label]), summaryOf(t).record_semantics]).toLowerCase().includes(q)); };
    form.onreset = () => { filter(() => true); feedback(''); };
    form.onsubmit = async event => {
      event.preventDefault();
      const q = form.elements.query.value.trim(); if (!q) return filter(() => true);
      try { const result = await request('search?query=' + encodeURIComponent(q)); const hits = result.tables.filter(t => t.score > 0).map(t => t.source_id); filter(t => hits.includes(t.name)); feedback(`找到 ${hits.length} 张相关表。`); }
      catch (error) { feedback(error.message, true); }
    };
  }
  function detail(root, table) {
    const summary = summaryOf(table);
    root.innerHTML = `<button class="table-back" id="back-to-tables">← 全部数据表</button><div class="table-detail-heading"><div><h2>${esc(table.label || table.name)}</h2><code>${esc(table.schema)}.${esc(table.name)}</code></div><div class="record-tags">${chips([state(table.understanding_status), `定义${state(summary.status)}`])}</div></div><p class="table-synopsis">${esc(summary.record_semantics || table.description || '尚未定义一行含义')}</p><nav class="table-tabs" aria-label="表详情">${[['definition', '基本定义'], ['columns', `字段定义 ${table.columns.length}`], ['observations', '数据概况'], ['relations', '关联与待确认']].map(([key, label]) => `<button data-table-tab="${key}" aria-current="${active === key ? 'page' : 'false'}">${label}</button>`).join('')}</nav><div id="table-detail-body"></div>`;
    root.querySelector('#back-to-tables').onclick = () => { selected = undefined; render(root); };
    root.querySelectorAll('[data-table-tab]').forEach(b => b.onclick = () => { active = b.dataset.tableTab; detail(root, table); });
    const body = root.querySelector('#table-detail-body');
    if (active === 'definition') definition(body, table, summary);
    if (active === 'columns') columns(body, table);
    if (active === 'observations') observations(body, table);
    if (active === 'relations') relations(body, table);
  }
  function definition(root, table, prior) {
    root.innerHTML = `<form class="form-card compact-form" id="table-definition-form"><div class="field-grid">${field('label', '中文名', table.label)}${field('business_domain', '业务领域', prior.business_domain)}</div>${area('description', '综合说明', table.description, 'rows="2" placeholder="这张表记录什么、用于什么"')}<div class="field-grid">${select('table_kind', '表的性质', [['', '未确认'], ['detail', '明细'], ['snapshot', '快照'], ['aggregate', '汇总'], ['dimension', '维度'], ['relationship', '关系']], prior.table_kind)}${field('purpose', '主要用途', prior.purpose)}</div>${area('record_semantics', '一行含义', prior.record_semantics, 'rows="2" placeholder="例如：一家公司一个月一项指标的一次上报记录"')}<div class="field-grid">${columnSelect('row_grain', '记录粒度', table, prior.row_grain, true)}${columnSelect('candidate_unique_key', '候选唯一键', table, prior.candidate_unique_key, true)}</div><p class="compact-hint">可多选真实字段。粒度描述记录层次，唯一键用于定位一行。唯一性：${esc(state(prior.unique_key_status || prior.grain_status))}；保存定义不会完成数据验证。</p><details class="definition-section"><summary>时间与更新</summary><div class="field-grid">${columnSelect('time_fields', '时间字段', table, prior.time_fields, true)}${area('time_semantics', '时间口径', prior.time_semantics, 'rows="2" placeholder="统计期间、发生时间、快照时点的含义"')}</div><div class="field-grid">${field('update_mode', '更新方式', prior.update_mode)}${field('update_frequency', '更新频率', prior.update_frequency)}</div>${area('entity_semantics', '对象与组织口径', prior.entity_semantics, 'rows="2"')}</details><details class="definition-section"><summary>适用范围与依据</summary><div class="field-grid">${area('query_scenarios', '适用问题（每行一项）', list(prior.query_scenarios), 'rows="3"')}${area('not_suitable_for', '不适用范围（每行一项）', list(prior.not_suitable_for), 'rows="3"')}</div>${area('limitations', '待确认事项（每行一项）', list(prior.limitations), 'rows="2"')}${area('business_terms', '检索词（每行一项）', list(prior.business_terms), 'rows="2"')}${area('evidence_ids', '定义依据（每行一项）', list(prior.evidence_ids), 'rows="2" placeholder="数据字典、制度文档或人工确认记录"')}<label class="check"><input type="checkbox" name="confirm_definition">依据上述资料确认本次表定义</label></details>${actions('保存定义')}</form>`;
    const form = root.querySelector('form');
    for (const key of ['row_grain', 'candidate_unique_key', 'time_fields']) for (const option of form.elements[key].options) option.selected = (prior[key] || []).includes(option.value);
    bindForm(form, async () => {
      const data = new FormData(form), catalog = getCatalog();
      const summary = { ...prior };
      for (const key of ['business_domain', 'purpose', 'record_semantics', 'table_kind', 'time_semantics', 'entity_semantics', 'update_mode', 'update_frequency']) summary[key] = String(data.get(key) || '').trim();
      for (const key of ['row_grain', 'candidate_unique_key', 'time_fields']) summary[key] = data.getAll(key).filter(Boolean);
      for (const key of ['query_scenarios', 'not_suitable_for', 'limitations', 'business_terms', 'evidence_ids']) summary[key] = lines(data.get(key));
      summary.confirm_definition = data.has('confirm_definition');
      summary.provenance = { ...prior.provenance, kind: 'manual', updated_at: new Date().toISOString() };
      const summaries = structuredClone(catalog.table_summaries || []), index = summaries.findIndex(s => s.source_id === table.name);
      if (index < 0) summaries.push(summary); else summaries[index] = summary;
      await saveChanges({ tables: catalog.tables.map(t => t.name === table.name ? { ...t, label: String(data.get('label')).trim(), description: String(data.get('description')).trim() } : t), table_summaries: summaries });
      await api.reload();
      feedback('表定义已保存。数据验证状态独立保留。');
    });
  }
  function columns(root, table) {
    root.innerHTML = `<div class="field-toolbar"><input type="search" aria-label="筛选字段" placeholder="字段名、中文名"><small>${table.columns.length} 个字段 · 点击编辑</small></div><div class="compact-fields">${table.columns.map((c, index) => `<button class="field-row" data-field="${index}"><span><b>${esc(c.label || c.name)}</b><code>${esc(c.name)}</code></span><span><code>${esc(c.type)}</code><small>${esc(roles(table, c).join('、') || '角色未绑定')}</small></span><span>${esc(c.format || c.unit || (c.unit_field ? `单位：${c.unit_field}` : '—'))}<small>${esc(state(c.status))}${c.format_status && c.format_status !== 'confirmed' ? ' · 格式' + esc(state(c.format_status)) : ''}</small></span><span aria-hidden="true">›</span></button>`).join('')}</div>`;
    root.querySelector('input').oninput = event => { const q = event.target.value.toLowerCase(); root.querySelectorAll('[data-field]').forEach(node => { const c = table.columns[Number(node.dataset.field)]; node.hidden = !`${c.name} ${c.label || ''}`.toLowerCase().includes(q); }); };
    root.querySelectorAll('[data-field]').forEach(b => b.onclick = () => editColumn(table, Number(b.dataset.field)));
  }
  function editColumn(table, index) {
    const c = table.columns[index], variants = variantsOf(table, c), scoped = variants.length > 1 || variants.some(v => v.selector && Object.keys(v.selector).length);
    const domain = c.declared_domain || {}, scope = c.scope_filter || {};
    const fields = `<div class="physical-facts"><b>${esc(c.name)}</b> <code>${esc(c.type)}</code><span>可空：${esc(c.is_nullable ?? '未知')}</span><span>键：${esc(c.column_key || '未声明')}</span><span>精度：${esc(c.numeric_precision ?? '—')} / ${esc(c.numeric_scale ?? '—')}</span></div><div class="field-grid">${field('label', '中文名', c.label)}${select('logical_type', '逻辑类型', [['', '未确认'], ['identifier', '编码'], ['text', '文本'], ['number', '数值'], ['boolean', '布尔'], ['category', '分类'], ['date', '日期'], ['datetime', '日期时间'], ['period', '统计期间']], c.logical_type)}</div>${area('description', '字段含义', c.description, 'rows="2"')}<p class="compact-hint">已关联角色：${esc(roles(table, c).join('、') || '暂无')}。</p><div class="field-grid">${field('format', '存储格式', c.format, 'text', scoped ? 'readonly' : '')}${select('granularity', '时间粒度', [['', '未确认'], ['year', '年'], ['month', '月'], ['day', '日']], c.granularity, scoped ? 'disabled' : '')}</div>${variants.length ? `<p class="compact-hint">已有 ${variants.length} 个时间格式定义。${scoped ? '条件格式在“时间格式变体”中维护。' : '全局时间格式会随字段定义同步更新。'} <a href="#period_formats" data-close-editor>查看定义 →</a></p>` : ''}<div class="field-grid">${field('unit', '固定单位', c.unit)}${columnSelect('unit_field', '或引用单位字段', table, c.unit_field)}</div><details class="definition-section" ${domain.kind ? 'open' : ''}><summary>允许值域与编码含义</summary>${select('domain_kind', '值域规则', [['', '未定义'], ['range', '数值范围'], ['enum', '枚举编码'], ['pattern', '格式规则']], domain.kind)}<div data-domain="range" class="field-grid">${field('domain_min', '允许最小值', domain.min, 'number', 'step="any"')}${field('domain_max', '允许最大值', domain.max, 'number', 'step="any"')}</div><div data-domain="enum">${area('domain_values', '编码 | 含义（每行一项）', (domain.values || []).map(v => `${v.value} | ${v.meaning || ''}`).join('\n'), 'rows="3"')}</div><div data-domain="pattern">${field('domain_pattern', '格式规则', domain.pattern)}</div>${area('value_domain', '值域补充说明', c.value_domain, 'rows="2"')}<p class="compact-hint">这里只定义允许值；实际出现的值见“数据概况”。</p></details><details class="definition-section" ${scope.field ? 'open' : ''}><summary>定义适用的记录范围</summary><div class="field-grid">${columnSelect('scope_field', '条件字段（留空表示整表）', table, scope.field)}${select('scope_operator', '条件', [['eq', '等于'], ['in', '属于集合'], ['like_any', '匹配任一模式']], scope.operator || 'eq')}</div>${area('scope_values', '条件值（每行一项）', list(scope.values || scope.patterns), 'rows="2"')}</details><details class="definition-section"><summary>确认依据与观测记录</summary>${area('evidence_ids', '定义依据（每行一项）', list(c.evidence_ids), 'rows="2"')}<label class="check"><input type="checkbox" name="confirm_definition">依据上述资料确认本次字段定义及格式</label><p class="compact-hint">当前定义：${esc(state(c.status))}；格式：${esc(state(c.format_status))}。确认定义不会删除历史观测或自动解决已有缺口。</p>${c.format_observed_shapes ? `<p>已观察格式：${esc(list(c.format_observed_shapes))}</p>` : '<p class="compact-hint">尚无字段格式观测记录。</p>'}</details><label class="check"><input name="allow_output" type="checkbox" ${c.allow_output !== false ? 'checked' : ''}>允许作为结果字段输出</label>`;
    modal(`字段定义 · ${c.label || c.name}`, fields, async data => {
      const value = { ...c };
      for (const key of ['label', 'description', 'logical_type', 'unit', 'unit_field', 'value_domain']) value[key] = String(data.get(key) || '').trim();
      if (!scoped) for (const key of ['format', 'granularity']) value[key] = String(data.get(key) || '').trim();
      value.evidence_ids = lines(data.get('evidence_ids')); value.confirm_definition = data.has('confirm_definition'); value.allow_output = data.has('allow_output');
      const kind = data.get('domain_kind'); delete value.declared_domain;
      if (kind === 'range') { value.declared_domain = { kind }; for (const [name, input] of [['min', 'domain_min'], ['max', 'domain_max']]) if (String(data.get(input)).trim()) value.declared_domain[name] = Number(data.get(input)); }
      if (kind === 'enum') value.declared_domain = { kind, values: lines(data.get('domain_values')).map(line => { const at = line.indexOf('|'); const code = (at < 0 ? line : line.slice(0, at)).trim(); return { value: domain.values?.find(v => String(v.value) === code)?.value ?? code, meaning: at < 0 ? '' : line.slice(at + 1).trim() }; }) };
      if (kind === 'pattern') value.declared_domain = { kind, pattern: String(data.get('domain_pattern')).trim() };
      delete value.scope_filter;
      if (data.get('scope_field')) { const operator = data.get('scope_operator'); value.scope_filter = { field: data.get('scope_field'), operator, [operator === 'like_any' ? 'patterns' : 'values']: lines(data.get('scope_values')) }; }
      await saveChanges({ tables: getCatalog().tables.map(t => t.name === table.name ? { ...t, columns: t.columns.map((col, i) => i === index ? value : col) } : t) });
    });
    const form = document.querySelector('#editor-form'); form.classList.add('compact-form');
    document.querySelector('#editor-dialog').classList.add('table-field-editor');
    const updateDomain = () => form.querySelectorAll('[data-domain]').forEach(node => { node.hidden = node.dataset.domain !== form.elements.domain_kind.value; });
    form.elements.domain_kind.onchange = updateDomain; updateDomain();
    form.querySelectorAll('[data-close-editor]').forEach(a => a.onclick = () => document.querySelector('#editor-dialog').close());
  }
  function observations(root, table) {
    const catalog = getCatalog(), records = [...(catalog.observed_probes || []), ...(catalog.coverage || [])].filter(p => p.source_id === table.name);
    const summary = summaryOf(table);
    root.innerHTML = `<p class="compact-hint">以下为已保存的数据证据。观测只对记录的时间和查询范围有效；样本不代表完整值域。</p><div class="observation-summary">${chips([`粒度核验：${state(summary.grain_status)}`, `唯一性：${state(summary.unique_key_status)}`, `${records.length} 条观测记录`])}</div>${records.length ? records.map(p => {
      const evidence = p.evidence && !Array.isArray(p.evidence) ? p.evidence : {};
      const scope = typeof p.scope === 'string' ? p.scope : JSON.stringify(p.scope || {});
      return `<article class="observation-card"><b>${esc(p.field || '表级观测')}</b><small>观测时间：${esc(p.observed_at || evidence.observed_at || '未记录')} · ${esc(p.method || '计算方式未记录')}</small><p>范围：${esc(scope === '{}' ? '未记录，不能视为全表结论' : scope)}</p><div class="record-tags">${chips([p.row_count != null && `行数 ${p.row_count}`, p.min != null && `最小值 ${p.min}`, p.max != null && `最大值 ${p.max}`, p.null_rate != null && `空值率 ${p.null_rate}`, p.distinct_count != null && `不同值 ${p.distinct_count}`])}</div>${p.observed_shapes ? `<p>格式分布：${esc(list(p.observed_shapes))}</p>` : ''}<details><summary>查看查询与原始证据</summary><pre>${esc(JSON.stringify(p, null, 2))}</pre></details></article>`;
    }).join('') : '<div class="table-empty">尚未探查。没有可用于声明真实范围的查询证据。</div>'}${summary.grain_evidence || summary.unique_key_evidence ? `<details class="definition-section"><summary>已有粒度与唯一性证据</summary><pre>${esc(JSON.stringify({ grain: summary.grain_evidence, unique_key: summary.unique_key_evidence }, null, 2))}</pre></details>` : ''}`;
  }
  function relations(root, table) {
    const catalog = getCatalog();
    const groups = [['业务对象', 'semantic_objects', (catalog.entities || []).filter(e => e.source_id === table.name)], ['指标', 'metrics', (catalog.metrics || []).filter(m => m.table === table.name)], ['术语', 'terms', (catalog.terms || []).filter(t => (t.source_id || t.table) === table.name)], ['关系', 'relationships', (catalog.relationships || []).filter(r => ['left', 'right', 'parent', 'child', 'subject', 'object'].some(k => r[k]?.source_id === table.name))], ['时间格式', 'period_formats', (catalog.period_formats || []).filter(p => p.source_id === table.name)]];
    const gaps = (catalog.semantic_gaps || []).filter(g => g.source_ids?.includes(table.name));
    root.innerHTML = `<div class="table-related">${groups.map(([label, panel, items]) => `<div><span><b>${label}</b><small>${esc(items.map(i => i.label || i.name || i.term || i.field || i.id).join('、') || '暂无显式绑定')}</small></span><a href="#${panel}">${items.length} 项 · 维护 →</a></div>`).join('')}</div><div class="table-issues"><b>待确认事项</b>${[...issues(table), ...(summaryOf(table).limitations || []), ...gaps.map(g => g.meaning)].map(text => `<p>${esc(text)}</p>`).join('') || '<p>当前未记录待确认事项。</p>'}${gaps.length ? '<a href="#semantic_gaps">查看语义缺口 →</a>' : ''}</div>`;
  }
  const api = { render, reload: async () => {} };
  return api;
}
