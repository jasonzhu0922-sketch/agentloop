# 包内数据访问契约

所有执行代码均在本包：`scripts/data_access.py` 组织确定性操作；`scripts/gateway/` 实现场景、目录存储、物理字段探查、SQL 策略、只读执行及审计；CLI 与 HTTP 共用它们。除已安装的 Python 依赖外，不导入外部项目代码，不调用外部自然语言问数服务，不读取模型配置或调用模型。

## 根目录连接配置

`connections.json` 位于 Skill 根目录，保存目录数据库与各场景业务数据库的连接凭据、场景授权表清单。本机源文件创建时使用 0600；Runtime 的不可变包副本可能为 0444，这是正常的只读部署，不要求或尝试 chmod。读取权限由宿主隔离控制，不以文件模式推断数据库可用性。不依赖环境变量或项目路径。`connections.example.json` 只说明结构；不要用示例覆盖实际文件。

目录数据库提供已配置的场景业务元数据（目录连接所选数据库的 `scenarios` 表），审计写入 同库的 `query_audit`。元数据读取使用只允许读取目录的专用账号，不读取模型配置、不初始化默认配置。场景绑定来自本包根目录配置；缺少绑定则拒绝，不默认访问其他场景。所有业务连接均检查真实 TiDB 身份、表级只读授权及范围，不能使用高权限账号。连接配置不通过 CLI 参数传递，不输出原始驱动异常。

使用 Runtime 提供的 Python 3.10 或更新版本，脚本沿用启动它的解释器。CLI 依赖由根目录 `requirements.txt` 声明（`PyMySQL` 和 `sqlglot`）；可选 HTTP 接口还需 `fastapi`、`uvicorn`，包内测试还需 `httpx`。依赖由宿主在对应 Python 环境中安装；缺失时报告 `dependency_unavailable`，不自动安装、搜索开发机解释器或改写只读 Skill 包。

TiDB 不支持 `START TRANSACTION READ ONLY`；本包不以 no-op 模式假装只读。业务账号必须仅有配置授权实体表的逐表 `SELECT`，禁止全局权限、通配授权、角色继承、写权限和转授权。查询设置服务端 `max_execution_time=10000`，按 TiDB EXPLAIN 的 `estRows` 限制预计扫描量，并保留 15 秒总时长与 4 MiB 完整结果限制。目录账号仅需 `scenarios` 的 SELECT 和 `query_audit` 的 INSERT；运行期间不创建数据库、账号或表。

## CLI

以下路径相对 Skill 根目录，输出路径使用当前 Runtime 可写工作区：

```bash
python3 scripts/data_client.py select-scenario --output <scenario-selection.json>
python3 scripts/data_client.py scenarios --output <scenarios.json>
python3 scripts/data_client.py catalog --scenario-id <id> --output <index.json>
python3 scripts/data_client.py catalog --scenario-id <id> --source-id <table_name> --output <details.json>
python3 scripts/data_client.py execute --scenario-id <id> --request-json '<SQL请求JSON>' --output <result.json>
```

`--source-id` 可重复，表名来自索引。查询必须保存完整结果。使用宿主工具时直接将以下 JSON 字符串放入 `args` 数组，不创建请求文件、不嵌入 shell 命令：

```json
{"sql":"SELECT <field> FROM <schema>.<table> WHERE <time_field> = %s","params":["<period>"]}
```

查询执行器只接收明确 SQL 与有限 JSON 标量参数；禁止传递连接覆盖、模型配置或自然语言问题。占位符与参数分开，不能拼接参数进 SQL。宿主路径别名需要先解析为实际文件路径。

占位符统一为 `%s`，与 `params` 按出现顺序一一对应；重复使用同一值也须重复传入。日期转换使用 `CAST(%s AS DATE)`，不能使用 PostgreSQL 的 `::date`、`DATE %s`、`DATE $1` 或 `$n` 占位符。参数样式和个数在业务查询连接前校验，错误不会通过改写为 SQL 字面量自动重试。

## 未指定场景时的 HIL

`select-scenario` 只列出可用场景并构建用户选择，不读取场景表结构、不执行业务 SQL。输出文件为 `agentloop.humanLoopRequirement/v1`；stdout 回执的顶层保留 `humanLoopRequirement`，使宿主从已注册的只读 Skill 命令根读取控制信号，创建真实 HIL 并暂停当前 Run。

请求固定为 `kind=selection`、`responseSchema.type=select`、`minSelections=1`、`maxSelections=1`、`resume.mode=continue_step`。选项由实时目录生成：`id` 为真实场景 id，`label` 为名称，`description` 为目录说明，`identityRefs` 保留场景身份。不得预选、裁剪成模型推荐项或用推测替换选项。即使只有一个选项也产生 HIL；空目录则失败，不自动采用 demo 或虚构场景。

等待宿主持久化的 HIL 答复，读取用户选中的唯一 option id 后，使用该 id 调用 `catalog` 与 `execute`。取消、未回答或尚未确认都不允许继续查询。同一任务已明确指定场景则使用 `scenarios` 核对身份，无需重新选择；仅凭业务问题不能跳过 HIL。HIL 请求、用户答复与后续查询由宿主保存在同一个 Run 中，脚本不自行写 Runtime 状态。

## 包内 HTTP 接口

`/api/data/catalog`、`/api/data/execute` 定义于 `scripts/data_api.py`，不挂载到其他应用。只有用户要求 HTTP 服务时运行 `python3 scripts/data_api.py --port 8001`，只绑定 `127.0.0.1`：

- `GET /api/scenarios`：场景 id、名称、描述。
- `GET /api/data/catalog?scenario_id=...`：业务目录索引，不含模型设置或连接信息。
- `GET /api/data/catalog?scenario_id=...&source_id=...`：选中表的字段、值域、输出限制及业务方法。索引与详情共享完整目录摘要 `catalog_revision`。
- `POST /api/data/execute`：显式 `scenario_id`、当前 Agent 生成的 `sql`、独立 `params`；执行逻辑与 CLI 相同。

## 结果与失败

执行响应 `nl2sql.query-result/v1` 含 `scenario_id`、`query_id`、`catalog_revision`、`sql`、`params`、`duration_ms`、`status` 和 `error`。成功时附 `dataset: {columns, rows, row_count}`。`query_id` 关联查询审计，当前 Runtime 保存规划与工具证据，不产生内层模型 Run。

`completed`、`rejected`、`failed` 分别表示成功、策略拒绝、执行失败。只有成功才有数据集，零行与 NULL 如实保留。CLI 退出 0 表示取得完整结果，1 表示失败，2 表示参数错误。失败也保存 JSON；不要自动重试或把故障描述为无数据。

`gateway_error` 包含不暴露凭据的 `diagnostic.phase`、`code` 和异常类型。区分配置读取、依赖加载、场景目录读取及查询分发，不能仅凭此状态断定网络、数据库或 VPN 故障。元数据动作的 `execution_state=not_applicable` 表示没有请求 SQL 执行，不代表进程未启动；命令是否启动以宿主工具的 executionReceipt 为准。

查询内部失败的详情位于 `error.diagnostic`：参数错误返回 `status=rejected`、`error.code=query_parameter_invalid`，阶段为 `query.bind`，具体代码为 `unsupported_parameter_style` 或 `parameter_count_mismatch`。SQL 策略拒绝仍为 `query_policy_rejected`。执行阶段区分 `connection.open`、`transaction.configure`、`role.check`、`query.explain`、`query.execute`、`result.fetch` 和 `result.serialize`；驱动提供 MySQL 错误号时附加整数 `vendor_code`（例如 1054 为字段不存在、1142 为权限拒绝）。不输出原始异常消息，不把缺失代码填成一个推测原因，也不把客户端绑定错误解释为数据库不支持参数。

文件回执包含绝对路径、字节数、SHA-256、场景、查询 id、状态与行数。6000 字符内的响应以 `content_complete=true` 和 `content` 原样放进同一次工具返回；大结果保存在完整文件中，按需读取或计算。`evidenceReceipt` 只证明来源和行数，不证明回答正确。目录版本变化时核对受影响字段与口径。
