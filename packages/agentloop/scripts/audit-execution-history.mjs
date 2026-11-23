// Controlled, interleaved live A/B. Never edits provider config or real tool data.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ContextAssembler } from '../src/runtime/context-assembler.ts';
import { deriveCurrentDecisionView } from '../src/runtime/current-decision-view.ts';
import { OpenAICompatibleModel } from '../src/runtime/models.ts';
import { encodeOpenAICompatiblePrompt } from '../src/runtime/prompt-protocol.ts';

const output = process.env.CONTEXT_AUDIT_OUTPUT || fileURLToPath(new URL('../../../outputs/context-projection-audit/live/', import.meta.url));
const configPath = process.env.DATA_AGENT_MODEL_CONFIG || '/Users/zhujun/coding/data-agent/config/llm-providers.json';
const source = await readFile(configPath, 'utf8');
const config = JSON.parse(source);
const modelKey = process.env.CONTEXT_AUDIT_MODEL || 'model-3eba18f1';
const selected = config.models[modelKey];
const provider = config.providers[selected.providerKey];
const apiKey = provider.apiKey || process.env[provider.apiKeyEnv];
if (!apiKey) throw new Error('Configured model credential unavailable');
await mkdir(output, { recursive: true });
const parameters = { temperature: 0, reasoningEffort: 'none', chatTemplateKwargs: { thinking: false, effort: 'none' }, maxOutputTokens: 4096 };
const model = new OpenAICompatibleModel({ baseUrl: provider.baseUrl, apiKey, model: selected.providerModel,
  contextWindowTokens: 128000, ...parameters, maxAttempts: 1, timeoutMs: 90000 });
const system = '你是执行助手。依据当前用户要求和工具回执推进；不要假定历史 assistant 判断已经证实。工具阶段优先直接调用，参数完整。完成后交付用户要求的全部内容。不得重复已成功完成的动作，不得把失败、未知效果、截断或缺失数据当作成功。所有工具都是本次受控测试的只读模拟工具。';
const tools = [{ name: 'inspect_document', description: '只读检查指定版本的文档事实；版本不符时返回当前版本。', inputSchema: {
  type: 'object', properties: { path: { type: 'string' }, revision: { type: 'string' } }, required: ['path', 'revision'], additionalProperties: false,
} }];
const facts = { ok: true, revision: 'v7', source: 'fixture://quality-report', date: '2026-11-22',
  rows: [{ label: '甲', amount: 42, unit: '万元' }, { label: '乙', amount: 18, unit: '万元' }],
  total: 60, excluded: '丙未取得数据，不能按零计入', limits: '只有一天快照，不支持趋势推断' };
const error = { ok: false, code: 'REVISION_CONFLICT', currentRevision: 'v7', reason: '请以当前版本 v7 读取原路径，其他参数不变。没有取得文档事实。' };
const runId = 'controlled-history-audit';
const basis = { identity: deriveCurrentDecisionView({ runId }).identity, toolEffects: { inspect_document: 'read' } };
const scenarios = ['short', 'long-recovery', 'detailed-delivery'];
function fixture(scenario) {
  const user = scenario === 'detailed-delivery'
    ? '请先检查 report.json 的当前版本 v7，交付一份详细核查报告，必须分别包含：范围和来源、逐项数据表、合计与算式、缺失数据处理、结论、局限与下一步。日期和单位不得省略，不要只给摘要。'
    : '请检查 report.json 的当前版本 v7，告诉我甲、乙各自金额和合计，保留日期、万元单位与来源，并说明丙的缺失和不能推断趋势。';
  const messages = [{ role: 'user', content: user }];
  if (scenario === 'long-recovery') for (let index = 0; index < 6; index++) {
    const id = `history-${index}`;
    messages.push({ role: 'assistant', content: 'I should inspect the previous report and think carefully about its revision before continuing. I need to compare previous observations and reconsider the next action. '.repeat(7)
      + '承诺保留全部金额与单位；假设旧版本仍可用，尚未验证。', toolCalls: [{ id, name: 'inspect_document', arguments: { path: 'report.json', revision: 'v2' } }], executionHistoryBasis: basis });
    messages.push({ role: 'tool', name: 'inspect_document', toolCallId: id, content: JSON.stringify(error), isError: true,
      executionOutcome: { invocationStatus: 'completed', operationStatus: 'failed' } });
  }
  return messages;
}
function grade(text, scenario) {
  const checks = { amounts: ['42', '18', '60'].every(value => text.includes(value)), date: text.includes('2026-11-22') || text.includes('2026年11月22日'),
    unit: text.includes('万元'), source: text.includes('fixture://quality-report'), missing: text.includes('丙') && /缺失|未取得|缺少|未知|未提供|未获取/.test(text),
    limitation: text.includes('趋势') && /不|仅|只有/.test(text) };
  if (scenario === 'detailed-delivery') Object.assign(checks, { table: text.includes('|'), arithmetic: /42\s*(?:万元)?\s*[+＋]\s*18/.test(text),
    scope: /范围/.test(text), conclusion: /结论/.test(text), next: /下一步|后续/.test(text) });
  return checks;
}
const report = { schema: 'agentloop.contextAB/v1', startedAt: new Date().toISOString(), modelKey,
  providerModel: selected.providerModel, parameters, configSha256: createHash('sha256').update(source).digest('hex'),
  routing: '混合路由、上游身份未知', design: '5 pairs per scenario; alternating AB/BA; same model, user, system, tool schemas/data; only executionHistoryProjection differs',
  limitations: ['Controlled simulated read tools; not production task success.', 'Deterministic rubric is necessary coverage, not independent semantic review.', 'No upstream hardware attribution.'], results: [] };
report.sourceHashes = Object.fromEntries(await Promise.all(['./audit-execution-history.mjs', '../src/runtime/execution-history-projection.ts', '../src/runtime/context-assembler.ts', '../src/runtime/prompt-protocol.ts', '../src/runtime/models.ts']
  .map(async path => [path, createHash('sha256').update(await readFile(new URL(path, import.meta.url))).digest('hex')])));
let interrupted = false;
const controller = new AbortController();
process.on('SIGINT', () => { interrupted = true; controller.abort(); });
const persist = () => writeFile(`${output}/results.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
await persist();
for (const scenario of scenarios) for (let pair = 1; pair <= 5; pair++) {
  for (const strategy of pair % 2 ? ['canonical', 'current'] : ['current', 'canonical']) {
    if (interrupted) break;
    const sample = { scenario, pair, strategy, status: 'running', requests: [], responses: [], events: [], toolCalls: [],
      processCharacters: 0, inputTokens: 0, outputTokens: 0, modelMilliseconds: 0, repeatFailures: 0, duplicateSuccessfulCalls: 0 };
    report.results.push(sample);
    const started = Date.now();
    const messages = fixture(scenario);
    sample.canonicalInput = structuredClone(messages);
    const assembly = new ContextAssembler({ runId, systemPrompt: system, runtimeContext: { phase: 'execution', content: JSON.stringify({ currentRevision: 'v7', outstanding: 'inspect current document, then deliver complete requested report', hypothesesAreUnverified: true }) },
      model, policy: { executionHistoryProjection: strategy }, emit: event => { sample.events.push(event); } });
    let successfulCalls = 0;
    try {
      for (let turn = 0; turn < 5; turn++) {
        const context = await assembly.assemble(messages, tools, controller.signal);
        const invocation = { runId, phase: 'execution', systemPrompt: system, messages: context.messages, runtimeContext: context.runtimeContext, tools, maxOutputTokens: parameters.maxOutputTokens };
        sample.requests.push({ ...invocation, wirePrompt: encodeOpenAICompatiblePrompt(invocation, 'system') });
        await persist();
        const before = Date.now();
        const response = await model.complete(invocation, controller.signal);
        sample.modelMilliseconds += Date.now() - before;
        sample.responses.push(response);
        sample.inputTokens += response.usage?.inputTokens ?? 0;
        sample.outputTokens += response.usage?.outputTokens ?? 0;
        if (response.toolCalls.length) sample.processCharacters += response.content.length;
        if (response.finishReason === 'length') { sample.status = 'truncated'; break; }
        if (!response.toolCalls.length) {
          sample.final = response.content;
          sample.checks = grade(response.content, scenario);
          sample.status = response.finishReason === 'stop' && successfulCalls > 0 && Object.values(sample.checks).every(Boolean)
            && sample.duplicateSuccessfulCalls === 0 ? 'success' : 'failed-delivery';
          break;
        }
        messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls, executionHistoryBasis: basis,
          ...(response.reasoningContent === undefined ? {} : { reasoningContent: response.reasoningContent }) });
        for (const call of response.toolCalls) {
          const correct = call.name === 'inspect_document' && call.arguments?.path === 'report.json' && call.arguments?.revision === 'v7';
          sample.toolCalls.push({ ...call, correct });
          if (correct) { successfulCalls++; if (successfulCalls > 1) sample.duplicateSuccessfulCalls++; }
          else sample.repeatFailures++;
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(correct ? facts : error), isError: !correct,
            executionOutcome: { invocationStatus: 'completed', operationStatus: correct ? 'succeeded' : 'failed' } });
        }
        await persist();
      }
      if (sample.status === 'running') sample.status = 'turn-limit';
    } catch (error) {
      sample.status = interrupted ? 'cancelled' : 'error';
      sample.error = { name: error.name, message: error.message, details: error.details };
    }
    sample.totalMilliseconds = Date.now() - started;
    sample.totalModelCalls = sample.responses.length;
    sample.finalTranscript = messages;
    await persist();
    console.log(JSON.stringify({ scenario, pair, strategy, status: sample.status, calls: sample.totalModelCalls, repeatFailures: sample.repeatFailures, milliseconds: sample.totalMilliseconds }));
  }
}
report.finishedAt = new Date().toISOString();
report.configUnchanged = source === await readFile(configPath, 'utf8');
report.cancelled = interrupted;
await persist();
