export function createDefinitionsSettings({ getCatalog, esc, field, area, modal, saveChanges, feedback }) {
  const state = { metrics: { category: '*', query: '', page: 0, selected: new Set(), collapsed: new Set() }, terms: { category: '*', query: '', page: 0, selected: new Set(), collapsed: new Set() } };
  let current = 'metrics';
  const lines = text => String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const preserveSelection = (values, previous = []) => values.length === previous.length && values.every(v => previous.includes(v)) ? previous : values;
  const uid = prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
  const rows = panel => getCatalog()[panel] || [];
  const categories = () => getCatalog().categories || [];
  const rowKey = (r, panel) => r.id || (panel === 'metrics' ? r.name : r.term);
  const title = panel => panel === 'metrics' ? '计算指标' : '业务术语';
  const status = value => ({ confirmed: '已确认', provisional: '待确认', stale: '已停用', invalid: '无效', unresolved: '待补充' }[value] || '待确认');
  const option = (name, label, entries, value = '', extra = '') => `<label>${esc(label)}<select name="${name}" ${extra}>${entries.map(([id, text]) => `<option value="${esc(id)}" ${String(id) === String(value ?? '') ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`;
  const multi = (name, label, table, values = []) => `<label>${esc(label)}<select name="${name}" multiple size="3">${(table?.columns || []).map(c => `<option value="${esc(c.name)}" ${values.includes(c.name) ? 'selected' : ''}>${esc(c.label ? `${c.label} · ${c.name}` : c.name)}</option>`).join('')}</select></label>`;
  const fieldOptions = table => [['', '未指定'], ...(table?.columns || []).map(c => [c.name, c.label ? `${c.label} · ${c.name}` : c.name])];
  const tableOptions = () => [['', '选择数据表'], ...getCatalog().tables.map(t => [t.name, `${t.label || t.name} · ${t.name}`])];
  const tableOf = source => getCatalog().tables.find(t => t.name === source);
  function descendants(id) {
    const result = new Set([id]); let previous = 0;
    while (previous !== result.size) { previous = result.size; for (const c of categories()) if (result.has(c.parent_id)) result.add(c.id); }
    return result;
  }
  function paths() {
    const byId = new Map(categories().map(c => [c.id, c]));
    return categories().map(c => { const names = [], seen = new Set(); let at = c; while (at && !seen.has(at.id)) { seen.add(at.id); names.unshift(at.name); at = byId.get(at.parent_id); } return [c.id, names.join(' / ')]; });
  }
  const categoryOptions = excluded => [['', '未分类'], ...paths().filter(([id]) => !excluded?.has(id))];
  const dataSources = row => [...new Set([row.table, row.source_id, ...(row.data_bindings || []).map(b => b.source_id)].filter(Boolean))];
  function render(root, panel) {
    current = panel;
    const local = state[panel], all = rows(panel), byCategory = id => all.filter(r => id === '*' || (id === '' ? !r.category_id : descendants(id).has(r.category_id))).length;
    if (local.category !== '*' && local.category !== '' && !categories().some(c => c.id === local.category)) local.category = '';
    const tree = (parent = null, seen = new Set()) => `<ul>${categories().filter(c => (c.parent_id || null) === parent && !seen.has(c.id)).sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name)).map(c => {
      const children = categories().some(child => child.parent_id === c.id);
      const row = `<button class="category-select ${local.category === c.id ? 'selected' : ''}" data-category="${esc(c.id)}"><span>${esc(c.name)}</span><small>${byCategory(c.id)}</small></button>`;
      return `<li>${children ? `<div class="category-branch"><button class="category-toggle" data-toggle-category="${esc(c.id)}" aria-expanded="${!local.collapsed.has(c.id)}" aria-label="展开或折叠 ${esc(c.name)}">${local.collapsed.has(c.id) ? '▸' : '▾'}</button>${row}</div>${local.collapsed.has(c.id) ? '' : tree(c.id, new Set([...seen, c.id]))}` : row}</li>`;
    }).join('')}</ul>`;
    root.innerHTML = `<div class="content-header definitions-header"><div><h2>${title(panel)}</h2><p>${panel === 'metrics' ? '维护加工计算及聚合口径。直接取值在术语中绑定。' : '维护业务叫法，以及表、字段和直接取数的关联。'}</p></div><button class="action-btn" id="add-record">＋ 新增</button></div><div class="definitions-layout"><details class="category-pane" open><summary>业务分类</summary><div class="category-tools"><button id="add-category">＋ 分类</button><button id="edit-category" ${['*', ''].includes(local.category) ? 'disabled' : ''}>设置</button></div><nav aria-label="业务分类树"><button class="category-select ${local.category === '*' ? 'selected' : ''}" data-category="*"><span>全部</span><small>${all.length}</small></button><button class="category-select ${local.category === '' ? 'selected' : ''}" data-category=""><span>未分类</span><small>${byCategory('')}</small></button>${tree()}</nav></details><section class="definitions-main"><div class="definition-toolbar"><input type="search" id="definition-search" aria-label="搜索名称或别名" placeholder="搜索名称、别名、标签" value="${esc(local.query)}">${option('definition_status', '状态', [['', '全部状态'], ['confirmed', '已确认'], ['provisional', '待确认'], ['stale', '已停用']], local.status || '')}<button class="secondary-btn" id="bulk-category">批量归类</button></div><div id="definition-list"></div></section></div>`;
    if (matchMedia('(max-width: 700px)').matches) root.querySelector('.category-pane').open = false;
    root.querySelectorAll('[data-category]').forEach(b => b.onclick = () => { local.category = b.dataset.category; local.page = 0; local.selected.clear(); render(root, panel); });
    root.querySelectorAll('[data-toggle-category]').forEach(b => b.onclick = () => { const id = b.dataset.toggleCategory; if (local.collapsed.has(id)) local.collapsed.delete(id); else local.collapsed.add(id); render(root, panel); });
    root.querySelector('#add-category').onclick = () => editCategory(undefined, !['*', ''].includes(local.category) ? local.category : null);
    root.querySelector('#edit-category').onclick = () => editCategory(categories().find(c => c.id === local.category));
    root.querySelector('#add-record').onclick = () => editDefinition(panel);
    root.querySelector('#bulk-category').onclick = () => {
      if (!local.selected.size) return feedback('请先勾选需要归类的条目。', true);
      modal(`移动 ${local.selected.size} 项`, option('category_id', '目标分类', categoryOptions()), async data => {
        await saveChanges({ [panel]: all.map(r => local.selected.has(rowKey(r, panel)) ? { ...r, category_id: data.get('category_id') || null } : r) });
        local.selected.clear();
      }); compactModal();
    };
    root.querySelector('#definition-search').oninput = event => { local.query = event.target.value; local.page = 0; drawList(root, panel); };
    root.querySelector('[name=definition_status]').onchange = event => { local.status = event.target.value; local.page = 0; drawList(root, panel); };
    drawList(root, panel);
  }
  function drawList(root, panel) {
    const local = state[panel], all = rows(panel), q = local.query.trim().toLowerCase();
    const under = descendants(local.category);
    const filtered = all.filter(r => (local.category === '*' || (local.category === '' ? !r.category_id : under.has(r.category_id)))
      && (!local.status || (r.status || 'provisional') === local.status)
      && (!q || [r.name, r.label, r.term, ...(r.aliases || []), ...(r.tags || [])].join(' ').toLowerCase().includes(q)));
    local.page = Math.min(local.page, Math.max(0, Math.ceil(filtered.length / 25) - 1));
    const page = filtered.slice(local.page * 25, (local.page + 1) * 25), labels = new Map(paths());
    root.querySelector('#definition-list').innerHTML = `<div class="definition-list-meta"><label><input type="checkbox" id="select-definition-page" ${page.length && page.every(r => local.selected.has(rowKey(r, panel))) ? 'checked' : ''}> 本页</label><span>${filtered.length} 项 · 已选 ${local.selected.size}</span></div><div class="definition-rows">${page.map(r => {
      const index = all.indexOf(r), legacy = panel === 'metrics' && r.aggregation === 'none';
      return `<article class="definition-row"><input type="checkbox" data-select-definition="${index}" aria-label="选择 ${esc(r.label || r.term || r.name)}" ${local.selected.has(rowKey(r, panel)) ? 'checked' : ''}><button class="definition-open" data-edit-definition="${index}"><b>${esc(r.label || r.term || r.name)}</b><small>${esc((r.aliases || []).join('、') || (panel === 'metrics' ? r.expression : r.meaning) || '未填写说明')}</small><span class="definition-meta">${esc([labels.get(r.category_id) || '未分类', ...dataSources(r).map(s => tableOf(s)?.label || s)].join(' · '))}</span></button><span class="definition-badge">${esc(legacy ? '原有取值定义' : status(r.status))}${r.unit ? `<small>${esc(r.unit)}</small>` : ''}</span><button class="definition-retire" data-retire-definition="${index}">${r.status === 'stale' ? '恢复' : '停用'}</button></article>`;
    }).join('') || '<p class="definition-empty">当前分类没有匹配条目。</p>'}</div><div class="definition-pager"><button id="definition-prev" ${local.page === 0 ? 'disabled' : ''}>上一页</button><span>${local.page + 1} / ${Math.max(1, Math.ceil(filtered.length / 25))}</span><button id="definition-next" ${(local.page + 1) * 25 >= filtered.length ? 'disabled' : ''}>下一页</button></div>`;
    root.querySelectorAll('[data-select-definition]').forEach(c => c.onchange = () => { const key = rowKey(all[Number(c.dataset.selectDefinition)], panel); if (c.checked) local.selected.add(key); else local.selected.delete(key); drawList(root, panel); });
    root.querySelector('#select-definition-page').onchange = event => { for (const r of page) { const key = rowKey(r, panel); if (event.target.checked) local.selected.add(key); else local.selected.delete(key); } drawList(root, panel); };
    root.querySelectorAll('[data-edit-definition]').forEach(b => b.onclick = () => editDefinition(panel, Number(b.dataset.editDefinition)));
    root.querySelectorAll('[data-retire-definition]').forEach(b => b.onclick = () => {
      const index = Number(b.dataset.retireDefinition), r = all[index], nextStatus = r.status === 'stale' ? 'provisional' : 'stale';
      modal(`${nextStatus === 'stale' ? '停用' : '恢复'}${title(panel)}`, `<p>${esc(r.label || r.term || r.name)}。定义与历史引用保留，恢复后需要重新确认。</p>`, async () => { await saveChanges({ [panel]: all.map((row, i) => i === index ? { ...row, lifecycle_action: nextStatus === 'stale' ? 'retire' : 'restore' } : row) }); }); compactModal();
    });
    root.querySelector('#definition-prev').onclick = () => { local.page--; drawList(root, panel); };
    root.querySelector('#definition-next').onclick = () => { local.page++; drawList(root, panel); };
  }
  function compactModal() { document.querySelector('#editor-dialog').classList.add('definition-editor'); document.querySelector('#editor-form').classList.add('compact-form'); }
  function editCategory(prior, parent = null) {
    const excluded = prior ? descendants(prior.id) : new Set();
    modal(prior ? '分类设置' : '新增分类', `${field('category_name', '分类名称', prior?.name, 'text', 'required')}${option('parent_id', '上级分类', [['', '顶层'], ...paths().filter(([id]) => !excluded.has(id))], prior?.parent_id || parent || '')}${field('category_order', '同级排序', prior?.order || 0, 'number', 'step="1"')}${prior ? '<button type="button" class="definition-danger" id="delete-category">删除分类并迁移内容…</button>' : ''}`, async data => {
      const value = { ...prior, id: prior?.id || uid('category'), name: String(data.get('category_name')).trim(), parent_id: data.get('parent_id') || null, order: Number(data.get('category_order')) };
      await saveChanges({ categories: prior ? categories().map(c => c.id === prior.id ? value : c) : [...categories(), value] });
    }); compactModal();
    if (prior) document.querySelector('#delete-category').onclick = () => {
      document.querySelector('#editor-dialog').close();
      modal('删除分类并迁移内容', `<p>仅删除“${esc(prior.name)}”。其中的指标、术语和直接子分类将迁移到所选位置。</p>${option('target', '迁移目标', [['', '条目未分类 / 子分类移到顶层'], ...paths().filter(([id]) => !excluded.has(id))], prior.parent_id || '')}`, async data => {
        const target = data.get('target') || null;
        await saveChanges({ categories: categories().filter(c => c.id !== prior.id).map(c => c.parent_id === prior.id ? { ...c, parent_id: target } : c),
          metrics: rows('metrics').map(r => r.category_id === prior.id ? { ...r, category_id: target } : r),
          terms: rows('terms').map(r => r.category_id === prior.id ? { ...r, category_id: target } : r) });
        state[current].category = target || '';
      }); compactModal();
    };
  }
  function editDefinition(panel, index) {
    const prior = index == null ? {} : rows(panel)[index], isMetric = panel === 'metrics';
    const draftBindings = structuredClone(prior.data_bindings || []);
    const initialFilters = [...(prior.filters || []), ...(prior.project ? [{ field: prior.project.field, operator: 'eq', values: [prior.project.value] }] : [])];
    const basic = `<div class="field-grid">${field(isMetric ? 'label' : 'term', isMetric ? '指标名称' : '术语名称', isMetric ? prior.label || prior.name : prior.term, 'text', 'required')}${option('category_id', '业务分类', categoryOptions(), prior.category_id || (!['*', ''].includes(state[panel].category) ? state[panel].category : ''))}</div>${area('aliases', '别名（每行一项）', (prior.aliases || []).join('\n'), 'rows="2"')}${area(isMetric ? 'description' : 'meaning', '业务定义与适用范围', isMetric ? prior.description : prior.meaning, 'rows="2" required')}`;
    const metric = isMetric ? `<section class="definition-section"><h4>计算与来源</h4><input type="hidden" name="name" value="${esc(prior.name || uid('metric'))}">${option('table', '来源表', tableOptions(), prior.table || '', 'required')}${area('expression', '计算表达式', prior.expression, 'rows="2" required placeholder="例如 SUM(amount) 或 SUM(profit) / NULLIF(SUM(revenue), 0)"')}<p class="compact-hint">直接读取一个字段请使用术语绑定。表达式中的字段必须来自所选表。</p>${field('unit', '结果单位', prior.unit)}<details class="definition-section"><summary>粒度、期间与汇总规则</summary><div id="metric-fields"></div><div class="field-grid">${option('time_aggregation', '跨时间汇总', [['', '未确认'], ['sum', '可求和'], ['last', '取期末'], ['weighted', '需加权'], ['forbidden', '禁止直接汇总']], typeof prior.time_aggregation === 'string' ? prior.time_aggregation : '')}${option('object_aggregation', '跨对象汇总', [['', '未确认'], ['sum', '可求和'], ['weighted', '需加权'], ['forbidden', '禁止直接汇总']], typeof prior.object_aggregation === 'string' ? prior.object_aggregation : '')}</div></details><details class="definition-section"><summary>固定筛选条件</summary><div id="metric-filters"></div></details></section>` : `<section class="definition-section"><div class="binding-heading"><h4>关联数据</h4><button type="button" class="secondary-btn" id="add-data-binding">＋ 关联</button></div><p class="compact-hint">可关联表、字段或直接取值。实际值、计划值可分别建立绑定。</p><div id="term-bindings"></div></section>`;
    const legacy = isMetric && prior.name ? `<details class="definition-section"><summary>已有高级口径（保留原结构）</summary><pre>${esc(JSON.stringify(Object.fromEntries(Object.entries(prior).filter(([key]) => !['id', 'name', 'label', 'description', 'category_id', 'aliases', 'tags', 'expression', 'table', 'unit', 'time_field', 'grain', 'filters', 'evidence_ids'].includes(key))), null, 2))}</pre><p class="compact-hint">未编辑的既有聚合规则、项目条件及来源证据会原样保留。</p></details>` : '';
    modal(`${index == null ? '新增' : '编辑'}${title(panel)}`, basic + (!isMetric ? option('source_id', '适用表（可选，留空表示跨来源）', [['', '跨来源'], ...tableOptions().slice(1)], prior.source_id || '') : '') + metric + `<details class="definition-section"><summary>标签与确认依据</summary>${area('tags', '标签（每行一项）', (prior.tags || []).join('\n'), 'rows="2"')}${area('evidence_ids', '确认依据（每行一项）', (prior.evidence_ids || prior.evidence || []).join('\n'), 'rows="2"')}<label class="check"><input type="checkbox" name="confirm_definition">依据上述资料确认本次定义</label><p class="compact-hint">当前：${status(prior.status)}。保存草稿不会自动确认业务口径。</p></details>` + legacy, async data => {
      const value = { ...prior, id: prior.id || uid(isMetric ? 'metric' : 'term'), category_id: data.get('category_id') || null,
        aliases: lines(data.get('aliases')), tags: lines(data.get('tags')), evidence_ids: lines(data.get('evidence_ids')), confirm_definition: data.has('confirm_definition') };
      if (isMetric) {
        for (const key of ['name', 'label', 'description', 'table', 'expression', 'unit', 'unit_field', 'time_field', 'time_aggregation', 'object_aggregation']) value[key] = String(data.get(key) || '').trim();
        value.grain = preserveSelection(data.getAll('grain').filter(Boolean), prior.grain);
        value.filters = readFilters(document.querySelector('#metric-filters'));
        // Display/classification edits must not rewrite legacy calculation contracts.
        if (JSON.stringify(value.filters) === JSON.stringify(initialFilters)) {
          if ('filters' in prior) value.filters = prior.filters; else delete value.filters;
        } else delete value.project;
        for (const key of ['unit', 'unit_field', 'time_field', 'time_aggregation', 'object_aggregation']) {
          if (!value[key] && !(key in prior)) delete value[key];
          else if (!value[key] && prior[key] && typeof prior[key] !== 'string') value[key] = prior[key];
        }
        if (!value.grain.length && !('grain' in prior)) delete value.grain;
        if (!prior.name || prior.definition_kind === 'calculated') value.definition_kind = 'calculated';
      } else {
        value.term = String(data.get('term')).trim(); value.meaning = String(data.get('meaning')).trim();
        if (draftBindings.length || 'data_bindings' in prior) value.data_bindings = draftBindings;
        if (data.get('source_id')) value.source_id = data.get('source_id'); else delete value.source_id;
      }
      const next = structuredClone(rows(panel)); if (index == null) next.push(value); else next[index] = value;
      await saveChanges({ [panel]: next });
    }); compactModal();
    if (isMetric) {
      const source = document.querySelector('#editor-form [name=table]');
      const draw = (initial = false) => {
        const selected = tableOf(source.value);
        document.querySelector('#metric-fields').innerHTML = `<div class="field-grid">${option('time_field', '期间字段', fieldOptions(selected), initial ? prior.time_field : '')}${option('unit_field', '来源单位字段（可选）', fieldOptions(selected), initial ? prior.unit_field : '')}</div>${multi('grain', '计算粒度', selected, initial ? prior.grain || [] : [])}<div class="metric-field-hints">可用字段：${esc((selected?.columns || []).map(c => c.name).join('、') || '请先选择来源表')}</div>`;
        renderFilters(document.querySelector('#metric-filters'), selected, initial ? initialFilters : []);
      };
      source.onchange = () => draw(); draw(true);
    } else {
      const drawBindings = () => {
        const box = document.querySelector('#term-bindings');
        box.innerHTML = draftBindings.map((b, i) => `<div class="binding-summary"><span><b>${esc(b.label || ({ table: '表关联', field: '字段关联', direct: '直接取值' }[b.kind]))}</b><small>${esc([tableOf(b.source_id)?.label || b.source_id, b.value_field || (b.fields || []).join('、'), ({ actual: '实际值', plan: '计划值', budget: '预算值', forecast: '预测值' }[b.value_role] || b.value_role)].filter(Boolean).join(' · '))}</small></span><button type="button" data-binding-edit="${i}">编辑</button><button type="button" data-binding-remove="${i}">移除</button></div>`).join('') || '<p class="definition-empty">尚无结构化绑定。可先保存业务解释。</p>';
        box.querySelectorAll('[data-binding-edit]').forEach(b => b.onclick = () => bindingEditor(draftBindings, Number(b.dataset.bindingEdit), drawBindings));
        box.querySelectorAll('[data-binding-remove]').forEach(b => b.onclick = () => { draftBindings.splice(Number(b.dataset.bindingRemove), 1); drawBindings(); });
      };
      document.querySelector('#add-data-binding').onclick = () => bindingEditor(draftBindings, undefined, drawBindings);
      drawBindings();
    }
  }
  const scalarText = value => typeof value === 'string' ? JSON.stringify(value) : String(value);
  function parseValues(text) { return lines(text).map(value => { try { const parsed = JSON.parse(value); if (typeof parsed === 'string' || Number.isSafeInteger(parsed)) return parsed; } catch {} return value; }); }
  function renderFilters(root, table, filters = []) {
    root.innerHTML = '<div class="filter-rows"></div><button type="button" class="filter-add">＋ 条件</button>';
    const add = value => {
      const row = document.createElement('div'); row.className = 'filter-row';
      row.innerHTML = `${option('filter_field', '字段', fieldOptions(table), value?.field || '')}${option('filter_operator', '条件', [['eq', '等于'], ['in', '属于']], value?.operator || 'eq')}${area('filter_values', '值（每行一项）', (value?.values || []).map(scalarText).join('\n'), 'rows="1"')}<button type="button" aria-label="移除条件">×</button>`;
      row.querySelector('button').onclick = () => row.remove(); root.querySelector('.filter-rows').append(row);
    };
    root.querySelector('.filter-add').onclick = () => add(); filters.forEach(add);
  }
  function readFilters(root) { return [...root.querySelectorAll('.filter-row')].map(row => ({ field: row.querySelector('[name=filter_field]').value, operator: row.querySelector('[name=filter_operator]').value, values: parseValues(row.querySelector('[name=filter_values]').value) })); }
  function bindingEditor(bindings, index, complete) {
    // A second dialog preserves all unsaved edits in the parent definition.
    const prior = index == null ? {} : bindings[index];
    const dialog = document.createElement('dialog'); dialog.className = 'definition-editor binding-dialog'; dialog.setAttribute('aria-label', '编辑数据绑定');
    dialog.innerHTML = `<form class="form-card compact-form"><h3>数据绑定</h3><div class="field-grid">${field('label', '绑定名称', prior.label)}${option('kind', '关联方式', [['table', '表说明'], ['field', '字段说明'], ['direct', '直接取值']], prior.kind || 'direct')}</div>${option('source_id', '来源表', tableOptions(), prior.source_id || '', 'required')}<div id="binding-fields"></div><p class="editor-feedback" role="status"></p><div class="form-actions"><button type="button" class="secondary-btn" data-cancel>取消</button><button type="submit" class="action-btn">应用绑定</button></div></form>`;
    document.body.append(dialog); dialog.addEventListener('close', () => dialog.remove());
    dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
    const form = dialog.querySelector('form');
    const draw = (initial = false) => {
      const table = tableOf(form.elements.source_id.value), kind = form.elements.kind.value;
      dialog.querySelector('#binding-fields').innerHTML = kind === 'table' ? '<p class="compact-hint">关联整张表的业务含义，不指定数值字段。</p>' : `${kind === 'field' ? multi('fields', '关联字段', table, initial ? prior.fields || [] : []) : `<div class="field-grid">${option('value_field', '取值字段', fieldOptions(table), initial ? prior.value_field : '', 'required')}${option('value_role', '数值角色', [['', '未指定'], ['actual', '实际值'], ['plan', '计划值'], ['budget', '预算值'], ['forecast', '预测值']], prior.value_role)}</div>`}<details class="definition-section" ${prior.filters?.length ? 'open' : ''}><summary>记录筛选条件</summary><div id="binding-filters"></div></details><details class="definition-section"><summary>期间、单位与粒度</summary><div class="field-grid">${option('time_field', '期间字段', fieldOptions(table), initial ? prior.time_field : '')}${option('unit_field', '单位字段', fieldOptions(table), initial ? prior.unit_field : '')}</div>${field('unit', '业务单位说明', prior.unit)}${multi('grain', '记录粒度', table, initial ? prior.grain || [] : [])}</details>`;
      if (kind !== 'table') renderFilters(dialog.querySelector('#binding-filters'), table, initial ? prior.filters || [] : []);
    };
    form.elements.source_id.onchange = () => draw(); form.elements.kind.onchange = () => draw(); draw(true);
    form.onsubmit = event => {
      event.preventDefault(); const data = new FormData(form), kind = data.get('kind');
      const value = { ...prior, id: prior.id || uid('binding'), kind, label: String(data.get('label')).trim(), source_id: data.get('source_id') };
      for (const k of ['value_field', 'value_role', 'time_field', 'unit_field', 'unit', 'fields', 'grain', 'filters']) delete value[k];
      if (kind !== 'table') {
        for (const k of ['value_field', 'value_role', 'time_field', 'unit_field', 'unit']) if (data.get(k)) value[k] = data.get(k);
        value.fields = preserveSelection(data.getAll('fields'), prior.fields); value.grain = preserveSelection(data.getAll('grain'), prior.grain); value.filters = readFilters(dialog.querySelector('#binding-filters'));
      }
      if (kind === 'field' && !value.fields.length) { form.querySelector('.editor-feedback').textContent = '请选择关联字段'; return; }
      if (index == null) bindings.push(value); else bindings[index] = value;
      dialog.close(); complete();
    };
    dialog.showModal();
  }
  return { render };
}
