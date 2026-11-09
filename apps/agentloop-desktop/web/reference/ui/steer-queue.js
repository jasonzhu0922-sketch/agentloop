// Presentation snapshot of Multi Runtime: ui/steer-queue.js. No Router transport.
const labels = { accepted: '已接收，等待处理', processing: '正在处理', applied: '已应用', answered: '已回答', needs_clarification: '需要澄清', unprocessed: '未处理' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function renderSteerMessages(messages = []) {
  return messages.map(message => `<div class="steer-message" data-steer-message="${escape(message.id)}"><div class="steer-message-user">${escape(message.text)}</div><small>${escape(labels[message.status] || message.status)}</small>${message.decision?.explanation || message.decision?.reason ? `<div class="steer-message-decision">${escape(message.decision.explanation || message.decision.reason)}</div>` : ''}</div>`).join('');
}

/** Stable request identity survives reloads and unknown responses. Scope is account + Runtime + conversation. */
export function createSteerDrafts(storage, scope) {
  const key = `agentloop.steer-drafts.v1:${JSON.stringify(scope)}`;
  let items;
  try { const saved = JSON.parse(storage.getItem(key) || '[]'); items = Array.isArray(saved) ? saved : []; } catch { items = []; }
  items = items.filter(item => typeof item.requestId === 'string' && typeof item.text === 'string').map(item => ({ ...item, state: item.state === 'submitting' ? 'unknown' : item.state }));
  const save = next => { storage.setItem(key, JSON.stringify(next)); items = next; };
  const refresh = () => { const saved = JSON.parse(storage.getItem(key) || '[]'); if (Array.isArray(saved)) items = saved; };
  save(items);
  return {
    list: () => { refresh(); return items.map(item => ({ ...item })); },
    add(text) { refresh(); if (!text.trim() || text.length > 16000) throw new Error('消息需为 1–16000 字符'); const item = { requestId: crypto.randomUUID(), text, state: 'draft' }; save([...items, item]); return item; },
    edit(id, text) { refresh(); const item = items.find(item => item.requestId === id); if (!item || item.state !== 'draft') throw new Error('消息已提交，不能编辑'); if (!text.trim() || text.length > 16000) throw new Error('消息需为 1–16000 字符'); save(items.map(item => item.requestId === id ? { ...item, text } : item)); },
    remove(id) { refresh(); const item = items.find(item => item.requestId === id); if (item && item.state !== 'draft') throw new Error('提交结果待确认，不能删除'); save(items.filter(item => item.requestId !== id)); },
    begin(id, runId) { refresh(); const item = items.find(item => item.requestId === id); if (!item || item.state === 'submitting') throw new Error('消息正在提交'); if (item.runId && item.runId !== runId) throw new Error('消息归属已绑定，请先确认原提交结果'); const next = { ...item, runId, state: 'submitting' }; save(items.map(item => item.requestId === id ? next : item)); return next; },
    failed(id, terminal = false) { refresh(); save(items.map(item => item.requestId !== id ? item : terminal ? { requestId: item.requestId, text: item.text, state: 'draft' } : { ...item, state: 'unknown' })); },
    reconcile(messages) { refresh(); const ids = new Set(messages.map(message => message.requestId)); save(items.filter(item => !ids.has(item.requestId))); },
  };
}

export function createSteerQueueView({ container, drafts, getRunId, submit, read, onAccepted, onMoveToComposer, onError }) {
  let editing, editText = '', rendered;
  function render() {
    const items = drafts.list(), active = getRunId();
    const signature = JSON.stringify([items, active, editing]);
    if (signature === rendered) return;
    rendered = signature;
    container.hidden = items.length === 0; container.replaceChildren();
    if (items.length) { const label = document.createElement('small'); label.className = 'steer-queue-label'; label.textContent = `待处理 · ${items.length}`; container.append(label); }
    for (const item of items) {
      const row = document.createElement('div'); row.className = `steer-queue-item${editing === item.requestId ? ' is-editing' : ''}`;
      const text = document.createElement('textarea'); text.value = editing === item.requestId ? editText : item.text; text.rows = editing === item.requestId ? 3 : 1; text.oninput = () => { editText = text.value; }; text.maxLength = 16000;
      text.readOnly = editing !== item.requestId; text.setAttribute('aria-label', '待处理消息'); row.append(text);
      const controls = document.createElement('div'); controls.className = 'steer-queue-actions'; row.append(controls);
      const button = (label, operation, disabled = false) => { const target = document.createElement('button'); target.type = 'button'; target.textContent = label; target.disabled = disabled; target.onclick = async () => { try { await operation(); } catch (error) { onError(error); } }; controls.append(target); };
      button(item.state === 'submitting' ? '提交中…' : item.state === 'unknown' ? '确认并重试' : active ? 'Steer' : '移入输入框', async () => {
        if (!active && item.state === 'draft') { onMoveToComposer(item.text); drafts.remove(item.requestId); render(); return; }
        const runId = item.runId || active;
        if (!runId) return;
        if (item.state === 'unknown') { const messages = await read(runId); drafts.reconcile(messages); if (messages.some(message => message.requestId === item.requestId)) { onAccepted(messages, runId); render(); return; } }
        const pending = drafts.begin(item.requestId, runId); render();
        try { const message = await submit(runId, { requestId: pending.requestId, text: pending.text }); drafts.reconcile([message]); onAccepted([message], runId); }
        catch (error) { drafts.failed(item.requestId, error.status === 409); onError(error); }
        render();
      }, item.state === 'submitting' || editing === item.requestId);
      button(editing === item.requestId ? '保存' : '编辑', () => { if (editing === item.requestId) { drafts.edit(item.requestId, text.value); editing = undefined; } else { editing = item.requestId; editText = item.text; } render(); }, item.state !== 'draft');
      button('删除', () => { drafts.remove(item.requestId); render(); }, item.state !== 'draft');
      container.append(row);
    }
  }
  render();
  return { render, add(text) { drafts.add(text); render(); }, reconcile(messages) { drafts.reconcile(messages); render(); } };
}
