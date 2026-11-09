import { renderMarkdown } from './markdown.js';
import { assistantMessagePresentation, completedArtifactSummary, terminalAwarePlanStepStatus } from './reference/presentation/assistant-message-presentation.js';
import { isNearBottom, nextScrollTop } from './reference/ui/scroll-follow.js';
import { hasSelectedTextWithin } from './reference/ui/message-selection.js';
import { artifactsVisible, visibleToolCalls } from './turn-projection.js';
import { liveProgressForEvent } from './reference/projections/assistant-event-projection.js';
import { renderHumanLoop, bindHumanLoop } from './human-loop.js';
const RUNTIME_ICON_ASSETS = Object.freeze({ xuanwu: 'xuanwu-mascot-icon.png', qinglong: 'runtime-qinglong.png', baihu: 'runtime-baihu.png', zhuque: 'runtime-zhuque.png', qilin: 'runtime-qilin.png', taotie: 'runtime-taotie.png', yinglong: 'runtime-yinglong.png', pixiu: 'runtime-pixiu.png' });
const runtimeIconUrl = key => `/assets/${RUNTIME_ICON_ASSETS[key] || RUNTIME_ICON_ASSETS.xuanwu}`;

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const lines = value => escape(value).replace(/\n/g, '<br>');
const clip = (value, max = 120) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max)}…` : text; };
const steerStatus = status => ({ accepted: '已接收，等待处理', processing: '正在处理', applied: '已应用', answered: '已回答', needs_clarification: '需要澄清', unprocessed: '未处理' }[status] || status || '');
function renderSteerMessage(message) {
  return `<div class="steer-message" data-steer-message="${escape(message.id)}"><div class="steer-message-bubble"><div class="steer-message-user">${escape(message.text)}</div><small>${escape(steerStatus(message.status))}</small></div></div>`;
}
const stepLabel = status => ({ completed: '已完成', running: '执行中', failed: '失败', cancelled: '已取消', pending: '待执行', queued: '待执行', rejected: '已拒绝', unfinished: '未确认完成', selected: '已选择', bound: '已绑定' }[status] || '待执行');
const time = value => Number.isFinite(value) ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '';
function formatDuration(seconds) {
  if (seconds <= 60) return `${seconds.toFixed(1)} 秒`;
  const tenths = Math.round(seconds * 10);
  return `${Math.floor(tenths / 600)} 分 ${((tenths % 600) / 10).toFixed(1)} 秒`;
}
const copyIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path></svg>';
function copyButton(kind, disabled = false) { return `<button type="button" class="message-copy" data-copy="${kind}" aria-label="复制${kind === 'user' ? '提问' : '回答'}"${disabled ? ' disabled' : ''}>${copyIcon}</button>`; }
export function renderUser(run) {
  const sources = (run.sources || []).map(source => `<span class="source-chip msg-source-chip">▤ ${escape(source.originalName)}</span>`).join('');
  return `<article class="msg user"><div class="msg-body"><div class="msg-bubble"><div class="msg-role">你</div>${sources ? `<div class="msg-source-row" aria-label="本轮上传文件">${sources}</div>` : ''}<div class="msg-text">${escape(run.input)}</div><div class="message-footer"><div class="message-timing">提问于 ${escape(time(run.createdAt))}</div>${copyButton('user')}</div></div></div></article>`;
}
function renderArtifacts(turn) {
  if (!artifactsVisible(turn) || !turn.artifacts.length) return '';
  const final = turn.artifacts.filter(item => item.role === 'final'); const other = turn.artifacts.filter(item => item.role !== 'final');
  const cards = (items, isStage = false) => `<div class="desktop-artifact-list${isStage ? ' stage-artifact-list' : ''}"${isStage ? ' role="region" aria-label="阶段产物列表" tabindex="0"' : ''}>${items.map(item => {
    const download = `/api/runs/${encodeURIComponent(turn.id)}/artifacts/${encodeURIComponent(item.id)}/download?runtimeId=${encodeURIComponent(turn.run.runtimeId || 'desktop-default')}`;
    return `<div class="desktop-artifact-row"><button type="button" class="desktop-artifact" data-artifact-id="${escape(item.id)}"><span class="desktop-artifact-icon" aria-hidden="true">▤</span><span class="desktop-artifact-name">${escape(item.name)}</span><small>${escape(item.bytes)} 字节 · 预览</small></button><a class="desktop-artifact-download" href="${escape(download)}" download="${escape(item.name)}" aria-label="下载 ${escape(item.name)}">下载</a></div>`;
  }).join('')}</div>`;
  const head = (label, count) => `<div class="inline-artifacts-head"><span>${label}</span><small>${count} 个文件</small></div>`;
  const finalBlock = final.length ? head(turn.status === 'completed' ? '最终产物' : '已生成文件 · 尚非成功交付', final.length) + cards(final) : '';
  const otherBlock = other.length ? head('阶段产物 · 尚非成功交付', other.length) + cards(other, true) : '';
  return `<section class="inline-artifacts" aria-label="本轮产物"><div class="artifact-summary"><span class="artifact-summary-icon" aria-hidden="true">▤</span><span><strong>本轮产物</strong><small>${turn.artifacts.length} 个文件</small></span></div><div class="artifact-groups">${finalBlock}${otherBlock}</div></section>`;
}
function toolRow(call, latest = false) {
  const parameters = Object.entries(call.arguments).filter(([key]) => !['input', 'content', 'body'].includes(key)).map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' · ');
  const title = call.name === 'computer_run_command' ? call.arguments.command || call.name : call.name;
  const result = call.error || (call.status === 'completed' && call.exitCode !== undefined ? `已完成 · 退出码 ${call.exitCode}` : stepLabel(call.status));
  return `<div class="execution-trace-item tool${latest ? ' latest' : ''}"><span class="execution-trace-dot tool"></span><span class="execution-trace-copy"><strong>${escape(title)}</strong><small title="${escape(clip(parameters, 500))}">主要参数：${escape(clip(parameters) || '-')}</small><small class="execution-trace-result">结果：${escape(clip(result))}</small></span><span class="execution-trace-seq">#${call.seq}</span></div>`;
}
function renderRoundHistory(rounds, open = false) {
  if (!Array.isArray(rounds) || !rounds.length) return '';
  const items = rounds.map(round => {
    const result = round?.result; const kind = result?.decision?.kind;
    const label = kind === 'complete_goal' ? '本轮完成目标' : kind === 'next_round' ? '本轮完成，继续下一轮' : '处理中';
    const output = typeof result?.output === 'string' && result.output.trim() ? `<div class="round-history-output">${escape(clip(result.output, 240))}</div>` : '';
    const scope = round.roundScope || result?.roundScope;
    const scopeText = scope ? `<div class="round-history-output">${escape(scope.kind === 'prerequisite' ? '前置研究' : '交付推进')}：${escape(scope.purpose)}<br>本轮完成条件：${escape(scope.completionBoundary)}<br>后续方向：${escape(scope.continuation)}</div>` : '';
    return `<li><span>第 ${Number(round.roundNumber) || '?'} 轮</span><b>${escape(label)}</b>${scopeText}${output}</li>`;
  }).join('');
  return `<details class="round-history"${open ? ' open' : ''}><summary>目标循环 · ${rounds.length} 轮</summary><ol>${items}</ol></details>`;
}
// Streaming content is a cumulative snapshot until it is committed. Keep each
// committed segment in event order instead of replacing it with the next one.
function renderProcess(turn, openTools = {}, openProtocol = {}, processOpen = true) {
  const items = []; const tools = new Map(); let segment; let previousContent = ''; let segmentPrefix = '';
  const messages = new Map((turn.inputMessages || []).map(message => [message.id, message]));
  const shownMessages = new Set();
  for (const event of turn.events) {
    const data = event.data || {};
    if (event.type === 'run.input.accepted' && data.message) {
      segment = undefined; segmentPrefix = previousContent;
      items.push({ kind: 'steer', message: messages.get(data.message.id) || data.message });
      shownMessages.add(data.message.id);
      continue;
    }
    if (event.type === 'run.input.decided' && data.message) {
      const explanation = data.message.decision?.explanation || data.message.decision?.reason;
      if (explanation) { segment = undefined; segmentPrefix = previousContent; items.push({ kind: 'steer-decision', text: explanation }); }
      continue;
    }
    if (data.responseVisibility === 'internal') continue;
    if (event.type === 'assistant.streaming' || event.type === 'assistant.committed') {
      if (typeof data.content === 'string') {
        const content = data.content;
        if (!content.startsWith(segmentPrefix)) segmentPrefix = '';
        const visible = content.slice(segmentPrefix.length);
        if (visible.trim()) {
          if (!segment) { segment = { kind: 'text', text: '', seq: event.seq }; items.push(segment); }
          segment.text = visible;
        }
        previousContent = content;
      }
      if (event.type === 'assistant.committed') { segment = undefined; previousContent = ''; segmentPrefix = ''; }
      continue;
    }
    const projected = visibleToolCalls([event], turn.status)[0];
    const label = projected ? undefined : liveProgressForEvent(event);
    // Technical events advance the footer, but do not interrupt the readable
    // transcript or split cumulative model text into separate paragraphs.
    if (!projected && !label) continue;
    // A subsequent snapshot may still belong to the same model response.
    // Only append its new suffix after an intervening visible event.
    segment = undefined; segmentPrefix = previousContent;
    if (projected) {
      const previous = tools.get(projected.id);
      const call = { ...previous, ...projected, name: data.toolName || data.name || previous?.name || projected.name, arguments: data.arguments || previous?.arguments || {} };
      tools.set(call.id, call);
      items.push({ kind: 'tool', call });
      continue;
    }
    // Consecutive progress events describe the same stretch of work. Show its
    // latest state in place while retaining every event in the Run history.
    const last = items.at(-1);
    const toolContinuation = event.type === 'model.request.started' && data.purpose !== 'conversation_turn_resolver' && !['planning', 'assessment'].includes(data.phase);
    if (last?.kind === 'progress') { last.text = label; last.seq = event.seq; last.toolContinuation = toolContinuation; }
    else items.push({ kind: 'progress', text: label, seq: event.seq, toolContinuation });
  }
  // A submit acknowledgement can arrive before its persisted event is polled.
  for (const message of messages.values()) if (!shownMessages.has(message.id)) items.push({ kind: 'steer', message });
  if (!items.length && turn.text && turn.status === 'running') items.push({ kind: 'text', text: turn.text });
  const groups = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const last = groups.at(-1);
    if (item.kind === 'progress' && item.toolContinuation && last?.kind === 'tools' && items[index + 1]?.kind === 'tool') last.entries.push(item);
    else if (item.kind === 'tool' && last?.kind === 'tools') { last.calls.push(item.call); last.entries.push(item); }
    else if (item.kind === 'tool') groups.push({ kind: 'tools', calls: [item.call], entries: [item] });
    else groups.push(item);
  }
  return groups.map(item => {
    if (item.kind === 'steer') return renderSteerMessage(item.message);
    if (item.kind === 'steer-decision') return `<div class="steer-message-decision">${lines(item.text)}</div>`;
    const hidden = processOpen ? '' : ' hidden';
    if (item.kind === 'text') {
      // Preserve protocol-shaped model text as evidence, without presenting it
      // as either user-facing prose or an actual structured tool invocation.
      const normalized = item.text.replaceAll('＜', '<').replaceAll('＞', '>').replaceAll('｜', '|');
      const protocol = /<\s*\|+\s*[\w-]+\s*\|+\s*(?:parameter|invoke|calls)\b|<\/?(?:tool_response|tool_calls?)\b/i.test(normalized);
      return protocol ? `<details class="process-protocol" data-protocol-seq="${escape(item.seq)}"${openProtocol[item.seq] ? ' open' : ''}${hidden}><summary>模型输出包含工具协议文本</summary><div class="process-protocol-text">${lines(item.text)}</div></details>` : `<div class="process-text"${hidden}>${lines(item.text)}</div>`;
    }
    if (item.kind === 'progress') return `<div class="process-progress"${hidden}>${escape(item.text)}</div>`;
    const first = item.calls[0]; const last = item.calls.at(-1);
    const count = new Set(item.calls.map(call => call.id)).size;
    const status = last.error || (last.status === 'completed' && last.exitCode !== undefined ? `已完成 · 退出码 ${last.exitCode}` : stepLabel(last.status));
    return `<details class="process-tool-group" data-tool-group="${escape(first.seq)}"${openTools[first.seq] ? ' open' : ''}${hidden}><summary><span class="process-tool-icon" aria-hidden="true">↗</span><span>工具调用 · ${count} 次</span><small>${escape(clip(last.name, 60))} · ${escape(clip(status, 80))}</small></summary><div class="process-tool-list">${item.entries.map(entry => entry.kind === 'tool' ? toolRow(entry.call) : `<div class="process-progress">${escape(entry.text)}</div>`).join('')}</div></details>`;
  }).join('');
}
export function renderAssistant(turn, ui = {}) {
  const presentation = assistantMessagePresentation(turn.status); const live = presentation.isLive;
  const plan = turn.plan.map(step => ({ ...step, status: terminalAwarePlanStepStatus(step.status, turn.status) }));
  const planId = `plan-${turn.id}`;
  const planToggle = plan.length ? `<button class="live-step-toggle" data-toggle="plan" aria-expanded="${Boolean(ui.plan)}" aria-controls="${escape(planId)}">步骤 ${plan.filter(step => step.status === 'completed').length}/${plan.length}<span class="live-step-caret">⌄</span></button>` : '';
  const planPanel = plan.length && ui.plan ? `<ol class="inline-plan-steps" id="${escape(planId)}">${plan.map((step, index) => `<li><span class="step-dot ${step.status === 'completed' ? 'done' : live && step.status === 'running' ? 'running' : step.status === 'failed' ? 'error' : 'pending'}"></span><span><b>${String(index + 1).padStart(2, '0')} ${escape(step.objective || step.id)}</b><small>${escape(!live && step.status === 'running' ? '未完成' : stepLabel(step.status))}</small></span></li>`).join('')}</ol>` : '';
  const roundHistory = renderRoundHistory(turn.rounds, ui.roundHistory);
  const planning = roundHistory || planToggle ? `<div class="planning-overview"><div class="planning-overview-head">${roundHistory}${planToggle}</div>${planPanel}</div>` : '';
  const reasoning = live && turn.reasoning ? `<details class="live-reasoning"${ui.reasoning !== false ? ' open' : ''}><summary>模型思考</summary><div class="reasoning-body">${lines(turn.reasoning)}</div></details>` : '';
  let output;
  if (turn.status === 'failed') output = `<div class="failure-title">${escape(turn.error || presentation.emptyText)}</div>${turn.partialText ? `<div class="partial-result"><strong>执行总结 · 尚非成功交付</strong>${renderMarkdown(turn.partialText)}</div>` : ''}`;
  else if (turn.text) output = live ? lines(turn.text) : renderMarkdown(turn.text);
  else output = live ? `<div class="live-progress" role="status">${escape(turn.progress || '正在连接本机 Runtime')}</div>` : `<span class="terminal-empty">${escape((turn.status === 'completed' ? completedArtifactSummary(turn.artifacts) : '') || presentation.emptyText)}</span>`;
  const humanLoop = live && turn.humanLoop?.status === 'open' ? renderHumanLoop(turn.humanLoop) : '';
  const last = turn.events.at(-1);
  const eventIndicator = `<span class="live-event-indicator ${live ? 'active' : 'terminal'} ${escape(turn.status)}" data-event-seq="${last?.seq ?? 'pending'}"${live ? ' role="status" aria-live="polite"' : ''}><i class="live-event-pulse" aria-hidden="true"></i><span class="live-event-number">${last ? `#${last.seq}` : '进行中'}</span><small>${escape(last?.type.replaceAll('.', ' ') || '正在连接 Runtime')}</small></span>`;
  const finished = turn.run.finishedAt; const elapsed = Number.isFinite(finished) ? Math.max(0, (finished - turn.run.createdAt) / 1000) : undefined;
  const timing = finished ? `回答结束于 ${time(finished)} · 耗时 ${formatDuration(elapsed)}` : '';
  const heading = turn.humanLoop?.status === 'open' ? '等待你的输入' : live ? escape(presentation.label) : elapsed !== undefined ? `${escape(presentation.label)} · 耗时 ${formatDuration(elapsed)}` : escape(presentation.label);
  const runtimeLabel = turn.run.runtimeName || turn.run.runtimeId || '本机 Runtime';
  const processOpen = ui.process === undefined ? live : Boolean(ui.process);
  const process = renderProcess(turn, ui.tools, ui.protocol, processOpen);
  return `<article class="msg assistant ${live ? 'live' : 'final'}${ui.selected ? ' selected' : ''}" data-assistant-message="${escape(turn.id)}"><img class="msg-avatar logo-image" src="${runtimeIconUrl(turn.run.runtimeIconKey)}" alt="Runtime"><div class="msg-body"><div class="live-card ${escape(presentation.cardClass)}"><div class="live-head"><span class="assistant-state ${escape(turn.status)}">${presentation.icon || (live ? '<span class="thinking"><i></i><i></i><i></i></span>' : '')}</span><button type="button" class="process-toggle" data-toggle="process" aria-expanded="${processOpen}" aria-controls="process-${escape(turn.id)}">${heading}<span aria-hidden="true">${processOpen ? '⌄' : '›'}</span></button><span class="execution-provenance"><span class="execution-provenance-chip runtime">${escape(runtimeLabel)}</span><span class="execution-provenance-chip model">${escape(turn.run.modelKey)}</span></span></div><div class="execution-process" id="process-${escape(turn.id)}"${!processOpen && !(turn.inputMessages || []).length && !turn.events.some(event => event.type === 'run.input.accepted') ? ' hidden' : ''}>${reasoning ? `<div${processOpen ? '' : ' hidden'}>${reasoning}</div>` : ''}${process || (live ? `<div class="live-progress" role="status">${escape(turn.progress || '正在连接本机 Runtime')}</div>` : '')}${planning ? `<div${processOpen ? '' : ' hidden'}>${planning}</div>` : ''}</div>${live ? '' : `<div class="live-output-text md">${output}</div>`}${humanLoop}${renderArtifacts(turn)}<div class="message-footer event-feedback">${eventIndicator}${timing ? `<div class="message-timing">${escape(timing)}</div>` : ''}${copyButton('assistant', !(turn.text || turn.partialText))}</div></div></div></article>`;
}

// Keyed turn nodes preserve old replies and browser selection. Only an altered
// assistant card is replaced, and each scroll surface follows independently.
export function createConversationView({ container, scroll, onArtifact, onHumanLoopResponse, status }) {
  const mounted = new Map(); let currentTurns = []; let selected; let pending;
  function render(turns = currentTurns, selectedId = selected, forceBottom = false) {
    currentTurns = turns; selected = selectedId;
    const follow = forceBottom || isNearBottom(scroll); const previousTop = scroll.scrollTop;
    const ids = new Set(turns.map(turn => turn.id));
    for (const [id, state] of mounted) if (!ids.has(id)) { state.wrapper.remove(); mounted.delete(id); }
    for (const turn of turns) {
      let state = mounted.get(turn.id);
      if (!state) {
        const wrapper = document.createElement('div'); wrapper.className = 'desktop-turn'; container.insertBefore(wrapper, pending || null);
        state = { wrapper, ui: {}, signature: '' }; mounted.set(turn.id, state);
      }
      if (state.wasLive === true && turn.status !== 'running') state.ui.process = false;
      state.wasLive = turn.status === 'running';
      const uiKey = `${turn.id === selectedId}|${state.ui.plan}|${state.ui.trace}|${state.ui.reasoning}|${state.ui.process}`;
      // Like Multi Runtime's live-card hot path, historical Markdown is not
      // reparsed merely because a different Run received another event.
      if (state.lastTurn === turn && state.revision === turn.revision && state.artifacts === turn.artifacts && state.uiKey === uiKey) continue;
      const user = renderUser(turn.run);
      if (user !== state.userMarkup) {
        const template = document.createElement('template'); template.innerHTML = user;
        const previous = state.wrapper.querySelector('.msg.user');
        if (previous) previous.replaceWith(template.content); else state.wrapper.prepend(template.content);
        state.userMarkup = user;
        state.wrapper.querySelector('[data-copy="user"]').onclick = () => copy(turn.run.input, state.wrapper.querySelector('[data-copy="user"]'));
      }
      const ui = { ...state.ui, selected: turn.id === selectedId };
      const markup = renderAssistant(turn, ui); const old = state.wrapper.querySelector('.msg.assistant');
      if (old && hasSelectedTextWithin(window.getSelection(), old)) continue;
      state.lastTurn = turn; state.revision = turn.revision; state.artifacts = turn.artifacts; state.uiKey = uiKey;
      if (markup === state.signature) continue;
      const metrics = ['.live-output-text', '.reasoning-body', '.execution-trace-list'].map(selector => {
        const target = old?.querySelector(selector); return { selector, follow: !target || isNearBottom(target), top: target?.scrollTop || 0 };
      });
      const stageScrollTop = old?.querySelector('.stage-artifact-list')?.scrollTop || 0;
      const focused = old?.contains(document.activeElement) ? document.activeElement?.dataset?.toggle : undefined;
      const template = document.createElement('template'); template.innerHTML = markup;
      // Polling, plan toggles and artifact updates must not erase a draft or
      // reset a submitting form. Preserve its DOM only for the same revision.
      const previousForm = old?.querySelector('form[data-human-loop]');
      const nextForm = template.content.querySelector('form[data-human-loop]');
      const sameRequest = previousForm && nextForm && previousForm.dataset.humanLoop === nextForm.dataset.humanLoop && previousForm.dataset.requestRevision === nextForm.dataset.requestRevision;
      const activeInput = sameRequest && previousForm.contains(document.activeElement) ? document.activeElement : undefined;
      if (sameRequest) nextForm.replaceWith(previousForm);
      if (old) old.replaceWith(template.content); else state.wrapper.append(template.content);
      state.signature = markup;
      const card = state.wrapper.querySelector('.msg.assistant');
      const form = card.querySelector('form[data-human-loop]');
      if (form && !sameRequest) bindHumanLoop(form, turn.humanLoop, (request, value) => onHumanLoopResponse(turn.id, request, value));
      activeInput?.focus({ preventScroll: true });
      for (const metric of metrics) { const target = card.querySelector(metric.selector); if (target) target.scrollTop = nextScrollTop(target, metric.follow, metric.top); }
      const stageList = card.querySelector('.stage-artifact-list'); if (stageList) stageList.scrollTop = stageScrollTop;
      for (const button of card.querySelectorAll('[data-toggle]')) button.onclick = () => { state.ui[button.dataset.toggle] = button.dataset.toggle === 'process' ? button.getAttribute('aria-expanded') !== 'true' : !state.ui[button.dataset.toggle]; if (button.dataset.toggle === 'plan' && state.ui.plan) state.ui.process = true; render(); };
      for (const button of card.querySelectorAll('[data-artifact-id]')) button.onclick = () => onArtifact(turn.id, button.dataset.artifactId);
      const reasoning = card.querySelector('.live-reasoning'); if (reasoning) reasoning.ontoggle = () => { state.ui.reasoning = reasoning.open; };
      const rounds = card.querySelector('.round-history'); if (rounds) rounds.ontoggle = () => { state.ui.roundHistory = rounds.open; };
      for (const details of card.querySelectorAll('[data-tool-group]')) details.ontoggle = () => { state.ui.tools ||= {}; state.ui.tools[details.dataset.toolGroup] = details.open; };
      for (const details of card.querySelectorAll('[data-protocol-seq]')) details.ontoggle = () => { state.ui.protocol ||= {}; state.ui.protocol[details.dataset.protocolSeq] = details.open; };
      card.querySelector('[data-copy="assistant"]').onclick = event => copy(turn.text || turn.partialText, event.currentTarget);
      if (focused) card.querySelector(`[data-toggle="${focused}"]`)?.focus({ preventScroll: true });
    }
    scroll.scrollTop = nextScrollTop(scroll, follow, previousTop);
  }
  async function copy(text, button) {
    try { await navigator.clipboard.writeText(text || ''); button.classList.add('copied'); button.title = '已复制'; status('已复制消息'); setTimeout(() => { button.classList.remove('copied'); button.title = ''; }, 1500); }
    catch { status('复制失败，请检查浏览器剪贴板权限。', true); }
  }
  document.addEventListener('selectionchange', () => { if (window.getSelection()?.isCollapsed) render(); });
  return { render, clear() { for (const state of mounted.values()) state.wrapper.remove(); mounted.clear(); currentTurns = []; selected = undefined; pending?.remove(); pending = undefined; },
    submitting(input, failed = false) {
      if (!pending) { pending = document.createElement('div'); pending.className = 'desktop-turn submission-pending'; container.append(pending); }
      pending.replaceChildren(); const text = document.createElement('div'); text.className = 'msg-text'; text.textContent = input;
      const hint = document.createElement('p'); hint.className = 'composer-status'; hint.setAttribute('role', 'status'); hint.textContent = failed ? '发送未确认；相同消息重试将复用请求 ID。' : '正在提交到本机 Runtime…'; pending.append(text, hint);
      scroll.scrollTop = scroll.scrollHeight;
    }, submitted() { pending?.remove(); pending = undefined; } };
}
