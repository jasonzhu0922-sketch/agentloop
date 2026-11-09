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

test('process preserves ordered cumulative messages and tools, then collapses behind the durable final answer', () => {
  const turn = createTurn(run());
  const events = [event(1, 'assistant.streaming', { content: '开始' }), event(2, 'assistant.streaming', { content: '开始检查' }), event(3, 'assistant.committed', { content: '开始检查' }), event(4, 'tool.dispatched', { toolCallId: 'read', toolName: 'read_file' }), event(5, 'tool.completed', { toolCallId: 'read' }), event(6, 'assistant.streaming', { content: '发现问题' }), event(7, 'assistant.committed', { content: '发现问题' }), event(8, 'assistant.committed', { content: '内部内容', responseVisibility: 'internal' })];
  updateTurn(turn, run(), events);
  const live = renderAssistant(turn);
  assert.match(live, /data-toggle="process" aria-expanded="true"/);
  assert.ok(live.indexOf('开始检查') < live.indexOf('read_file') && live.indexOf('read_file') < live.indexOf('发现问题'));
  assert.equal((live.match(/开始检查/g) || []).length, 1);
  assert.doesNotMatch(live, /内部内容/);
  updateTurn(turn, run('completed', '**最终结果**'), [event(9, 'run.completed', { output: '**最终结果**' })]);
  const final = renderAssistant(turn);
  assert.match(final, /data-toggle="process" aria-expanded="false"/);
  assert.match(final, /class="execution-process" id="process-run-a" hidden/);
  assert.match(final, /<strong>最终结果<\/strong>/);
  assert.match(renderAssistant(turn, { process: true }), /class="execution-process" id="process-run-a">/);
  const replay = createTurn(run('completed', '**最终结果**'));
  updateTurn(replay, replay.run, [...events, event(9, 'run.completed', { output: '**最终结果**' })]);
  assert.equal(renderAssistant(replay), final);
});

test('readable progress and tool changes stay ordered while technical events update the footer', () => {
  const turn = createTurn(run());
  updateTurn(turn, run(), [event(1, 'assistant.streaming', { content: '先检查' }), event(2, 'tool.dispatched', { toolCallId: 'a', toolName: 'read_file' }), event(3, 'assistant.streaming', { content: '先检查再分析' }), event(4, 'model.request.started', { purpose: 'conversation_turn_resolver' }), event(5, 'tool.completed', { toolCallId: 'a' }), event(6, 'assistant.committed', { content: '先检查再分析' }), event(7, 'runtime.capability_snapshot.created')]);
  const html = renderAssistant(turn);
  const positions = ['先检查', '结果：执行中', '再分析', '正在理解本轮需求', '结果：已完成'].map(text => html.indexOf(text));
  assert.ok(positions.every(position => position >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.equal((html.match(/先检查/g) || []).length, 1);
  assert.equal((html.match(/再分析/g) || []).length, 1);
  assert.doesNotMatch(html.split('<div class="message-footer event-feedback">')[0], /capability_snapshot/);
  assert.match(html, /data-event-seq="7"[^>]*>[\s\S]*#7[\s\S]*runtime capability_snapshot created/);
});

test('consecutive progress events share one line and stay separated by visible content', () => {
  const turn = createTurn(run());
  const events = [event(1, 'model.request.started', { purpose: 'conversation_turn_resolver' }), event(2, 'runtime.capability_snapshot.created'), event(3, 'planning.started'), event(4, 'plan.admitted'), event(5, 'plan.step.started'), event(6, 'assistant.committed', { content: '开始检查' }), event(7, 'model.request.started'), event(8, 'model.request.started', { phase: 'assessment' }), event(9, 'tool.dispatched', { toolCallId: 'a', toolName: 'read_file' }), event(10, 'model.request.started')];
  updateTurn(turn, run(), events);
  const html = renderAssistant(turn);
  const progress = [...html.matchAll(/<div class="process-progress">([^<]*)<\/div>/g)].map(match => match[1]);
  assert.deepEqual(progress, ['正在执行当前步骤', '正在核验当前结果', '正在执行当前步骤']);
  assert.ok(html.indexOf(progress[0]!) < html.indexOf('开始检查'));
  assert.ok(html.indexOf('开始检查') < html.indexOf(progress[1]!) && html.indexOf(progress[1]!) < html.indexOf('read_file'));
  assert.equal(turn.events.length, events.length);
});

test('adjacent tool events form collapsed, expandable groups without crossing visible text', () => {
  const turn = createTurn(run());
  updateTurn(turn, run(), [event(1, 'tool.dispatched', { toolCallId: 'a', toolName: 'search' }), event(2, 'tool.dispatched', { toolCallId: 'b', toolName: 'read' }), event(3, 'runtime.capability_snapshot.created'), event(4, 'tool.completed', { toolCallId: 'a' }), event(5, 'assistant.committed', { content: '继续分析' }), event(6, 'tool.dispatched', { toolCallId: 'c', toolName: 'write' })]);
  const html = renderAssistant(turn);
  assert.equal((html.match(/class="process-tool-group"/g) || []).length, 2);
  assert.match(html, /data-tool-group="1"><summary>[\s\S]*?工具调用 · 2 次/);
  assert.match(html, /data-tool-group="6"><summary>/);
  assert.ok(html.indexOf('结果：已完成') < html.indexOf('继续分析'));
  assert.match(renderAssistant(turn, { tools: { 1: true } }), /data-tool-group="1" open>/);
});

test('accepted steer stays at its event position and remains visible when the process is collapsed', () => {
  const turn = createTurn(run());
  const accepted = { id: 'steer-1', seq: 1, text: '补充范围', status: 'accepted' };
  const decided = { ...accepted, status: 'answered', decision: { explanation: '已了解' } };
  updateTurn(turn, run(), [event(1, 'assistant.committed', { content: '先查询' }), event(2, 'run.input.accepted', { message: accepted }), event(3, 'assistant.committed', { content: '继续分析' }), event(4, 'run.input.decided', { message: decided })]);
  const html = renderAssistant(turn, { process: true });
  assert.ok(html.indexOf('先查询') < html.indexOf('补充范围') && html.indexOf('补充范围') < html.indexOf('继续分析'));
  assert.ok(html.indexOf('继续分析') < html.indexOf('已了解'), 'decision is shown when decided, not at acceptance');
  assert.match(html, /class="steer-message-bubble"><div class="steer-message-user">补充范围/);
  assert.match(html, /class="steer-message-decision">已了解/);
  assert.equal((html.match(/data-steer-message="steer-1"/g) || []).length, 1);
  assert.match(html, /已了解/);
  const collapsed = renderAssistant(turn, { process: false });
  assert.match(collapsed, /class="process-text" hidden>先查询/);
  assert.match(collapsed, /data-steer-message="steer-1"/);
  const pending = createTurn(run());
  updateTurn(pending, run(), [], undefined, undefined, undefined, [accepted]);
  assert.match(renderAssistant(pending), /data-steer-message="steer-1"/);
});

test('streaming text after an accepted steer appears after the user message without repeating its prefix', () => {
  const turn = createTurn(run());
  const message = { id: 's', seq: 1, text: '补充问题', status: 'accepted' };
  updateTurn(turn, run(), [event(1, 'assistant.streaming', { content: '先处理' }), event(2, 'run.input.accepted', { message }), event(3, 'assistant.streaming', { content: '先处理再继续' })]);
  const html = renderAssistant(turn);
  assert.ok(html.indexOf('先处理') < html.indexOf('补充问题') && html.indexOf('补充问题') < html.indexOf('再继续'));
  assert.equal((html.match(/先处理/g) || []).length, 1);
});

test('routine execution updates between tool calls stay inside one ordered group', () => {
  const turn = createTurn(run());
  updateTurn(turn, run(), [event(1, 'assistant.committed', { content: '先检查资料' }), event(2, 'tool.completed', { toolCallId: 'a', toolName: 'read_file' }), event(3, 'model.request.started', { phase: 'execution' }), event(4, 'tool.completed', { toolCallId: 'b', toolName: 'read_result' }), event(5, 'model.request.started', { phase: 'execution' }), event(6, 'tool.completed', { toolCallId: 'c', toolName: 'write_file' }), event(7, 'assistant.committed', { content: '检查完成' }), event(8, 'tool.completed', { toolCallId: 'd', toolName: 'search' }), event(9, 'model.request.started', { phase: 'assessment' }), event(10, 'tool.completed', { toolCallId: 'e', toolName: 'read_file' })]);
  const html = renderAssistant(turn);
  assert.equal((html.match(/class="process-tool-group"/g) || []).length, 3);
  assert.match(html, /工具调用 · 3 次/);
  const first = html.slice(html.indexOf('data-tool-group="2"'), html.indexOf('检查完成'));
  assert.ok(first.indexOf('read_file') < first.indexOf('正在执行当前步骤') && first.indexOf('正在执行当前步骤') < first.indexOf('read_result'));
  assert.match(html, /正在核验当前结果/);
  assert.equal(turn.events.length, 10);
});

test('protocol-shaped model text remains inspectable as model output rather than a tool call', () => {
  const turn = createTurn(run());
  updateTurn(turn, run(), [event(1, 'assistant.streaming', { content: '<｜DSML｜ parameter name="tool_call_id">call_123</tool_call_id>\n<tool_response>示例</tool_response>' })]);
  const html = renderAssistant(turn);
  assert.match(html, /<details class="process-protocol" data-protocol-seq="1"><summary>模型输出包含工具协议文本/);
  assert.match(html, /&lt;tool_response&gt;示例&lt;\/tool_response&gt;/);
  assert.doesNotMatch(html, /class="process-tool-group"/);
  assert.match(renderAssistant(turn, { protocol: { 1: true } }), /data-protocol-seq="1" open/);
  const normal = createTurn(run()); updateTurn(normal, run(), [event(1, 'assistant.streaming', { content: '工具协议可以用于调用。' })]);
  assert.match(renderAssistant(normal), /class="process-text">工具协议可以用于调用/);
});

test('assistant cards identify the Runtime that handled the Run', () => {
  const turn = createTurn({ ...run(), runtimeId: 'runtime-a', runtimeName: '写作 Runtime' });
  assert.match(renderAssistant(turn), /execution-provenance-chip runtime">写作 Runtime<\/span>/);
});

test('plan steps appear beside goal rounds and remain available without round history', () => {
  const turn = createTurn(run());
  turn.plan = [{ id: 'step', objective: '分析', status: 'running' }];
  turn.rounds = [{ roundNumber: 1 }];
  const html = renderAssistant(turn, { plan: true, roundHistory: true });
  assert.doesNotMatch(html.split('<div class="execution-process"')[0], /data-toggle="plan"/);
  assert.match(html, /class="planning-overview-head"><details class="round-history" open>[\s\S]*?<\/details><button class="live-step-toggle"/);
  assert.match(html, /class="inline-plan-steps"/);
  turn.rounds = [];
  assert.match(renderAssistant(turn), /class="planning-overview-head"><button class="live-step-toggle"/);
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

test('interrupted safe model streams render a recovery wait instead of a terminal failure', () => {
  const turn = createTurn(run());
  updateTurn(turn, run(), [event(1, 'run.recovery_required', {
    actionId: 'recovery-action', reason: 'model_stream_interrupted',
  })]);
  assert.equal(turn.recovery?.status, 'required');
  assert.match(renderAssistant(turn), /模型流中断，当前步骤已保留，等待恢复决策/);
  assert.doesNotMatch(renderAssistant(turn), /本次未能形成可提交的最终结果/);
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

test('many stage artifacts remain accessible in their own bounded list', async () => {
  const turn = createTurn(run('completed'));
  turn.artifacts = Array.from({ length: 20 }, (_, index) => ({ id: `file-${index}`, name: `file-${index}.txt`, role: 'process', bytes: 1 }));
  const html = renderAssistant(turn);
  assert.match(html, /class="desktop-artifact-list stage-artifact-list" role="region" aria-label="阶段产物列表" tabindex="0"/);
  assert.equal((html.match(/class="desktop-artifact-row"/g) || []).length, 20);
  assert.match(html, /20 个文件/);
  const css = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.stage-artifact-list\s*\{[^}]*max-height:\s*200px;[^}]*overflow-y:\s*auto/s);
});

test('polling retains artifacts during execution and shows them on completion', async () => {
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
  assert.doesNotMatch(renderAssistant(turn), /data-artifact-id="report"|本轮产物/);
  const revision = turn.revision; const previous = turn.artifacts;
  await poll(); assert.equal(turn.revision, revision); assert.equal(turn.artifacts, previous);
  artifacts = [{ ...file, bytes: 200, sha256: 'revised' }]; await poll();
  assert.equal(turn.revision, revision + 1); assert.doesNotMatch(renderAssistant(turn), /200 字节/);
  currentRun = run('completed'); events = [event(2, 'run.completed')];
  artifacts = [{ ...file, role: 'final' }, { ...file, id: 'draft', name: 'draft.html' }]; await poll();
  const html = renderAssistant(turn);
  assert.match(html, /最终产物/); assert.match(html, /draft.html/);
  assert.equal((html.match(/data-artifact-id="report"/g) || []).length, 1);
  assert.equal(requests.filter(path => path.endsWith('/artifacts')).length, 5);
});

test('failed and cancelled runs expose retained artifacts without claiming delivery', () => {
  for (const state of ['failed', 'cancelled']) {
    const turn = createTurn(run(state));
    turn.artifacts = [{ id: 'partial', name: 'partial.txt', role: 'process', bytes: 5 }];
    const html = renderAssistant(turn);
    assert.match(html, /partial.txt/);
    assert.match(html, /尚非成功交付/);
    assert.doesNotMatch(html, /最终产物/);
  }
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
  assert.equal(paths.length, 6);
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
  for (const file of ['presentation/assistant-message-presentation.js', 'projections/assistant-event-projection.js', 'projections/execution-detail-projection.js', 'ui/scroll-follow.js', 'ui/composer-input.js', 'ui/message-selection.js', 'ui/steer-queue.js']) {
    const copied = await readFile(new URL(`../web/reference/${file}`, import.meta.url), 'utf8');
    const original = await readFile(new URL(`../../agentloop-multi-runtime/web/client/${file}`, import.meta.url), 'utf8');
    assert.equal(copied.slice(copied.indexOf('\n') + 1), original, file);
  }
});


test('artifact cards offer independent preview and scoped download actions', () => {
  const turn = createTurn(run('completed'));
  turn.artifacts = [{ id: 'file"<unsafe>', name: '周报.html', role: 'final', bytes: 100 }];
  const html = renderAssistant(turn);
  assert.match(html, /<button type="button" class="desktop-artifact" data-artifact-id="file&quot;&lt;unsafe&gt;">/);
  assert.match(html, /· 预览/);
  assert.match(html, /href="\/api\/runs\/run-a\/artifacts\/file%22%3Cunsafe%3E\/download\?runtimeId=desktop-default" download="周报.html"/);
  assert.match(html, /aria-label="下载 周报.html"/);
  turn.run.runtimeId = 'runtime-a';
  assert.match(renderAssistant(turn), /download\?runtimeId=runtime-a/);
  assert.match(html, /^<article class="msg assistant [^"]+" data-assistant-message="run-a">/);
  assert.doesNotMatch(html, /aria-label="查看该轮执行详情"|aria-pressed=/);
});

test('only artifact buttons bind the conversation preview action', async () => {
  const source = await readFile(new URL('../web/conversation.js', import.meta.url), 'utf8');
  assert.match(source, /button\.onclick = \(\) => onArtifact\(turn\.id, button\.dataset\.artifactId\)/);
  assert.doesNotMatch(source, /card\.(?:onclick|onkeydown)\s*=/);
});
