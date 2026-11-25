# Redis 执行状态与 TiDB 长期历史

验证日期：2026-11-25。本次基于现有原生 Redis records 实现；没有恢复 SQLite changeset 执行路径，没有 SQL 解释器、Runtime writer 租约、启动抢占或心跳。未迁移、清理旧数据，未提交或推送；三个工作区原有改动保留。

## 存储契约与装配

- `RuntimePersistence`：Redis 提交执行状态、事件与同事务历史待办；Redis 持久化确认仍是执行提交边界。
- `RuntimeHistoryReader`：会话分页、会话详情和 Run 成果读取。
- `RuntimeHistorySink`：批量写入长期历史；不能调用模型、工具或业务效果。
- `RuntimeHistoryOutbox`：持久对象版本、合并待办、重试、版本条件确认及状态指标。
- `createRuntimeHistory`：内核统一工厂；Redis 装配独立 TiDB reader/writer，SQLite 装配现有 SQLite history reader。
- `RuntimeHistoryView`：宿主统一读取边界；执行中 Run/HIL 读 Redis，终态成果读 history，过程读近期 Redis 或已校验归档。

仓库内与独立 Data Agent 已接入完整历史，Multi Runtime 服务宿主也更新装配。Desktop、Local Runtime、默认 Report Agent 继续 SQLite，不要求 Redis/TiDB。Report Agent 可选旧 Redis summary 集成保留兼容，本轮实际启用与验收的是默认 SQLite。

## TiDB 表及版本

新增 `runtime_history_objects`，每个业务实体一行，不是整 Run 单行 JSON 摘要。主键 `(namespace, kind, object_id)`；列为 `entity_id, version BIGINT, deleted, owner_id, conversation_id, run_id, plan_id, updated_at, payload_json LONGTEXT`。有 owner/分页、conversation、run、plan、entity 索引。`object_id` 为执行记录身份或派生对象身份的 SHA256；正文保留实体所需字段。

实体种类包含 conversations、runs、plans、plan_steps、plan_revision_snapshots、run_outcomes、run_round_results、results、artifacts、archives、run_input_messages、sources、run_sources。TiDB 不新增细粒度 `run_events`，不逐条投影流增量、模型输出或 Action 观察。会话最近 Run、数量与列表摘要由 TiDB 已入库实体计算。

每个对象独立递增版本，与 Run 事件序号无关。Redis 原生 COMMIT Lua 在执行记录同一提交内登记更新；同对象待办合并为最新版本，保留最早积压时间。payload 以不经 Lua 解码的 JSON 字符串保存，确保空数组等类型保真。

SQL 在事务内按固定锁顺序分块多行写入（最多 50 行/约 1 MiB 每语句）；只有更高对象版本可替换未删除行。墓碑不可被迟到投影或更高版本重新创建。相同 ID 的实体不支持删除后复活。

## 入库、删除与恢复

会话创建/标题、Run 接纳/终态、Plan/Step/修订、Result/Outcome、关联源、删除等实体变化自动产生待办；流式事件不产生待办。失败/取消时已形成的发布结果和有效部分成果保留。

后台 worker 单实例仅一批在途，批量上限可配。SQL commit 成功后才 CAS 确认 Redis 待办；确认或重试只影响相同版本，旧确认不能删除新待办。响应丢失保留任务，重复消费、乱序和多个 worker 由版本条件保持幂等，无需新租约。任务、尝试次数、下一次重试时间和错误保存在 Redis，重启继续；重试只重写历史，不重跑模型/工具。

删除在执行记录提交时产生对象墓碑；派生对象随源对象删除或执行删除链登记。查询入口检查 owner 和根 Run/Conversation，迟到子实体不能恢复已删除会话/Run。归档发布检查 Run 仍存在且未删除，避免删除后再发布。

worker 使用独立读写连接池（默认各 2，最大 16）、操作/连接超时（默认 3000ms）、有限批量（默认 100，最大 1000）、周期（1000ms）、指数退避（1000～60000ms）。超时连接销毁；不排队等待池容量。TiDB 连接/DDL 延迟到历史查询或后台处理，服务启动和 Run 不等待它。

`/api/history/status` 暴露 pendingCount、oldestAgeMs、lastSuccessAt、lastFailureAt、lastError、retries、lastLatencyMs、acknowledged，以及归档状态/错误；错误同时写服务日志。历史 HTTP 失败明确返回，页面提供重试，不读取整份 Redis 历史冒充 TiDB。

## 文件及归档

文件归档和 TiDB worker 独立。终态 Run 的完整 records 快照与分段事件先写不可变文件、fsync、校验，再发布 manifest 引用；快照的纯 records 乐观冲突可重试，范围不含外部效果。归档是可重建的后台任务，重启可重新校验和发布，不依赖 SQL 成功。

实际产物从工具回执与文件重新验证取得名称/MIME/大小/SHA256；将内容复制到 `artifacts/<sha256>.bin` 后发布稳定引用。大于 64 KiB 的历史正文存入 `history-content/<sha256>.json`，读取时校验并还原。过程 manifest 保存 schema、事件版本和校验和。完整过程缺失/损坏显式报错。

Data Agent 终态产物列表、预览和下载通过 history view 读取 TiDB 元数据及校验过的不可变文件；请求内下载，不把临时签名 URL 入库。当前实现为本机文件后端；远程共享对象存储可实现相同 RuntimeArchiveStore，但本轮未部署/验证远程对象存储。

本轮无自动 Redis 清理。未来清理必须另行实现并同时验证 TiDB 已确认、内容/归档完整及保留期；不得清理 active/HIL/待恢复/未确认任务。旧库、旧表、旧 namespace 和历史文件均保留。

## 页面来源与配置

- 左侧分页：TiDB，稳定 `(updated_at DESC, object_id DESC)` cursor；同 ID 合并。
- 新建/尚未入库：页面立即显示 accepted Run，在 sessionStorage 保存有限乐观显示快照；SQL 追上同 Run 及终态后移除，避免重复或迟到 running 回退。
- 终态输入、Plan/Step、最终回答、Result/Outcome、产物：TiDB。
- 活跃进度、HIL、恢复、取消、SSE：Redis。
- 详细过程：近期 Redis；缺失/缺口时读取已确认且校验的归档。
- SQL 故障：历史失败与重试提示；composer 和正在执行的 SSE 可继续。

Data Agent 历史连接优先级：`DATA_AGENT_HISTORY_TIDB_URL` > `DATA_AGENT_RUNTIME_SUMMARY_TIDB_URL` > `DATA_AGENT_TIDB_URL`，三者均只用于异步历史与查询；Redis 通过 `DATA_AGENT_REDIS_URL`、`DATA_AGENT_REDIS_STATE_PREFIX`；`DATA_AGENT_STATE_BACKEND=sqlite` 时不要求历史连接。业务 Skill 的目录库和查询库、nl2sql_skill/nl2sql_group 未调整。

可调项：`DATA_AGENT_HISTORY_CONNECTION_LIMIT/TIMEOUT_MS/BATCH_SIZE/INTERVAL_MS/RETRY_BASE_MS/RETRY_MAX_MS`。Multi Runtime 对应 `RUNTIME_HISTORY_*`，URL 兼容 `RUNTIME_SUMMARY_TIDB_URL`。

实际独立 Data Agent 8810 使用现有 Redis 与 `DATA_AGENT_TIDB_URL` 历史兼容入口，历史库 `agentloop_data_agent`；未输出凭证。Report Agent 8820 实际启动为 SQLite。两者在直接确认执行存储中 active Run 为 0 后优雅重启。

## 打包、实际服务与验证证据

最终内核包 SHA256：`78b17ae1320304ad9e585fe04c2014a9f219900a9e238c1e353f47ec9d737922`。

两个独立仓库实际依赖 `vendor/zhujun-agentloop-0.1.0-history-78b17ae13203.tgz`；包内 388 个 dist 文件、构建产物和两个 node_modules 安装树逐文件匹配，实际解析入口也核对。详见 `packages/agentloop/verification/history/installation.json`。

8810 最终安装版本的实际模型 Run `6bb2c7f6-60b0-47d9-abfb-0cf699b7172e` completed，真正调用 load_skill；89 连续事件、8 流相关事件、5 成功 Action，TiDB 最终回答/Plan/Outcome/用量/归档确认，pendingCount=0。详见 `installed-live.json`。

验证脚本及脱敏 JSON 在 `packages/agentloop/verification/` 与 `verification/history/`。测试使用新建临时 TiDB 数据库、隔离 Redis/namespace/目录/端口；没有删除原数据库或历史。

- `tidb-faults.json`：真实 TiDB 提交响应丢失、旧 running 与终态乱序、旧确认、多 worker、删除迟到/复活、Redis 重新连接恢复、SQL 初始化失败后恢复、大结果文件校验。
- `http-outage.json`：SQL socket 在启动前卡住，服务约 639ms 启动，Run 约 31ms 接纳；实际模型与 load_skill 完成，归档先完成，9 个待办；服务重启/网络恢复后补写为 0。SQL-only sentinel 会话在 Redis 不存在，却出现在 HTTP TiDB 列表。
- `tidb-artifact.json`：真实 computer_write_file 写 CSV，TiDB 元数据与实际字节校验一致；修改原工作区文件后，历史下载/预览仍读原始不可变内容。该文件明确标记为 process，并未冒充 accepted final deliverable。
- 原生/历史回归 63/63（含流式/提前工具、Action 成功/失败事务、重启、归档缺口与校验损坏、数组保真）。仓库内 Data 21/21，独立 Data 48/48 与 Redis 状态 6/6，Report 48/48，Local Runtime 124/124，Desktop 221/221。内核构建与两个独立应用 typecheck 通过。

浏览器已观察正常历史刷新后的已完成会话，以及 TiDB 卡住时明确的历史失败/重试提示。延迟期间的新会话/活跃状态合并由页面状态回归与真实 HTTP 故障测试覆盖；完整浏览器“提交→故障中刷新→恢复后去重”交互未全部走完，不将其记为通过。

完整内核基线仍有两项失败：unit 333/334，TiDB profile migration mock 预期 information_schema 而实现使用 SHOW CREATE TABLE；kernel 659 pass/1 fail/2 skipped，failure-report no_progress 的 RUN_LIMIT_EXCEEDED 与 STEP_NOT_COMPLETED 预期不符。已在移除本次 history hooks 的临时基线副本复现，未混入本次修复。Multi Runtime 全量类型检查在现有 tests 有错误；contracts 9/10，现有 RouterService 类型引用契约失败；本轮宿主装配没有报类型错误，未部署 Multi Runtime。

## 性能证据与边界

最终本机 TiDB 8.5、Redis AOF always，脚本工具 fixture，各 16 Run、并发 4；每组 16 个 Run 和 16 个归档成功，恢复后 backlog=0。测量包含当前后台负载，非隔离容量测试。

| TiDB 状态 | Run/s | 执行 P50/P95 ms | 执行结束待办 | 入库 P50/P95 ms | SQL 活跃时间对象/s |
|---|---:|---:|---:|---:|---:|
| 正常 | 2.80 | 1439/1650 | 1 | 44/1095 | 128.9 |
| 每批额外350ms | 2.49 | 1390/2231 | 28 | 651/815 | 33.9 |
| ECONNREFUSED后恢复 | 2.54 | 1648/1978 | 144 | 2893/6515 | 2646.0 |

最后一列只计算成功写批的活跃时间，故障恢复数值是短时补写速率，不是持续吞吐。真实 SELECT SLEEP(2) 被约 150ms 超时中断并可重连。源码执行没有 await TiDB，但 Redis 任务、后台 CPU/I/O 与重试仍有成本；短测中执行 P95 变化可见，不能宣称没有性能影响。尚未做长时间、大规模、多机器或远程对象存储压测。
