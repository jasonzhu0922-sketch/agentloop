const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

// The request schema owns the interaction. No scenario-specific choices or
// implicit acceptance: a response is sent only by submitting this form.
export function renderHumanLoop(request) {
  const schema = request.responseSchema;
  if (!schema) return '<p role="status">正在读取待回答的问题…</p>';
  let controls;
  if (schema.type === 'select') {
    controls = `<p class="human-loop-hint">请选择 ${schema.minSelections === schema.maxSelections ? schema.minSelections : `${schema.minSelections}–${schema.maxSelections}`} 项</p><div class="human-loop-options">${schema.options.map((option, index) => `<label><input type="${schema.maxSelections === 1 ? 'radio' : 'checkbox'}" name="choice" value="${index}"><span><strong>${escape(option.label)}</strong>${option.description ? `<small>${escape(option.description)}</small>` : ''}</span></label>`).join('')}</div>`;
  } else if (schema.type === 'form') {
    controls = `<div class="human-loop-fields">${schema.fields.map((field, index) => {
      const attrs = `name="field-${index}"${field.required ? ' required' : ''} maxlength="${Number.isSafeInteger(field.maxLength) && field.maxLength > 0 ? field.maxLength : 20000}"`;
      const input = field.valueType === 'textarea' ? `<textarea ${attrs} rows="4"></textarea>` : `<input ${attrs} type="${['date', 'number'].includes(field.valueType) ? field.valueType : 'text'}"${field.valueType === 'number' ? ' step="any"' : ''}>`;
      return `<label><span>${escape(field.label)}${field.required ? ' *' : ''}</span>${field.description ? `<small>${escape(field.description)}</small>` : ''}${input}${field.valueType === 'file_ref' ? '<small>填写已有文件的引用或路径</small>' : ''}</label>`;
    }).join('')}</div>`;
  } else if (schema.type === 'confirm') {
    controls = `<div class="human-loop-options"><label><input type="radio" name="decision" value="accept" required><span>${escape(schema.acceptLabel)}</span></label><label><input type="radio" name="decision" value="reject" required><span>${escape(schema.rejectLabel)}</span></label></div><label class="human-loop-reason">说明${schema.requireReasonOnReject ? '（拒绝时必填）' : '（选填）'}<textarea name="reason" rows="2" maxlength="20000"></textarea></label>`;
  } else return '<p role="alert">当前问题的回答格式不受支持，请更新客户端。</p>';
  return `<form class="human-loop" data-human-loop="${escape(request.id)}" data-request-revision="${request.revision}" aria-label="等待你的输入"><header><strong>${escape(request.title)}</strong><span>等待你的输入</span></header><p class="human-loop-prompt">${escape(request.prompt)}</p><details><summary>为什么需要你的输入</summary><p>${escape(request.rationale)}</p></details><fieldset>${controls}<button type="submit" class="human-loop-submit">提交回答并继续</button></fieldset><p class="human-loop-feedback" role="status" aria-live="polite"></p></form>`;
}

export function readHumanLoopResponse(request, form) {
  const data = new FormData(form), schema = request.responseSchema;
  if (schema.type === 'select') {
    const selected = data.getAll('choice').map(index => schema.options[Number(index)]?.id);
    if (selected.some(id => id === undefined) || selected.length < schema.minSelections || selected.length > schema.maxSelections) throw new Error(`请选择 ${schema.minSelections}–${schema.maxSelections} 项。`);
    return selected;
  }
  if (schema.type === 'form') return Object.fromEntries(schema.fields.map((field, index) => {
    const value = String(data.get(`field-${index}`) ?? '');
    if (field.required && !value.trim()) throw new Error(`请填写${field.label}。`);
    if (value.length > (field.maxLength ?? 20000)) throw new Error(`${field.label}内容过长。`);
    return [field.id, value];
  }));
  const decision = data.get('decision'), reason = String(data.get('reason') ?? '').trim();
  if (decision === 'accept') return true;
  if (decision !== 'reject') throw new Error('请选择确认或拒绝。');
  if (schema.requireReasonOnReject && !reason) throw new Error('请填写拒绝原因。');
  return { accepted: false, ...(reason ? { reason } : {}) };
}

export function bindHumanLoop(form, request, onRespond) {
  let submitting = false;
  form.onsubmit = async event => {
    event.preventDefault();
    if (submitting) return;
    const feedback = form.querySelector('.human-loop-feedback'), fields = form.querySelector('fieldset');
    try {
      if (!form.reportValidity()) return;
      const value = readHumanLoopResponse(request, form);
      submitting = true; fields.disabled = true; feedback.textContent = '正在提交回答…';
      await onRespond(request, value);
      feedback.textContent = '回答已提交，正在继续任务。';
      // Keep an accepted response disabled until authoritative polling removes
      // it, including when the first post-submit refresh fails.
    } catch (error) {
      feedback.textContent = error.status === 409 ? '这个问题已被回答或发生变化，正在同步最新状态。' : `提交未确认：${error.message}。你的填写已保留。`;
      submitting = false; fields.disabled = false;
    }
  };
}
