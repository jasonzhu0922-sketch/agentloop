> 历史设计记录：以下 SQL/changeset 阶段说明已被 `docs/RUNTIME-NATIVE-RECORDS-STATUS.md` 的领域记录实现取代，不能用作当前部署契约。

# Runtime 状态后端边界与 Redis 迁移设计

## 结论

Redis 可以作为 Runtime 的可选状态后端，但它不是一个只替换查询接口的缓存层。对会影响下一步执行、并发条件或终态判断的状态，写入和读取必须使用同一个权威视图；否则会出现 Redis 读到新状态、TiDB 仍是旧状态，下一次条件更新又把新状态覆盖的问题。

当前事件日志已经具备一个独立的 Redis journal：Redis 先确认事件并分配 Run 序号，TiDB 后台批量投影。这个边界只覆盖 `run_events`，不能推导出 Action、Plan、预算或终态状态也已经异步化。

## 当前影响面

直接 SQL 使用分布在 Runtime、Planning 和 Storage repositories 中。最近的只读审计结果为：

- 28 个文件包含直接 SQL 调用；
- 约 372 个 `prepare`、`exec` 或间接事务调用；
- 56 个事务边界；
- 主要跨表状态包括 `runs`、`runtime_actions`、`plans`、`plan_steps`、`run_inputs`、`run_recovery_states`、`run_planning_budgets`、`run_rounds`、`canonical_run_states`、`run_outcomes` 和 Result/Artifact 元数据。

因此不能把一个 Redis Hash 接到某个 Repository 的 `get()` 上，就认为状态迁移完成。必须先把每个领域的命令、版本条件和投影边界固定下来。

## Redis 的定位

Redis 后端应由宿主显式注入，不能因为存在 `DATA_AGENT_REDIS_URL` 就自动改变 Runtime 的一致性模型。建议提供两种明确模式：

| 模式 | 权威写入 | 运行中读取 | 历史读取 | 适用宿主 |
| --- | --- | --- | --- | --- |
| `sql` | SQLite/TiDB/PostgreSQL 事务 | SQL | SQL | Desktop、Local Runtime、默认 Kernel 测试 |
| `redis-runtime` | Redis AOF + 版本化命令 | Redis 状态视图 | Redis 与 SQL 合并，SQL 投影完成后可只读 SQL | 需要跨网络隔离 Runtime 状态的服务 |

`redis-runtime` 的 TiDB 角色是可重放投影和历史归档，不是 Run 推进的同步依赖。Redis 必须启用 AOF、`appendfsync always`、`noeviction`；不满足时启动失败，不能静默降级到一个半 Redis、半 SQL 的混合模式。

## 必须保持在同一 Redis 原子操作中的状态

第一阶段只迁移运行控制面，不迁移业务结果和文件字节：

1. Run 的当前状态、执行版本、取消/停止请求和当前恢复标记；
2. Action 的创建、派发、结果提交、失败、取消和 revision/fence 条件；
3. Run Input 的去重、顺序、状态和 checkpoint；
4. Planning/Intent budget 的初始化、扣减、重试扩容；
5. Recovery proposal 的次数限制和状态转移；
6. 事件序号与事件 journal。

这些命令必须以 `(runtimeId, runId)` 为 Redis 原子分区键，以 `commandId` 幂等，以 `expectedVersion` 或 Action revision 做 CAS。禁止把 SQL 字符串、任意 Lua 片段或未校验 JSON 作为通用状态命令传入。

## 暂时继续由 SQL 负责的状态

Plan 完整定义、Canonical Run State、Round/Assessment、Result、Outcome、Artifact 元数据、Source 元数据、Skill 配置和历史对话在第一阶段仍由 SQL 事务负责。它们有跨表验证、历史重读和删除级联要求，应该在 Runtime 状态命令稳定后再迁移。

文件内容和 Workspace 不进入 Redis；Redis 只保存可重建的状态和命令，不保存大结果或凭据。

## 事务与恢复契约

每条状态命令至少包含：`commandId`、`runtimeId`、`runId`、`kind`、`expectedVersion`、`createdAt` 和规范化 payload。Redis Lua 脚本在同一分区内完成：校验版本、幂等检查、修改状态、追加命令日志和发布变更通知。

TiDB 投影器按命令序号批量写入，并保留 `runtime_state_command_commits(command_id, run_id, version)`。提交响应丢失时按 `commandId` 重放；Redis 重启时从 AOF 恢复；TiDB 投影失败时保留命令，不阻塞 Run。应用重启先恢复 Redis 未投影命令，再接受新的 Run。

终态的安全边界是：Redis 必须先完成不可逆的终态 CAS 和 Outcome 引用绑定，之后才允许向用户发布终态事件。TiDB 还未投影时，查询接口从 Redis 返回该终态；投影完成后两边必须通过 command/version 校验一致。

## 宿主兼容性

- Desktop 和 Local Runtime 当前不注入 `eventOutbox`，仍使用 SQL/SQLite；本设计不会自动改变它们。
- data-agent 当前注入 Redis event outbox，只启用事件 journal；Action、Plan、预算等状态仍是 SQL 权威，不能宣称已经脱离远端 TiDB。
- 新的 Redis Runtime 状态后端必须成为 `RunService` 的显式构造选项，并在同一选项下构造全部相关 Repository；不能让某些 Repository 读 Redis、另一些 Repository 写 SQL。
- 任何不支持命令日志、版本 CAS、重放和查询合并的宿主只能使用 `sql` 模式。

## 实施顺序

1. 先定义 `RuntimeStateStore`、命令类型、版本/CAS 和投影收据；为 SQL 实现建立等价适配器，不改变默认行为。
2. 将 Run/Input/Budget/Action 的读写集中到控制面 Repository，并用 Repository contract tests 固定事务语义。
3. 实现 Redis 命令日志和 Lua 原子状态机；先接 Run/Input，再接 Budget/Action，最后接 Recovery。
4. 将 Runtime 查询改成 `active Redis view + SQL historical view` 合并读取；所有游标使用 Runtime version，不使用数据库时间戳推断。
5. 接入终态、取消、恢复、删除和归档：删除必须写 tombstone，避免后台投影把已删除 Run 复活；归档后才允许只读 SQL。
6. 让 data-agent 显式选择模式，Desktop/Local Runtime 继续跑 SQL contract suite，再分别跑 Redis integration suite。

## 验收条件

- Redis 不可用时，`redis-runtime` 启动失败且不执行半状态迁移；`sql` 模式不受影响。
- SQL 投影阻塞时，模型、工具、Action 结果、取消和终态推进不等待投影；运行中查询能看到 Redis 状态。
- 同一 `commandId` 重放只产生一次状态变化；CAS 冲突不会覆盖更新状态。
- 进程在 Redis 写入后、SQL 投影前退出，重启后状态、事件序号和查询结果不丢失、不重复、不倒退。
- 回滚、取消、恢复、删除、归档及终态提交分别有失败注入测试；不能只测试正常 Action 创建。
- Desktop 220 项、Local Runtime 123 项现有测试继续通过；新增 Redis contract/integration suite 单独报告，不把 SQL 默认模式和 Redis 模式混为一个通过结论。
