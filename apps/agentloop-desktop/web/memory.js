const $ = id => document.getElementById(id);
const labels = { preference: '偏好', fact: '事实', 'experience.episode': '任务记录', 'experience.task_group': '经验组', 'experience.procedure': '可复用方法',
  active: '已启用', superseded: '已替代', deleted: '已删除', queued: '等待处理', processing: '处理中', succeeded: '已成功', failed: '待重试', dead_letter: '重试耗尽',
  candidate: '待验证', verified: '已验证', response: '回复', planner: '规划', execution: '执行', artifact: '产物', human_loop: '用户确认',
  completed: '已完成', cancelled: '已取消', running: '执行中', classicPath: '方法路径', reusableKnowledge: '复用规则', failureLessons: '失败教训' };
const errors = { memory_query_invalid: '查询条件无效，请检查输入。Run ID 至少需要 4 位。', memory_run_query_too_broad: '匹配的任务过多，请输入更完整的 Run ID。',
  memory_item_not_found: '该记忆不存在或已不可访问，请刷新列表。', memory_run_not_found: '该任务已被删除，请重新查询。', memory_storage_invalid: '记忆存储状态异常，请检查本机数据目录。',
  account_changed: '登录账号已切换，请刷新页面后查询。' };
let accountId, tab = 'library', itemOffset = 0, jobOffset = 0, generation = 0, detailGeneration = 0, selectedItem, runRuntime;
const limit = 25;
function node(tag, text, cls) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; }
function message(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function date(value) { return value ? new Date(Number(value)).toLocaleString('zh-CN', { hour12: false }) : '—'; }
function badge(value) { return node('span', labels[value] || value || '未标注', `badge${['dead_letter', 'failed', 'candidate'].includes(value) ? ' warn' : ['verified', 'succeeded'].includes(value) ? ' good' : ''}`); }
function json(value) { return node('pre', JSON.stringify(value, null, 2), 'json'); }
function disclosure(title, value) { const el = node('details'); el.append(node('summary', title), json(value)); return el; }
function empty(container, title, copy) { const el = node('div', undefined, 'empty'); el.append(node('h2', title), node('p', copy)); container.replaceChildren(el); }
function button(title, fn, cls) { const el = node('button', title, cls); el.type = 'button'; el.onclick = () => { if (el.disabled) return; el.disabled = true; void task(fn).finally(() => { el.disabled = false; }); }; return el; }
function clearPrivateContent() {
  generation++; detailGeneration++;
  for (const id of ['items', 'detail', 'stats', 'jobs', 'job-stats', 'run-result', 'item-pager', 'job-pager']) $(id).replaceChildren();
  $('account').textContent = '请确认登录账号'; $('memory-state').hidden = true;
}
async function api(path) {
  const response = await fetch(path, { credentials: 'same-origin' });
  if (response.status === 401) { clearPrivateContent(); $('login').hidden = false; throw new Error('session_required'); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  if (accountId && data.accountId !== accountId) { clearPrivateContent(); throw new Error('account_changed'); }
  if (data.configuration) { $('memory-state').hidden = false; $('memory-state').textContent = data.configuration.enabled ? 'Memory 已启用 · 查询当前账号的本机记录。' : 'Memory 当前关闭；已保存的历史记忆仍可查询。'; }
  return data;
}
async function task(fn) {
  try { await fn(); }
  catch (error) { message(error.message === 'session_required' ? '登录后即可查询当前账号的本机记忆。' : errors[error.message] || '读取失败，请重试；数据未被修改。', true); }
}
function stats(container, entries) {
  container.replaceChildren(...entries.map(([title, count]) => { const el = node('div', undefined, 'stat'); el.append(node('strong', String(count)), node('span', title)); return el; }));
}
function pager(container, total, offset, onPage) {
  const previous = button('上一页', () => onPage(Math.max(0, offset - limit))), next = button('下一页', () => onPage(offset + limit));
  previous.disabled = offset === 0; next.disabled = offset + limit >= total;
  container.replaceChildren(previous, node('span', total ? `${offset + 1}–${Math.min(offset + limit, total)} / ${total}` : '0 条'), next);
}
function setUrl() {
  const params = new URLSearchParams({ view: tab });
  if (tab === 'run') { if ($('run-query').value.trim()) params.set('run', $('run-query').value.trim()); if (runRuntime) params.set('runtimeId', runRuntime); }
  history.replaceState(null, '', `/memory?${params}`);
}
async function showTab(value) {
  generation++; detailGeneration++; tab = value;
  for (const name of ['library', 'jobs', 'run']) $(`${name}-panel`).hidden = name !== tab;
  for (const control of document.querySelectorAll('[data-tab]')) control.setAttribute('aria-selected', String(control.dataset.tab === tab));
  setUrl();
  if (tab === 'library') await loadItems();
  else if (tab === 'jobs') await loadJobs();
  else if ($('run-query').value.trim()) await loadRun();
  else message('输入 Run ID，查看召回、沉淀及执行证据。');
}
async function openRun(id, runtime) { $('run-query').value = id; runRuntime = runtime; await showTab('run'); }
function runLink(id, runtime) { return button(id, () => openRun(id, runtime), 'link-button'); }
function section(container, title, ...children) { const el = node('section', undefined, 'detail-section'); el.append(node('h3', title), ...children); container.append(el); return el; }
function facts(entries) { const dl = node('dl', undefined, 'facts'); for (const [key, value] of entries) dl.append(node('dt', key), node('dd', String(value ?? '—'))); return dl; }

async function loadItems() {
  const ticket = ++generation; detailGeneration++; selectedItem = undefined; message('正在查询记忆…');
  empty($('detail'), '选择一条记忆', '查看完整内容、适用范围、来源与版本。'); $('items').replaceChildren(); $('item-pager').replaceChildren();
  const params = new URLSearchParams({ q: $('query').value.trim(), category: $('category').value, status: $('item-status').value, offset: itemOffset, limit });
  const data = await api(`/api/memory?${params}`); if (ticket !== generation) return;
  const count = predicate => data.counts.filter(row => row.status === 'active' && predicate(row)).reduce((sum, row) => sum + row.count, 0);
  stats($('stats'), [['偏好', count(r => r.kind === 'preference')], ['事实', count(r => r.kind === 'fact')], ['经验组', count(r => r.subtype === 'experience.task_group')], ['可复用方法', count(r => r.subtype === 'experience.procedure')], ['任务记录', count(r => r.subtype === 'experience.episode')]]);
  $('result-count').textContent = `${data.total} 条 · 按最近更新排序`;
  if (!data.items.length) empty($('items'), data.available ? '没有匹配的记忆' : '尚无记忆数据库', data.available ? '试试其他关键词或类型。' : '当前账号还没有保存记忆；页面不会创建空数据库。');
  for (const item of data.items) {
    const el = button('', () => loadDetail(item.id), 'item'); el.dataset.id = item.id; el.setAttribute('aria-pressed', 'false');
    const badges = node('div', undefined, 'badges'); badges.append(badge(labels[item.subtype] ? item.subtype : item.kind), badge(item.status));
    el.append(badges, node('strong', item.canonicalKey || item.subtype), node('p', item.preview || '暂无内容'), node('small', `v${item.revision} · ${date(item.updatedAt)}`)); $('items').append(el);
  }
  pager($('item-pager'), data.total, itemOffset, async offset => { itemOffset = offset; await loadItems(); });
  message(data.available ? '已读取当前账号的记忆。顶部数字为已启用条目；是否适用于当前任务，还需核对条件和有效期。' : '当前账号还没有记忆数据。');
}
async function loadDetail(id) {
  const ticket = ++detailGeneration; selectedItem = id; empty($('detail'), '正在读取…', '');
  for (const el of $('items').children) el.setAttribute('aria-pressed', String(el.dataset.id === id));
  const data = await api(`/api/memory/items/${encodeURIComponent(id)}`); if (ticket !== detailGeneration || selectedItem !== id || tab !== 'library') return;
  const { item, current } = data, container = $('detail'); container.replaceChildren();
  const tags = node('div', undefined, 'badges'); tags.append(badge(labels[item.subtype] ? item.subtype : item.kind), badge(item.status)); if (current.maturity) tags.append(badge(current.maturity));
  if (current.expiresAt && current.expiresAt <= Date.now()) tags.append(badge('已过期'));
  else if (current.validFrom > Date.now()) tags.append(badge('尚未生效'));
  container.append(tags, node('h2', item.canonicalKey || item.subtype), node('div', `${item.id} · v${current.revision}`, 'meta'), node('p', current.content, 'content'));
  section(container, '适用范围', facts([['适用条件', current.applicability.conditions?.join('；') || '未记录'], ['排除条件', current.applicability.exclusions?.join('；') || '未记录'], ['应用阶段', current.targets.map(t => labels[t] || t).join('、')], ['生效时间', date(current.validFrom)], ['到期时间', current.expiresAt ? date(current.expiresAt) : '未设置'], ['来源权威', current.authority], ['置信度', current.confidence]]), disclosure('适用条件与排除范围', current.applicability), disclosure('激活条件', current.activation));
  const sources = section(container, '来源');
  if (!current.sources.length) sources.append(node('p', '没有来源记录', 'meta'));
  for (const source of current.sources) {
    const row = node('div', undefined, 'source'); row.append(node('span', `${source.type} · `)); if (source.runId) row.append(runLink(source.runId));
    if (source.quotedText) row.append(node('p', source.quotedText, 'content')); sources.append(row);
  }
  if (current.value.knowledgeUnits?.length) {
    const knowledge = section(container, '逐条知识验证');
    for (const unit of current.value.knowledgeUnits) {
      const detail = node('details'), summary = node('summary'); summary.append(badge(unit.status), document.createTextNode(` ${labels[unit.section] || unit.section} · ${unit.supports?.length || 0} 次独立支持`));
      detail.append(summary, json(unit.content)); for (const support of unit.supports || []) detail.append(runLink(support.runId)); knowledge.append(detail);
    }
  }
  section(container, '完整结构', disclosure('查看保存的结构化内容', current.value));
  const historySection = section(container, `版本记录 · ${data.total} 个版本`);
  function appendRevisions(revisions) { for (const rev of revisions) { const el = node('details'); el.append(node('summary', `v${rev.revision} · ${date(rev.createdAt)} · ${rev.changeReason}`), node('p', rev.content, 'content'), disclosure('版本结构与来源', rev)); historySection.append(el); } }
  appendRevisions(data.revisions); let loaded = data.revisions.length;
  const more = button('更多版本', async () => {
    const next = await api(`/api/memory/items/${encodeURIComponent(id)}?offset=${loaded}`);
    if (ticket !== detailGeneration) return; more.remove(); appendRevisions(next.revisions); loaded += next.revisions.length; more.hidden = loaded >= next.total; historySection.append(more);
  }); more.hidden = loaded >= data.total; historySection.append(more);
  if (innerWidth < 850) container.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function loadJobs() {
  const ticket = ++generation; message('正在读取沉淀记录…'); $('jobs').replaceChildren(); $('job-pager').replaceChildren();
  const params = new URLSearchParams({ q: $('job-query').value.trim(), status: $('job-status').value, offset: jobOffset, limit });
  const data = await api(`/api/memory/jobs?${params}`); if (ticket !== generation) return;
  stats($('job-stats'), ['queued', 'processing', 'succeeded', 'failed', 'dead_letter'].map(key => [labels[key], data.counts.find(row => row.status === key)?.count || 0]));
  if (!data.jobs.length) empty($('jobs'), '没有匹配的沉淀记录', '显式保存记忆不一定产生异步沉淀作业。');
  for (const job of data.jobs) {
    const el = node('article', undefined, 'job'), copy = node('div', undefined, 'job-copy'); copy.append(badge(job.status), node('div', job.runId, 'meta'), node('div', `${date(job.enqueuedAt)} · 已尝试 ${job.attempts} 次`, 'meta'));
    if (job.lastError) copy.append(node('div', job.lastError, 'job-error'));
    el.append(copy, button('核对 Run →', () => openRun(job.runId))); $('jobs').append(el);
  }
  pager($('job-pager'), data.total, jobOffset, async offset => { jobOffset = offset; await loadJobs(); });
  message(`已读取 ${data.total} 条匹配记录。成功表示沉淀流程完成，是否形成可复用知识需查看记忆详情。`);
}
function runCard(title) { const el = node('section', undefined, 'run-card'); el.append(node('h2', title)); $('run-result').append(el); return el; }
async function loadRun(afterSeq = 0, continuation) {
  const ticket = ++generation, key = continuation?.id || $('run-query').value.trim(); message('正在核对 Run…'); setUrl();
  if (!afterSeq) $('run-result').replaceChildren();
  const params = new URLSearchParams({ run: key, limit: 20, afterSeq }); if (continuation?.runtimeId || runRuntime) params.set('runtimeId', continuation?.runtimeId || runRuntime);
  const data = await api(`/api/memory/runs?${params}`); if (ticket !== generation) return;
  if (!data.matches.length) { empty($('run-result'), '没有找到该 Run', '请核对 Run ID；仅查询当前账号下的任务。'); message('未找到匹配任务。'); return; }
  if (!data.detail) {
    const choices = runCard('找到多个任务，请选择'); for (const match of data.matches) choices.append(button(`${match.runtimeName} · ${match.id} · ${match.input}`, () => openRun(match.id, match.runtimeId), 'item'));
    message('请选择一个完整 Run。'); return;
  }
  const detail = data.detail, match = data.matches[0];
  if (!afterSeq) {
    const intro = runCard('任务'); intro.append(badge(detail.run.status), node('p', `${match.runtimeName} · ${detail.run.id}`, 'meta'), node('p', detail.run.input, 'content'));
    const recalls = runCard(`召回快照 · ${detail.projections.length} 条`);
    recalls.append(node('p', '这里证明记忆已进入对应阶段的上下文。实际采用情况请继续核对下方执行证据。', 'note'));
    if (!detail.projections.length) recalls.append(node('p', detail.memoryAvailable ? '没有找到召回投影；这不代表记忆库为空。' : '当前账号没有记忆数据库。', 'meta'));
    for (const projection of detail.projections) recalls.append(disclosure(`${labels[projection.target] || projection.target} · ${projection.memoryRevisionIds?.length || 0} 个记忆版本 · ${projection.id}`, projection));
    const settlement = runCard(`本次沉淀 · ${detail.jobs.length} 条作业`);
    for (const job of detail.jobs) { settlement.append(badge(job.status), node('p', `尝试 ${job.attempts} 次${job.lastError ? ` · ${job.lastError}` : ''}`, 'meta')); }
    if (!detail.jobs.length) settlement.append(node('p', '没有异步沉淀作业；显式记忆保存请查看 memory.explicit_commit 事件。', 'meta'));
    for (const attempt of detail.attempts) settlement.append(disclosure(`${attempt.stage} · ${attempt.status} · ${attempt.modelKey}`, attempt));
    const result = runCard('最终结果'); result.append(node('p', detail.run.output || (detail.run.errorCode ? `任务错误：${detail.run.errorCode}` : '尚无最终输出'), 'content'));
    const evidence = runCard('执行证据'); evidence.id = 'run-evidence'; evidence.append(node('p', '按时间顺序展示记忆、用户确认、计划和工具事件。保留原始内容供核对，不自动推断逐条记忆是否采用。', 'meta'));
  }
  const evidence = $('run-evidence'); evidence.querySelector('[data-more]')?.remove();
  for (const event of detail.events) evidence.append(disclosure(`#${event.seq} · ${event.type} · ${date(event.createdAt)}`, event.data));
  if (!afterSeq && !detail.events.length) evidence.append(node('p', '没有匹配的执行事件。历史 Run 可能没有新增的召回事件，请结合召回快照查看。', 'meta'));
  if (detail.hasMore) { const more = button('继续加载执行证据', () => loadRun(detail.events.at(-1).seq, { id: match.id, runtimeId: match.runtimeId })); more.dataset.more = 'true'; evidence.append(more); }
  message('已读取 Run 的真实记录。召回与实际采用请分开核对。');
}

for (const el of document.querySelectorAll('[data-tab]')) el.onclick = () => void task(() => showTab(el.dataset.tab));
$('refresh').onclick = () => void task(() => showTab(tab));
$('library-search').onsubmit = event => { event.preventDefault(); itemOffset = 0; void task(loadItems); };
$('jobs-search').onsubmit = event => { event.preventDefault(); jobOffset = 0; void task(loadJobs); };
$('run-search').onsubmit = event => { event.preventDefault(); runRuntime = undefined; void task(loadRun); };
await task(async () => {
  const session = await api('/api/session'); accountId = session.accountId; $('account').textContent = session.user.displayName || session.user.email;
  const params = new URLSearchParams(location.search); $('run-query').value = params.get('run') || ''; runRuntime = params.get('runtimeId') || undefined;
  await showTab(['library', 'jobs', 'run'].includes(params.get('view')) ? params.get('view') : params.has('run') ? 'run' : 'library');
});
