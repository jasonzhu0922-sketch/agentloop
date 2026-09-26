# TiDB 状态数据清理

`prune-tidb-state-before.mjs` 只清理由截止时间确定的完整 Router Task 和 Runtime Run 依赖链。它不会清理全局 Skill、Conversation，或任何 Local Runtime Agent SQLite 文件。

先预检（不写入）：

```sh
AGENTLOOP_ROUTER_STATE_DATABASE_URL='mysql://root@127.0.0.1:4000/agentloop_router' \
AGENTLOOP_RUNTIME_STATE_DATABASE_URL='mysql://root@127.0.0.1:4000/agentloop_runtime' \
node apps/agentloop-multi-runtime/scripts/prune-tidb-state-before.mjs \
  --before=2026-09-24T16:00:00.000Z
```

确认预检的 Run、Task 与 Event 数量后，才执行同一 cutoff 的清理：

```sh
AGENTLOOP_ROUTER_STATE_DATABASE_URL='mysql://root@127.0.0.1:4000/agentloop_router' \
AGENTLOOP_RUNTIME_STATE_DATABASE_URL='mysql://root@127.0.0.1:4000/agentloop_runtime' \
node apps/agentloop-multi-runtime/scripts/prune-tidb-state-before.mjs \
  --before=2026-09-24T16:00:00.000Z \
  --apply --confirm=2026-09-24T16:00:00.000Z
```

`--confirm` 必须逐字匹配 `--before`，避免 Shell 历史或日期修改导致意外清理。Router 和 Runtime 在不同 schema，不能声称跨库原子；脚本按 Runtime、Router 顺序执行，任一中断后以相同命令重跑即可幂等收敛。
