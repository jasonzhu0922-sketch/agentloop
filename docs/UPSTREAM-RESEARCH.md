# 上游框架代码核验

核验日期：2026-08-17。引用均固定到本次核验的提交，避免主分支后续变化让设计依据漂移。

## 1. PI Agent

- 仓库：[badlogic/pi-mono](https://github.com/badlogic/pi-mono)
- 核验提交：[`58302d34e703e0453ea13bdd10c7e423589ce177`](https://github.com/badlogic/pi-mono/tree/58302d34e703e0453ea13bdd10c7e423589ce177)
- 许可证：MIT

关键源码：

- [`packages/agent/src/agent-loop.ts`](https://github.com/badlogic/pi-mono/blob/58302d34e703e0453ea13bdd10c7e423589ce177/packages/agent/src/agent-loop.ts)：外层 follow-up 队列、内层 tool/steering 循环、模型边界前的上下文转换、工具预检，以及并行执行后按模型调用顺序回填结果。
- [`packages/agent/src/harness/system-prompt.ts`](https://github.com/badlogic/pi-mono/blob/58302d34e703e0453ea13bdd10c7e423589ce177/packages/agent/src/harness/system-prompt.ts)：稳定系统提示只列 Skill 的名称、描述和文件位置，要求匹配时再读取完整文件。
- [`packages/agent/src/harness/skills.ts`](https://github.com/badlogic/pi-mono/blob/58302d34e703e0453ea13bdd10c7e423589ce177/packages/agent/src/harness/skills.ts)：解析标准 `SKILL.md`，显式调用时才生成包含完整正文和相对路径根的独立 `<skill>` 块。

采用：

- Loop 保持小而明确；消息、模型和工具通过接口进入。
- 并行工具可以按完成时间发事件，但交给模型的 ToolResult 必须保持原始调用顺序。
- 模型响应因长度截断时，不执行可能参数不完整的工具调用。
- 上下文变换只发生在模型边界，持久记录保留原始事实。
- Skill 使用渐进式披露：目录常驻，完整原文按需进入当前对话，任务提示不复制 Skill 工作流。

调整：

- PI 的子 Agent 示例面向单机开发者 CLI；本项目把来源信任改成登录用户、私有 Agent 白名单和不可变能力凭证。

## 2. OpenCode

- 仓库：[sst/opencode](https://github.com/sst/opencode)
- 核验提交：[`4d68d30b48a99379b2baaf597dbad576707ea36d`](https://github.com/sst/opencode/tree/4d68d30b48a99379b2baaf597dbad576707ea36d)
- 许可证：MIT

关键源码：

- [`packages/opencode/src/session/system.ts`](https://github.com/sst/opencode/blob/4d68d30b48a99379b2baaf597dbad576707ea36d/packages/opencode/src/session/system.ts)：每个模型回合把权限过滤后的 verbose Skill 目录加入系统上下文，不放完整正文。
- [`packages/opencode/src/tool/skill.ts`](https://github.com/sst/opencode/blob/4d68d30b48a99379b2baaf597dbad576707ea36d/packages/opencode/src/tool/skill.ts)：`skill` Tool 经权限确认后返回完整 Skill 正文、Base directory 和抽样资源列表。
- [`packages/opencode/src/skill/index.ts`](https://github.com/sst/opencode/blob/4d68d30b48a99379b2baaf597dbad576707ea36d/packages/opencode/src/skill/index.ts)：多来源发现、名称冲突、权限过滤和目录/正文分离的权威实现。
- [`packages/opencode/src/session/prompt.ts`](https://github.com/sst/opencode/blob/4d68d30b48a99379b2baaf597dbad576707ea36d/packages/opencode/src/session/prompt.ts)：循环逐回合重新组装环境、指令、MCP、Skill 目录和动态 Tool 快照。

采用：

- 工具集不是全局常量，而是由当前 Run 的能力凭证动态物化。
- Skill 只常驻名称/描述；正文按需加载。
- 同一个 Run 只能有一个驱动者，多个 Run 可以并行。
- Skill ToolResult 是完整指令进入当前会话的唯一动态路径，不再由用户 Prompt 或 Agent persona 复述一遍。

调整：

- OpenCode 的本地 Skill 来源和权限规则不是 SaaS 多租户隔离。本项目在数据库查询、Agent-Skill 绑定和运行时 `load_skill` 三个边界重复执行所有权约束。

## 3. DeepSeek Harness

- 仓库：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- 核验提交：[`47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)
- 许可证：MIT

关键源码：

- [`packages/core/agent-loop/README.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/README.zh.md)：Agent Loop 是唯一具体循环，压缩、权限、沙箱、重试、子 Agent、持久化和 UI 均通过插件/事件扩展。
- [`packages/core/agent-loop/src/tool-calls.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/tool-calls.ts)：独占工具形成屏障，并行工具使用有界滚动池；分发可以重叠，但策略、结果和结果上下文按模型顺序提交；取消为未启动调用补合成结果以保持协议可回放。
- [`packages/skill/skill/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/skill/skill/src/index.ts)：Skill Registry 合并多 Provider、按 Scope 分层、缓存目录快照并按需加载正文。
- [`packages/subagent/subagent/src/depth.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent/src/depth.ts)：持久会话头中的委派深度是权威事实；恢复后的运行时值只能加深，不能把深度降回零。
- [`packages/subagent/subagent/src/lifecycle.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent/src/lifecycle.ts)：子 Agent start/end 成对，结果从子会话自己的事件后缀得出，而不是把 teardown 成功误认为任务成功。

采用：

- Loop 只做“组装请求 → 调模型 → 执行工具 → 重复”；其余能力通过明确扩展点进入。
- Run 事件先于外部副作用持久化，回放时每个 ToolCall 都必须有对应结果。
- 子 Agent 具有独立会话、独立上下文、父子谱系和单调深度。
- 子 Agent 的最终状态来自它自己的终止事件，而不是父 Agent 的主观总结。

调整：

- 本项目目标是多用户应用，增加身份控制面、私有 Skill Vault 和租户审计；这些不应塞进通用 Loop。

## 4. Skill 披露与上下文压缩专项核验

### 4.1 PI

专项源码：

- [`packages/coding-agent/docs/skills.md`](https://github.com/badlogic/pi-mono/blob/58302d34e703e0453ea13bdd10c7e423589ce177/packages/coding-agent/docs/skills.md)：启动时只扫描并披露 `name / description / location`，模型匹配任务后再用 `read` 读取完整 `SKILL.md`；Skill 中的脚本、参考资料和资产都以 Skill 根目录解析。
- [`packages/coding-agent/docs/compaction.md`](https://github.com/badlogic/pi-mono/blob/58302d34e703e0453ea13bdd10c7e423589ce177/packages/coding-agent/docs/compaction.md)：当 `contextTokens > contextWindow - reserveTokens` 时自动压缩；默认 `reserveTokens=16384`、`keepRecentTokens=20000`。
- [`packages/coding-agent/src/core/compaction/compaction.ts`](https://github.com/badlogic/pi-mono/blob/58302d34e703e0453ea13bdd10c7e423589ce177/packages/coding-agent/src/core/compaction/compaction.ts)：按有效消息边界选择保留尾部；单个超大 turn 可以从 assistant 消息处切分；重复压缩把上一版摘要和新被移出的历史合并成下一版结构化摘要。
- [`packages/coding-agent/src/core/compaction/utils.ts`](https://github.com/badlogic/pi-mono/blob/58302d34e703e0453ea13bdd10c7e423589ce177/packages/coding-agent/src/core/compaction/utils.ts)：摘要输入中的每个 ToolResult 最多序列化 2,000 字符；完整 ToolResult 仍留在原会话记录中。
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/badlogic/pi-mono/blob/58302d34e703e0453ea13bdd10c7e423589ce177/packages/coding-agent/src/core/session-manager.ts)：`CompactionEntry` 保存摘要、`firstKeptEntryId`、压缩前 token 数和用量；模型上下文由“最新摘要 + 保留尾部”重建，历史节点不被改写。

PI 的 Skill 披露是渐进式建议，官方文档也明确说明模型不一定主动读取，需要提示或 `/skill:name` 强制。本项目不能接受这种概率性：Planner 选择 Skill 前和 Skill-bound Step 执行前都由 Runtime 强制进入 `load_skill` 门。

### 4.2 OpenCode

专项源码：

- [`packages/opencode/src/skill/index.ts`](https://github.com/sst/opencode/blob/4d68d30b48a99379b2baaf597dbad576707ea36d/packages/opencode/src/skill/index.ts)：Registry 内部保存完整正文，但 `Skill.fmt(..., verbose=true)` 对模型只披露名称、描述和位置，并在 Agent 权限过滤后生成目录。
- [`packages/opencode/src/tool/skill.ts`](https://github.com/sst/opencode/blob/4d68d30b48a99379b2baaf597dbad576707ea36d/packages/opencode/src/tool/skill.ts)：`skill` Tool 再次做权限确认，返回完整正文、Base directory 和抽样文件列表；正文以 ToolResult 进入对话。
- [`packages/opencode/src/session/overflow.ts`](https://github.com/sst/opencode/blob/4d68d30b48a99379b2baaf597dbad576707ea36d/packages/opencode/src/session/overflow.ts)：可用输入窗口由模型上下文、模型输入上限、最大输出和 compaction reserve 共同决定，而不是按消息条数触发。
- [`packages/opencode/src/session/compaction.ts`](https://github.com/sst/opencode/blob/4d68d30b48a99379b2baaf597dbad576707ea36d/packages/opencode/src/session/compaction.ts)：先 prune 旧 Tool 输出，再做结构化 compaction；`skill` 是受保护 Tool，不参与普通输出清理；摘要序列化同样把单个 ToolResult 限为 2,000 字符；近期尾部预算默认是可用输入窗口的 25%，并限制在 2,000–15,000 token。

OpenCode 的 prune 会在持久 Tool Part 上标记 `compacted` 并清除模型可见输出。本项目的事件存储同时承担审计与恢复权威，因此采用更严格的投影式实现：原始 `tool.completed` 事件和 Tool evidence 永不改写，只在下一次模型请求的 Context Projection 中替换旧输出。

### 4.3 本项目采用的标准协议

1. **目录披露**：稳定上下文只放授权 Skill 的 `id / name / description / version / location`，绝不放正文、脚本内容或框架复述的工作流。
2. **显式激活**：完整原文只允许由 `load_skill` ToolResult 注入；Planner 必须先激活再 `submit_plan`，Skill-bound Step 必须先激活才开放执行 Tool。
3. **资源解析**：Skill 原文引用的脚本、参考资料和资产按已核验的只读 Package 根目录解析；框架不预读、不改写、不补充第三方 Skill。
4. **模型边界投影**：事件、ToolCall/Result、Plan、Assessment 和 Outcome 保留原始事实；Context Assembler 只生成当轮 `ModelInvocation`，其 canonical transcript 与 `RuntimeContextSnapshot` 不混用。Provider Prompt Encoder 再按 DeepSeek/OpenAI-compatible 的 `system / user / assistant / tool` wire 角色编码。
5. **两阶段降载**：先替换旧的、可从事件或 Artifact 回查的 Tool 输出；仍超预算时，把较老的完整交换压成结构化摘要并保留近期尾部。
6. **边界保护**：当前任务原文、当前 Plan Step/成功标准、最近修复反馈、未闭合 Tool 对和近期 Tool evidence 不可静默丢失。
7. **Skill 重新激活**：`load_skill` 的精确 ToolResult 在普通 prune 中受保护；一旦它随旧历史进入结构化 compaction，摘要不能替代 Skill 原文，Runtime 必须撤销本轮激活并重新只开放 `load_skill`，产生新的 `skill.activated` 证据。
8. **可审计性**：每次投影裁剪或摘要记录预算、估算 token、摘要版本、首个保留消息、被替换 ToolCall 和需要重新激活的 Skill；snapshot 带 phase、ID、上一个 snapshot ID 和 hash，摘要模型调用有独立 usage，不占用业务 Tool step 计数。

这比直接照搬任一上游更适合当前 Plan-first Runtime：PI/OpenCode 的会话摘要负责“继续聊天”，本项目还必须保证 Plan、Skill Compliance 和 Terminal Committer 的权威事实不依赖摘要模型是否记住。

## 5. 许可证与代码使用方式

三个上游在本次固定提交上均为 MIT。M1 重构已把 PI 的有界并发映射和结果有序回填、OpenCode 的逐步 Tool 快照物化边界、DeepSeek Harness 的独占屏障/有界并发工具调度和子 Agent 终态来源规则移植到 Runtime；Plan-first、私有 Skill、登录鉴权和 Batch 是本项目新增语义。具体文件映射与完整许可证见根目录 `THIRD_PARTY_NOTICES.md`。

本文件是工程来源记录，不构成法律意见。
