# PI 动态 System Prompt 拼装逻辑核验

核验日期：2026-08-22。对象是 `earendil-works/pi` 当前 `main` 分支的 `packages/coding-agent`，不是本仓库早期固定移植提交里的 `packages/agent` harness。

## 关键源码

- `packages/coding-agent/src/core/system-prompt.ts`：`buildSystemPrompt()`，最终文本拼装函数。
- `packages/coding-agent/src/core/agent-session.ts`：`AgentSession` 的工具注册、资源读取、每轮 system prompt 刷新和 extension 覆盖入口。
- `packages/coding-agent/src/core/resource-loader.ts`：加载 `SYSTEM.md`、`APPEND_SYSTEM.md`、`AGENTS.md` / `CLAUDE.md`、Skills、Prompt templates、Extensions。
- `packages/coding-agent/src/core/skills.ts`：Skill 扫描、校验、去重和 `<available_skills>` 目录格式化。
- `packages/coding-agent/src/server/create-harness.ts`：server/harness 模式下用当前 active tools 拼装 system prompt 的轻量入口。

源码链接：

- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/system-prompt.ts
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/resource-loader.ts
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/skills.ts
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/server/create-harness.ts

## 总体结论

PI 的内置提示词不是单个静态 prompt。它是一个按当前运行状态拼装的模型边界投影：

```text
资源加载层 ResourceLoader
  -> SYSTEM.md / APPEND_SYSTEM.md
  -> AGENTS.md / CLAUDE.md 项目上下文
  -> Skill 目录
  -> Extensions / Prompt templates / Themes

会话运行层 AgentSession
  -> 生成基础工具定义
  -> 合并 extension / SDK 工具
  -> 按 allowlist / denylist / active tools 过滤
  -> 收集工具 promptSnippet / promptGuidelines
  -> 生成 BuildSystemPromptOptions

拼装层 buildSystemPrompt()
  -> customPrompt 分支或默认内置分支
  -> appendSystemPrompt
  -> project_context
  -> available_skills
  -> current working directory

每轮模型调用前
  -> prepareNextTurnWithContext 重新把当前 systemPrompt 和 tools 放入上下文
  -> before_agent_start extension 仍可临时覆盖本轮 systemPrompt
```

它的核心设计是：稳定 persona 和操作规则来自默认 prompt；动态能力来自当前工具注册表；项目规则来自 `AGENTS.md` / `CLAUDE.md`；Skill 只先披露目录，完整正文通过读文件或 `/skill:name` 进入对话；Extension 可以在资源发现、工具注册、每轮开始前继续改变可见上下文。

## 资源加载层

`DefaultResourceLoader.reload()` 是 system prompt 输入材料的来源。它会先解析包管理器配置和 CLI 附加路径，再加载 extensions、skills、prompt templates、themes 和项目上下文。

上下文文件查找规则：

- 全局 agent 目录先找：`AGENTS.override.md`、`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD`。
- 再从当前 `cwd` 向父目录逐级查找同一组文件。
- 项目上下文按祖先顺序加入，避免同一路径重复。
- 对 git worktree 有 shadow 处理，避免主 worktree 和 linked worktree 的同名上下文重复生效。

系统提示文件查找规则：

- `SYSTEM.md`：如果项目已 trusted，优先用 `cwd/.pi/SYSTEM.md`；否则或不存在时用全局 `agentDir/SYSTEM.md`。
- `APPEND_SYSTEM.md`：如果项目已 trusted，优先用 `cwd/.pi/APPEND_SYSTEM.md`；否则或不存在时用全局 `agentDir/APPEND_SYSTEM.md`。
- CLI 或 SDK 显式传入的 `systemPrompt`、`appendSystemPrompt` 会作为 source 进入同一条解析路径。
- 如果 source 是现有文件路径，读取文件内容；否则把 source 字符串本身当 prompt 文本。

Skills 加载规则：

- ResourceLoader 收集启用的 skill 路径，包括包配置、CLI 传入路径和 extension 发现路径。
- `loadSkills()` 负责从路径中找 `SKILL.md` 或根目录 Markdown 文件。
- `name` 来自 frontmatter，否则用父目录名；`description` 必填；名称要求小写字母、数字和连字符，最多 64 字符；description 最多 1024 字符。
- 同名 Skill 只保留第一个，后续冲突作为 diagnostic。

## 工具与 Extension 层

`AgentSession._buildRuntime()` 会创建当前运行时：

- 默认基础工具是 `read`、`bash`、`edit`、`write`。
- 也可以通过 `baseToolsOverride` 替换基础工具集合。
- 内置工具定义来自 `createAllToolDefinitions()`，其中 `read` 会带图片自动缩放设置，`bash` 会带 shell prefix 和 shell path 设置。
- Extension 注册的工具和 SDK custom tools 会与内置工具合并。
- `allowedToolNames` 和 `excludedToolNames` 会过滤工具注册表。
- `includeAllExtensionTools` 为 true 时，extension 工具会自动进入 active tools。

`_refreshToolRegistry()` 会同步三份结构：

- `_toolDefinitions`：工具定义和来源信息。
- `_toolPromptSnippets`：每个工具的一行能力摘要，进入 `Available tools`。
- `_toolPromptGuidelines`：每个工具贡献的提示规则，进入 `Guidelines`。

随后 `setActiveToolsByName()` 会把 active tools 写入 agent state，并调用 `_rebuildSystemPrompt()` 重新生成 `_baseSystemPrompt`。所以 PI 的 system prompt 会随着工具启停、extension reload、资源 reload 改变。

## `_rebuildSystemPrompt()` 的输入包

`AgentSession._rebuildSystemPrompt(toolNames)` 先过滤出当前真实存在的 active tools，然后构造：

```ts
{
  cwd,
  skills: loadedSkills,
  contextFiles: loadedContextFiles,
  customPrompt: loaderSystemPrompt,
  appendSystemPrompt,
  selectedTools: validToolNames,
  toolSnippets,
  promptGuidelines
}
```

这些字段分别来自：

- `cwd`：当前工作目录。
- `skills`：ResourceLoader 当前已加载 Skill 目录。
- `contextFiles`：ResourceLoader 当前已加载 `AGENTS.md` / `CLAUDE.md` 等项目上下文。
- `customPrompt`：`SYSTEM.md` 或显式 system prompt；存在时替换默认内置 persona。
- `appendSystemPrompt`：一个或多个 append prompt 用空行连接。
- `selectedTools`：当前 active tools。
- `toolSnippets`：active tools 的一行描述。
- `promptGuidelines`：active tools 的工具级规则，已 trim 和去重。

## `buildSystemPrompt()` 的拼装分支

### 1. 有 `customPrompt`

当 `customPrompt` 存在时，PI 不再使用默认内置身份文本。拼装顺序是：

```text
customPrompt
appendSystemPrompt
<project_context>
  <project_instructions path="...">...</project_instructions>
</project_context>
available_skills 目录（只有 read 工具可用时）
Current working directory: ...
```

注意：自定义 prompt 分支仍会追加项目上下文和 Skill 目录，但不会自动生成默认 `Available tools` 与默认 `Guidelines` 段。因此完全替换 `SYSTEM.md` 会丢掉默认内置工具说明，除非自定义 prompt 自己补回来。

### 2. 没有 `customPrompt`

默认分支先生成 PI 内置身份和工具说明：

```text
You are an expert coding assistant operating inside pi, a coding agent harness...

Available tools:
...

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
...

Pi documentation ...
```

然后按顺序追加：

```text
appendSystemPrompt
<project_context>
  <project_instructions path="...">...</project_instructions>
</project_context>
available_skills 目录（只有 read 工具可用时）
Current working directory: ...
```

默认工具列表不是 `selectedTools` 的简单枚举，而是只显示有 `promptSnippet` 的 active tools。如果 active tool 没有 snippet，它仍可能作为工具可调用，但不会出现在 `Available tools` 文本段里。

默认 guideline 由三部分组成：

- 如果有 `bash`，但没有 `grep` / `find` / `ls`，加入一条“用 bash 做文件操作”的规则。
- 加入 active tools 贡献的 `promptGuidelines`。
- 永远加入“响应简洁”和“处理文件时清晰展示路径”两条规则。

## Skill 目录与正文进入方式

`formatSkillsForPrompt()` 只把可由模型主动触发的 Skill 放进 `<available_skills>`：

```text
The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory ...

<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

这里不放 Skill 正文。正文进入上下文有两条路径：

- 模型按提示使用 `read` 工具读取 `<location>` 指向的 Skill 文件。
- 用户显式输入 `/skill:name args`，`AgentSession._expandSkillCommand()` 读取对应文件、去掉 frontmatter，用 `<skill name="..." location="...">` 包住正文，并把可选 args 接在后面。

`disable-model-invocation: true` 的 Skill 不进入 `<available_skills>`，只能通过显式 `/skill:name` 使用。

## 每轮刷新与临时覆盖

`AgentSession` 在构造时安装 `prepareNextTurnWithContext` wrapper。每次模型下一轮前，它都会把：

- `systemPrompt: _systemPromptOverride ?? _baseSystemPrompt`
- `tools: agent.state.tools.slice()`
- 当前 model
- 当前 thinking level

放回 agent context。这意味着 system prompt 和工具列表不是启动时冻结的，而是每轮取当前状态。

每次用户 prompt 进入前，`before_agent_start` extension hook 还会拿到：

- 展开后的用户文本。
- 图片输入。
- `_baseSystemPrompt`。
- `_baseSystemPromptOptions`。

Extension 可以返回新的 `systemPrompt`，这会成为本轮 `_systemPromptOverride`。本轮结束后 `_runAgentPrompt()` 会清空 `_systemPromptOverride`，下一轮默认回到 `_baseSystemPrompt`。

## Server Harness 轻量路径

`create-harness.ts` 提供 `buildCodingAgentHarnessSystemPrompt()`：

- 从 `activeToolNames` 找到 active tool 对象。
- 把每个工具的 `promptSnippet` 规范成单行。
- 合并每个工具的 `promptGuidelines`。
- 调用同一个 `buildSystemPrompt()`。

如果没有外部传入工具，server harness 默认创建 `read`、`bash`、`edit`、`write` 四个工具，并给它们挂上各自的 prompt snippet 和 guidelines。这里的职责更薄：它不自己发现 `AGENTS.md` 或 Skills，而是通过传入的 `systemPromptOptions` 复用核心拼装函数。

## 对 AgentLoop 的启发

PI 的动态拼装值得借鉴的地方：

1. 工具可见文本来自工具定义自身的 `promptSnippet` 和 `promptGuidelines`，不是 central prompt 里硬编码所有工具说明。
2. System prompt 每轮从当前工具状态重建，能适配 extension reload、active tool 改变和资源刷新。
3. `SYSTEM.md` 是替换，`APPEND_SYSTEM.md` 是追加，两者语义清晰。
4. 项目上下文使用显式 XML-ish 边界，避免 Markdown heading 混淆文件边界。
5. Skill 目录和 Skill 正文分离，目录常驻，正文按需读取。

AgentLoop 不能直接照搬的地方：

1. PI 依赖模型自觉 read Skill 文件；AgentLoop 的 Plan-first 链路需要 Runtime 强制 Skill activation，否则 Skill compliance 证据不稳定。
2. PI 的 extension 可以在 `before_agent_start` 临时覆盖 system prompt；AgentLoop 若支持类似能力，必须把覆盖来源、作用范围和 hash 持久化，否则会破坏 Run 审计。
3. PI 把 `SYSTEM.md` 作为替换默认 prompt；AgentLoop 的服务端 persona、权限、Plan/Assessment/Terminal Commit 边界不应被项目文件替换，只能作为受限 project instruction 进入模型上下文。
4. PI 的工具启停是会话级交互能力；AgentLoop 的工具能力应继续由 `CapabilityGrant`、Step binding、side-effect policy 和用户授权共同决定，不能由 prompt 文本授予。

## 简化伪代码

```ts
async function rebuildPiPrompt(session) {
  await resourceLoader.reload();

  const baseTools = createAllToolDefinitions(cwd, settings);
  const extensionTools = extensionRunner.getAllRegisteredTools();
  const sdkTools = customTools;
  const registry = applyAllowDeny([...baseTools, ...extensionTools, ...sdkTools]);

  const activeToolNames = resolveActiveTools(registry, previousActiveTools, extensionPolicy);
  const toolSnippets = collectPromptSnippets(registry, activeToolNames);
  const promptGuidelines = collectPromptGuidelines(registry, activeToolNames);

  const options = {
    cwd,
    selectedTools: activeToolNames,
    toolSnippets,
    promptGuidelines,
    customPrompt: resourceLoader.getSystemPrompt(),
    appendSystemPrompt: resourceLoader.getAppendSystemPrompt().join("\n\n"),
    contextFiles: resourceLoader.getAgentsFiles().agentsFiles,
    skills: resourceLoader.getSkills().skills,
  };

  return buildSystemPrompt(options);
}
```

```ts
function buildSystemPrompt(options) {
  if (options.customPrompt) {
    return [
      options.customPrompt,
      options.appendSystemPrompt,
      projectContext(options.contextFiles),
      hasRead(options.selectedTools) ? availableSkills(options.skills) : "",
      `Current working directory: ${normalize(options.cwd)}`,
    ].join("");
  }

  return [
    defaultPiIdentityAndDocs,
    availableTools(options.selectedTools, options.toolSnippets),
    guidelines(options.selectedTools, options.promptGuidelines),
    options.appendSystemPrompt,
    projectContext(options.contextFiles),
    hasRead(options.selectedTools) ? availableSkills(options.skills) : "",
    `Current working directory: ${normalize(options.cwd)}`,
  ].join("");
}
```
