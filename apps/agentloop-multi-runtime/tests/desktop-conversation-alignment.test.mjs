import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { renderProcess, visibleToolCalls } from '../../../packages/agentloop-conversation-ui/process.js';
import { renderHumanLoop as renderInlineHumanLoop } from '../../../packages/agentloop-conversation-ui/human-loop.js';
import { liveProgressForEvent, replayAssistantEvents } from '../web/client/projections/assistant-event-projection.js';
import { assistantMessagePresentation, completedArtifactSummary } from '../web/client/presentation/assistant-message-presentation.js';
import { isExecutionLogArtifact, isFinalDeliveryArtifact, artifactVerificationLabel } from '../web/client/presentation/artifact-display.js';

const source = await readFile(new URL('../web/client/app.js', import.meta.url), 'utf8');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const code = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const view = runInNewContext(`${code('function planStepLabel(', 'function formatDuration(ms)')}
${code('function eventTypeLabel(', 'function renderMessageFooter(')}
${code('function renderMessage(', '\nasync function copyConversationMessage')}
${code('function renderHumanLoop(message)', '\nasync function startFromCheckpoint')}
renderMessage`, {
  renderProcess, liveProgressForEvent, assistantMessagePresentation, completedArtifactSummary,
  isExecutionLogArtifact, isFinalDeliveryArtifact, artifactVerificationLabel,
  activeConversation: () => undefined, selectedAssistantMessage: () => undefined,
  projectPlanStatuses: plan => plan, executionProvenanceParts: () => [], availableModels: [],
  formatMessageTime: () => '', formatConversationDuration: () => '',
  escapeHtml, formatText: escapeHtml, renderMarkdown: text => `<p>${escapeHtml(text)}</p>`,
  formatBytes: bytes => `${bytes} B`, renderInlineHumanLoop,
});
const event = (seq, type, data = {}) => ({ seq, type, data, createdAt: seq });
const message = (extra = {}) => ({ id: 'turn', role: 'assistant', status: 'running', text: '', plan: [], events: [], ...extra });

test('Multi Runtime uses Desktop ordered process, one row per call and chronological steer', () => {
  const events = [
    event(1, 'assistant.streaming', { content: '先检查' }),
    event(2, 'assistant.committed', { content: '先检查资料' }),
    event(3, 'tool.planned', { toolCallId: 'call', toolName: 'read_file', arguments: { path: '<report>' } }),
    event(4, 'tool.dispatched', { toolCallId: 'call' }),
    event(5, 'tool.completed', { toolCallId: 'call', result: '检查结果' }),
    event(6, 'run.input.accepted', { message: { id: 'steer', text: '请保留原文', status: 'accepted' } }),
    event(7, 'assistant.committed', { content: '继续整理' }),
    event(8, 'assistant.committed', { content: '内部评估秘密', responseVisibility: 'internal' }),
  ];
  const html = view(message({ text: '继续整理', detailEvents: events }));
  assert.ok(html.indexOf('先检查资料') < html.indexOf('read_file'));
  assert.ok(html.indexOf('read_file') < html.indexOf('请保留原文'));
  assert.ok(html.indexOf('请保留原文') < html.indexOf('继续整理'));
  assert.equal(html.split('data-tool-call="call"').length - 1, 1);
  assert.match(html, /data-tool-call="call"><summary>/);
  assert.match(html, /&lt;report&gt;/);
  assert.doesNotMatch(html, /内部评估秘密|class="live-output-text|role="button"|查看该轮执行详情/);
});

test('terminal answer collapses process and shows three files, final first, with retained stage files', () => {
  const artifacts = Array.from({ length: 6 }, (_, i) => ({ id: `f${i}`, name: `f${i}.txt`, bytes: i, role: i === 4 ? 'final' : 'process', verification: { delivery: i === 4 ? 'committed' : 'uncommitted' } }));
  const turn = message({ status: 'completed', text: '最终回答', artifacts, detailEvents: [event(1, 'assistant.committed', { content: '处理过程' })] });
  const html = view(turn);
  assert.match(html, /data-process-toggle="turn" aria-expanded="false"/);
  assert.match(html, /class="process-text" hidden/);
  assert.equal(html.split('最终回答').length - 1, 1);
  assert.deepEqual([...html.matchAll(/data-artifact-card="([^"]+)"/g)].map(match => match[1]), ['f4', 'f0', 'f1']);
  assert.match(html, /展开其余 3 个文件/);
  assert.equal([...view({ ...turn, artifactsExpanded: true }).matchAll(/data-artifact-card=/g)].length, 6);
  assert.doesNotMatch(view({ ...turn, status: 'running' }), /data-artifact-card=/);
  for (const status of ['failed', 'cancelled']) {
    const stopped = view({ ...turn, status });
    assert.match(stopped, /尚非成功交付/);
    assert.doesNotMatch(stopped, /<span>最终产物<\/span>|class="artifact-role final">已交付/);
  }
});

test('HIL is inline in its own assistant turn and requires explicit choice and rejection reason', () => {
  const html = view(message({ humanLoop: { id: 'question', revision: 3, status: 'open', title: '请确认', prompt: '是否继续', rationale: '需要授权', responseSchema: { type: 'confirm', acceptLabel: '同意', rejectLabel: '拒绝', requireReasonOnReject: true } } }));
  assert.match(html, /<form class="human-loop"/);
  assert.match(html, /data-request-revision="3"/);
  assert.match(html, /拒绝时必填/);
  assert.doesNotMatch(html, / checked|role="dialog"|human-loop-panel/);
});

test('history replay restores all event positions and Plan state beyond bounded browser cache', async () => {
  const events = [event(1, 'plan.admitted', { steps: [{ id: 'first', objective: '检查源文件', status: 'pending' }] }), event(2, 'plan.step.started', { stepId: 'first' }), event(3, 'assistant.committed', { content: '早期文字' }), ...Array.from({ length: 240 }, (_, i) => event(i + 4, 'model.request.started', { phase: 'execution' })), event(244, 'plan.step.completed', { stepId: 'first' }), event(245, 'run.completed', { output: '持久化回答' })];
  const replay = runInNewContext(`(${code('async function replayPersistedRunEvents(', '\nasync function hydrateCommandEvidence').trim()})`, {
    api: '/api', fetch: async url => { assert.equal(url, '/api/v1/assignments/assignment/events?afterSeq=0'); return { ok: true, json: async () => ({ events }) }; },
    replayAssistantEvents, completeAssistantMessage: () => {},
    setVolatile: (target, key, value) => Object.defineProperty(target, key, { value, configurable: true, writable: true }),
    mergeDetailEvents: (current = [], incoming = []) => [...new Map([...current, ...incoming].map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq),
  });
  const turn = message({ assignmentId: 'assignment' });
  assert.equal(await replay(turn, 'tenant', 'user'), true);
  assert.equal(turn.events.length, 160);
  assert.equal(turn.detailEvents.length, 245);
  assert.equal(turn.plan[0].status, 'completed');
  assert.equal(turn.status, 'completed');
  assert.equal(turn.text, '持久化回答');
  assert.match(view(turn), /早期文字/);
});

test('internal model responses never replace user-facing state or reasoning', () => {
  const turn = message({ text: '公开内容', reasoning: '公开思考' });
  replayAssistantEvents(turn, [event(1, 'assistant.streaming', { content: '内部内容', reasoning: '内部思考', responseVisibility: 'internal' })]);
  assert.equal(turn.text, '公开内容'); assert.equal(turn.reasoning, '公开思考');
  assert.equal(visibleToolCalls([event(1, 'tool.dispatched', { toolCallId: 'call' })], 'cancelled')[0].status, 'cancelled');
});
