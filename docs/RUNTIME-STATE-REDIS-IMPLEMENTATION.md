> 历史兼容实现说明：本文描述内存 SQLite + changeset，**不是 Redis 原生后端**。当前实现、配置与验证请见 [Runtime 原生状态后端](RUNTIME-NATIVE-RECORDS-STATUS.md)。

# 旧 Redis changeset 兼容实现：历史实现与验证

> 2026-11-25 更正：下文描述的是“内存 SQLite + Redis changeset 日志”兼容适配器，不能作为 Redis 原生服务端 Runtime 后端完成的证据。新的记录访问边界、原生 Redis 记录层及尚未完成的接入工作，见 [RUNTIME-NATIVE-RECORDS-STATUS.md](RUNTIME-NATIVE-RECORDS-STATUS.md)。下文验证数字属于旧实现，不能转用于新后端验收。

2026-11-24。本文件描述当前实现，替代旧设计中尚未实现的领域命令拆分建议。

## 边界

Kernel 新增 RuntimeStateStore、RuntimeStateConnection、RedisRuntimeStateStore 和 RuntimeStateMaintenance。原有 AppDatabase/Repository/RunService 的领域事务及 SQLite 默认行为保留。

RuntimeStateConnection 使用 node:sqlite 的内存数据库作为关系查询视图，记录 SQLite Session 的事务行变更。事务命令具有 UUID、Runtime 全局版本和 SHA-256 校验；Schema 变化使用带完整表数据的快照记录。Redis 不执行 SQL，仅原子保存版本、提交回执及二进制变更日志。此次采用 Runtime 全局提交序列，保留跨表乃至父子 Run 事务；没有先将数百个 SQL 调用逐一改写成 Lua 状态机。

提交顺序是：执行原有事务、检查延迟外键、生成变更、Redis 持久化确认、提交内存视图、返回调用方。回滚不产生持久提交；提交响应丢失时查询 UUID 回执；不能确认时停止该连接继续写入，重启重放。并发读等待提交，不能观察暂存状态。Redis 全局版本拒绝另一个过期视图的写入，不使用 writer 租约或心跳。

Redis 要求 AOF、appendfsync always、noeviction，且 key 类型必须匹配。每个命令有大小限制、整个日志有容量限制和提前限制新 Run 的接口；大对象应存文件。进程重启从持久日志恢复全部关系视图，校验格式、版本连续性、哈希与外键。

## 三端接入

- Data Agent 显式选择 RuntimeStateConnection。Action、Plan、预算、HIL、恢复、输入、MCP 调用记录、幂等记录及运行查询均使用同一视图，执行期间不再访问远程状态 SQL。
- Desktop / Local Runtime 不选择新后端，继续使用原 SQLite 文件和原事务。
- Report Agent 不选择新后端，继续使用自身 SQLite 配置；只更新安装的 Kernel tarball。

Data Agent 首次迁移先排空旧 Redis 事件队列，然后按依赖表顺序和主键游标分批导入有效 SQL 历史，每批保存迁移进度。源库悬空引用按用户允许跳过并记录数量；没有修改源表。初始化后重启不再依赖 TiDB 历史读取。进程中断可从已提交游标继续。

## 后台消费者

RuntimeStateMaintenance 与执行事务使用独立 async context。TiDB 后台摘要写入与磁盘归档分别运行，一方失败不能阻止另一方。

TiDB 的 runtime_run_records 保留 Run 摘要、Plan 定义/最终步骤状态、最终回答和 Outcome；不保存逐事件过程或 Step evidence_json。相同内容不重复投影，更新有版本保护，删除写 tombstone，旧投影不能覆盖新版本。

磁盘保存连续提交分段、带校验的归档游标，以及按 namespace/owner/conversation/run 隔离的终态详情。文件使用临时写入、fsync、rename 和目录同步，游标只在文件确认后推进。记录包含原始行变更，可用于恢复；不能只把 UI 事件当成恢复日志。

## 保留策略和范围

当前不自动裁剪 Redis 详细日志，不将 Redis 当作可清空缓存。默认容量由宿主配置；Data Agent 默认 2 GiB，80% 时限制新 Run，现有 Run 使用预留空间。持久化硬失败不能假装成功。自动历史卸载、从归档按需装载和跨主机接管没有在本版本启用。

一个 namespace 由一个受管理 Runtime 宿主执行。内存关系视图与 Redis 日志均按 Runtime 保存，过程文件另按会话隔离。共享磁盘不能防止主机/磁盘故障，备份和异地复制需独立部署。工具已执行但结果未提交仍按既有 replayPolicy 处理，存储后端不承诺外部副作用恰好一次。

## 验证

- 内核状态契约 9 项通过：完整 Run/Action/事件/终态恢复、事务回滚、延迟外键提交前验证、读取隔离、响应丢失、持久化失败、Schema 迁移、损坏拒绝、归档和投影故障/删除。
- Data Agent 应用 47 项通过；真实 Redis/TiDB 集成 4 项通过，覆盖 SQL 故障、原生 HIL、并发、幂等、Redis 重启、HTTP/SSE、容量、版本冲突、旧事件迁移及断库重开。
- Desktop 220 项、Local Runtime 123 项通过；包含真实 SQLite 文件、HTTP Run、事件游标、用户确认及重启恢复。测试使用已有、安装 packaging 的 Python 3.12.8。
- Report Agent 应用 47 项、Python 32 项通过；包含 SQLite 重开、HIL、实际模拟报告与产物下载。
- 各端类型检查通过；Data Agent 与 Report Agent 安装的 dist 文件树哈希与 Kernel 构建相同。
- 内核既有两项失败仍存在：TiDB profile migration 旧 CHECK_CONSTRAINTS 断言；no_progress 旧错误码断言。完整内核单元 332 通过/1 失败；回归 634 通过/1 失败/2 跳过。

验证证据：/Users/zhujun/coding/data-agent/outputs/runtime-state/verification/summary.json。源代码/打包安装、当前服务启动和业务查询性能是不同证据边界；本次未据此宣称同题问数缩短多少秒，也未替换已安装的 Desktop 发行包。
