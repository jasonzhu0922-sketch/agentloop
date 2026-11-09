# GoalPlan 与 Steer 实现记录

更新日期：2026-11-08。对应 [设计方案](./GOALPLAN-STEER-DESIGN.md)。本记录区分源码实现、自动化测试与实际部署验收。

## 已实现

- Plan 显式声明 `RoundScope`：`prerequisite` 研究轮可以关联单一最终目标而不提前承担交付；`delivery` 轮按当前范围准入，未满足的全局目标保持开放。
- Round Result 保留 scope、正式 Step Result、Assessment 和 canonical revision。后轮通过显式绑定读取前轮结果；相同结果内容更换 ID 不构成新进展。当前内容指纹比较不等于语义去重。
- `run_input_messages` 持久化原文、身份、顺序和处理决定；`run_input_controls` 提供序列化控制行、消费水位和租约。同请求同内容幂等，异内容冲突。
- 消息接收、工具派发、Step 提交、Round 提交及全部成功终态入口共用数据库栅栏。先接收的消息不能被完成提交越过；取消/失败会记录未处理原因。
- 初始 Planner 的旧结果不能跨越消息水位直接持久准入。执行中在模型、工具、Assessment、Step Post 和完成边界消费消息。
- 进度问答保留原目标；明确调整形成 canonical intent revision，并经 Planner、Admission、Plan Revision Assessment 提交。旧合同退休，已发生的 Action、回执和正式结果保留，显式绑定后可复用。
- 澄清形成持久 HIL 并暂停；绑定 request/revision 的结构化回答被写为新输入，携带原消息引用，再进入相同消费链路。已有 HIL 保留，普通 Steer 不构成对它的授权回答。
- 失败的语义处理释放消费租约；暂停 Run 的持久输入由恢复扫描重试。Local Runtime 的既有恢复定时器与 Runtime Host 的所属 Run 扫描接入同一队列。丢失执行权或未知副作用仍走既有恢复合同，不自动重放工具。
- Desktop、Router → Runtime Host、Router → Local Agent，以及 strict-local 接口贯通 GET/POST messages；请求沿原 Run 的 Runtime 绑定路由，校验认证及账户归属。
- Desktop 与 Multi Runtime 使用共享队列模块：发送加入草稿，点击 Steer 才提交；编辑/删除、稳定 ID、未知响应恢复、终态草稿保留、账户/会话隔离。Desktop 刷新会恢复选中的 Runtime/会话。队列采用紧凑单行布局，紧邻输入框；轮询不重建未变化的编辑区域，保留正在输入的草稿。服务端持久消息决定对话状态。
- Round 历史可展开查看本轮目的、完成条件和后续方向。

## 已验证

- Kernel、Local Runtime、Desktop 构建及 Desktop 类型检查。
- 内核单元测试；研究专用首轮 → 正式 Result → 第二轮交付的确定性完整 Run。
- 工具启动前的消息阻止旧动作；工具完成后的消息保留真实回执且不重复副作用；最终提交前接收的消息先处理。
- 初始规划澄清时尚无 admitted Plan；回答后在同一 Run 恢复。执行中澄清、HIL 等待期间的进度回答、丢失唤醒后的持久扫描均有回归测试。
- 退休完成合同的 Result 显式授权、幂等、终态竞争、过期消费租约、重复事实指纹、队列刷新、未知响应身份和多窗口状态。
- 真实 HTTP Router → Host 测试：认证身份覆盖不可信请求头，跨账户/租户请求不转发，终态 409 穿透传输。
- 隔离 Desktop HTTP 服务 + Chrome + 真实 Kernel + 确定性模型：运行中输入、草稿编辑/删除、刷新恢复、点击 Steer、已回答状态刷新后恢复、1440px 与 390px 布局。

浏览器验收脚本：`node apps/agentloop-desktop/tests/fixtures/steer-browser-qa.ts`。它使用临时数据目录和随机端口，不修改 8796 上正在运行的服务。截图与临时 SQLite 数据保留于脚本输出目录。

## 部署与验收边界

- 新增版本迁移 `runtime/0016_round_scopes`、`runtime/0017_run_inputs`；不修改旧迁移 checksum。既有 SQLite 自动安装对应 schema；PostgreSQL/TiDB 使用其方言 DDL 和锁定读取。
- 升级必须先停止旧 Worker，再执行迁移并启动新 Worker；旧 Worker 不具备输入栅栏，不能与新 Worker 混跑。原有事实不回填成虚构消息。
- PostgreSQL/TiDB 的真实并发、锁及迁移验收仍需在对应数据库实例执行；本次 SQLite 测试不替代它们。
- 未发布安装包、未重启用户当前的 8796 服务、未发布生产；本次浏览器模型是确定性测试模型，尚未执行真实模型 + 真实材料的完整设计案例。
- Multi Runtime UI 的独立浏览器验收、连接丢失及跨进程故障注入矩阵仍需补充；共享队列逻辑及 HTTP 路由已经自动化验证。
- 全量回归存在既有失败（已在 HEAD 的隔离源码副本复现语言断言和 Router 源码检查）：语言测试的两项 Skill 目录投影断言、Router 边界源码检查中的既有 Kernel type import，以及 Multi Runtime 既有类型错误。命令沙箱测试需要在允许 macOS sandbox/本地监听的环境执行。不能把这些检查报告为全绿。
