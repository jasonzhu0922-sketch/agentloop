import { createSteerDrafts, createSteerQueueView } from './reference/ui/steer-queue.js';
import { createComposerPreferences } from './composer-preferences.js';
import { createArtifactWorkspace } from './artifact-workspace.js';
import { installCapabilitySettings } from './capability-settings.js';
import { artifactsVisible, createTurn, updateTurn } from './turn-projection.js';
import { readRunUpdate } from './run-polling.js';
import { createConversationView } from './conversation.js';
import { autoResizeComposerInput, resetComposerInput, shouldSubmitComposerOnKeydown } from './reference/ui/composer-input.js';
const RUNTIME_ICON_ASSETS = Object.freeze({ xuanwu: 'xuanwu-mascot-icon.png', qinglong: 'runtime-qinglong.png', baihu: 'runtime-baihu.png', zhuque: 'runtime-zhuque.png', qilin: 'runtime-qilin.png', taotie: 'runtime-taotie.png', yinglong: 'runtime-yinglong.png', pixiu: 'runtime-pixiu.png' });
const runtimeIconUrl = key => `/assets/${RUNTIME_ICON_ASSETS[key] || RUNTIME_ICON_ASSETS.xuanwu}`;
const element = id => document.getElementById(id);
let csrf; let conversationId; let activeRun; let pending; let selectedSources = []; let runtimeId; const runtimeNames = new Map(); const runtimeIcons = new Map();
let conversationRuntimeLocked = false; let conversationPersisted = false;
let generation = 0; let selectedRunId; let cancelling = false;
let locked = true; let operationLocked = true; const turns = new Map(); let orderedRunIds = [];
let PENDING_KEY; let ACTIVE_KEY; let preferences; let steerAccount; let steerQueue; let steerScope;
const status = (message, error = false) => { const target = element('status'); target.textContent = message; target.hidden = !message; target.className = `composer-status${error ? ' error' : ''}`; };
function node(tag, className, text) {
  const result = document.createElement(tag); result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}
const artifactWorkspace = createArtifactWorkspace({ element, api, onOpen: () => details(true) });
const view = createConversationView({ container: element('transcript'), scroll: element('conversation-scroll'), status,
  onHumanLoopResponse: respondHumanLoop,
  onArtifact(id, artifactId) { selectedRunId = id; renderTurns(); renderDetails(); artifactWorkspace.select(artifactId); } });
function renderTurns(forceBottom = false) {
  element('empty-state').hidden = orderedRunIds.length > 0 || Boolean(pending);
  view.render(orderedRunIds.map(id => turns.get(id)), selectedRunId, forceBottom);
}
function renderDetails() {
  const turn = turns.get(selectedRunId);
  element('events').textContent = turn?.events.slice(-200).map(event => `${event.seq} ${event.type} ${JSON.stringify(event.data)}`).join('\n') || '尚无事件';
  artifactWorkspace.render(turn && !artifactsVisible(turn) ? { ...turn, artifacts: [] } : turn, runtimeId || 'desktop-default');
}
function details(open) {
  element('details').hidden = !open; element('workspace').classList.toggle('artifact-open', open);
  if (open) artifactWorkspace.activate(); else artifactWorkspace.collapse();
  element('details-toggle').setAttribute('aria-expanded', String(open));
}
function navigation(open) {
  element('sidebar').classList.toggle('navigation-open', open);
  element('navigation-toggle').setAttribute('aria-expanded', String(open));
}
function resetAttachments() { element('attachments').replaceChildren(); element('attachments').hidden = true; }
async function api(path, body) {
  const scoped = /^(\/api\/(?:models|conversations|runs|sources))(?:\/|$)/.test(path) && path !== '/api/conversations' && !path.includes('runtimeId=');
  if (scoped) { const joiner = path.includes('?') ? '&' : '?'; path = `${path}${joiner}runtimeId=${encodeURIComponent(runtimeId || 'desktop-default')}`; }
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Desktop-CSRF': csrf ?? '' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) { generation++; busy(true); location.replace('/login'); }
    const error = new Error(data.error || '请求失败'); error.status = response.status; throw error;
  }
  return data;
}
function renderSteerQueue() {
  if (!steerAccount || !conversationId) return;
  const scope = [steerAccount, runtimeId || 'desktop-default', conversationId];
  const key = JSON.stringify(scope);
  if (key !== steerScope) {
    steerScope = key;
    steerQueue = createSteerQueueView({ container: element('steer-queue'), drafts: createSteerDrafts(localStorage, scope),
      getRunId: () => activeRun,
      submit: async (id, input) => (await api(`/api/runs/${encodeURIComponent(id)}/messages`, input)).message,
      read: async id => (await api(`/api/runs/${encodeURIComponent(id)}/messages`)).messages,
      onAccepted: messages => { for (const message of messages) { const turn = turns.get(message.runId); if (turn) { turn.inputMessages = [...(turn.inputMessages || []).filter(item => item.id !== message.id), message].sort((a, b) => a.seq - b.seq); turn.revision++; } } renderTurns(true); },
      onMoveToComposer: text => { element('message').value = text; autoResizeComposerInput(element('message')); element('message').focus(); },
      onError: error => status(`Steer 未确认：${error.message}。消息保留在队列中。`, true),
    });
  } else steerQueue.render();
}
function busy(value) {
  operationLocked = value; locked = value || Boolean(activeRun);
  element('send').disabled = value; element('message').disabled = value; element('model').disabled = locked;
  element('cancel').disabled = !activeRun || cancelling; element('cancel').hidden = !activeRun; element('send').hidden = false; element('send').title = activeRun ? '加入待处理队列' : '发送';
  element('file').disabled = locked; element('upload-file').disabled = locked;
  element('new-conversation').disabled = value;
  updateRuntimePicker(); renderSteerQueue();
  for (const checkbox of element('run-connectors').querySelectorAll('input')) checkbox.disabled = locked;
  for (const button of element('conversations').querySelectorAll('button')) button.disabled = value;
}
function updateRuntimePicker() {
  const select = element('runtime-select');
  select.disabled = operationLocked || conversationRuntimeLocked;
  const hint = element('runtime-lock-hint');
  if (hint) hint.textContent = conversationRuntimeLocked ? '会话已绑定' : operationLocked ? '正在准备' : '单击机器人开始新会话';
  const badge = element('runtime-badge-name');
  if (badge) badge.textContent = runtimeNames.get(runtimeId) || runtimeId || '本机 Runtime';
  for (const button of element('runtime-robots').querySelectorAll('button')) {
    button.disabled = operationLocked || Boolean(activeRun);
    const current = button.runtimeId === runtimeId;
    button.classList.toggle('current', current); button.setAttribute('aria-pressed', String(current));
  }
}
function decorateRun(run) {
  if (!run) return run;
  return { ...run, runtimeName: runtimeNames.get(run.runtimeId) || run.runtimeName || run.runtimeId || '本机 Runtime', runtimeIconKey: runtimeIcons.get(run.runtimeId) || run.runtimeIconKey || 'xuanwu' };
}
async function loadRuntimes() {
  const { runtimes } = await api('/api/runtimes');
  runtimeNames.clear(); runtimeIcons.clear(); for (const runtime of runtimes) { runtimeNames.set(runtime.id, runtime.displayName); runtimeIcons.set(runtime.id, runtime.iconKey || 'xuanwu'); }
  const select = element('runtime-select'); select.replaceChildren();
  for (const runtime of runtimes) { const option = node('option', '', `${runtime.displayName} · ${runtime.status}`); option.value = runtime.id; select.append(option); }
  select.value = runtimeId || runtimes[0]?.id || 'desktop-default'; runtimeId = select.value;
  renderRuntimeRobots(runtimes);
  updateRuntimePicker();
  return runtimes;
}
function renderRuntimeRobots(runtimes) {
  const container = element('runtime-robots'); container.replaceChildren();
  const shape = runtimes.length > 3 ? 'runtime-arc' : '';
  container.className = `runtime-robots${shape ? ` ${shape}` : ''}`;
  if (runtimes.length > 3) {
    const current = runtimes.find(runtime => runtime.id === runtimeId) || runtimes[0];
    const hub = node('button', 'runtime-hub'); hub.type = 'button'; hub.runtimeId = current.id; hub.title = `使用「${current.displayName}」开启新会话`;
    const avatar = document.createElement('img'); avatar.src = runtimeIconUrl(current.iconKey); avatar.alt = `${current.displayName} Runtime`;
    hub.append(avatar); hub.onclick = () => void startRuntimeConversation(current.id);
    container.append(hub);
  }
  const robotTints = ['#d7eee4', '#dbe5ff', '#f7e3c4', '#eadcf7', '#f7dada', '#d9eef3'];
  for (const runtime of runtimes) {
    const button = node('button', 'runtime-robot'); button.type = 'button'; button.runtimeId = runtime.id;
    button.style?.setProperty('--robot-tint', robotTints[runtimes.indexOf(runtime) % robotTints.length]);
    button.title = `单击以使用「${runtime.displayName}」开启新会话`;
    const avatar = document.createElement('img'); avatar.src = runtimeIconUrl(runtime.iconKey); avatar.alt = `${runtime.displayName} Runtime`;
    button.replaceChildren(avatar, ...(runtimes.length > 3 ? [] : [node('span', '', runtime.displayName)]));
    if (runtimes.length > 3) {
      const index = runtimes.indexOf(runtime); const angle = runtimes.length === 1 ? -90 : -150 + (120 * index / (runtimes.length - 1));
      button.style?.setProperty('--arc-x', `${Math.round(Math.cos(angle * Math.PI / 180) * 100)}px`);
      button.style?.setProperty('--arc-y', `${Math.round(Math.sin(angle * Math.PI / 180) * 75)}px`);
      button.title = `单击以使用「${runtime.displayName}」开启新会话`;
    }
    button.onclick = () => void startRuntimeConversation(runtime.id);
    container.append(button);
  }
  updateRuntimePicker();
}
function restoreConnectors() {
  const selected = new Set(preferences?.connectors(runtimeId, conversationId) || []);
  for (const checkbox of element('run-connectors').querySelectorAll('input')) checkbox.checked = selected.has(checkbox.value);
}
element('run-connectors').addEventListener('change', () => {
  preferences?.setConnectors(runtimeId, conversationId, [...element('run-connectors').querySelectorAll('input:checked')].map(input => input.value));
});
element('model').addEventListener('change', () => preferences?.setModel(element('model').value));
async function loadConnectors() {
  const container = element('run-connectors'); container.replaceChildren();
  try {
    // Connector accounts are device-level and owner-scoped, rather than part
    // of an individual Runtime configuration. The API intentionally has no
    // Runtime-scoped Connector route.
    const { connections } = await api('/api/connectors');
    if (!connections.length) return;
    const title = node('span', 'desktop-connector-title', '本轮授权 Connector'); container.append(title);
    for (const connection of connections.filter(c => c.enabled && c.moduleAvailable)) { const label = node('label', 'desktop-connector-choice'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = connection.id; checkbox.checked = false; checkbox.disabled = locked; label.append(checkbox, node('span', '', connection.displayName)); container.append(label); }
    restoreConnectors();
  } catch { status('Connector 列表读取失败；本轮不会自动授权连接。', true); }
}
async function conversations() {
  const { conversations } = await api('/api/conversations'); element('conversations').replaceChildren();
  for (const item of conversations) {
    const isCurrent = item.id === conversationId && (!item.runtimeId || item.runtimeId === runtimeId);
    const row = node('div', `session-wrap${isCurrent ? ' active' : ''}`);
    const button = node('button', `session${isCurrent ? ' active' : ''}`); button.type = 'button'; button.disabled = operationLocked;
    const body = node('span', 'session-body'); body.append(node('span', 'session-title', item.title), node('span', 'session-runtime', item.runtimeName || item.runtimeId || '本机 Runtime'));
    const dot = node('span', 'session-dot'); dot.setAttribute('aria-hidden', 'true');
    button.append(dot, body);
    if (isCurrent) element('conversation-title').textContent = item.title;
    button.onclick = () => selectConversation(item.id, item.runtimeId).catch(error => status(error.message, true));
    const remove = node('button', 'session-delete', '×'); remove.type = 'button'; remove.disabled = operationLocked;
    remove.title = '删除会话'; remove.setAttribute('aria-label', `删除会话：${item.title}`);
    remove.onclick = () => deleteConversation(item);
    row.append(button, remove); element('conversations').append(row);
  }
}
async function deleteConversation(item) {
  if (operationLocked || !window.confirm(`确定删除会话「${item.title}」及其历史记录？此操作无法撤销。`)) return;
  busy(true);
  try {
    await api(`/api/conversations/${encodeURIComponent(item.id)}/remove?runtimeId=${encodeURIComponent(item.runtimeId || runtimeId)}`, {});
  } catch (error) {
    status(error.status === 409 ? '该会话仍有任务执行中，请停止任务并等待结束后再删除。' : `删除会话失败：${error.message}`, true);
    busy(false); return;
  }
  preferences?.removeConversation(item.runtimeId || runtimeId, item.id);
  if (conversationId === item.id && (!item.runtimeId || item.runtimeId === runtimeId)) resetConversation();
  status('会话已删除。');
  try { await conversations(); }
  catch (error) { status(`会话已删除，但列表刷新失败：${error.message}`, true); }
  finally { busy(false); }
}
async function transcript(token = generation, unconfirmedConversation = false) {
  if (!conversationId) return;
  let history;
  try { history = await api(`/api/conversations/${encodeURIComponent(conversationId)}`); }
  catch (error) {
    // A saved send is written before admission. A rejected/unreceived request
    // may never have created its conversation; keep its exact request for retry.
    // Only the conversation lookup may be absent, not any persisted Run data.
    if (unconfirmedConversation && error.status === 404 && error.message === 'NOT_FOUND') return;
    throw error;
  }
  const { runs } = history;
  if (token !== generation) return;
  // Hydrate every turn from durable events, not only the newest Run. The same
  // projector handles reconnect, history, and incremental running updates.
  const hydrated = await Promise.all(runs.map(async run => {
    const turn = createTurn(decorateRun(run));
    const [{ events }, { artifacts }, { rounds }, { messages }] = await Promise.all([
      api(`/api/runs/${encodeURIComponent(run.id)}/events`), api(`/api/runs/${encodeURIComponent(run.id)}/artifacts`), api(`/api/runs/${encodeURIComponent(run.id)}/rounds`), api(`/api/runs/${encodeURIComponent(run.id)}/messages`),
    ]);
    const humanLoop = run.status === 'running' ? await api(`/api/runs/${encodeURIComponent(run.id)}/human-loop/current`) : {};
    return updateTurn(turn, decorateRun(run), events, artifacts, humanLoop, rounds, messages);
  }));
  if (token !== generation) return;
  turns.clear(); for (const turn of hydrated) turns.set(turn.id, turn);
  orderedRunIds = runs.map(run => run.id); selectedRunId = runs.at(-1)?.id;
  renderTurns(true); renderDetails();
  return runs;
}
async function watch(id, token) {
  activeRun = id; busy(false);
  try {
    while (token === generation) {
      const turn = turns.get(id); if (!turn) break;
      const { run, events, artifacts, rounds, humanLoop, messages } = await readRunUpdate(api, turn);
      if (token !== generation) return;
      updateTurn(turn, decorateRun(run), events, artifacts, humanLoop, rounds, messages);
      steerQueue?.reconcile(turn.inputMessages || []);
      renderTurns(); if (selectedRunId === id) renderDetails();
      if (run.status !== 'running') {
        await conversations(); break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (error) { if (token === generation) status(`连接中断：${error.message}。重新选择对话可从持久化记录恢复。`, true); }
  finally { if (token === generation) { activeRun = undefined; cancelling = false; busy(operationLocked); } }
}
async function respondHumanLoop(id, request, value) {
  const token = generation, turn = turns.get(id), scope = runtimeId || 'desktop-default';
  if (!turn || turn.status !== 'running' || turn.humanLoop?.id !== request.id || turn.humanLoop.revision !== request.revision) throw new Error('问题已变化，请等待同步后再回答');
  try {
    await api(`/api/runs/${encodeURIComponent(id)}/human-loop/${encodeURIComponent(request.id)}/respond?runtimeId=${encodeURIComponent(scope)}`, { value, expectedRevision: request.revision });
  } catch (error) {
    if (token === generation && error.status === 409) {
      const current = await api(`/api/runs/${encodeURIComponent(id)}/human-loop/current?runtimeId=${encodeURIComponent(scope)}`).catch(() => undefined);
      if (token === generation && current) { updateTurn(turn, turn.run, [], undefined, current); renderTurns(); }
    }
    throw error;
  }
  if (token !== generation) return;
  status('回答已提交，正在继续原任务。');
  // A disconnected watcher may have stopped while the user was filling in
  // the form. Reconnect to the same Run instead of creating another one.
  if (!activeRun) void watch(id, token);
}
async function selectConversation(id, conversationScope) {
  if (operationLocked) return;
  if (conversationScope && conversationScope !== runtimeId) {
    runtimeId = conversationScope; element('runtime-select').value = runtimeId; updateRuntimePicker();
  }
  conversationRuntimeLocked = true; conversationPersisted = true; busy(true); navigation(false);
  status('');
  const token = ++generation; activeRun = undefined; cancelling = false; conversationId = id; pending = undefined; selectedSources = [];
  sessionStorage.removeItem(PENDING_KEY);
  sessionStorage.setItem(ACTIVE_KEY, JSON.stringify({ conversationId: id, runtimeId }));
  restoreConnectors();
  resetAttachments(); turns.clear(); orderedRunIds = []; selectedRunId = undefined; view.clear(); renderDetails();
  try {
    const runs = await transcript(token); if (token !== generation) return; await conversations();
    const last = runs?.at(-1);
    if (last) {
      if (last.status === 'running') { void watch(last.id, generation); return; }
    }
  } finally { if (!activeRun) busy(false); }
}
element('composer').onsubmit = async event => {
  event.preventDefault();
  if (operationLocked) return;
  const input = element('message').value;
  if (activeRun) {
    if (!input.trim()) return;
    try { renderSteerQueue(); steerQueue.add(input); element('message').value = ''; resetComposerInput(element('message')); status('已加入队列；点击 Steer 后提交给当前任务。'); } catch (error) { status(error.message, true); }
    return;
  } const modelKey = element('model').value;
  if (!input.trim() || !modelKey) { status('请输入消息，并显式选择执行模型。', true); return; }
  const connectorConnectionIds = [...element('run-connectors').querySelectorAll('input:checked')].map(input => input.value);
  const payload = { input, modelKey, ...(conversationId ? { conversationId } : {}), uploadedSourceIds: [...selectedSources], connectorConnectionIds };
  if (!pending || pending.runtimeId !== runtimeId || JSON.stringify(pending.payload) !== JSON.stringify(payload)) pending = { requestId: crypto.randomUUID(), runtimeId, payload };
  busy(true);
  view.submitting(input); element('empty-state').hidden = true;
  try {
    // Business request only, never Session/CSRF/model credentials. Persist before
    // sending so a reload after a lost response can reuse the same request ID.
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    const { run } = await api('/api/runs', { requestId: pending.requestId, ...pending.payload });
    view.submitted();
    status('');
    sessionStorage.removeItem(PENDING_KEY);
    pending = undefined; conversationId = run.conversationId; sessionStorage.setItem(ACTIVE_KEY, JSON.stringify({ conversationId, runtimeId })); conversationRuntimeLocked = true; conversationPersisted = true; selectedSources = []; resetAttachments();
    element('message').value = ''; resetComposerInput(element('message')); generation++;
    const decoratedRun = decorateRun(run);
    turns.set(run.id, updateTurn(createTurn(decoratedRun), decoratedRun)); if (!orderedRunIds.includes(run.id)) orderedRunIds.push(run.id);
    selectedRunId = run.id; renderTurns(true); renderDetails();
    // A sidebar refresh failure must not abandon an already accepted Run or
    // mislabel it as an unconfirmed send.
    void conversations().catch(error => status(`会话列表刷新失败：${error.message}`, true));
    await watch(run.id, generation);
  } catch (error) { busy(false); if (pending) view.submitting(input, true); status(`发送未确认：${error.message}。相同消息重试将复用请求 ID。`, true); }
};
element('cancel').onclick = async () => {
  if (!activeRun || cancelling) return;
  const token = generation; const id = activeRun;
  cancelling = true; busy(false);
  try { await api(`/api/runs/${encodeURIComponent(id)}/cancel`, {}); if (token === generation) status('已请求取消；执行退出前，本地服务仍会保护资源。'); }
  catch (error) { if (token === generation) { cancelling = false; busy(operationLocked); status(error.message, true); } }
};
function resetConversation() {
  sessionStorage.removeItem(ACTIVE_KEY);
  generation++; activeRun = undefined; cancelling = false; conversationRuntimeLocked = false; conversationPersisted = false; conversationId = crypto.randomUUID(); pending = undefined; selectedSources = [];
  sessionStorage.removeItem(PENDING_KEY);
  restoreConnectors();
  turns.clear(); orderedRunIds = []; selectedRunId = undefined; view.clear(); resetAttachments(); renderDetails(); resetComposerInput(element('message'));
  element('empty-state').hidden = false; element('conversation-title').textContent = '新对话'; element('message').value = ''; details(false); navigation(false);
}
element('new-conversation').onclick = () => {
  if (operationLocked) return;
  resetConversation(); status(element('model').value ? '新对话 · 可直接发送任务。' : '新对话 · 请选择模型后发送任务。'); busy(false);
  void conversations().catch(error => status(error.message, true));
};
async function startRuntimeConversation(targetRuntimeId) {
  if (operationLocked) return;
  if (activeRun) { status('当前任务仍在执行，请完成或取消后再切换 Runtime。', true); return; }
  const targetName = runtimeNames.get(targetRuntimeId) || targetRuntimeId;
  const hasRounds = orderedRunIds.length > 0 || turns.size > 0;
  const shouldRemoveEmpty = !hasRounds && conversationPersisted && conversationId;
  busy(true);
  try {
    if (shouldRemoveEmpty) {
      await api(`/api/conversations/${encodeURIComponent(conversationId)}/remove`, {});
      preferences?.removeConversation(runtimeId, conversationId);
    }
    runtimeId = targetRuntimeId;
    element('runtime-select').value = runtimeId; updateRuntimePicker();
    resetConversation();
    await refreshModels(); await loadConnectors(); await conversations();
    status('');
  } catch (error) {
    status(`Runtime 会话切换失败：${error.message}`, true);
  } finally { busy(false); }
}
element('runtime-select').onchange = event => { if (event.target.value) void startRuntimeConversation(event.target.value); };
element('file').onchange = async event => {
  const file = event.target.files[0]; if (!file) return;
  if (file.size > 4 * 1024 * 1024 || file.size === 0) { status('附件必须为 1 字节至 4 MiB。', true); return; }
  busy(true);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const { source } = await api('/api/sources', { conversationId, originalName: file.name, contentBase64: btoa(binary) });
    conversationRuntimeLocked = true; conversationPersisted = true;
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
const themeButton = element('theme-toggle');
const themeKey = 'agentloop.desktop.theme.v1';
const themes = [{ id: 'light', label: '明亮' }, { id: 'dark', label: '深色' }, { id: 'purple', label: '智慧紫' }];
let themeIndex = themes.findIndex(theme => theme.id === localStorage.getItem(themeKey));
if (themeIndex < 0) themeIndex = themes.findIndex(theme => theme.id === 'purple');
function applyTheme() {
  const current = themes[themeIndex];
  const next = themes[(themeIndex + 1) % themes.length];
  document.documentElement.dataset.theme = current.id;
  const label = `当前主题：${current.label}；点击切换到${next.label}`;
  themeButton.title = label;
  themeButton.setAttribute('aria-label', label);
}
applyTheme();
themeButton.addEventListener('click', () => {
  themeIndex = (themeIndex + 1) % themes.length;
  localStorage.setItem(themeKey, themes[themeIndex].id);
  applyTheme();
});
element('logout').onclick = async () => {
  const button = element('logout'); button.disabled = true;
  try {
    if (!csrf) csrf = (await api('/api/auth/logout-token')).csrfToken;
    const result = await api('/api/auth/logout', {});
    if (PENDING_KEY) sessionStorage.removeItem(PENDING_KEY);
    generation++; busy(true);
    // Full navigation clears private transcripts/settings from the document.
    // The fixed flag reports unconfirmed cloud revocation without reflecting
    // arbitrary query text, credentials or server exception messages.
    location.replace(result.cloudRevoked ? '/login' : '/login?logout=local-only');
  } catch (error) { status(`退出结果未确认：${error.message}`, true); button.disabled = false; }
};
element('message').onkeydown = event => {
  if (shouldSubmitComposerOnKeydown(event) && !operationLocked) { event.preventDefault(); element('composer').requestSubmit(); }
};
element('message').oninput = () => autoResizeComposerInput(element('message'));
for (const button of document.querySelectorAll('.suggestion')) button.onclick = () => { if (!locked) { element('message').value = button.textContent; autoResizeComposerInput(element('message')); element('message').focus(); } };
document.addEventListener('keydown', event => { if (event.key === 'Escape') { details(false); navigation(false); } });
async function refreshModels() {
  const { models } = await api('/api/models'); const selection = preferences?.model() || element('model').value;
  element('model').replaceChildren(node('option', '', '请选择模型')); element('model').firstChild.value = '';
  for (const model of models) { const option = node('option', '', model); option.value = model; element('model').append(option); }
  element('model').value = models.includes(selection) ? selection : '';
  return models;
}
installCapabilitySettings({ api, element, refreshModels, status, currentRuntime: () => runtimeId, refreshCapabilities: async () => { await loadRuntimes(); await loadConnectors(); } });
busy(true);
let initializationPhase = '账号确认';
try {
  const session = await api('/api/session'); csrf = session.csrfToken;
  initializationPhase = '本地初始化';
  PENDING_KEY = `agentloop-desktop-pending:${session.accountId}`;
  ACTIVE_KEY = `agentloop-desktop-active:${session.accountId}`;
  steerAccount = session.accountId;
  preferences = createComposerPreferences(localStorage, session.accountId);
  conversationId = crypto.randomUUID();
  element('account-identity').textContent = session.user.email;
  await loadRuntimes(); await loadConnectors();
  const models = await refreshModels();
  await conversations(); status(models.length ? (element('model').value ? '请选择任务并发送。' : '请选择本机模型后发送。') : '尚未配置本机模型。请在本机能力设置中添加 Provider 和模型。');
  initializationPhase = '会话恢复';
  const saved = sessionStorage.getItem(PENDING_KEY);
  if (saved) {
    const restored = JSON.parse(saved);
    if (typeof restored.requestId !== 'string' || typeof restored.payload?.input !== 'string' || !Array.isArray(restored.payload?.uploadedSourceIds)) throw new Error('待确认发送记录无效，请检查当前标签页的本机存储。');
    if (restored.runtimeId !== undefined && typeof restored.runtimeId !== 'string') throw new Error('待确认发送记录无效，请检查当前标签页的本机存储。');
    if (restored.runtimeId && restored.runtimeId !== runtimeId) { runtimeId = restored.runtimeId; await loadRuntimes(); await refreshModels(); await loadConnectors(); }
    pending = restored; conversationId = pending.payload.conversationId || crypto.randomUUID(); conversationRuntimeLocked = true; conversationPersisted = false; selectedSources = pending.payload.uploadedSourceIds;
    element('message').value = pending.payload.input; element('model').value = pending.payload.modelKey;
    const pendingConnectors = new Set(pending.payload.connectorConnectionIds || []);
    for (const checkbox of element('run-connectors').querySelectorAll('input')) checkbox.checked = pendingConnectors.has(checkbox.value);
    if (conversationId) conversationPersisted = (await transcript(generation, true)) !== undefined;
    autoResizeComposerInput(element('message')); view.submitting(pending.payload.input, true); element('empty-state').hidden = true;
    status('已恢复一条未确认的发送。保持消息和模型不变，点击发送将复用原请求 ID。');
  }
  busy(false);
  if (!saved) {
    const active = JSON.parse(sessionStorage.getItem(ACTIVE_KEY) || 'null');
    if (typeof active?.conversationId === 'string' && typeof active?.runtimeId === 'string') await selectConversation(active.conversationId, active.runtimeId);
  }
} catch (error) {
  busy(true);
  if (initializationPhase === '账号确认') element('account-identity').textContent = '云端账号确认失败';
  status(`${initializationPhase}失败：${error.message}。${initializationPhase === '账号确认' ? '可退出后重新登录。' : '请检查本机配置或刷新页面重试。'}`, true);
}
