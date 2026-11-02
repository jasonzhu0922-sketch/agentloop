import { installModelSettings } from './model-settings.js';
import { createTurn, updateTurn, hasTerminalEvent } from './turn-projection.js';
import { createConversationView } from './conversation.js';
import { autoResizeComposerInput, resetComposerInput, shouldSubmitComposerOnKeydown } from './reference/ui/composer-input.js';
const element = id => document.getElementById(id);
let csrf; let conversationId; let activeRun; let pending; let selectedSources = [];
let generation = 0; let selectedRunId; let cancelling = false;
let locked = true; const turns = new Map(); let orderedRunIds = [];
const PENDING_KEY = 'agentloop-desktop-development-pending';
const status = (message, error = false) => { element('status').textContent = message; element('status').className = `composer-status${error ? ' error' : ''}`; };
const runState = value => ({ running: '执行中', completed: '已完成', cancelled: '已取消', failed: '执行失败' }[value] ?? value);
function node(tag, className, text) {
  const result = document.createElement(tag); result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}
const view = createConversationView({ container: element('transcript'), scroll: element('conversation-scroll'), status,
  onSelect(id) { selectedRunId = id; renderTurns(); renderDetails(); details(true); } });
function renderTurns(forceBottom = false) {
  element('empty-state').hidden = orderedRunIds.length > 0 || Boolean(pending);
  view.render(orderedRunIds.map(id => turns.get(id)), selectedRunId, forceBottom);
}
function renderDetails() {
  const turn = turns.get(selectedRunId);
  element('events').textContent = turn?.events.slice(-200).map(event => `${event.seq} ${event.type} ${JSON.stringify(event.data)}`).join('\n') || '尚无事件';
  renderArtifacts(turn?.id, turn?.artifacts || []);
}
function details(open) {
  element('details').hidden = !open; element('workspace').classList.toggle('artifact-open', open);
  element('details-toggle').setAttribute('aria-expanded', String(open));
}
function navigation(open) {
  element('sidebar').classList.toggle('navigation-open', open);
  element('navigation-toggle').setAttribute('aria-expanded', String(open));
}
function resetAttachments() { element('attachments').replaceChildren(); element('attachments').hidden = true; }
function emptyArtifacts() {
  const container = element('artifacts'); container.className = 'artifact-empty';
  container.replaceChildren(node('span', 'artifact-empty-icon', '▧'), node('strong', '', '暂无产物'), node('p', '', '任务生成的文件会在这里显示。普通回复不会作为文件产物。'));
}
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Desktop-CSRF': csrf ?? '' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
function busy(value) {
  locked = value;
  element('send').disabled = value; element('message').disabled = value; element('model').disabled = value;
  element('cancel').disabled = !activeRun || cancelling; element('cancel').hidden = !activeRun; element('send').hidden = Boolean(activeRun);
  element('file').disabled = value || !conversationId; element('upload-file').disabled = element('file').disabled;
  element('new-conversation').disabled = value;
  for (const button of element('conversations').querySelectorAll('button')) button.disabled = value;
}
async function conversations() {
  const { conversations } = await api('/api/conversations'); element('conversations').replaceChildren();
  for (const item of conversations) {
    const button = node('button', `session${item.id === conversationId ? ' active' : ''}`); button.type = 'button'; button.disabled = locked;
    const body = node('span', 'session-body'); body.append(node('span', 'session-title', item.title));
    button.append(node('span', 'session-dot'), body);
    if (item.id === conversationId) element('conversation-title').textContent = item.title;
    button.onclick = () => selectConversation(item.id).catch(error => status(error.message, true));
    element('conversations').append(button);
  }
}
async function transcript(token = generation) {
  if (!conversationId) return;
  const { runs } = await api(`/api/conversations/${encodeURIComponent(conversationId)}`);
  if (token !== generation) return;
  // Hydrate every turn from durable events, not only the newest Run. The same
  // projector handles reconnect, history, and incremental running updates.
  const hydrated = await Promise.all(runs.map(async run => {
    const turn = createTurn(run);
    const [{ events }, { artifacts }] = await Promise.all([
      api(`/api/runs/${encodeURIComponent(run.id)}/events`), api(`/api/runs/${encodeURIComponent(run.id)}/artifacts`),
    ]);
    updateTurn(turn, run, events); turn.artifacts = artifacts; return turn;
  }));
  if (token !== generation) return;
  turns.clear(); for (const turn of hydrated) turns.set(turn.id, turn);
  orderedRunIds = runs.map(run => run.id); selectedRunId = runs.at(-1)?.id;
  renderTurns(true); renderDetails();
  return runs;
}
function renderArtifacts(id, artifacts) {
  element('artifacts').replaceChildren(); element('artifacts').className = 'desktop-artifact-list';
  if (!artifacts.length) emptyArtifacts();
  for (const item of artifacts) {
    const link = node('a', 'desktop-artifact'); const name = node('span', '', item.name);
    name.append(node('small', '', `${item.bytes} 字节 · ${item.role} · 下载`)); link.append(node('span', 'desktop-artifact-icon', '▤'), name);
    link.href = `/api/runs/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(item.id)}/download`; link.download = item.name;
    element('artifacts').append(link);
  }
}
async function watch(id, token) {
  activeRun = id; busy(true);
  try {
    while (token === generation) {
      const turn = turns.get(id); if (!turn) break;
      const { events } = await api(`/api/runs/${encodeURIComponent(id)}/events?afterSeq=${turn.lastSeq}`);
      const { run } = await api(`/api/runs/${encodeURIComponent(id)}`);
      if (token !== generation) return;
      updateTurn(turn, run, events);
      // The terminal commit can land between the two reads. Drain once more
      // before ending the watcher so final Plan/tool events are never lost.
      if (run.status !== 'running' && !hasTerminalEvent(turn)) {
        const tail = await api(`/api/runs/${encodeURIComponent(id)}/events?afterSeq=${turn.lastSeq}`);
        if (token !== generation) return;
        updateTurn(turn, run, tail.events);
      }
      renderTurns(); if (selectedRunId === id) renderDetails();
      status(`本机任务 · ${runState(run.status)}`);
      if (run.status !== 'running') {
        const result = await api(`/api/runs/${encodeURIComponent(id)}/artifacts`);
        if (token !== generation) return;
        turn.artifacts = result.artifacts; renderTurns(); if (selectedRunId === id) renderDetails();
        await conversations(); break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (error) { status(`连接中断：${error.message}。重新选择对话可从持久化记录恢复。`, true); }
  finally { if (token === generation) { activeRun = undefined; cancelling = false; busy(false); } }
}
async function selectConversation(id) {
  if (locked) return;
  busy(true); navigation(false);
  const token = ++generation; conversationId = id; pending = undefined; selectedSources = [];
  sessionStorage.removeItem(PENDING_KEY);
  resetAttachments(); turns.clear(); orderedRunIds = []; selectedRunId = undefined; view.clear(); renderDetails();
  try {
    const runs = await transcript(token); if (token !== generation) return; await conversations();
    const last = runs?.at(-1);
    if (last) {
      status(`本机任务 · ${runState(last.status)}`);
      if (last.status === 'running') { void watch(last.id, generation); return; }
    }
  } finally { if (!activeRun) busy(false); }
}
element('composer').onsubmit = async event => {
  event.preventDefault();
  if (locked) return;
  const input = element('message').value; const modelKey = element('model').value;
  if (!input.trim() || !modelKey) { status('请输入消息，并显式选择执行模型。', true); return; }
  const payload = { input, modelKey, ...(conversationId ? { conversationId } : {}), uploadedSourceIds: [...selectedSources] };
  if (!pending || JSON.stringify(pending.payload) !== JSON.stringify(payload)) pending = { requestId: crypto.randomUUID(), payload };
  busy(true);
  view.submitting(input); element('empty-state').hidden = true;
  try {
    // Business request only, never Session/CSRF/model credentials. Persist before
    // sending so a reload after a lost response can reuse the same request ID.
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    const { run } = await api('/api/runs', { requestId: pending.requestId, ...pending.payload });
    view.submitted();
    sessionStorage.removeItem(PENDING_KEY);
    pending = undefined; conversationId = run.conversationId; selectedSources = []; resetAttachments(); emptyArtifacts();
    element('message').value = ''; resetComposerInput(element('message')); generation++;
    turns.set(run.id, updateTurn(createTurn(run), run)); if (!orderedRunIds.includes(run.id)) orderedRunIds.push(run.id);
    selectedRunId = run.id; renderTurns(true); renderDetails();
    // A sidebar refresh failure must not abandon an already accepted Run or
    // mislabel it as an unconfirmed send.
    void conversations().catch(error => status(`会话列表刷新失败：${error.message}`, true));
    await watch(run.id, generation);
  } catch (error) { busy(false); if (pending) view.submitting(input, true); status(`发送未确认：${error.message}。相同消息重试将复用请求 ID。`, true); }
};
element('cancel').onclick = async () => {
  if (!activeRun || cancelling) return;
  cancelling = true; busy(true);
  try { await api(`/api/runs/${encodeURIComponent(activeRun)}/cancel`, {}); status('已请求取消；执行退出前，本地服务仍会保护资源。'); }
  catch (error) { cancelling = false; busy(Boolean(activeRun)); status(error.message, true); }
};
element('new-conversation').onclick = () => {
  if (locked) return;
  generation++; conversationId = undefined; pending = undefined; selectedSources = [];
  sessionStorage.removeItem(PENDING_KEY);
  turns.clear(); orderedRunIds = []; selectedRunId = undefined; view.clear(); resetAttachments(); renderDetails(); resetComposerInput(element('message'));
  element('empty-state').hidden = false; element('conversation-title').textContent = '新对话'; element('message').value = ''; status('新对话 · 请选择模型后发送任务。'); busy(false); navigation(false);
  void conversations().catch(error => status(error.message, true));
};
element('file').onchange = async event => {
  const file = event.target.files[0]; if (!file || !conversationId) return;
  if (file.size > 1_048_576 || file.size === 0) { status('附件必须为 1 字节至 1 MiB。', true); return; }
  busy(true);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const { source } = await api('/api/sources', { conversationId, originalName: file.name, contentBase64: btoa(binary) });
    selectedSources.push(source.id); element('attachments').hidden = false;
    const chip = node('span', 'source-chip'); const remove = node('button', '', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `移除附件 ${source.originalName}`);
    remove.onclick = () => { if (locked) return; selectedSources = selectedSources.filter(id => id !== source.id); chip.remove(); element('attachments').hidden = selectedSources.length === 0; };
    chip.append(node('span', 'file-icon'), node('span', '', source.originalName), remove); element('attachments').append(chip);
    status('附件已保存到本机，将绑定下一次 Run。');
  } catch (error) { status(error.message, true); }
  finally { busy(false); event.target.value = ''; }
};
element('upload-file').onclick = () => element('file').click();
element('details-toggle').onclick = () => details(element('details').hidden);
element('details-close').onclick = () => details(false);
element('navigation-toggle').onclick = () => navigation(!element('sidebar').classList.contains('navigation-open'));
element('theme-toggle').onclick = () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; };
element('message').onkeydown = event => {
  if (shouldSubmitComposerOnKeydown(event) && !locked) { event.preventDefault(); element('composer').requestSubmit(); }
};
element('message').oninput = () => autoResizeComposerInput(element('message'));
for (const button of document.querySelectorAll('.suggestion')) button.onclick = () => { if (!locked) { element('message').value = button.textContent; autoResizeComposerInput(element('message')); element('message').focus(); } };
document.addEventListener('keydown', event => { if (event.key === 'Escape') { details(false); navigation(false); } });
async function refreshModels() {
  const { models } = await api('/api/models'); const selection = element('model').value;
  element('model').replaceChildren(node('option', '', '请选择模型')); element('model').firstChild.value = '';
  for (const model of models) { const option = node('option', '', model); option.value = model; element('model').append(option); }
  element('model').value = models.includes(selection) ? selection : '';
  return models;
}
installModelSettings({ api, element, refreshModels, status });
busy(true);
try {
  const session = await api('/api/dev/session', {}); csrf = session.csrfToken;
  const models = await refreshModels();
  await conversations(); status(models.length ? '开发身份已建立，请选择模型后发送。' : '本机服务已就绪，尚未配置模型。请在本机能力设置中添加 Provider 和模型。');
  const saved = sessionStorage.getItem(PENDING_KEY);
  if (saved) {
    const restored = JSON.parse(saved);
    if (typeof restored.requestId !== 'string' || typeof restored.payload?.input !== 'string' || !Array.isArray(restored.payload?.uploadedSourceIds)) throw new Error('待确认发送记录无效，请检查当前标签页的本机存储。');
    pending = restored; conversationId = pending.payload.conversationId; selectedSources = pending.payload.uploadedSourceIds;
    element('message').value = pending.payload.input; element('model').value = pending.payload.modelKey;
    if (conversationId) await transcript();
    autoResizeComposerInput(element('message')); view.submitting(pending.payload.input, true); element('empty-state').hidden = true;
    status('已恢复一条未确认的发送。保持消息和模型不变，点击发送将复用原请求 ID。');
  }
  busy(false);
} catch (error) { busy(true); status(`本地初始化失败：${error.message}`, true); }
