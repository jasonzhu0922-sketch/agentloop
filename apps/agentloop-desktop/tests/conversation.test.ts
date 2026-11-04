import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { createTurn, updateTurn, hasTerminalEvent, visibleToolCalls } = await import(new URL('../web/turn-projection.js', import.meta.url).href);
const { readRunUpdate } = await import(new URL('../web/run-polling.js', import.meta.url).href);
const { isNearBottom, nextScrollTop } = await import(new URL('../web/reference/ui/scroll-follow.js', import.meta.url).href);
const { shouldSubmitComposerOnKeydown, composerInputHeight } = await import(new URL('../web/reference/ui/composer-input.js', import.meta.url).href);
// Resolve the virtual /markdown.js asset to the exact same shared renderer as
// the HTTP host. These tests exercise production templates, not a test replica.
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../web/conversation.js', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'desktop-markdown-asset', setup(builder) {
  builder.onResolve({ filter: /^\.\/markdown\.js$/ }, () => ({ path: fileURLToPath(new URL('../../../packages/agentloop-artifact-preview/src/index.ts', import.meta.url)) }));
} }] });
const { renderUser, renderAssistant } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles![0]!.contents).toString('base64')}`);
const run = (status = 'running', output?: string) => ({ id: 'run-a', input: '提问', modelKey: 'local:test', status, output, createdAt: 1000, ...(status !== 'running' ? { finishedAt: 2300 } : {}) });
const event = (seq: number, type: string, data = {}) => ({ seq, type, data, createdAt: 1000 + seq });

test('cumulative public streaming replaces rather than duplicates text; replay is per Run and idempotent', () => {
  const turn = createTurn(run());
  updateTurn(turn, run(), [event(2, 'assistant.streaming', { content: '你好' }), event(1, 'assistant.streaming', { content: '你' })]);
  assert.equal(turn.text, '你好'); assert.equal(turn.lastSeq, 2);
  const revision = turn.revision; updateTurn(turn, run()); assert.equal(turn.revision, revision);
  updateTurn(turn, run(), [event(2, 'assistant.streaming', { content: 'duplicate' }), event(3, 'assistant.streaming', { content: 'internal-secret', responseVisibility: 'internal' })]);
  assert.equal(turn.text, '你好'); assert.equal(turn.events.length, 3);
  const other = createTurn({ ...run(), id: 'run-b' }); updateTurn(other, other.run, [event(1, 'assistant.streaming', { content: '另一轮' })]);
  assert.equal(other.text, '另一轮'); assert.equal(turn.lastSeq, 3);
});

test('complete event replay retains early Plan state beyond the diagnostic display limit', () => {
  const turn = createTurn(run());
  updateTurn(turn, run(), [event(1, 'plan.admitted', { steps: [{ id: 'step', objective: '检查', status: 'pending' }] }), event(2, 'plan.step.started', { stepId: 'step' }), ...Array.from({ length: 240 }, (_, index) => event(index + 3, 'model.requested'))]);
  updateTurn(turn, run('completed', '**完成**'), [event(243, 'plan.step.completed', { stepId: 'step' }), event(244, 'run.completed', { output: '**完成**' })]);
  assert.equal(turn.plan[0].status, 'completed'); assert.equal(turn.events.length, 244); assert.ok(hasTerminalEvent(turn));
  assert.equal(turn.text, '**完成**'); assert.equal(turn.reasoning, '');
  const html = renderAssistant(turn, { plan: true }); assert.match(html, /步骤 1\/1/); assert.match(html, /<strong>完成<\/strong>/); assert.doesNotMatch(html, /class="thinking"/);
});

test('durable terminal output is authoritative and a failed report is never rendered as success', () => {
  const turn = createTurn(run()); updateTurn(turn, run(), [event(1, 'assistant.streaming', { content: '草稿', reasoning: '临时思考' })]);
  updateTurn(turn, run('failed', '已持久化的失败总结'), [event(2, 'run.failed', { code: 'RUN_LIMIT_EXCEEDED', output: '已持久化的失败总结' })]);
  assert.equal(turn.text, ''); assert.equal(turn.reasoning, ''); assert.equal(turn.partialText, '已持久化的失败总结');
  const html = renderAssistant(turn); assert.match(html, /尚非成功交付/); assert.match(html, /已持久化的失败总结/); assert.doesNotMatch(html, /class="thinking"/);
  const empty = createTurn(run()); empty.text = 'interim'; updateTurn(empty, run('completed'));
  assert.equal(empty.text, ''); assert.match(renderAssistant(empty), /未返回文本内容/);
});

test('cancelled and interrupted Runs cannot leave active tool/Plan or successful delivery badges', () => {
  const turn = createTurn(run()); updateTurn(turn, run('cancelled'), [event(1, 'plan.admitted', { steps: [{ id: 'step', status: 'running' }] }), event(2, 'tool.dispatched', { toolCallId: 'call', toolName: 'read_file' }), event(3, 'run.cancelled')]);
  turn.artifacts = [{ id: 'file', name: 'partial.txt', role: 'final', bytes: 12 }];
  assert.equal(visibleToolCalls(turn.events, turn.status)[0].status, 'cancelled');
  const html = renderAssistant(turn, { plan: true }); assert.match(html, /已取消/); assert.match(html, /尚非成功交付/); assert.doesNotMatch(html, /step-dot running|任务已完成|class="thinking"/);
});

test('tool calls retain arguments, real result/error and sequence without manufacturing success', () => {
  const events = [event(1, 'tool.planned', { toolCallId: 'call', toolName: 'computer_run_command', arguments: { command: 'echo', args: ['hello'] } }), event(2, 'tool.dispatched', { toolCallId: 'call' }), event(3, 'tool.completed', { toolCallId: 'call', result: '{"exitCode":2}' }), event(4, 'tool.completed', { toolCallId: 'bad', toolName: 'read', isError: true })];
  const calls = visibleToolCalls(events, 'completed'); assert.equal(calls.length, 2); assert.equal(calls[0].arguments.command, 'echo'); assert.equal(calls[0].exitCode, 2); assert.equal(calls[1].status, 'failed');
});

test('terminal reconciliation clears stale waiting state and keeps every artifact visible', () => {
  const turn = createTurn(run()); updateTurn(turn, run(), [event(1, 'run.waiting_user', { request: { id: 'request', status: 'open' } })]);
  assert.match(renderAssistant(turn), /等待你的输入/);
  updateTurn(turn, run('completed', '完成')); assert.equal(turn.humanLoop, undefined);
  turn.artifacts = [{ id: 'final', name: 'final.txt', role: 'final', bytes: 1 }, { id: 'process', name: 'process.txt', role: 'process', bytes: 1 }];
  assert.match(renderAssistant(turn), /final.txt/); assert.match(renderAssistant(turn), /process.txt/);
  assert.doesNotMatch(renderAssistant(turn), /data-toggle="artifacts"/);
});

test('polling exposes artifacts before completion, even without new events, and reconciles final delivery', async () => {
  const turn = createTurn(run());
  const file = { id: 'report', name: 'report.html', role: 'process', bytes: 100, sha256: 'draft' };
  let artifacts: typeof file[] = []; let currentRun = run();
  let events = [event(1, 'tool.completed', { toolName: 'computer_write_file', result: '{"path":"report.html"}' })];
  const requests: string[] = [];
  const api = async (path: string) => {
    requests.push(path);
    if (path.includes('/events?')) return { events: [...events] };
    if (path.endsWith('/artifacts')) return { artifacts: artifacts.map(item => ({ ...item })) };
    return { run: currentRun };
  };
  const poll = async () => {
    const update = await readRunUpdate(api, turn);
    updateTurn(turn, update.run, update.events, update.artifacts);
  };
  await poll(); assert.doesNotMatch(renderAssistant(turn), /data-artifact-id=/);
  events = []; artifacts = [file]; await poll();
  assert.equal(turn.status, 'running'); assert.equal(turn.lastSeq, 1);
  assert.match(renderAssistant(turn), /data-artifact-id="report"/);
  assert.match(renderAssistant(turn), /阶段产物/); assert.doesNotMatch(renderAssistant(turn), /最终产物/);
  const revision = turn.revision; const previous = turn.artifacts;
  await poll(); assert.equal(turn.revision, revision); assert.equal(turn.artifacts, previous);
  artifacts = [{ ...file, bytes: 200, sha256: 'revised' }]; await poll();
  assert.equal(turn.revision, revision + 1); assert.match(renderAssistant(turn), /200 字节/);
  currentRun = run('completed'); events = [event(2, 'run.completed')];
  artifacts = [{ ...file, role: 'final' }, { ...file, id: 'draft', name: 'draft.html' }]; await poll();
  const html = renderAssistant(turn);
  assert.match(html, /最终产物/); assert.match(html, /draft.html/);
  assert.equal((html.match(/data-artifact-id="report"/g) || []).length, 1);
  assert.equal(requests.filter(path => path.endsWith('/artifacts')).length, 5);
});

test('polling drains a racing terminal commit and does not mutate a turn before its scope is checked', async () => {
  const turn = createTurn(run());
  const snapshot = JSON.stringify(turn); const paths: string[] = [];
  const update = await readRunUpdate(async (path: string) => {
    paths.push(path);
    if (path.endsWith('/events?afterSeq=0')) return { events: [event(1, 'tool.completed')] };
    if (path.endsWith('/events?afterSeq=1')) return { events: [event(2, 'run.failed')] };
    if (path.endsWith('/artifacts')) return { artifacts: [{ id: 'partial', name: 'partial.txt', role: 'process', bytes: 5 }] };
    return { run: run('failed') };
  }, turn);
  assert.equal(JSON.stringify(turn), snapshot, 'a stale response can be discarded without touching the old conversation');
  assert.equal(paths.length, 4);
  updateTurn(turn, update.run, update.events, update.artifacts);
  assert.ok(hasTerminalEvent(turn)); assert.equal(turn.lastSeq, 2);
  assert.match(renderAssistant(turn), /partial.txt/); assert.doesNotMatch(renderAssistant(turn), /最终产物/);
});

test('templates escape untrusted labels, streaming HTML and Markdown while preserving rich final output', () => {
  const dangerous = '<img src=x onerror=alert(1)>';
  const turn = createTurn({ ...run(), input: dangerous, modelKey: dangerous, sources: [{ originalName: dangerous }] });
  turn.text = dangerous; assert.doesNotMatch(renderUser(turn.run), /<img/); assert.doesNotMatch(renderAssistant(turn), /<img src=x/);
  updateTurn(turn, { ...turn.run, status: 'completed', output: '# 标题\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))' });
  const html = renderAssistant(turn); assert.match(html, /<h1>标题<\/h1>/); assert.match(html, /<table>/); assert.match(html, /language-js/); assert.doesNotMatch(html, /<script>|href="javascript:/);
});

test('scroll follow and composer shortcuts match Multi Runtime boundaries', () => {
  assert.ok(isNearBottom({ scrollTop: 670, scrollHeight: 1000, clientHeight: 300 }));
  assert.equal(isNearBottom({ scrollTop: 200, scrollHeight: 1000, clientHeight: 300 }), false);
  assert.equal(nextScrollTop({ scrollHeight: 2000, clientHeight: 300 }, false, 200), 200);
  assert.equal(nextScrollTop({ scrollHeight: 2000, clientHeight: 300 }, true, 200), 1700);
  assert.equal(shouldSubmitComposerOnKeydown({ key: 'Enter' }), false);
  assert.equal(shouldSubmitComposerOnKeydown({ key: 'Enter', metaKey: true, isComposing: true }), false);
  assert.ok(shouldSubmitComposerOnKeydown({ key: 'Enter', ctrlKey: true })); assert.equal(composerInputHeight(300, 24), 72);
});

test('pure presentation snapshots remain exactly aligned with Multi Runtime, not its transport', async () => {
  for (const file of ['presentation/assistant-message-presentation.js', 'projections/assistant-event-projection.js', 'projections/execution-detail-projection.js', 'ui/scroll-follow.js', 'ui/composer-input.js', 'ui/message-selection.js']) {
    const copied = await readFile(new URL(`../web/reference/${file}`, import.meta.url), 'utf8');
    const original = await readFile(new URL(`../../agentloop-multi-runtime/web/client/${file}`, import.meta.url), 'utf8');
    assert.equal(copied.slice(copied.indexOf('\n') + 1), original, file);
  }
});


test('artifact cards select the right artifact for preview instead of navigating to a download', () => {
  const turn = createTurn(run('completed'));
  turn.artifacts = [{ id: 'file"<unsafe>', name: '周报.html', role: 'final', bytes: 100 }];
  const html = renderAssistant(turn);
  assert.match(html, /<button type="button" class="desktop-artifact" data-artifact-id="file&quot;&lt;unsafe&gt;">/);
  assert.match(html, /· 预览/);
  assert.doesNotMatch(html, / download|\/download|· 下载/);
});
