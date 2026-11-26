# AgentLoop 经营问数 Agent

独立应用，基于 `@zhujun/agentloop` 内核和应用内的 TiDB `data-analysis` Skill。免登录，提供分析工作台和参考 `~/coding/nl2sql` 迁移的知识与数据管理页面。固定集团经营分析单场景，无场景切换，不依赖 nl2sql 的服务或源码。

## 固定能力

应用层 `fixedDataAnalysisPlanner` 直接生成绑定 `data-analysis` 的单步骤 Plan，跳过主 Skill 的模型选择。模型在步骤内依据当前目录完成领域规划、实体/指标/期间绑定、SQL 生成、受控查询和结果核对；不是把业务 SQL 或口径写死在计划里。

目前采用现有 TiDB Skill 的 `group`（集团经营分析）范围。指标或实体存在歧义时，通过内核原生 HIL 暂停和恢复。会话重建、Plan Admission、工具授权、独立结果评估、取消和失败处理均由内核执行。

**不配置、不实例化 Memory。** 同一对话的历史与已发布 Result 是内核对话上下文，不是 Memory。

## 存储边界

| 内容 | 存储 |
| --- | --- |
| 会话、Run、Plan、Canonical State、事件、Action、Result、HIL、请求幂等记录 | 内核原生 Redis（默认）或磁盘 SQLite |
| 业务目录、术语、实体和指标定义、SQL 审计 | Skill 配置的 TiDB 目录数据库 |
| 业务查询 | Skill 配置的 TiDB 授权表，只读 SQL |
| 大查询结果、导出、命令输出和执行附件 | `DATA_AGENT_FILE_DIR` 下的持久磁盘目录；回执保存路径、大小、SHA-256 |
| Runtime 连接与启动参数 | 宿主环境变量，已 gitignore |
| 业务连接与模型配置 | 宿主本地配置文件，管理页面可编辑；密码与 API Key 不回显 |

应用通过内核 `RuntimeStateConfig` 选择 sqlite/redis，目录使用独立 SQL 连接；Redis 故障不降级。文件目录应使用稳定持久卷；更换机器时需保持挂载路径并迁移文件，否则历史文件引用不可读。Runtime 状态与文件目录需配套备份。Skill 在 Runtime 的只读包目录中执行，不调用第二套 NL2SQL 模型流程。

## 启动

要求 Node 26+、Python 3.10+、现有 TiDB 目录/业务数据和开启 AOF/appendfsync always/noeviction 的 Redis（或选择磁盘 SQLite）。应用只初始化自己的 Runtime 表，不初始化或改动业务表、目录内容。

在仓库根目录安装 workspace 依赖并构建内核：

```sh
npm install
npm run build:kernel
```

在本应用目录中准备配置：

```sh
cp .env.example .env
cp config/llm-providers.example.json config/llm-providers.json
cp skills/data-analysis/connections.example.json skills/data-analysis/connections.json
python3 -m venv .venv
.venv/bin/python -m pip install -r skills/data-analysis/requirements.txt
```

编辑 `.env` 的 `DATA_AGENT_STATE_BACKEND`、`DATA_AGENT_REDIS_URL`、`DATA_AGENT_PYTHON` 和模型配置。Redis 模式设置 `DATA_AGENT_HISTORY_TIDB_URL`，兼容旧摘要 URL 与 `DATA_AGENT_TIDB_URL`，仅用于后台历史和页面查询。Skill 连接文件配置现有目录库、业务库和精确授权表。URL 中的用户名或密码含特殊字符时需要 URL 编码。TiDB TLS 可在 Runtime URL 中指定 `?ssl=true`。

`DATA_AGENT_PYTHON` 可使用 `.venv/bin/python` 的绝对路径。所有配置路径相对本应用目录，`DATA_AGENT_FILE_DIR` 应保持稳定。端口默认 `8810`，只监听 `127.0.0.1`。

```sh
# 在仓库根目录执行
npm run start:data-agent
```

打开 [本机对话页](http://127.0.0.1:8810)。页面无需登录。支持新对话、历史恢复、进度与回答流、结构化澄清、停止查询；[知识与数据管理](http://127.0.0.1:8810/settings) 中可编辑业务连接、业务目录与模型配置。当前不提供用户管理、业务数据写入或公网部署。HttpOnly 本机页面 cookie 与同源检查用于阻止其他网页代发请求，不是账号系统。

同一服务也提供 MCP SSE Server：`http://127.0.0.1:8810/mcp/sse`。MCP 客户端通过标准 `initialize`、`tools/list` 和 `tools/call` 使用 `query`、`search_tables`；`query` 复用当前 AgentLoop Run、HIL 和只读 Skill 执行链路，支持 `clarification_run_id` 与 `clarification_response` 继续澄清。调用进度通过 `notifications/progress` 推送，客户端断开后 Run 仍继续并在内核 `runtime_observations` 记录 中保留终态记录。管理页同源接口 `/api/mcp/server`、`/api/mcp/calls` 只用于查看服务和调用记录，不暴露凭据、SQL 或完整大结果。

不同执行实例使用稳定、不同的 DATA_AGENT_RUNTIME_ID；启动仅恢复本分区，不使用 Runtime writer 租约。Ctrl-C 正常停止会取消正在执行的查询并等待退出，保留等待用户澄清的请求供重启后继续；异常退出后的未完成执行由内核按照持久化证据处理，不自动重放未知副作用。

## 知识与数据管理

管理页包含数据连接、Server 状态、工作流、数据表与字段、指标定义、业务术语、分析 Skills（专业分析提示）、案例问题和模型管理。工作流展示本应用的真实执行流程；Server 展示本机服务状态。表知识支持人工维护与检索比对；当前没有迁移 nl2sql 的 AI 批量解读流程或 MCP 调试台。

目录编辑写回 Skill 读取的 TiDB `scenarios.group.config`，保留未编辑的高级业务定义，使用行锁和版本校验阻止过期覆盖。业务连接仍由 Skill 根目录 `connections.json` 唯一持有；保存前验证真实目录和授权表，保存后刷新不可变 Skill 包。业务连接、目录和模型保存前需要完成或停止尚未结束的分析，包括待确认请求。Runtime 状态库地址仍为启动配置，不能通过页面迁移正在使用的 Runtime 数据库。

配置管理的 Python 入口位于宿主 `scripts/manage_catalog.py`，没有加入 Skill 执行清单，模型不能调用管理写入入口。案例问题保存在目录中，分析工作台会读取显示。

## 模型配置契约

应用直接使用内核 `LlmProviderRegistry` 的配置格式和校验，不维护独立的厂商参数转换。示例采用百炼原生 Provider；百炼托管的 DeepSeek 也使用 `kind: "alibaba"`，以接入服务而非模型名称决定 SDK。

- 连接层：Provider 的 `kind`、`baseUrl`、`apiKeyEnv` 和 `protocol`。
- 模型层：`providerKey`、`providerModel`、上下文和输出上限。
- 思考策略：统一使用 `reasoning`，可选值由内核 schema 提供；`none` 关闭思考，`provider-default` 使用服务默认，其余档位由所选 Provider SDK 转换。
- 厂商扩展：确有需要时使用 `providerOptions`，内容直接对应所选 SDK 的选项，不再套厂商命名空间。百炼的 `enableThinking`、`thinkingBudget` 属于此处的高级选项，SDK 会优先采用它们；常规思考控件只编辑 `reasoning`，更改时应清除冲突的高级思考选项。
- `reasoningVisibility` 仅控制思考过程展示，不改变模型的思考策略。

百炼关闭思考的配置是 Provider 的 `kind: "alibaba"` 配合模型的 `reasoning: "none"`。不要保留模型或 Provider 顶层的旧 `enableThinking`、`thinkingMode` 等控制；内核拒绝原生 Provider 的旧字段和统一/旧字段混用。

配置页面使用 `GET /api/model-configuration/schema` 获取内核导出的 `MODEL_CONFIGURATION_EDITOR_SCHEMA`，其中包含 Provider、服务预设、统一思考档位和字段约束；接口沿用本机页面 cookie 与同源保护。页面不复制厂商映射或自行维护档位。`/api/settings/models` 读取和保存使用内核字段名，保存前交给同一个 `LlmProviderRegistry` 校验，通过后原子持久化并更新模型工厂，作用于下一次分析。密钥保留在服务端；修改接入类型或地址需重新填写密钥。手动修改文件后需重启应用。

## 验证

```sh
npm run typecheck --workspace agentloop-data-agent
npm test --workspace agentloop-data-agent
npm run test:catalog --workspace agentloop-data-agent
# 使用已装依赖的解释器运行 Skill 离线回归
python3 -m unittest discover -s apps/agentloop-data-agent/skills/data-analysis/scripts -p 'test_*.py'
```

真实数据库回归使用 `npm run test:live --workspace agentloop-data-agent`，显式读取本机 `.env`，创建独立测试 schema，验证后只删除该次创建的 schema。测试包含真实内核与 TiDB、HIL、重试幂等和重开恢复；业务源只执行只读查询，Skill 正常写查询审计。

启动应用后运行 `npm run verify:browser --workspace agentloop-data-agent`，使用本机 Chrome 验证桌面/手机布局、真实模型取数和刷新恢复。截图与本次 Run 快照保存在忽略的 `data/qa`，默认查询人力月报的最新月份；可用 `DATA_AGENT_TEST_QUESTION` 改变验证问题。Chrome 路径由 `DATA_AGENT_CHROME` 指定。

在本应用目录运行 `node --env-file-if-exists=.env scripts/verify-settings.mts`，验证全部管理栏目、真实 TiDB 保存与 Skill 读取、连接保存后的包刷新、模型保存、刷新恢复和手机布局。写入在独立临时库和配置副本中执行，业务库只读，结束时清理临时库；截图保存在 `data/qa/settings`。

本应用中的 Skill 从仓库现有 TiDB 版 `custom-skills/data-analysis` 建立独立源码基线；后续修改归本应用所有。连接凭据不在源码中。

原生 Runtime 接入以 [内核后端文档](../../docs/RUNTIME-NATIVE-RECORDS-STATUS.md) 为准；本次旧 TiDB/changeset 历史已放弃，不迁移也不删除。完整历史分工与验收见 [存储交付记录](../../docs/RUNTIME-HISTORY-STORAGE.md)。


## Redis 执行与 TiDB 长期历史

Redis 是执行状态提交边界；接纳、推进、工具、HIL、取消和终态不等待 TiDB。Redis 同次原子提交登记对象级递增版本的历史待办；后台合并后以有版本条件的事务批量写入 `runtime_history_objects`。会话、Run、Plan/Step、修订、有效部分结果、Outcome、产物元数据和归档引用分别保存为实体行。新增细粒度事件、流式输出和 Action 观察不写 TiDB `run_events`。

Redis 模式必须配置历史连接：`DATA_AGENT_HISTORY_TIDB_URL` > 兼容 `DATA_AGENT_RUNTIME_SUMMARY_TIDB_URL` > 兼容 `DATA_AGENT_TIDB_URL`。两个旧入口均仅用于完整历史，不再同步保存执行状态。历史读池与写池各自默认 2 个连接、每条操作 3000ms 超时；单工作器同时处理一个批次，默认 100 个对象/批、1000ms 轮询、1000–60000ms 指数退避。超时销毁连接。SQL 提交后才 CAS 确认；重复消费、响应丢失和重启可重写，不重跑模型或工具；旧确认不能删除新版本待办，删除墓碑禁止迟到更新复活对象。

左侧列表直接查询 TiDB，使用 `(updated_at, object_id)` 降序游标分页；已结束 Run 的输入、计划、回答、结果、产物读取 TiDB。活跃 Run 的状态/HIL/恢复读取 Redis，详细过程通过统一接口读取近期 Redis 事件或已校验的完整归档。新会话在浏览器按 ID 保留到入库完成；失败显示“加载失败，点击重试”，不改用整份 Redis 历史。`GET /api/history/status` 提供待办数量、最早年龄、最近成功/失败、重试次数和入库延迟。

文件内容使用持久 workspace/归档卷，TiDB 仅保存稳定引用、版本、大小与校验和；大于 64KiB 的历史实体内容写入校验后的不可变文件，读取时核对并还原。配置共享 namespace 的多实例须共享同一文件卷。下载能力按请求解析稳定引用，历史元数据不保存临时签名 URL。业务 Skill 的 `nl2sql_skill`、`nl2sql_group` 等连接不变。

SQLite 模式仍由内核使用磁盘 SQLite 保存执行及历史，不需要 Redis/TiDB。旧历史本次不迁移、不删除；无自动 Redis 清理。以后清理须同时满足历史入库确认、文件/过程归档验证、保留期，活跃/HIL/待恢复/未确认对象不得清理。
