# Skill 元数据维护与运行依赖

日期：2026-11-12

状态：Desktop 与共享 Local Runtime 源码已实现；未重新打包或更新已安装客户端。

## 用户操作

在“设置 → Skill 管理”上传 ZIP 或目录。导入后直接展开“本机运行条件”：展示用途、已满足条件、待补配置，以及已选择此 Skill 的 Runtime。上传加入当前账号的本机共享库，不选择目标 Runtime、不修改任何 Runtime 配置；多个 Runtime 可在自身配置中分别选择同一个 Skill。上传不要求用户编辑或确认元数据，也不会触发依赖下载。

Desktop 和 Local Agent 共用 `packages/agentloop-local-runtime/src/service/skill-metadata-generator.ts`。新上传或重新上传时，已有 `agentloop.skill.json` 或历史 frontmatter 声明直接沿用，不查询或调用模型。缺少声明时，在规则识别基础上按当前账号的模型配置顺序逐个尝试，首个返回有效声明的模型即停止；Desktop 使用账号本机模型配置或显式注入的 Host 模型，Local Agent 继续遵守自身的云端模型复用开关。

共享识别服务读取完整 SKILL.md（受大小预算限制），根 README、依赖声明和实际 manifest，并递归读取正文和 Markdown 链接引用的包内文本。只读取经过包检查的文件，不联网、不执行脚本，排除私密、二进制和越界文件。最多 24 份资料、总计 15 万字符；遗漏和截断均留记录。模型接收实际正文与资料内容，来源记录保存路径、实际输入节选的 SHA256、行数和截断状态，不复制正文到元数据。

模型补充匹配标签、典型请求及工作职责等语义字段，也可提取在引用资料对应行中明确出现的依赖名称。依赖必须附有效文件/行号依据，缺乏依据的建议被排除；标识符片段不能充当完整依赖名。基础声明不从字段名或包内资产推断交付文件，避免把 description 当作 script，或把输入 CSV、执行脚本当成最终产物。身份、执行接口和可产生的来源证据仍以包内实际声明为准；有真实脚本时可识别 local_script 执行方式，有 manifest 时读取并验证实际接口。原始包不改写；识别结果、字段依据、模型标识、尝试顺序和状态保存为包外元数据版本，并进入 Runtime 的 Skill 发现目录。重启不会重新生成。没有模型或全部失败时仍完成导入，列表明确显示基础识别或模型识别未完成；不会持久化可能包含凭据的 Provider 原始错误。

- **本机运行条件**：沿用现有卡片，无 Runtime 选择器、绑定或启动按钮。只读展示设备共享资源是否就绪；缺少模型或 MCP 时提供相应设置入口。Runtime 的 Skill 选择仍在 Runtime 配置页维护，修改其中一个不会影响其他实例。
- **维护元数据**：沿用现有设置卡片，默认只展示名称、用途和一个可选的“典型请求”输入框，无需逐项填写。标签、职责、产物、识别依据及只读 JSON 在默认关闭的“更多设置”中维护或查看，执行接口以只读摘要展示。“手动补充依赖”单独折叠，优先使用包内依赖和自动诊断。保存保留折叠区的原有值，字段出错时自动展开对应区域。
- **依赖诊断**：查看本机共享运行资源的逐项检查结果、信息来源、检查时间和所用环境。修改声明或外部环境后，可重新诊断。
- **查看 Python 依赖安装方案**：展示本机共享环境及有效 Skill 库的合并依赖。只有再次点击“安装 Python 依赖”才开始下载。
- **安装结果**：查看阶段、日志和失败原因。完成后可查看新环境的诊断结果；安装状态只在最终记录保存后对外标为完成。

元数据保存仍遵守现有 Runtime 配置边界：使用此 Skill 的实例需要先停止。保存创建新的包外 revision，并检查编辑页面读取的 revision，拒绝覆盖其他页面的新修改。

## 表单契约

`SKILL_DECLARATION_EDITOR_SCHEMA` 与声明解析器位于内核的 `skill-declaration.ts`，通过 metadata API 返回。页面使用服务端提供的字段集合、枚举、必选项和数量/长度限制；中文标签和布局由 Desktop 管理。

`identity`、`activation`、`workflow`、`execution`、`compatibility` 保留现有语义。新增可选 `requirements`：

```json
{
  "requirements": {
    "python": {
      "version": ">=3.10,<3.14",
      "packages": ["pandas>=2.0", "requests[socks]>=2.31"],
      "files": ["requirements-inference.txt"]
    },
    "commands": ["ffmpeg"],
    "environment": ["DATA_API_URL"],
    "mcpServers": ["business-data"]
  }
}
```

`workflow.requiredSkills` 继续表示 Skill 依赖，使用本机库多选；已声明但未安装的依赖保留并标记。

## 诊断范围

| 类型 | 自动检查 | 安装或处理方式 |
| --- | --- | --- |
| Python | 解释器、版本范围、实际分发版本、extras、传递依赖、平台标记 | 用户点击安装；完成后再次验证 |
| 依赖文件 | 根目录 requirements.txt，以及显式启用的其他包内依赖文件 | 支持包内相对路径引用；拒绝越界 |
| 系统命令 | 是否存在于实际执行 PATH；诊断不执行命令 | 按工具说明手动安装 |
| 环境变量 | 实际命令环境是否提供该名称；不返回值 | 配置对应连接或宿主环境 |
| MCP | 本机共享 MCP 目录是否配置该 key | 在 MCP 页面完成连接与工具测试；仅已配置不会标为已验证 |
| 其他 Skill | 本机 Skill 库是否已具备所需 Skill | 上传到共享库，使用时由 Runtime 按需选择 |

其他 `requirements-*.txt` 不会仅因文件名被自动启用。检测到 `package.json` 或尚未适配的 `pyproject.toml` 时，明确提示按说明准备依赖；当前不自动安装 Node 项目、系统软件或 Python 解释器，也不从脚本 import 语句猜测可安装的软件包名称。

## 安装与执行环境

安装和诊断属于 Host 的设备管理能力，不作为模型可调用的 Run Tool 暴露。依赖声明不授予命令、目录、MCP 或凭据权限。

当前账号在本设备上使用一个共享 managed Python 环境，已有与新建 Runtime 均使用同一份环境。环境继承宿主自带 Python 软件包；新增依赖写入共享 venv，不修改原始 Skill 包、系统 Python 或应用自带 Python。

安装流程：

1. 合并本机有效 Skill 库的 Python 依赖，避免重建环境时丢失其他 Skill 所需的软件包。对合并依赖和各 Skill 的 package hash / metadata revision 生成安装方案指纹。共享依赖冲突会使安装失败并保留原环境，不按 Runtime 拆分环境来绕过冲突。
2. 用户触发安装后，取得设备管理排他权；活动 Run 或其他配置操作会阻止安装。
3. 重新检查方案指纹，拒绝执行过期方案。
4. 创建新 venv，使用固定 argv 调用 pip，仅接受经 PEP 508 解析的命名依赖和二进制软件包。URL、可编辑项目和安装器参数不会作为安装指令执行。
5. 验证合并依赖，检查失败则删除未启用的新环境，保持原环境。
6. 原子发布环境指针，重载所有运行中的 Runtime；停止的实例保持停止。
7. 实际命令工具使用该环境的 PATH、RUNTIME_PYTHON 和只读沙箱目录。重载失败时明确区分“依赖已安装”和“Runtime 未恢复”。
8. 全部运行实例重载成功后清理被替换的共享环境；删除某个 Runtime 不删除共享 Skill 库、依赖环境、MCP 或 Connector。旧实现留下的 Runtime 专属依赖目录不作为正式入口读取，也不自动删除。

安装记录按账号保存，日志有长度限制且隐藏软件包索引 URL。服务退出后遗留的 running 记录显示为中断，不视为安装成功。

## 验证

角色只描述工作流参与方式。显式指定的已授权 Skill 不会因 support、qa、source_provider 或缺少角色而提前排除。来源能力由实际 sourceKinds 与 producesEvidenceKinds 契约生成，仍要求绑定声明该接口的 Skill；不允许借用未绑定的其他 Skill 或 MCP 来源。意图解析若同时声明“必须调用 Skill”和普通 reply，会返回矛盾原因让模型重新解析；仅询问 Skill 用途或清单仍可直接回复。

回归覆盖表单字段保留、只读边界、字段校验、版本冲突、账号隔离、依赖文件越界、PEP 508 标记/版本/extras、安装失败、过期方案和共享环境重载。

识别回归还覆盖 ZIP/目录共用链路、已有声明绕过模型、按配置顺序尝试并在首个有效结果停止、无模型/失败时仍可导入、越权执行声明被排除、账号独立的真实 HTTP 适配器调用、重启持久化，以及模型识别结果进入 `discovered_skills`。HTTP 测试使用本机受控响应服务，不等同于真实远程模型验收。

本次资源归属修正验证：

- 上传与诊断不改变 Runtime 配置；旧绑定 API 已删除，运行条件和依赖 API 拒绝 `runtimeId` 参数。
- 两个 Runtime 可分别选择同一个包；取消其中一个的选择不影响另一个。包、诊断和安装记录仍按账号隔离。
- 本地生成 wheel 后真实安装，三个真实 Runtime 工厂获得同一份 Python 环境，并通过实际命令沙箱导入同一模块得到 417。删除其中一个 Runtime，另一个重启后仍可执行；新建实例无需重复安装。
- 活动 Run 阻止共享依赖安装。安装成功重载所有运行实例，停止实例保持停止。
- Chrome 验证 1440、900、480 像素布局，无 Runtime 选择器和绑定按钮；默认表单仍只有一个可选输入，安装请求不携带 Runtime 目标。

提交前已将 `capability-inventory.test.ts` 的旧无工具回复断言更新为当前只读契约：回复保留已授权读取工具，不包含写入工具或未声明只读的 MCP 工具；查询配置目录时不实际调用服务。

修正资源归属后，四类真实上传已重新验收通过，使用真实配置模型和隔离 Desktop，通过真实上传 API、配置、Runtime catalog、已准入计划、工具调用和最终结果核对全链路：

| Skill 类型 | 实际执行结果 |
| --- | --- |
| 纯指令 | 读取包内 references/workflow.md，返回三步顺序和唯一口令 |
| 有脚本、无 manifest | cwd=@skills/acceptance-script，执行 scripts/run.py，返回 3 条、总额 853 |
| 有 manifest | 按包内执行接口运行自身 scripts/run.py，返回 3 条、总额 1397 |
| 外部连接 | 先显示缺少 acceptance-source，再配置/测试/选择共享 MCP，真实调用 read_record，返回本轮唯一回执、units 37、amount 4819 |

最新证据和 Run ID 见 [共享资源验收记录](../outputs/skill-device-sharing-acceptance-20261112/README.md)。外部连接使用本机只读验收服务，模型及脚本均真实执行。当前仅验证源码和隔离开发实例，没有重新打包、发布或更新原有安装实例。

修正后的验收脚本通过 Runtime 配置 API 选择 Skill，不再调用上传绑定接口。最新资源归属验收记录见 `outputs/skill-device-sharing-acceptance-20261112/`。

提交前验证：Desktop 全量 185/185；共享 Local Runtime 全量 84/84；内核单元测试 301/301，内核集成测试 458 项通过、2 项跳过；Memory 全量 75/75。内核、Memory、Local Runtime 和 Desktop 构建及类型检查通过。Multi Runtime 类型检查仍有 14 项诊断，与当前 HEAD 基线完全一致。Chrome 与真实模型上传沿用前述验收记录，本次提交检查未重复调用远程模型。
