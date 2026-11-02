import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { ModelAdapter } from '@zhujun/agentloop';
import { startDesktop } from '../../src/application.ts';
import { greetingModel, modelPort } from '../../../../packages/agentloop-local-runtime/tests/fixtures/models.ts';

// Manual browser QA only: a clearly labelled deterministic model, real Kernel
// and isolated temporary DB. No provider credentials or external requests.
const base = greetingModel();
const output = '# 对话流验收（确定性测试模型）\n\n这条回复由本机 Kernel 执行，**不是真实模型验收**。\n\n## 展示细节\n\n- 实时正文与事件序号\n- 可折叠的执行计划\n- 历史记录、复制与时间信息\n\n| 能力 | 状态 |\n| --- | --- |\n| Markdown | 已渲染 |\n| 本机持久化 | 已执行 |\n\n```ts\nconst runtime = "local";\n```\n\n' + Array.from({ length: 12 }, (_, index) => `段落 ${index + 1}：这是一段用于检查长回复滚动与历史阅读位置的测试内容。`).join('\n\n');
const model: ModelAdapter = { ...base,
  async streamComplete(input, sink, signal) {
    const response = await base.complete(input, signal);
    if (response.toolCalls.length) return response;
    for (const text of output.match(/.{1,35}|\n/g) || []) {
      await setTimeout(250, undefined, { signal }); await sink({ type: 'text_delta', text });
    }
    return { ...response, content: output };
  },
};
const root = await mkdtemp(join(tmpdir(), 'agentloop-conversation-preview-')); const skills = join(root, 'skills'); await mkdir(skills);
const app = await startDesktop({ mode: 'development', dataDirectory: join(root, 'data'), models: modelPort(model), bundledSkillDirectories: [skills], openBrowser: false });
console.log(JSON.stringify({ fixture: true, origin: app.origin, directory: root }));
if (!app.existing) for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void app.close().then(() => process.exit(0)).catch(() => console.error('fixture_has_active_run')); });
