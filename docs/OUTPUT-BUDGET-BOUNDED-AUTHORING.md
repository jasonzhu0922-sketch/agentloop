# 输出预算与分块续写

## 问题与契约

模型必须先生成完整的工具调用参数，Runtime 才能校验、提交和执行。输出在原生工具调用 JSON 中途终止时，未完成的调用不能执行，也不能按任意字节切片后直接写文件。

本次修改让模型在每轮调用前获得与实际输出上限一致的内容预算，使用完整的小调用逐次提交。成功回执决定已完成部分；截断且未执行的参数不贡献文件内容。文件写入成功仍需经过内容校验、Assessment 和正式交付。

## 实现

- 工具通过 `RuntimeTool.boundedContent` 声明内容字段、目标字段和续写语义；Runtime 不根据工具名、扩展名或报告业务推断这些规则。
- `toolContentBudget` 按实际调用的 `maxOutputTokens` 计算预算，默认内容份额为 25%。16384 的普通执行轮将内容上限收紧到 4096 字符，同时检查整个参数 JSON 的估算 token 数。字符上限与 token 上限是两个条件，不是等价单位。
- 工具定义的静态上限继续生效；每轮投影只能收紧它。工具可见性、权限和授权范围沿用现有机制。
- 超预算参数在工具解析和文件副作用之前拒绝；普通调用和流式就绪调用共用该校验。
- 同一轮、同一工具与同一目标只准备一个有界内容调用，下一块等待上一块回执。新文件使用 `create`，后续使用 `append`。
- 每次 `finishReason=length` 后缩小后续块预算。连续三次没有成功工具写入进展的截断停止重试，改变调用参数或不发出工具调用不能重置计数。成功进展可清除连续失败计数，但保留已缩小的预算。
- `loop.output_budget.updated` 是恢复预算状态的持久化权威，先于截断轮的 `assistant.committed` 落盘。RunService 恢复时将其交回 AgentLoop，不从不完整参数重建写入进度。
- `runtime_bounded_authoring` 上下文保留最多八个目标的成功写入回执，包括路径、字节数、版本、哈希、原有 ResultRef 和文件末尾 800 字符。该上下文与普通修复指令分别维护。
- `append` 原样连接内容，不插入换行或分隔符。模型必须显式保留边界字符；工具返回实际文件尾部供下一轮核对。
- 流式返回中已完成并提交的工具调用保留真实效果；截断的尾部调用不执行、不作为原生成功交换重放。

## 验证记录：2026-11-13

### 源码与构建

定向检查共 70 项通过：分块续写、预算拒绝、流式执行、恢复、ResultRef、原有截断行为和交付链。新增分块测试 8 项全部通过，包含预算事件先于截断检查点的顺序断言。

```sh
node --experimental-strip-types --test packages/agentloop/tests/bounded-authoring.test.ts
npm run build:kernel
npm run build:local-runtime
npm run build:desktop
git diff --check
```

kernel、local-runtime、Desktop 构建及差异检查通过。

扩展检查 `agent-loop.test.ts`、`context-assembler.test.ts`、`computer-tools.test.ts` 为 246/254；关闭新增预算策略的控制副本也复现相同 8 项失败，不能据此宣称全套测试通过。日志保留在 `/tmp/agentloop-bounded-authoring-regression.log` 和 `/tmp/agentloop-bounded-authoring-control.log`。

### 开发版重启

实际开发 Desktop 数据目录为 `/tmp/agentloop-desktop-goal-loop`。16:51（北京时间）检查三个账户运行数据库中没有活动 Run 后，旧进程 45143 正常退出，新进程 46535 就绪；实例身份从 `b6146132-55c8-4de6-9108-7a549520451b` 变为 `6d6b13af-f7c7-416b-9357-b38f3a07ee1d`。这是该次开发版重启证据，不代表发行包或原生安装升级。收尾读取实例锁时已是后续进程 47905、实例 `080c6be9-06ea-4481-80df-ccec2b1bb67e`，因此不能把 46535 表述为当前进程；本次未再次中断后续实例。

### 真实模型长报告：通过

- 隔离 Desktop 数据目录、测试认证身份，使用实际已配置的 `deepseek-v4.1-flash`，保留 `maxOutputTokens=16384`。
- Run：`d6d450f9-abf3-4795-a657-2216c938890e`，正式终态 `run.completed`，有 `candidate.approved` 和 `terminal.delivery_committed`。
- 文件：`bounded-report.md`，12,553 字符，30,477 字节；12 章按顺序唯一出现，各章正文均超过 500 字符。
- 15 次目标文件写入：1 次 `create`、14 次 `append`；每次均符合当轮投影预算。收尾轮输出上限较小，因此其中若干块的内容上限为 1024。
- 一次超预算调用在写入之前被拒绝，随后模型改用小块继续。后续一次有 14 个 hunk 的标准文件编辑修正标题边界的换行，再次验证后交付。
- 逐次重放持久化参数，检查每次写入及补丁前后哈希，精确重建最终文件；工作区版本和下载交付物一致，保留所有原有 ResultRef。
- 最终 SHA-256：`fb3d6d26fdc09f53225dd30c08728a3eb35950bab74f1b3edc32adcddf243ed7`。
- 27 次模型请求合计输出 28,859 tokens，单轮均未出现 `finishReason=length`；真实截断后的缩小及恢复分支由定向回归验证。
- 完整复核：`/tmp/agentloop-bounded-authoring-report-live/verified-report.json`；复核程序：`/tmp/agentloop-bounded-authoring-report-verify.mjs`。

最初验收脚本只累计 create/append，遗漏合法补丁，导致最终等式误报；原始 `report.json` 保留该错误，独立复核加入补丁的精确前置条件和前后哈希，未修改正式 Run 或文件内容。

### 重复原文逐字复写：未通过

另一个更严格用例要求通过模型参数逐字复写 22,537 字符、包含大量重复段落的原文。Run `20effea6-9bb3-44e0-b02c-b0a411183574` 成功提交 8 个目标文件块，所有块参数累积后的哈希均与文件回执一致，但模型生成的正文遗漏重复段落。随后上下文摘要连续两次 `finishReason=length`，以 `MODEL_ERROR: Context summarizer did not return a complete structured summary` 终止，未交付为成功结果。

该失败证据保留在 `/tmp/agentloop-bounded-authoring-live/`。预算策略保证完整小调用、已提交字节和恢复依据，不保证模型任意原文复写的语义正确，也不解决独立摘要阶段的截断。不能把普通长报告通过表述为该逐字复写用例通过。
