// Canonical Desktop conversation process. Host and Router transports stay outside this module.
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const lines = value => escape(value).replace(/\n/g, '<br>');
const clip = (value, max = 120) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max)}…` : text; };
const steerStatus = status => ({ accepted: '已接收，等待处理', processing: '正在处理', applied: '已应用', answered: '已回答', needs_clarification: '需要澄清', unprocessed: '未处理' }[status] || status || '');
function renderSteerMessage(message) {
  return `<div class="steer-message" data-steer-message="${escape(message.id)}"><div class="steer-message-bubble"><div class="steer-message-user">${escape(message.text)}</div><small>${escape(steerStatus(message.status))}</small></div></div>`;
}
const stepLabel = status => ({ completed: '已完成', running: '执行中', failed: '失败', cancelled: '已取消', pending: '待执行', queued: '待执行', rejected: '已拒绝', unfinished: '未确认完成', selected: '已选择', bound: '已绑定' }[status] || '待执行');

export function visibleToolCalls(events, runStatus) {
  const calls = new Map();
  for (const event of events) {
    const data = event.data || {}; const id = data.toolCallId;
    if (!id || !['tool.planned', 'assistant.tool_call.committed', 'tool.dispatched', 'tool.effect_pending', 'tool.completed', 'tool.failed', 'tool.rejected'].includes(event.type)) continue;
    const call = calls.get(id) || { id, name: data.toolName || data.name || '工具', status: 'queued', arguments: {} };
    call.seq = event.seq;
    if (data.toolName || data.name) call.name = data.toolName || data.name;
    if (data.arguments && typeof data.arguments === 'object') call.arguments = data.arguments;
    if (event.type === 'tool.completed') call.status = 'completed';
    else if (event.type === 'tool.failed') call.status = 'failed';
    else if (event.type === 'tool.rejected') call.status = 'rejected';
    else if (['tool.dispatched', 'tool.effect_pending'].includes(event.type)) call.status = 'running';
    if (event.type === 'tool.failed') call.error = data.error;
    if (event.type === 'tool.rejected') call.error = data.reason;
    if (data.result !== undefined) call.result = data.result;
    if (event.type === 'tool.completed') {
      let result = data.result;
      if (typeof result === 'string') { try { result = JSON.parse(result); } catch { result = undefined; } }
      if (Number.isFinite(result?.exitCode)) call.exitCode = result.exitCode;
      if (data.isError === true) { call.status = 'failed'; call.error = '工具返回错误'; }
    }
    calls.set(id, call);
  }
  return [...calls.values()].map(call => ({ ...call, status: runStatus === 'cancelled' && ['queued', 'running'].includes(call.status) ? 'cancelled' : call.status }));
}

function toolRow(call, open = false, evidence = {}) {
  if (evidence.arguments) call = { ...call, arguments: evidence.arguments };
  const parameters = Object.entries(call.arguments).filter(([key]) => !['input', 'content', 'body'].includes(key)).map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' · ');
  const command = typeof call.arguments.command === 'string' ? [call.arguments.command, ...(Array.isArray(call.arguments.args) ? call.arguments.args : [])].join(' ') : undefined;
  const title = command || [call.name, parameters].filter(Boolean).join(' · ');
  const result = call.error || (call.status === 'completed' && call.exitCode !== undefined ? `已完成 · 退出码 ${call.exitCode}` : stepLabel(call.status));
  const format = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  let output = call.result;
  if (typeof output === 'string') { try { output = JSON.parse(output); } catch { /* Plain text results stay verbatim. */ } }
  if (typeof evidence.stdout === 'string' || typeof evidence.stderr === 'string') output = {
    ...(output && typeof output === 'object' ? output : {}),
    ...(typeof evidence.stdout === 'string' ? { stdout: evidence.stdout } : {}),
    ...(typeof evidence.stderr === 'string' ? { stderr: evidence.stderr } : {}),
  };
  const streams = output && typeof output === 'object' && (typeof output.stdout === 'string' || typeof output.stderr === 'string');
  const section = (label, text) => `<section><div class="process-tool-detail-label">${label}</div><pre>${escape(text)}</pre></section>`;
  const outputDetail = streams ? ['stdout', 'stderr'].filter(key => output[key]).map(key => section(key, output[key])).join('') : output !== undefined ? section('输出', format(output)) : '';
  return `<details class="process-tool-call ${escape(call.status)}" data-tool-call="${escape(call.id)}"${open ? ' open' : ''}><summary><span class="process-tool-icon" aria-hidden="true">${command ? '›_' : '↗'}</span><span class="process-tool-title" title="${escape(title)}">${escape(title)}</span><small class="process-tool-status" title="${escape(result)}">${escape(clip(result, 80))}</small></summary><div class="process-tool-detail">${command ? section('Shell', `$ ${command}`) : ''}${section('参数', format(call.arguments))}${outputDetail}${section('结果', `${result} · #${call.seq}`)}</div></details>`;
}
// Streaming content is a cumulative snapshot until it is committed. Keep each
// committed segment in event order instead of replacing it with the next one.
export function renderProcess(turn, openTools = {}, openProtocol = {}, processOpen = true, openToolDetails = {}, liveProgressForEvent = () => undefined) {
  const items = []; const tools = new Map(visibleToolCalls(turn.events, turn.status).map(call => [call.id, call]));
  const shownTools = new Set(); let segment; let previousContent = ''; let segmentPrefix = '';
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
    // Each call occupies its first event position and reflects its latest state.
    // All lifecycle events remain available in the persisted Run history.
    if (projected && shownTools.has(projected.id)) continue;
    const label = projected ? undefined : liveProgressForEvent(event);
    // Technical events advance the footer, but do not interrupt the readable
    // transcript or split cumulative model text into separate paragraphs.
    if (!projected && !label) continue;
    // A subsequent snapshot may still belong to the same model response.
    // Only append its new suffix after an intervening visible event.
    segment = undefined; segmentPrefix = previousContent;
    if (projected) {
      shownTools.add(projected.id);
      items.push({ kind: 'tool', call: tools.get(projected.id), seq: event.seq });
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
    else if (item.kind === 'tool') groups.push({ kind: 'tools', calls: [item.call], entries: [item], seq: item.seq });
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
    return `<details class="process-tool-group" data-tool-group="${escape(item.seq)}"${openTools[item.seq] ? ' open' : ''}${hidden}><summary><span class="process-tool-icon" aria-hidden="true">↗</span><span>工具调用 · ${item.calls.length} 次</span></summary><div class="process-tool-list">${item.entries.map(entry => entry.kind === 'tool' ? toolRow(entry.call, openToolDetails[entry.call.id], turn.toolEvidence?.[entry.call.id]) : `<div class="process-progress">${escape(entry.text)}</div>`).join('')}</div></details>`;
  }).join('');
}
