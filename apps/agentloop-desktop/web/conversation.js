import { renderMarkdown } from './markdown.js';
import { assistantMessagePresentation, completedArtifactSummary, terminalAwarePlanStepStatus } from './reference/presentation/assistant-message-presentation.js';
import { executionActivities } from './reference/projections/execution-detail-projection.js';
import { isNearBottom, nextScrollTop } from './reference/ui/scroll-follow.js';
import { hasSelectedTextWithin } from './reference/ui/message-selection.js';
import { visibleToolCalls } from './turn-projection.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const lines = value => escape(value).replace(/\n/g, '<br>');
const clip = (value, max = 120) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max)}…` : text; };
const stepLabel = status => ({ completed: '已完成', running: '执行中', failed: '失败', cancelled: '已取消', pending: '待执行', queued: '待执行', rejected: '已拒绝', unfinished: '未确认完成', selected: '已选择', bound: '已绑定' }[status] || '待执行');
const time = value => Number.isFinite(value) ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '';
const copyIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path></svg>';
function copyButton(kind, disabled = false) { return `<button type="button" class="message-copy" data-copy="${kind}" aria-label="复制${kind === 'user' ? '提问' : '回答'}"${disabled ? ' disabled' : ''}>${copyIcon}</button>`; }
export function renderUser(run) {
  const sources = (run.sources || []).map(source => `<span class="source-chip msg-source-chip">▤ ${escape(source.originalName)}</span>`).join('');
  return `<article class="msg user"><div class="msg-body"><div class="msg-bubble"><div class="msg-role">你</div>${sources ? `<div class="msg-source-row" aria-label="本轮上传文件">${sources}</div>` : ''}<div class="msg-text">${escape(run.input)}</div><div class="message-footer"><div class="message-timing">提问于 ${escape(time(run.createdAt))}</div>${copyButton('user')}</div></div></div></article>`;
}
function renderArtifacts(turn, ui) {
  if (!turn.artifacts.length) return '';
  const final = turn.artifacts.filter(item => item.role === 'final'); const other = turn.artifacts.filter(item => item.role !== 'final');
  const cards = items => `<div class="desktop-artifact-list">${items.map(item => `<a class="desktop-artifact" href="/api/runs/${encodeURIComponent(turn.id)}/artifacts/${encodeURIComponent(item.id)}/download" download><span class="desktop-artifact-icon">▤</span><span>${escape(item.name)}<small>${escape(item.bytes)} 字节 · ${item.role === 'final' && turn.status === 'completed' ? '最终产物' : '阶段产物'} · 下载</small></span></a>`).join('')}</div>`;
  const head = (label, count) => `<div class="inline-artifacts-head"><span>${label}</span><small>${count} 个文件</small></div>`;
  const finalBlock = final.length ? head(turn.status === 'completed' ? '最终产物' : '已生成文件 · 尚非成功交付', final.length) + cards(final) : '';
  const otherBlock = !other.length ? '' : turn.status === 'completed' ? `<button type="button" class="execution-trace-toggle" data-toggle="artifacts" aria-expanded="${Boolean(ui.artifacts)}">${ui.artifacts ? '收起其他产物' : `查看其他产物 ${other.length} 个`} ⌄</button>${ui.artifacts ? cards(other) : ''}` : head('阶段产物 · 尚非成功交付', other.length) + cards(other);
  return `<section class="inline-artifacts" aria-label="本轮产物">${finalBlock}${otherBlock}</section>`;
}
function toolRow(call, latest = false) {
  const parameters = Object.entries(call.arguments).filter(([key]) => !['input', 'content', 'body'].includes(key)).map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' · ');
  const title = call.name === 'computer_run_command' ? call.arguments.command || call.name : call.name;
  const result = call.error || (call.status === 'completed' && call.exitCode !== undefined ? `已完成 · 退出码 ${call.exitCode}` : stepLabel(call.status));
  return `<div class="execution-trace-item tool${latest ? ' latest' : ''}"><span class="execution-trace-dot tool"></span><span class="execution-trace-copy"><strong>${escape(title)}</strong><small title="${escape(clip(parameters, 500))}">主要参数：${escape(clip(parameters) || '-')}</small><small class="execution-trace-result">结果：${escape(clip(result))}</small></span><span class="execution-trace-seq">#${call.seq}</span></div>`;
}
export function renderAssistant(turn, ui = {}) {
  const presentation = assistantMessagePresentation(turn.status); const live = presentation.isLive;
  const plan = turn.plan.map(step => ({ ...step, status: terminalAwarePlanStepStatus(step.status, turn.status) }));
  const planId = `plan-${turn.id}`; const traceId = `trace-${turn.id}`;
  const planToggle = plan.length ? `<button class="live-step-toggle" data-toggle="plan" aria-expanded="${Boolean(ui.plan)}" aria-controls="${escape(planId)}">步骤 ${plan.filter(step => step.status === 'completed').length}/${plan.length}<span class="live-step-caret">⌄</span></button>` : '';
  const planPanel = plan.length && ui.plan ? `<ol class="inline-plan-steps" id="${escape(planId)}">${plan.map((step, index) => `<li><span class="step-dot ${step.status === 'completed' ? 'done' : live && step.status === 'running' ? 'running' : step.status === 'failed' ? 'error' : 'pending'}"></span><span><b>${String(index + 1).padStart(2, '0')} ${escape(step.objective || step.id)}</b><small>${escape(!live && step.status === 'running' ? '未完成' : stepLabel(step.status))}</small></span></li>`).join('')}</ol>` : '';
  const reasoning = live && turn.reasoning ? `<details class="live-reasoning"${ui.reasoning !== false ? ' open' : ''}><summary>模型思考</summary><div class="reasoning-body">${lines(turn.reasoning)}</div></details>` : '';
  let output;
  if (turn.status === 'failed') output = `<div class="failure-title">${escape(turn.error || presentation.emptyText)}</div>${turn.partialText ? `<div class="partial-result"><strong>执行总结 · 尚非成功交付</strong>${renderMarkdown(turn.partialText)}</div>` : ''}`;
  else if (turn.text) output = live ? lines(turn.text) : renderMarkdown(turn.text);
  else output = live ? `<div class="live-progress" role="status">${escape(turn.progress || '正在连接本机 Runtime')}</div>` : `<span class="terminal-empty">${escape((turn.status === 'completed' ? completedArtifactSummary(turn.artifacts) : '') || presentation.emptyText)}</span>`;
  // Human Loop controls are not exposed by Desktop yet: do not pretend that a
  // waiting Run is progressing, or manufacture an answer/confirmation button.
  if (live && turn.humanLoop?.status === 'open') output += '<p class="desktop-action-needed">任务正在等待用户输入；Desktop 尚未接入此响应操作。</p>';
  const calls = visibleToolCalls(turn.events, turn.status).map(call => !live && ['running', 'queued'].includes(call.status) ? { ...call, status: 'unfinished' } : call);
  const latest = calls.filter(call => call.status === 'running').at(-1) || calls.at(-1);
  const trace = latest ? `<section class="execution-trace" aria-label="本轮工具执行状态"><div class="execution-trace-head"><div class="execution-trace-latest">${toolRow(latest, true)}</div>${calls.length > 1 ? `<button class="execution-trace-toggle" data-toggle="trace" aria-expanded="${Boolean(ui.trace)}" aria-controls="${escape(traceId)}">${ui.trace ? '收起工具' : `查看工具 ${calls.length} 次`} ⌄</button>` : ''}</div>${ui.trace && calls.length > 1 ? `<div class="execution-trace-list" id="${escape(traceId)}">${[...calls].reverse().map(call => toolRow(call)).join('')}</div>` : ''}</section>` : '';
  const skills = executionActivities(turn.events).skills;
  const skillMarkup = skills.length ? `<div class="desktop-skill-chips" aria-label="本轮技能">${skills.map(skill => `<span>✦ ${escape(skill.name)} · ${escape(stepLabel(skill.status))}</span>`).join('')}</div>` : '';
  const last = turn.events.at(-1);
  const eventIndicator = `<span class="live-event-indicator ${live ? 'active' : 'terminal'} ${escape(turn.status)}" data-event-seq="${last?.seq ?? 'pending'}"><i class="live-event-pulse" aria-hidden="true"></i><span class="live-event-number">${last ? `#${last.seq}` : '进行中'}</span><small>${escape(last?.type.replaceAll('.', ' ') || '正在连接 Runtime')}</small></span>`;
  const finished = turn.run.finishedAt; const elapsed = Number.isFinite(finished) ? Math.max(0, (finished - turn.run.createdAt) / 1000) : undefined;
  const timing = finished ? `回答结束于 ${time(finished)} · 耗时 ${elapsed.toFixed(1)} 秒` : '';
  return `<article class="msg assistant ${live ? 'live' : 'final'}${ui.selected ? ' selected' : ''}" data-assistant-message="${escape(turn.id)}" tabindex="0" role="button" aria-label="查看该轮执行详情" aria-pressed="${Boolean(ui.selected)}"><img class="msg-avatar logo-image" src="/assets/xuanwu-mascot-icon.png" alt="玄武"><div class="msg-body"><div class="live-card ${escape(presentation.cardClass)}"><div class="live-head"><span class="assistant-state ${escape(turn.status)}">${presentation.icon || (live ? '<span class="thinking"><i></i><i></i><i></i></span>' : '')}</span><span>AgentLoop · ${turn.humanLoop?.status === 'open' ? '等待你的输入' : escape(presentation.label)}</span><span class="execution-provenance"><span class="execution-provenance-chip location">本机</span><span class="execution-provenance-chip model">${escape(turn.run.modelKey)}</span></span>${planToggle}</div>${planPanel}${reasoning}<div class="live-output-text md">${output}</div>${trace}${skillMarkup}${renderArtifacts(turn, ui)}<div class="message-footer event-feedback">${eventIndicator}${timing ? `<div class="message-timing">${escape(timing)}</div>` : ''}${copyButton('assistant', !(turn.text || turn.partialText))}</div></div></div></article>`;
}

// Keyed turn nodes preserve old replies and browser selection. Only an altered
// assistant card is replaced, and each scroll surface follows independently.
export function createConversationView({ container, scroll, onSelect, status }) {
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
      const uiKey = `${turn.id === selectedId}|${state.ui.plan}|${state.ui.trace}|${state.ui.reasoning}|${state.ui.artifacts}`;
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
      const focused = old?.contains(document.activeElement) ? document.activeElement?.dataset?.toggle : undefined;
      const template = document.createElement('template'); template.innerHTML = markup;
      if (old) old.replaceWith(template.content); else state.wrapper.append(template.content);
      state.signature = markup;
      const card = state.wrapper.querySelector('.msg.assistant');
      for (const metric of metrics) { const target = card.querySelector(metric.selector); if (target) target.scrollTop = nextScrollTop(target, metric.follow, metric.top); }
      for (const button of card.querySelectorAll('[data-toggle]')) button.onclick = () => { state.ui[button.dataset.toggle] = !state.ui[button.dataset.toggle]; render(); };
      const reasoning = card.querySelector('.live-reasoning'); if (reasoning) reasoning.ontoggle = () => { state.ui.reasoning = reasoning.open; };
      card.querySelector('[data-copy="assistant"]').onclick = event => copy(turn.text || turn.partialText, event.currentTarget);
      card.onclick = event => { if (event.target.closest('button,a,summary,details') || hasSelectedTextWithin(window.getSelection(), card)) return; onSelect(turn.id); };
      card.onkeydown = event => { if (event.target !== card || !['Enter', ' '].includes(event.key)) return; event.preventDefault(); onSelect(turn.id); };
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
