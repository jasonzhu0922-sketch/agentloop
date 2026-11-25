# Redis 原生事件并发修复（2026-11-25）

实际 Data Agent 的流式新 Run 出现 `Runtime record already exists: run_events`；完整合成流式 Run 也复现了 `Runtime transaction observed concurrent changes`。

根因是多个流式观察事件并发读取同一 Run 的计数器，而 RunService 又在每条事件外层打开事务，使事件仓库无法识别并处理自己的追加提交冲突。旧序号所对应的事件可能已经由另一个提交写入，因此冲突也可能在 INSERT 检查阶段出现。

修复包括：

- 普通事件由事件仓库持有提交边界；预算事件仍将预算和事件一起原子提交，已有领域外层事务保持原边界。
- Redis 对独立事件追加按 Run 排队，跨实例版本冲突仅重试纯记录追加，最多重试 31 次。不重试领域回调、工具执行或不确定提交。不引入全局执行锁。
- 测试覆盖同 Run 的 48 个并发追加（两实例、单条与批量混合，共 72 条连续事件），以及模型并发调用 sink 的完整 Run；SQLite 和真实临时 Redis 都执行相同契约。

验证：内核记录契约 48/48、旧日志重放 9/9、旧事件队列 14/14；独立 Data 应用 47/47、状态测试 6/6、Report 应用 48/48，两应用类型检查通过。

共享内核回归：Local Runtime 124/124、Desktop 221/221、仓库内 Data Agent 20/20。源码测试与包安装均通过；本次未重新制作 Desktop 安装器或启动 Electron GUI。

独立应用已重新安装 `zhujun-agentloop-0.1.0-native-10ace24994c5.tgz`，完整 dist 树和 CLI 均与本次构建核对一致。Data Agent 实际 npm start 已重新加载修复包。

实际 8810 服务通过配置模型执行无业务查询的连通性 Run：`aa36f893-cfcd-4b37-b20c-d507b5103e25`，完成，60 条连续事件，含 2 条流式事件，无 model.request.failed，Last-Event-ID 补齐准确。没有重放此前失败的业务请求。

本机空历史初始化、安装核对及 HTTP 验证凭据保存在 Data Agent 的 `data/files/runtime-migration-2026-11-25T02-34-35-087Z/`。其中配置文件含连接信息，不应提交。旧执行历史按用户选择不迁移；旧源日志/表保留。

## 补充：Action 事务与提前工具执行

`52ea957a-04ff-4bb5-9f6f-1016d8ff993f` 在已安装上次修复包、进程已重启的情况下仍然失败。其第 52 条 `model.request.failed` 再次报告 `Runtime record already exists: run_events`，并非安装版本未更新。

上次测试覆盖独立事件追加及纯文本流，未覆盖原生后端在 Action 派发/结果提交/失败提交的领域事务中与流式事件并发。尤其 `tool_call_ready` 会在模型流结束前启动工具，Action 事务中的事件追加加入已有事务，无法独立重试。

本次新增显式 `recordTransaction` 契约：仅允许纯 Repository 读写回调在乐观版本冲突后重试，已有外层事务和普通 `transaction` 不被重放。Action 的派发、结果提交和失败提交采用这个契约；工具执行、模型调用和结果准备仍位于回调之外，提交响应不确定错误不重试。

新增确定性竞态测试，在 Action 已读取计数器但尚未插入事件时，让另一实例提交流式事件，分别验证派发、成功和失败提交。另有四个 Action 与流式事件并发，以及完整 Run 的 `tool_call_ready` 提前工具执行测试；共同断言副作用只执行一次、Action 状态正确、事件连续。内核相关测试 81/81 通过。

本次独立应用安装包为 `zhujun-agentloop-0.1.0-native-4f802159d751.tgz`，包 SHA-256 `4f802159d7519257a091663b9be97df870a94022403d5c71fe338102d8b1f946`，build ID 为 `action-stream-cas-7286151b3181`。包以先前已安装包为基底，仅替换 `runtime-action-repository`、`runtime-records`、`redis-runtime-records` 三个模块的 JS/声明，未带入工作区新增的其他无关源码修改。两个应用安装目录的完整 dist 树均与该包核对一致。

Data Agent 的 8810 服务于北京时间 11:02:43 重新启动加载新包。实际配置模型的新 Run `fefda281-82a0-43dc-9663-b961a12cc4cc` 仅通过 `load_skill` 读取说明，不访问业务库，89 条连续事件、提前派发工具执行一次、所有 Action 成功、Run 完成，无失败事件。保留原失败 Run，未重放其业务请求。

应用回归：Data 47/47、状态 6/6、Report 48/48，两个应用类型检查通过。完整安装核对及实际新 Run 凭据为本机上述目录的 `action-race-install-verification.json` 和 `live-early-tool-verification.json`。
