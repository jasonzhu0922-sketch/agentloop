# Multi Runtime 共享状态与故障接管设计

状态：提案
适用范围：`apps/agentloop-multi-runtime` 的本地开发与生产部署
关联文档：[多 Runtime 负载分流设计](./MULTI-RUNTIME-LOAD-BALANCING-DESIGN.md)

## 1. 结论

Multi Runtime 的 Runtime Host 应是可替换的执行器，而不是某个 Run 的唯一状态所有者。

- **共享 workspace 保持不变。** 每个 Host 挂载同一个 POSIX 工作区根，`RunService` 继续按 `conversations/<conversationId>/` 隔离会话文件。
- **运行状态必须抽离出 Host 本地数据库。** Run、Plan、Step、事件、工具回执、恢复决策、Outcome、派发幂等和执行租约进入共享状态库。
- **生产使用 PostgreSQL + 对象存储 + RWX workspace。** PostgreSQL 负责事务状态；对象存储负责不可变附件与交付物；RWX 文件系统承载执行期间需要 POSIX 语义的工作区。
- **本地开发可使用共享 SQLite/WAL + 本地文件 BlobStore。** 它只适用于单机、低并发、本地磁盘；不是多节点生产方案。

这样，Host1 卸载或失联后，Router 能把未终结 Run 交给 Host2 从持久化边界恢复；不会把“Host1 的本地数据库仍可访问”当作可用性前提。

## 2. 当前拓扑与首个断裂边界

当前参考实现中，状态分布如下：

| 内容 | 当前位置 | 是否可被另一 Host 接管 | 问题 |
|---|---|---:|---|
| Router Assignment、节点心跳 | Router `control-plane.db` | 部分可以 | 不包含 Run 的完整执行事实 |
| Run、Plan、Step、事件、Action、Outcome | `data/local/<runtime>/agentloop.db` | 不可以 | Host 下线后无法读取或恢复 |
| Dispatch 幂等账本 | Host 本地 `mr_host_dispatches` | 不可以 | 新 Host 无法确认旧派发是否已接受 |
| 上传附件索引和文件 | Router 本地 JSON 与目录 | 不可以 | Router 失效、扩容或迁移后不可用 |
| 执行 workspace | 统一挂载 `WORKSPACE_ROOT` | 可以 | 需要继续保持共享 POSIX 语义 |
| Skill 包缓存 | Host 本地 | 不应成为恢复依据 | 恢复必须依赖版本化、可复取的 Skill 输入 |

首个语义断裂边界是：**Run 的权威状态与其执行 Host 绑定。** 即使 workspace 已被所有 Host 共享，Host2 也没有 Plan、工具回执、步骤状态和 Outcome，无法判断从何处安全继续。

## 3. workspace 的边界

`workspace` 不是需要迁移到对象存储的状态库。

现有 Compose 已把同一个 `RUNTIME_WORKSPACE_HOST_PATH` 挂载到每个 Runtime Host 的相同容器路径。`RunService` 在该根目录下使用 `conversations/<conversationId>/` 分隔会话，因此 Host 迁移时可以继续访问同一份执行文件、命令输出和中间产物。

workspace 的目标形态：

| 环境 | workspace 实现 | 原因 |
|---|---|---|
| 本地开发 | 本机目录或 Docker bind mount | 便于调试，所有本地 Host 看到同一文件树 |
| 生产 | RWX POSIX 文件系统，例如 EFS、CephFS 或受控 NFS | Tool、命令、临时文件和原子重命名需要文件系统语义 |

对象存储不替代执行 workspace。它只存放不可变对象：原始附件、最终交付物、可选 checkpoint 快照和大型工具结果引用。将活跃 workspace 直接替换成 S3 会破坏现有 Tool 的目录、锁、临时文件和进程执行语义。

## 4. 目标拓扑

```text
Browser
  │  创建任务、读取 SSE
  ▼
Router / Scheduler
  │  PostgreSQL: Task / Assignment / Run / Plan / Event / Action / Lease / Outcome
  │  Object storage: attachment / delivered artifact / snapshot
  │
  ├──── Host 1 ─┐
  ├──── Host 2 ─┼──── Shared POSIX workspace
  └──── Host N ─┘       conversations/<conversationId>/
```

Router 是任务与租约的调度权威；Host 是某一租约期内 Run 的执行者；`Run -> Plan -> evidence/receipts -> Assessment -> TerminalCommitter -> Outcome` 仍是完成权威。

## 5. 共享状态所有权

### 5.1 PostgreSQL

所有 Router 与 Host 连接同一个逻辑状态库。现有 `AppDatabase` 已接受注入的 `PgConnection`，因此仓储接口不应因数据库后端切换而重写。

必须中央化的表/事实包括：

- AgentLoop 内核表：`conversations`、`runs`、`plans`、`plan_steps`、`run_events`、`runtime_actions`、恢复记录、证据和 `run_outcomes`；
- Router 表：Runtime 节点、任务、Assignment、健康快照和调度事件；
- `run_leases`：Run 当前执行者、过期时间、fence、接管原因；
- `dispatch_receipts`：`dispatchKey` 与 Run 的幂等映射；
- 附件与交付物元数据：对象键、哈希、大小、媒体类型、所有者和保留策略；
- `conversation_runtime_migrations`：会话从旧 Host 迁移到新 Host 的原因和时间。

Host 本地只能保留可丢弃缓存，例如临时模型连接、容器沙箱、Skill 下载缓存与日志镜像。任何恢复所需的事实都不得只写入本地磁盘或进程内 Map。

### 5.2 对象存储

附件和交付物采用不可变对象键；数据库只保存元数据和 hash。建议键前缀：

```text
tenant/<tenantId>/conversation/<conversationId>/attachment/<attachmentId>
tenant/<tenantId>/run/<runId>/artifact/<artifactId>
tenant/<tenantId>/run/<runId>/checkpoint/<checkpointId>
```

Router 负责鉴权并向 Host 提供受限的读取凭据、短期签名 URL 或受信任内部代理。Host 不应知道对象存储的长期管理密钥。

## 6. 任务、亲和性与均衡调度

前端不选择、不保存也不预绑定 Runtime。提交只创建 `Task(queued)`；只有 Scheduler 实际取得可用槽位时才写入 Assignment 与 Host 租约。

调度顺序：

1. 筛选心跳有效、profile/capability/model 兼容且容量未满的 Host；
2. 对同一会话，将最后成功执行的 Host 视为**偏好**，而非强制绑定；
3. 若偏好 Host 为 healthy 且有容量，优先它；否则按归一化负载选择其他候选 Host；
4. 记录迁移事件并创建新的 lease；
5. Host 接受后才持久化 `remoteRunId` 与 accepted receipt。

独立会话始终按容量均衡。`reserved` 只是防止瞬时超卖，不能形成会话 affinity；只有已接受、存在 `remoteRunId` 的执行才可以成为 affinity 候选。

## 7. Run 租约与 fencing

一个 Run 在任意时间只能有一个有效执行者。

```text
queued -> assigned -> starting -> running -> terminal
                         │               │
                         └── dispatch fail┘
                                          │ lease expires / Host unhealthy
                                          ▼
                                     recovering -> assigned
```

`run_leases` 至少包含：`run_id`、`host_id`、`lease_expires_at`、`fence`、`state`、`updated_at`。

- Scheduler 以单个事务条件更新领取 lease，并递增 `fence`；
- Host 每次续约、写事件、改变 Step/Action 状态、提交 Outcome 都携带 fence；
- 写入只在 fence 与当前 lease 匹配时成功；
- Host1 网络分区后即使仍在运行，Host2 接管后 Host1 的旧 fence 也不能提交新状态；
- 仅凭一次 endpoint 错误不得立即双派发，应等待租约过期或获得明确的 fencing 保障。

`runtime_actions` 已有 replay policy、lease 与 fence 相关事实；Run 级 lease 应与之协作，而不是另起一套脱离 Action 回执的恢复逻辑。

## 8. 故障接管语义

Host 失联不等于可以从任意 CPU 指令位置无损迁移。恢复以已持久化执行边界为准：

| 边界 | 处理 |
|---|---|
| 已提交的 Tool receipt | 复用，不重放 |
| `safe` 或 `idempotent` 未完成 Action | 新 Host 可按原幂等键重试 |
| 外部副作用 Action 无确认回执 | 标记 `recovery_required`，不得自动重放 |
| 进行中的模型流 | 终止旧流；从已提交 Plan、事件和步骤边界重建上下文 |
| 终态已提交 | 只读投影，不能再接管 |

恢复 Host 必须重新读取共享 workspace，并通过 Tool receipt、文件 hash、Evidence 与 Assessment 决定下一动作。模型文本或文件存在本身都不是完成依据。

## 9. 本地与生产快速切换

统一使用后端配置，而不是为本地与生产维护两套 Router/Host 协议：

```text
AGENTLOOP_STATE_DRIVER=sqlite | postgres
AGENTLOOP_STATE_SQLITE_PATH=/state/agentloop.db
AGENTLOOP_STATE_DATABASE_URL=postgresql://...

AGENTLOOP_BLOB_DRIVER=filesystem | s3
AGENTLOOP_BLOB_ROOT=/shared/blobs
AGENTLOOP_BLOB_BUCKET=agentloop-artifacts

AGENTLOOP_WORKSPACE_ROOT=/workspace
```

| 模式 | 状态库 | BlobStore | workspace | 约束 |
|---|---|---|---|---|
| `local` | 一个共享 SQLite/WAL 文件 | 本地文件 | 本机共享目录 | 单机、低并发、本地磁盘；不可用于多节点生产 |
| `production` | PostgreSQL | S3 或兼容对象存储 | RWX POSIX 卷 | 多 Router、多 Host、可扩缩容 |

SQLite 模式需要显式配置 WAL、busy timeout、单一迁移者和 Router 先启动；不能把网络文件系统上的 SQLite 当作生产集群数据库。PostgreSQL 模式需要所有 Router/Host 使用同一连接串，并通过部署密钥管理系统注入凭据。

## 10. 实施阶段

1. **连接工厂**：为 Router 与 Runtime Host 增加统一 `StateStore`/数据库工厂，支持 SQLite 与 PostgreSQL；保持现有仓储调用面。
2. **共享运行态**：将 Host 的 `agentloop.db`、本地 dispatch ledger 与 Router control-plane 合并为同一逻辑状态库；Router 负责 schema 初始化。
3. **BlobStore**：抽象本地文件与 S3，实现 PostgreSQL 元数据、哈希校验和授权读取。
4. **租约接管**：实现 Run lease、fence、健康过期扫描、Assignment 重派和事件/Terminal 写入 fencing。
5. **安全恢复**：使用 Action replay policy、工具回执与共享 workspace 从最后安全边界恢复；对不安全窗口显式进入恢复待决。
6. **亲和性降级**：将会话 affinity 改为健康时的调度偏好；Host draining 或故障时记录迁移并重新均衡。
7. **演练与上线**：并行双写/导入历史状态、故障注入、回滚开关和生产可观测性验收。

历史本地 Run 不会因代码或存储拓扑升级自动变为可接管；它们需要显式导入、终结或重跑。

## 11. 验收标准

- 两个 Host 对同一共享状态库运行；独立会话按健康容量均衡。
- 新会话在前端创建时没有 Assignment 或 Host 绑定；派发成功后才有 accepted receipt。
- Host1 执行中断后，租约过期，Host2 对安全 Action 恢复；旧 Host 的 fence 写入被拒绝。
- 不安全外部副作用不会在接管期间自动重复执行。
- SSE 从共享 `run_events` 按序恢复，浏览器重连后能看到终态。
- workspace 文件在接管前后仍位于相同 `conversations/<conversationId>/` 路径；附件和交付物可通过 BlobStore 校验读取。
- 同一套 Router/Host 镜像仅通过环境配置切换 `local` 与 `production` 存储后端。
- PostgreSQL 故障切换、对象存储读取失败、Host 进程杀死、网络分区和 Router 重启均有自动化集成测试与运行手册。

## 12. 非目标

- 不承诺迁移正在飞行的模型 HTTP 请求、子进程或未持久化内存；
- 不承诺对未知副作用工具实现 exactly-once；
- 不让多个 Host 同时推进同一个 Run；
- 不把共享 workspace 作为跨 Host 读取 Run 数据库的替代物；
- 不以“调用成功”“产物存在”或模型最终文本替代 Assessment 与 Terminal Committer 的完成权威。
