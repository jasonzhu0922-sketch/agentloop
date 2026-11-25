# Runtime 原生状态后端

实现入口是 `openRuntimeState(RuntimeStateConfig)`，配置只在启动时选择，不热切换。`RunService` 和领域 Repository 接收 `RuntimePersistence`；SQLite 兼容入口只在适配器中归一化，业务流程没有 backend 分支。

```ts
const state = await openRuntimeState({ backend: "sqlite", filename: "/data/runtime.sqlite" });
// 或
const state = await openRuntimeState({ backend: "redis", url: process.env.REDIS_URL!, namespace: "agentloop:{deployment}" });
const runs = new RunService({ database: state, skills, modelFactory });
```

SQLite 使用磁盘数据库和原有约束。Redis 使用独立记录 Hash、记录版本、唯一约束声明、查询 Set、每 Run 有序事件索引以及提交回执；原生执行路径不导入 SQLite，不解释 SQL，也不向 Redis 发送 SQL。旧 `RuntimeStateConnection` 是内存 SQLite + changeset 兼容实现，只供历史兼容与显式离线迁移，不能当成原生后端。

## 事务和并发契约

Run、Conversation、Plan/Step、Action、输入消费/幂等、预算、Canonical State、HIL、恢复、Round/Checkpoint、Result/Outcome、事件和宿主接入回执都经过同一记录接口。跨 Run/父子 Run/Conversation 的已有事务继续是一个提交；没有把这些操作拆成独立、不一致的提交。删除先核验活动 Action/恢复状态，再在同一事务级联，并写下独立删除墓碑供后台摘要使用。

SQLite 使用单机事务。Redis 在调用线程暂存本次事务的读取和写入，以 Lua 原子检查每个记录/所读索引的版本、唯一约束、引用及 key 类型，再更新记录、索引、事件序号、提交回执。写入失败不发布临时状态；回包丢失查询同一命令回执，不重跑带副作用的回调。不确定提交抛出 `RuntimeCommitUncertain`，可在新连接 `inspectCommit(commandId)` 后核验领域状态。并发冲突只拒绝本次操作，不停止整个实例。纯 `find` 在快照冲突时有限重读；领域事务和外部效果不自动重试。

不同 Run 不共用等待 Redis 确认的执行锁。一个 namespace 是一个 Redis 数据分区，事务涉及的 key 必须位于同一 Redis primary；本客户端不支持 Redis Cluster 重定向。生产可按租户/部署分配 namespace；需要跨 Run 原子操作的记录不能跨 namespace。不同 namespace 的事务不能宣称原子。没有新 Runtime writer 租约或启动抢占。Action fence、输入消费租约、规划恢复租约和业务 dispatch 占用保留原契约。

宿主创建 Run 时同时持久化 `runtime_executors` 的稳定 runtimeId。每个同时运行的执行实例必须使用不同 runtimeId；重启后仅协调属于自身的 Run。相同 runtimeId 的重复进程不是受支持的部署；没有后台自动抢占/故障转移。控制面的节点健康心跳是既有路由机制，与状态写入互斥无关。输入/HIL/恢复/取消命令由内核验证归属，错误实例返回 409 与 `runtime_execution_owner_mismatch`、目标 runtimeId，路由层必须转发或保持亲和性；跨实例读取和 SSE 补齐使用共享 primary。

## 持久化与保留

Redis 启动要求 AOF 已启用、`appendfsync always`、`noeviction`、AOF 最近写入状态正常。Redis 返回确认是状态提交边界；失败不降级。请按数据量配置 Redis 内存和磁盘，监控 fsync 延迟及 AOF 错误。此实现没有副本多数派确认，也未验证主从故障转移安全性。

`RuntimeRecordMaintenance` 的归档和摘要是两个独立后台工作，不参与 Run 提交。TiDB 故障不会阻止文件归档或 Run 推进。`SqlRuntimeSummarySink` 仅投影终态 Run、Plan、最终答案和 Outcome 到新增的 `runtime_run_summaries`，按事件序号防止旧投影覆盖新终态/删除墓碑；不会把新增过程事件写入 TiDB `run_events`。旧 SQL 表原样保留。

终态快照、每 250 条的校验事件分段、最后写入的 manifest 构成可验证归档。`FileRuntimeArchiveStore` 使用受保护文件、fsync 和 SHA-256 校验；`RuntimeArchiveStore.put/get` 是远程对象存储适配边界。`restoreRuntimeArchives` 或迁移工具的 `restore-archive` 在导入前校验所有对象。父子 Run/共享引用应一起选取对应 manifest；缺少依赖、冲突快照或缺失事件会显式失败。运行中的 Run 依靠 Redis/AOF 当前记录恢复，不在启动时重放全部历史。

大文件始终保留在工作目录/文件存储。多个服务端实例必须把 `WORKSPACE_ROOT`/Data Agent `DATA_AGENT_WORKSPACE_DIR` 指向相同路径的共享持久卷；归档 store 不自动复制这些业务文件。对象存储接入需要宿主 materialize 到工作目录。备份/恢复必须配套校验共享文件，不能只有 Redis 元数据。未实现自动冷数据裁剪/TTL；归档成功也不会自动删除 Redis 数据。后台去重缓存有界，历史 Redis 数据及幂等回执仍需容量规划。

## 应用默认值

| 宿主 | 默认 | 选择方法 |
| --- | --- | --- |
| Desktop | sqlite | 设备 .env 的 `AGENTLOOP_RUNTIME_STATE_BACKEND=sqlite|redis`；默认不连接 Runtime Redis/TiDB |
| Local Runtime / Multi Runtime 的 Local Agent | sqlite | `LocalRuntimeHostOptions.stateConfig` / Manager `stateConfig`；Local Agent 环境变量同 Runtime Host，默认 sqlite |
| 仓库内 Data Agent | redis | `DATA_AGENT_STATE_BACKEND=sqlite|redis` |
| 独立 Data Agent | redis | 同上，使用同一个内核实现 |
| 独立 Report Agent | sqlite | `REPORT_AGENT_STATE_BACKEND=sqlite|redis` 或数据连接页保存后重启 |
| Multi Runtime 服务端 Runtime Host | redis | `AGENTLOOP_RUNTIME_STATE_BACKEND=sqlite|redis` |
| Account Service / Router / Web | 不属于 Runtime 执行状态宿主 | 原有身份/控制面 SQL 配置独立保留 |

Desktop：设备 `.env` 可选择 Redis，必须配置 `AGENTLOOP_RUNTIME_REDIS_URL`、`AGENTLOOP_RUNTIME_REDIS_NAMESPACE`；按 Runtime storageKey 和账户隔离派生 namespace。Local Runtime 的本机配置、目录权限、Skill catalogue 与 Memory 库仍在 SQLite，执行证据通过统一记录接口读取。Memory 使用每 Run 持久游标，不依赖 SQLite rowid；升级时可幂等重扫。Local Agent 同样可使用上述环境变量，namespace 按 storageKey 派生。各设备须使用独立 base namespace。Local Runtime 的归档位于各 Runtime 根下 `runtime-state-archive`。

Data Agent：SQLite 文件 `DATA_AGENT_SQLITE_FILE`；Redis URL `DATA_AGENT_REDIS_URL`；namespace `DATA_AGENT_REDIS_STATE_PREFIX` 保持原来的绝对文件目录 SHA-256 推导公式，迁移机器应显式固定旧值。`DATA_AGENT_RUNTIME_ID` 指定执行分区。旧 `DATA_AGENT_REDIS_IMPORT_LEGACY=true` 不再执行启动导入，必须离线迁移；旧 changeset 字节限额不再适用。旧 TiDB URL/connection-settings 文件存在且未显式选择后端时拒绝启动，避免无声切换到空历史。可选后台摘要为 `DATA_AGENT_RUNTIME_SUMMARY_TIDB_URL`。

Report Agent：`REPORT_AGENT_SQLITE_FILE`、`REPORT_AGENT_REDIS_URL`、`REPORT_AGENT_REDIS_NAMESPACE`、`REPORT_AGENT_RUNTIME_ID`。旧 `runtime-connection/v1` 可读且不改写；旧 TiDB 执行配置会明确要求迁移，不能当成 Redis。业务 Connector 配置不变。

Runtime Host：`AGENTLOOP_RUNTIME_REDIS_URL`、`AGENTLOOP_RUNTIME_REDIS_NAMESPACE`（默认 `agentloop-runtime-state`）、稳定的 `RUNTIME_ID`；SQLite 文件 `DATABASE_PATH`。`RUNTIME_SUMMARY_TIDB_URL` 可选；`RUNTIME_ARCHIVE_ROOT` 应指向共享持久卷。Router 的 `AGENTLOOP_ROUTER_STATE_*` 仍管理控制面 SQL，旧 `AGENTLOOP_RUNTIME_STATE_DRIVER/DATABASE_URL` 仅供历史迁移脚本使用。旧 Runtime SQL 环境存在且未显式设置新 backend 时拒绝启动，需先离线迁移。Docker 示例提供持久 AOF Redis；生产和 Kubernetes 注入共享 Redis 地址。

## 离线迁移与恢复

如果明确放弃旧执行历史，可以停止全部 writer 后执行 `agentloop-runtime-state initialize-empty target.json empty-audit.json --writers-stopped`。目标配置同 Redis 导入，包含当前旧日志的准确 `legacyVersion`；命令独占创建带校验和的空状态凭据，仅对空原生目标完成初始化，拒绝已有不同数据。随后显式设置宿主 backend 并重启。此操作不复制旧记录，旧 Redis 日志和 SQL 表仍保留；业务 Skill 目录及文件不受影响。不能仅设置 backend 绕过未处理的旧 namespace。

切配置不会共享或复制历史；先停止所有旧/新写入方、备份 SQLite/Redis AOF/旧 TiDB 与文件卷，再迁移。不要在真实数据上试验。迁移工具只操作明确的配置文件，凭据文件应为 0600：

```sh
npm run build --workspace @zhujun/agentloop
# 安装包也提供 agentloop-runtime-state 命令
node packages/agentloop/scripts/transfer-runtime-state.mjs export source.json backup.json --writers-stopped
node packages/agentloop/scripts/transfer-runtime-state.mjs import target.json backup.json --writers-stopped
```

源配置支持 `{backend:"sqlite",filename:...}`、`{backend:"redis",url:...,namespace:...}`、`{backend:"legacy-redis",url:...,namespace:...}` 和 `{backend:"tidb",url:...}`（两个旧源还需指定 `legacyEventOutbox`）。SQLite 使用只读源的 backup API；旧 Redis 只在离线工具中重放 changeset；TiDB 只 SELECT，写入/建表只发生在临时磁盘 staging。工具保留 staging 路径便于诊断。

备份包含表行数和 SHA-256。导入按引用依赖排序，支持完全相同备份的断点续传，拒绝目标已有差异/额外记录，最后重新导出核验行数和校验和。旧 namespace 保持不变，原生记录在 `:native-v2` 下；旧 changeset version 不为零时目标配置必须提供准确 `legacyVersion`。迁移期间 namespace 标记为 importing，正常启动被拒绝；只有核验成功并且旧 version 未变化才写 complete 标记。旧日志不删除；旧 writer 此后再写会导致新启动拒绝，不能两套同时运行。

旧宿主 request/MCP/dispatch 表有显式映射。已人工确认的悬空记录可在源配置 `confirmedOrphans:[{table,key:{主键:值},reason:"审核原因"}]` 中精确列举；仅从 staging 跳过，输出数量与原因。未确认的悬空/循环引用会停止迁移。旧源配置必须显式提供 `legacyEventOutbox:null`（已确认从未使用）或 `{url,prefix}`。工具检查 pending stream、batches 均为空，并核对保留的序号计数与已投影事件最高序号；不隐式消费应用私有 outbox。非空队列或序号不一致会停止导出。

归档恢复：目标配置增加 `archiveRoot`，将需恢复的全部 manifest 的 `{key,sha256}` 数组写入 references.json，再运行 `transfer-runtime-state.mjs restore-archive target.json references.json --writers-stopped`。元数据恢复后还要恢复同路径文件卷。迁移失败时保留源数据、备份和 staging，停止目标、修复已确认的原因后续传；回到原后端需使用原有配置和原历史，不能把新后端新增历史自动带回。

## 本次验证记录（2026-11-25）

可重查的日志、包内容校验和、源文件哈希与原始性能数据保存在 `packages/agentloop/verification/runtime-records/summary.json` 及同目录。验证使用临时数据库、Redis namespace、目录与端口，没有重启当前服务或触碰真实业务历史。

| 范围 | 结果 |
| --- | --- |
| 内核编译、44 表静态 schema 检查 | 通过 |
| SQLite/真实 AOF Redis 共用契约 + 诊断 | 50/50：包含完整执行、预算/输入幂等、Action fence、HIL 重开、回滚/回包丢失/持久化失败、并发、多进程、事件补齐、删除、归档恢复及摘要重试 |
| Local Runtime | 124/124：实际 Redis factory 创建/完成新 Run、重开幂等、Memory 证据、删除墓碑与 SQLite→Redis→SQLite 隔离 |
| Desktop | 类型检查通过，221/221：账户与应用启动、确定性新 Run、配置选择；未启动真实 Electron GUI/安装新系统安装包 |
| 仓库 Data Agent | 20/20 |
| 独立 Data Agent | 类型检查、47/47；真实 Redis 应用套件 6/6（其中两项明确验证旧兼容适配器）；真实 HTTP 接纳新 Run，在 Runtime SQL 离线时完成 HIL、文件工具、重启/恢复和终态；业务连接管理 17/17 |
| 独立 Report Agent | 类型检查、48/48；包含临时 HTTP 启动、新 SQLite Run 完成、SSE Last-Event-ID 和重开 |
| Runtime Host | 源码类型检查通过，6/6 接入/归属/取消恢复路由/部署契约 |
| 内核广泛回归 | unit 332/333；kernel 634 通过、1 失败、2 跳过。两项失败已在任务开始源码副本复现：TiDB profile 迁移断言、no_progress 错误码断言 |

两个独立应用均重新安装内容哈希包 `zhujun-agentloop-0.1.0-native-002667e6e3c3.tgz`，安装的整个 `dist` 树 SHA-256 与本次内核构建一致，迁移 CLI 也已随包安装。新 Run 使用确定性模型与隔离工具 fixture，没有重放真实业务查询或调用真实模型。Multi Runtime 全量类型检查仍有已有测试类型错误；扩展检查 Local Agent main 另有原有工具导出名/可选值类型错误，未改动那些无关代码。

完整 RunService 的 256 Run、并发 16、两个服务对象对比（本机临时 Redis，AOF always，无 HTTP/真实模型/后台归档负载）：

| 后端 | Run/s | Run p95 | Redis 命令响应对/Run |
| --- | ---: | ---: | ---: |
| 磁盘 SQLite | 173.78 | 111.7 ms | 0 |
| Redis 原生记录 | 7.46 | 2349.8 ms | 453 |
| 旧 SQLite changeset Redis | 4.04 | 4871.0 ms | 47 |

原生 Redis 命令延迟 p50/p95 为 4.38/10.04 ms；命令数是客户端请求/响应对计数，不是 TCP 包数。32 Run 的并发 1/8/16 扫描也保存原始结果：原生吞吐 4.07/5.59/8.59 Run/s，旧后端 4.34/4.22/4.26 Run/s。原生实现已解除跨 Run 的全局确认锁，但 453 次命令/Run 的读取、索引/版本核验和持久化往返仍是明显瓶颈，不能宣称生产高并发性能完成。此数据不是多进程吞吐或生产长期压测。

尚有限制：每 namespace 单 Redis primary，不支持 Cluster 重定向/副本多数派安全性/执行实例自动接管；控制写入要求执行归属亲和性。没有自动历史 TTL/裁剪；离线导出仍会在进程内装载全量记录，循环历史依赖会明确拒绝。未取得安全临时 TiDB 服务，真实 TiDB 历史迁移和 SQL 协议投影尚未集成验收；已验证 SQL 完全不可用、投影重试与旧投影防覆盖。共享文件路径必须由部署提供，对象存储需宿主适配。旧 PostgreSQL 生产发布脚本的原生 Redis 备份/回滚编排仍待实现，当前不能直接用于新后端自动发布。
