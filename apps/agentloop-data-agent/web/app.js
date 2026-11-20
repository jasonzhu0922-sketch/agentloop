import { renderMarkdown } from './markdown.js';
const $ = selector => document.querySelector(selector);
const state = { conversationId: null, runs: [], active: null, cursor: 0, modelKey: null, epoch: 0, timer: null, sending: false, pendingMessage: null };
const phases = { 'plan.proposed': '正在理解问题', 'plan.admitted': '正在查证数据', 'model.request.started': '正在分析与推理', 'tool.planned': '正在准备查询', 'tool.dispatched': '正在查询业务数据', 'tool.completed': '正在分析查询结果', 'assistant.committed': '正在整理回答', 'step.assessment_started': '正在核对答案', 'human_loop.requested': '需要你确认', 'run.waiting_user': '需要你确认' };
const toolLabels = { computer_run_command: '查询业务数据', computer_read_json: '读取查询结果', request_human_loop: '确认查询口径', load_skill: '加载数据分析能力', websearch: '检索资料', webfetch: '读取资料' };

async function api(path, data) { const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error ?? '请求失败'); return result; }
function notice(error) { $('#notice').textContent = error?.message ?? ''; $('#notice').hidden = !error; }
function element(tag, className, content) { const node = document.createElement(tag); if (className) node.className = className; if (content !== undefined) node.textContent = content; return node; }
function escape(value = '') { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function formatDuration(ms) { if (!Number.isFinite(ms)) return ''; const seconds = Math.max(0, ms) / 1000; return seconds < 60 ? `${seconds.toFixed(1)} 秒` : `${Math.floor(seconds / 60)} 分 ${(seconds % 60).toFixed(1)} 秒`; }
function time(value) { return Number.isFinite(value) ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : ''; }
function answerContent(text) {
  const root = element('div', 'answer-text md');
  root.innerHTML = renderMarkdown(text);
  return root;
}
function eventData(event) { return event?.data && typeof event.data === 'object' ? event.data : {}; }
function friendlyToolName(name) { return toolLabels[name] || String(name || '工具').replaceAll('_', ' '); }
function executionDuration(ms) { const seconds = Math.max(0, Math.floor(ms / 1000)); if (seconds < 60) return `${seconds} 秒`; const minutes = Math.floor(seconds / 60); const remainder = seconds % 60; if (minutes < 60) return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分钟`; const hours = Math.floor(minutes / 60); const minuteRemainder = minutes % 60; return minuteRemainder ? `${hours} 小时 ${minuteRemainder} 分` : `${hours} 小时`; }
function runDuration(run) { return executionDuration((run.finishedAt || Date.now()) - run.createdAt); }
function chineseProgress(text) { const value = String(text || '').trim(); const chinese = value.match(/[\u3400-\u9fff]/gu)?.length || 0; const latin = value.match(/[A-Za-z]/gu)?.length || 0; return chinese > 0 && chinese * 2 >= latin; }
function timelineCodeLabel(value) {
  const aliases = { 'retrieve-knowledge': '知识检索', 'get-query-context': '查询上下文', 'get-metrics': '指标定义', 'execute-sql': '数据查询' };
  if (aliases[value]) return aliases[value];
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value) || /^\d{6}$/u.test(value)) return value;
  return '';
}
function timelineProgress(text) {
  const source = String(text || '');
  const latestMonth = source.match(/latest_month\s*=\s*\**(\d{6})/iu)?.[1];
  if (latestMonth) {
    return `查询已返回结果：人力月报数据中的最新月份为 ${latestMonth.slice(0, 4)} 年 ${Number(latestMonth.slice(4))} 月（年月编码 ${latestMonth}）。正在核对月份字段和结果口径。`;
  }
  const minDate = source.match(/min_date`?\s*=\s*\**(\d{4}-\d{2}-\d{2})/iu)?.[1];
  const maxDate = source.match(/max_date`?\s*=\s*\**(\d{4}-\d{2}-\d{2})/iu)?.[1];
  const distinctCount = source.match(/distinct_index_count`?\s*=\s*\**(\d+)/iu)?.[1];
  const recordCount = source.match(/record_count`?\s*=\s*\**(\d+)/iu)?.[1];
  if (minDate && maxDate && distinctCount && recordCount) {
    const coverage = minDate === maxDate ? `仅覆盖 ${minDate} 当天` : `覆盖 ${minDate} 至 ${maxDate}`;
    return `查询已返回结果：有效时序数据${coverage}，共有 ${Number(distinctCount).toLocaleString('zh-CN')} 个不同指标、${Number(recordCount).toLocaleString('zh-CN')} 条记录。正在核对日期字段和统计口径。`;
  }
  if (/用户确认了.*口径/u.test(source) && /时序数据表/u.test(source) && /有效记录/u.test(source)) {
    const label = source.match(/口径([A-ZＡ-Ｚ])/u)?.[1] || '';
    return `用户已确认${label ? `口径${label}` : '查询口径'}：按时序数据表中的有效记录统计不同指标数。正在据此查询日期范围、指标数和记录数。`;
  }
  if (/Skill 已加载/u.test(source) && /retrieve-knowledge/iu.test(source)) {
    const subject = source.match(/检索([^。！？；]+?)的目录信息/u)?.[1];
    return `正在检索${subject ? `${subject}的` : '与问题相关的'}目录信息，定位数据来源和统计指标。`;
  }
  if (/stdout/iu.test(source) && /content_complete=false/iu.test(source)) {
    return '知识检索已返回回执，正在读取完整结果，核对数据来源、业务术语和指标定义。';
  }
  const sourceLabels = [...source.matchAll(/`[^`]+`（([^）]+)）\s*[:：]/gu)].map(match => match[1]).filter(Boolean);
  if (/(?:知识检索|检索结果).*(?:找到|明确|匹配|返回)/su.test(source) && sourceLabels.length) {
    const uniqueLabels = [...new Set(sourceLabels)].slice(0, 3);
    const sources = uniqueLabels.length > 1 ? `${uniqueLabels.slice(0, -1).join('、')}和${uniqueLabels.at(-1)}` : uniqueLabels[0];
    if (/日期|记录|指标数|三个要素/u.test(source)) {
      return `知识检索已定位到${sources}，将分别用于核对日期范围、有效记录数和不同指标数。`;
    }
    return `知识检索已定位到${sources}，正在核对表结构、时间字段和统计口径。`;
  }
  if (/(?:读取文件|读取保存的|完整知识检索结果)/u.test(source) && /(?:字段|指标定义|来源|术语)/u.test(source)) {
    return '正在读取完整查询上下文，核对数据来源、表字段和指标定义。';
  }
  if (/第3点/u.test(source) && /is_deleted/iu.test(source)) {
    return '正在确认时序数据表是否包含软删除标识，以确保记录数只统计有效数据。';
  }
  if (/columns_complete=false/iu.test(source) || /并非所有列都已展示/u.test(source)) {
    return '当前字段列表尚未完整展开，但业务定义已明确有效记录仅包含未删除数据。正在进一步核验完整表结构。';
  }
  if (/is_deleted/iu.test(source) && /market_index_count/iu.test(source) && /不等于/u.test(source)) {
    return '已确认时序数据表包含软删除标识。指标数仍有两种口径：时序数据中实际出现的指标数，或指标信息表中的注册指标数。';
  }
  if (/is_deleted/iu.test(source) && /用户问的是/u.test(source) && /不同指标/u.test(source)) {
    return '表结构核验已完成。结合用户问题，正在确认“不同指标数”应采用有效时序数据中的去重指标数。';
  }
  const monthFormat = source.match(/格式为\s*`?(YYYYMM)`?/iu)?.[1];
  if (/已经获取到上下文/u.test(source) && monthFormat) {
    const label = sourceLabels[0] || '人力月报';
    return `查询上下文已确认：${label}按月记录，月份格式为 ${monthFormat}。正在查询最新月份。`;
  }
  const plain = source
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/\*\*([^*\n]+)\*\*/gu, '$1')
    .replace(/__([^_\n]+)__/gu, '$1')
    .replace(/^\s*```[^\n]*$/gmu, '')
    .replace(/^\s{0,3}#{1,6}\s+/gmu, '')
    .replace(/^\s*>\s?/gmu, '')
    .replace(/^\s*[-*+]\s+/gmu, '')
    .replace(/[ \t]+/gu, ' ')
    .trim();
  if (!plain || /(?:^|\s)Skill(?:\s|$)/iu.test(plain) && plain.length < 30) return '';
  const internal = /(?:stdout|stderr|content_complete|plan_seed|query_plan|plan_verification|resultPointer|sourcePointer|available_column|table_summar|diagnostics|columns_complete|\bstatus=|\bJSON\b|\bSELECT\b|\bCOUNT\s*\(|\bMIN\s*\(|\bMAX\s*\(|\bAVG\s*\()/iu;
  const completeSentences = plain.match(/[^。！？；\n]+[。！？；]/gu) || [];
  const selected = [];
  let length = 0;
  for (const raw of completeSentences) {
    if (internal.test(raw)) continue;
    let sentence = raw
      .replace(/`[^`]+`（([^）]+)）/gu, '$1')
      .replace(/`[^`]+`\s*\(([^)]+)\)/gu, '$1')
      .replace(/（`[^`]+`）/gu, '')
      .replace(/\(`[^`]+`\)/gu, '')
      .replace(/`([^`]+)`/gu, (_, value) => timelineCodeLabel(value))
      .replace(/（\s*）|\(\s*\)/gu, '')
      .replace(/^(?:现在)?按照 Skill 工作流，?\s*/iu, '')
      .replace(/^(?:首先|然后)?(?:让我|我需要|我先)\s*/u, '正在')
      .replace(/^我(?:正在)?\s*(读取|获取|检查|确认|核对|查询|检索|生成|构造|执行)/u, '正在$1')
      .replace(/^(?:先|现在)\s*(读取|获取|检查|确认|核对|查询|检索|生成|构造|执行)/u, '正在$1')
      .replace(/，?以便生成\s*SQL[^。！？；]*([。！？；])/iu, '$1')
      .replace(/，?然后用\s*get-query-context[^。！？；]*([。！？；])/iu, '$1')
      .replace(/\bSQL\b/giu, '查询')
      .replace(/\s+([，。！？；：])/gu, '$1')
      .replace(/([（(])\s+/gu, '$1')
      .replace(/\s+([）)])/gu, '$1')
      .replace(/([，：])\s*([，。！？；])/gu, '$2')
      .trim();
    if (sentence.length < 8 || /\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/u.test(sentence) || !chineseProgress(sentence)) continue;
    if (/Skill 已加载/u.test(sentence)) continue;
    if (/^(?:领域计划|查询计划|步骤|参数|过滤条件)[:：]/u.test(sentence)) continue;
    if (/^(?:不过|但是|但|由于|而|其中|这些都是|值得注意的是)[，：]?/u.test(sentence) && !/(?:结果|数据|覆盖|口径|来源)/u.test(sentence)) continue;
    if (/(?:这个条件|该条件|这个指标|这个结果)[。！？；]$/u.test(sentence)) continue;
    if (sentence.length > 160) sentence = `${sentence.slice(0, 157).trimEnd()}…`;
    if (selected.includes(sentence)) continue;
    if (length + sentence.length > 280 && selected.length) break;
    selected.push(sentence);
    length += sentence.length;
    if (selected.length === 2) break;
  }
  if (selected.length) return selected.join(' ');
  if (/(?:is_deleted|软删除).*(?:表结构|字段|列)|(?:表结构|字段|列).*(?:is_deleted|软删除)/iu.test(source)) {
    return '正在核对表结构和有效记录条件，确认统计范围只包含未删除数据。';
  }
  if (/market_index_count/iu.test(source) && /不等于|口径/u.test(source)) {
    return '正在比较“时序数据中实际出现的指标数”和“指标信息表中的注册指标数”两种口径，确认哪一种与用户问题一致。';
  }
  if (/(?:读取|获取).*(?:完整|文件).*(?:知识|查询).*(?:结果|上下文)/u.test(source)) {
    return '正在读取完整查询上下文，核对数据来源、表结构和指标定义。';
  }
  return '';
}
function eventStepKey(event) {
  const data = eventData(event);
  const step = data.step ?? data.stepId ?? data.turn;
  return step === undefined || step === null ? '' : `${data.phase || 'execution'}:${step}`;
}
function visibleTimelineTool(data) {
  return data.toolName !== 'load_skill';
}
function executionTimeline(run) {
  const tools = new Map();
  const narrationSteps = new Map();
  const items = [];
  for (const event of run.events || []) {
    const data = eventData(event);
    if (event.type === 'assistant.streaming' || event.type === 'assistant.committed') {
      const stepKey = eventStepKey(event);
      if (!stepKey) continue;
      const content = String(event.content ?? data.content ?? '');
      const narration = narrationSteps.get(stepKey);
      if (!narration || content.length >= narration.content.length) {
        narrationSteps.set(stepKey, { stepKey, seq: narration?.seq ?? event.seq ?? 0, content });
      }
      continue;
    }
    if (!event.type.startsWith('tool.') || !visibleTimelineTool(data)) continue;
    const toolId = data.toolCallId || (data.step !== undefined && data.toolName ? `step:${data.step}:${data.toolName}` : '');
    if (!toolId) continue;
    let tool = tools.get(toolId);
    if (!tool) {
      tool = { id: toolId, seq: event.seq || 0, start: event, end: null };
      tools.set(toolId, tool);
      items.push({ kind: 'tool', id: toolId, seq: event.seq || 0, tool });
    }
    if (event.type === 'tool.planned' || !tool.start) tool.start = event;
    if (event.type === 'tool.completed' || event.type === 'tool.failed') tool.end = event;
    if (data.toolName && !eventData(tool.start).toolName) tool.start = { ...tool.start, data: { ...eventData(tool.start), toolName: data.toolName } };
  }
  for (const narration of narrationSteps.values()) {
    const text = timelineProgress(narration.content);
    if (text) items.push({ kind: 'narration', id: narration.stepKey, seq: narration.seq, text });
  }
  const seenNarrations = new Set();
  return items.filter(item => {
    if (item.kind === 'tool') return true;
    if (!item.text || seenNarrations.has(item.text)) return false;
    seenNarrations.add(item.text);
    return true;
  }).sort((left, right) => left.seq - right.seq || (left.kind === 'narration' ? -1 : 1));
}
function toolInvocation(tool) {
  const data = tool.start ? eventData(tool.start) : {};
  const args = data.arguments && typeof data.arguments === 'object' ? data.arguments : null;
  if (!args) return data.toolName || 'tool';
  const text = JSON.stringify(args, null, 2);
  return `${data.toolName || 'tool'}(${text.length > 1200 ? `${text.slice(0, 1200)}\n…` : text})`;
}
function toolResultSummary(tool) {
  if (!tool.end) return '运行中，尚无返回记录';
  const data = eventData(tool.end);
  if (data.errorPreview) return String(data.errorPreview);
  if (data.resultPreview) return String(data.resultPreview);
  if (tool.end.type === 'tool.failed' || data.isError || data.operationStatus === 'failed') return '运行失败，运行记录未提供错误详情';
  if (typeof data.exitCode === 'number') return `运行完成，退出码 ${data.exitCode}；运行记录未提供返回详情`;
  return '运行完成，运行记录未提供返回详情';
}
function toolResultOverview(tool) {
  if (!tool.end) return '运行中';
  const data = eventData(tool.end);
  if (tool.end.type === 'tool.failed' || data.isError || data.operationStatus === 'failed') return typeof data.exitCode === 'number' ? `运行失败，退出码 ${data.exitCode}` : '运行失败';
  return typeof data.exitCode === 'number' ? `运行完成，退出码 ${data.exitCode}` : '运行完成';
}
function toolDuration(tool) {
  if (!tool.start?.createdAt) return '运行中';
  const end = tool.end?.createdAt || Date.now();
  return formatDuration(end - tool.start.createdAt);
}
function toolIcon() { return '<span class="preview-execution-tool__icon" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false"><ellipse cx="8" cy="4.5" rx="4.5" ry="2"/><path d="M3.5 4.5v5c0 1.1 2 2 4.5 2s4.5-.9 4.5-2v-5M3.5 7c0 1.1 2 2 4.5 2s4.5-.9 4.5-2"/></svg></span>'; }
function processMarkup(run) {
  const live = run.status === 'running';
  const rows = executionTimeline(run).map(item => {
    if (item.kind === 'narration') return `<div class="preview-execution-step preview-execution-step--narration" data-narration-id="${escape(item.id)}"><div class="preview-execution-narration"><div class="preview-execution-narration__text"><p>${escape(item.text)}</p></div></div></div>`;
    const tool = item.tool;
    const startData = eventData(tool.start);
    const failed = tool.end && (tool.end.type === 'tool.failed' || eventData(tool.end).isError || eventData(tool.end).operationStatus === 'failed');
    const status = tool.end ? failed ? 'failed' : 'completed' : 'running';
    return `<div class="preview-execution-step preview-execution-step--tool preview-execution-step--${status}" data-tool-call-id="${escape(tool.id)}"><details class="preview-execution-tool"><summary class="preview-execution-tool__summary"><span class="preview-execution-tool__main">${toolIcon()}<span class="preview-execution-tool__name">${escape(friendlyToolName(startData.toolName))}</span></span></summary><div class="preview-execution-tool__technical"><div class="preview-execution-tool__technical-label">本次运行</div><pre class="preview-execution-tool__invocation">${escape(toolInvocation(tool))}</pre><div class="preview-execution-tool__overview-meta"><p class="preview-execution-tool__technical-summary">${escape(toolResultOverview(tool))}</p><p class="preview-execution-tool__technical-duration">耗时：${escape(toolDuration(tool))}</p></div><div class="preview-execution-tool__technical-label">返回详情</div><pre class="preview-execution-tool__result">${escape(toolResultSummary(tool))}</pre></div></details></div>`;
  }).join('');
  const status = run.status === 'failed' ? '执行失败' : live ? '运行中' : run.status === 'cancelled' ? '已停止' : '已完成';
  return `<section class="preview-execution-timeline" data-run-id="${escape(run.id)}" aria-label="真实执行轨迹"><details class="preview-execution-stream"${live ? ' open' : ''}><summary class="preview-execution-stream__summary"><span class="preview-execution-stream__title">${escape(status)} · 已运行 ${escape(runDuration(run))}</span><span class="preview-execution-stream__chevron" aria-hidden="true"></span></summary><div class="preview-execution-timeline__list">${rows}${live ? '<div class="preview-execution-thinking" role="status"><span>正在思索中</span></div>' : ''}</div></details></section>`;
}
function renderUser(run) { return `<article class="message user" data-run-id="${escape(run.id)}"><div class="message-body"><div class="message-text">${escape(run.input)}</div><div class="message-time">${escape(time(run.createdAt))}</div></div></article>`; }
function formatBytes(value) { const bytes = Number(value) || 0; if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function artifactMarkup(run) { const artifacts = Array.isArray(run.artifacts) ? run.artifacts : []; if (!artifacts.length) return ''; return `<div class="answer-artifacts" aria-label="交付文件">${artifacts.map(artifact => `<a class="answer-artifact" href="/api/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(artifact.id)}/download" download><span class="answer-artifact__icon" aria-hidden="true">↓</span><span><strong>下载文件</strong><small>${escape(artifact.name)} · ${escape(formatBytes(artifact.bytes))}</small></span></a>`).join('')}</div>`; }
function renderAssistant(run) { const live = run.status === 'running'; const content = run.output || (run.status === 'failed' ? `查询未完成（${run.errorCode || '执行失败'}）。请调整问题或稍后重试。` : run.status === 'cancelled' ? '已停止本次查询。' : ''); const answer = live ? '' : `<div class="answer-content">${answerContent(content).outerHTML}</div>${artifactMarkup(run)}`; return `<article class="message assistant ${live ? 'live' : 'final'}" data-run-id="${escape(run.id)}"><div class="assistant-card">${processMarkup(run)}${answer}<div class="assistant-footer"><span>${run.finishedAt ? `完成于 ${escape(time(run.finishedAt))}` : ''}</span>${live ? '' : `<button class="copy-answer" type="button" data-copy-run="${escape(run.id)}">复制回答</button>`}</div></div></article>`; }
function captureDisclosure(root) {
  const stream = root?.querySelector('.preview-execution-stream');
  return { streamOpen: stream ? stream.open : null, tools: new Set([...root?.querySelectorAll('[data-tool-call-id] > .preview-execution-tool[open]') || []].map(node => node.parentElement.dataset.toolCallId)), scrollX: window.scrollX, scrollY: window.scrollY };
}
function restoreDisclosure(root, disclosure, live) {
  const stream = root?.querySelector('.preview-execution-stream');
  if (stream && live && disclosure.streamOpen !== null) stream.open = disclosure.streamOpen;
  root?.querySelectorAll('[data-tool-call-id]').forEach(node => { const details = node.querySelector(':scope > .preview-execution-tool'); if (details) details.open = live && disclosure.tools.has(node.dataset.toolCallId); });
}
function bindCopyButtons(root = document) { for (const button of root.querySelectorAll('[data-copy-run]')) button.onclick = async () => { const run = state.runs.find(item => item.id === button.dataset.copyRun); try { await navigator.clipboard.writeText(run?.output || run?.draft || ''); button.textContent = '已复制'; setTimeout(() => { button.textContent = '复制回答'; }, 1200); } catch { notice(new Error('复制失败，请检查浏览器权限')); } }; }
function syncLiveAssistant(current, next) {
  current.className = next.className;
  const currentTimeline = current.querySelector('.preview-execution-timeline');
  const nextTimeline = next.querySelector('.preview-execution-timeline');
  if (!currentTimeline || !nextTimeline) return false;
  const currentTitle = currentTimeline.querySelector('.preview-execution-stream__title');
  const nextTitle = nextTimeline.querySelector('.preview-execution-stream__title');
  if (currentTitle && nextTitle) currentTitle.textContent = nextTitle.textContent;
  const currentList = currentTimeline.querySelector('.preview-execution-timeline__list');
  const nextList = nextTimeline.querySelector('.preview-execution-timeline__list');
  if (!currentList || !nextList) return false;
  const keyed = new Map([...currentList.children].map(node => [node.dataset.toolCallId ? `tool:${node.dataset.toolCallId}` : node.dataset.narrationId ? `narration:${node.dataset.narrationId}` : node.classList.contains('preview-execution-thinking') ? 'thinking' : '', node]).filter(([key]) => key));
  const ordered = [];
  for (const nextItem of [...nextList.children]) {
    const key = nextItem.dataset.toolCallId ? `tool:${nextItem.dataset.toolCallId}` : nextItem.dataset.narrationId ? `narration:${nextItem.dataset.narrationId}` : nextItem.classList.contains('preview-execution-thinking') ? 'thinking' : '';
    const currentItem = key ? keyed.get(key) : null;
    if (!currentItem) { ordered.push(nextItem); continue; }
    if (nextItem.dataset.narrationId) {
      const currentText = currentItem.querySelector('.preview-execution-narration__text p');
      const nextText = nextItem.querySelector('.preview-execution-narration__text p');
      const currentValue = currentText?.textContent || '';
      const nextValue = nextText?.textContent || '';
      if (currentText && nextText && nextValue !== currentValue && nextValue.startsWith(currentValue)) {
        currentText.textContent = nextValue;
      }
    } else if (nextItem.dataset.toolCallId) {
      currentItem.className = nextItem.className;
      for (const selector of ['.preview-execution-tool__name', '.preview-execution-tool__invocation', '.preview-execution-tool__technical-summary', '.preview-execution-tool__technical-duration', '.preview-execution-tool__result']) {
        const currentValue = currentItem.querySelector(selector);
        const nextValue = nextItem.querySelector(selector);
        if (currentValue && nextValue && currentValue.textContent !== nextValue.textContent) currentValue.textContent = nextValue.textContent;
      }
    }
    ordered.push(currentItem);
    keyed.delete(key);
  }
  ordered.forEach((node, index) => { if (currentList.children[index] !== node) currentList.insertBefore(node, currentList.children[index] || null); });
  return true;
}
function renderRun(run) {
  const messages = $('#messages');
  const selector = CSS.escape(run.id);
  let user = messages.querySelector(`.message.user[data-run-id="${selector}"]`);
  let assistant = messages.querySelector(`.message.assistant[data-run-id="${selector}"]`);
  if (!user) { const template = document.createElement('template'); template.innerHTML = renderUser(run); user = template.content.firstElementChild; messages.append(user); }
  const template = document.createElement('template'); template.innerHTML = renderAssistant(run); const next = template.content.firstElementChild;
  if (assistant && run.status === 'running' && syncLiveAssistant(assistant, next)) return;
  const disclosure = captureDisclosure(assistant);
  if (assistant) assistant.replaceWith(next); else messages.append(next);
  restoreDisclosure(next, disclosure, run.status === 'running');
  bindCopyButtons(next);
  if (disclosure.scrollY !== window.scrollY || disclosure.scrollX !== window.scrollX) window.scrollTo(disclosure.scrollX, disclosure.scrollY);
}
function render() { $('#welcome').hidden = state.runs.length > 0; for (const run of state.runs) renderRun(run); const valid = new Set(state.runs.map(run => run.id)); $('#messages').querySelectorAll('.message[data-run-id]').forEach(node => { if (!valid.has(node.dataset.runId)) node.remove(); }); const busy = Boolean(state.active) || state.sending; $('#send').disabled = busy; $('#stop').hidden = !state.active; $('#prompt').disabled = busy; if (!busy) $('#status').textContent = '从真实业务数据开始'; }
async function history() { const { conversations } = await api('/api/conversations'); $('#history').replaceChildren(...conversations.map(conversation => { const button = element('button', conversation.id === state.conversationId ? 'active' : '', conversation.title); button.title = conversation.title; button.onclick = () => openConversation(conversation.id).catch(notice); return button; })); }
function rememberConversation(id) { if (id) sessionStorage.setItem('data-agent-chat', id); else sessionStorage.removeItem('data-agent-chat'); }
function reset() { state.epoch++; clearTimeout(state.timer); state.conversationId = null; state.runs = []; state.active = null; state.cursor = 0; state.pendingMessage = null; rememberConversation(null); $('#human-loop').hidden = true; notice(null); render(); $('#prompt').value = ''; $('#prompt').focus(); void history().catch(notice); }
async function loadRun(run) { const snapshot = await api(`/api/runs/${encodeURIComponent(run.id)}?after=0`); return { ...snapshot.run, events: snapshot.events, humanLoop: snapshot.humanLoop, artifacts: snapshot.artifacts }; }
async function openConversation(id) { if (state.sending) return; const epoch = ++state.epoch; clearTimeout(state.timer); const conversation = await api(`/api/conversations/${encodeURIComponent(id)}`); if (state.epoch !== epoch) return; state.conversationId = id; rememberConversation(id); state.runs = await Promise.all(conversation.runs.map(run => loadRun(run))); state.active = [...state.runs].reverse().find(run => run.status === 'running')?.id ?? null; state.cursor = state.active ? (state.runs.find(run => run.id === state.active)?.events?.at(-1)?.seq || 0) : 0; $('#human-loop').hidden = true; render(); await history(); if (state.active) void poll(epoch); }
async function send(event) { event.preventDefault(); if (state.active || state.sending) return; const input = $('#prompt').value.trim(); if (!input) return; notice(null); state.sending = true; state.conversationId ??= crypto.randomUUID(); rememberConversation(state.conversationId); if (!state.pendingMessage || state.pendingMessage.input !== input || state.pendingMessage.conversationId !== state.conversationId) { try { state.modelKey = (await api('/api/config')).defaultModelKey; } catch (error) { state.sending = false; render(); notice(error); return; } state.pendingMessage = { requestId: crypto.randomUUID(), conversationId: state.conversationId, input, modelKey: state.modelKey }; } render(); try { const { run } = await api('/api/messages', state.pendingMessage); state.pendingMessage = null; state.runs.push({ ...run, events: [] }); state.active = run.status === 'running' ? run.id : null; state.cursor = 0; $('#prompt').value = ''; render(); await history(); if (state.active) void poll(state.epoch); } catch (error) { notice(error); } finally { state.sending = false; render(); } }
async function poll(epoch) { if (epoch !== state.epoch || !state.active) return; const id = state.active; try { const snapshot = await api(`/api/runs/${encodeURIComponent(id)}?after=${state.cursor}`); if (epoch !== state.epoch || state.active !== id) return; const index = state.runs.findIndex(run => run.id === id); if (index === -1) return; const prior = state.runs[index]; const events = [...(prior.events || []), ...snapshot.events]; const draft = [...events].reverse().find(event => typeof event.content === 'string' && event.content.trim())?.content ?? prior.draft; state.runs[index] = { ...snapshot.run, events, draft, humanLoop: snapshot.humanLoop, artifacts: snapshot.artifacts }; state.cursor = events.at(-1)?.seq ?? state.cursor; if (snapshot.run.status !== 'running') state.active = null; render(); const latest = [...snapshot.events].reverse().find(event => phases[event.type]); if (state.active && latest) $('#status').textContent = phases[latest.type]; renderHumanLoop(snapshot.humanLoop); if (!state.active) { await history(); $('#prompt').focus(); return; } } catch (error) { notice(error); } if (epoch === state.epoch && state.active) state.timer = setTimeout(() => { void poll(epoch); }, 1100); }
let displayedRequest = null;
function renderHumanLoop(request) { const root = $('#human-loop'); if (!request) { root.hidden = true; displayedRequest = null; return; } const identity = `${state.active}:${request.id}:${request.revision}`; if (displayedRequest === identity && !root.hidden) return; displayedRequest = identity; root.hidden = false; const form = element('form'); form.append(element('h3', '', request.title), element('p', '', request.prompt)); const schema = request.responseSchema; let value; if (schema.type === 'select') { const controls = schema.options.map(option => { const label = element('label'); const input = element('input'); input.type = schema.maxSelections === 1 ? 'radio' : 'checkbox'; input.name = 'choice'; input.value = option.id; label.append(input, document.createTextNode(` ${option.label}${option.description ? ` · ${option.description}` : ''}`)); form.append(label); return input; }); value = () => controls.filter(control => control.checked).map(control => control.value); } else if (schema.type === 'form') { const controls = schema.fields.map(field => { const label = element('label', '', field.label); const control = element(field.valueType === 'textarea' ? 'textarea' : 'input'); if (control.tagName === 'INPUT') control.type = ['number', 'date'].includes(field.valueType) ? field.valueType : 'text'; control.required = field.required; if (field.maxLength) control.maxLength = field.maxLength; label.append(control); form.append(label); return [field.id, control]; }); value = () => Object.fromEntries(controls.map(([id, control]) => [id, control.value])); } else { value = () => true; const reason = element('input'); reason.type = 'text'; reason.placeholder = '拒绝原因'; if (schema.requireReasonOnReject) form.append(reason); const reject = element('button', '', schema.rejectLabel); reject.type = 'button'; reject.onclick = () => { if (schema.requireReasonOnReject && !reason.value.trim()) { notice(new Error('请填写拒绝原因')); return; } void respond({ accepted: false, ...(reason.value.trim() ? { reason: reason.value } : {}) }); }; form.append(reject); } const submit = element('button', '', schema.type === 'confirm' ? schema.acceptLabel : '确认并继续'); submit.type = 'submit'; form.append(submit); const runId = state.active, epoch = state.epoch; async function respond(answer) { form.querySelectorAll('button').forEach(button => { button.disabled = true; }); try { await api(`/api/runs/${encodeURIComponent(runId)}/human-loop`, { requestId: request.id, revision: request.revision, value: answer }); if (epoch === state.epoch) { root.hidden = true; displayedRequest = null; notice(null); } } catch (error) { notice(error); form.querySelectorAll('button').forEach(button => { button.disabled = false; }); } } form.onsubmit = event => { event.preventDefault(); void respond(value()); }; root.replaceChildren(form); }
$('#composer').onsubmit = send; $('#prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#composer').requestSubmit(); } }; $('#new-chat').onclick = () => { if (!state.sending) reset(); }; $('#stop').onclick = async () => { if (state.active) { try { await api(`/api/runs/${encodeURIComponent(state.active)}/cancel`, {}); } catch (error) { notice(error); } } }; document.querySelectorAll('[data-question]').forEach(button => { button.onclick = () => { $('#prompt').value = button.dataset.question; $('#prompt').focus(); }; });
try { const config = await api('/api/config'); state.modelKey = config.defaultModelKey; void api('/api/sample-questions').then(({ questions }) => { if (!questions.length) return; $('.suggestions').replaceChildren(...questions.map(question => { const button = element('button', '', question); button.type = 'button'; button.onclick = () => { $('#prompt').value = question; $('#prompt').focus(); }; return button; })); }).catch(() => {}); const current = sessionStorage.getItem('data-agent-chat'); if (current) await openConversation(current); else await history(); } catch (error) { notice(error); }
