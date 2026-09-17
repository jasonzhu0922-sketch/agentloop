# 前端断线与 Router 终态同步修复

日期：2026-09-16。范围：观察连接与状态投影，不修改 Runtime 执行、Assessment、Recovery 或交付门槛。

## 现场与数据修正

Run `a7347c8d-7998-443c-81fe-f93d48ca165e` 在 20:01:08 已完成；Plan completed，Assessment approved，事件 397 为 terminal.delivery_committed，398 为 run.completed，Outcome 为 completed / plan_assessed_and_completed。
Router 的 `assignment_581b98f7-4287-4ca1-a274-604f9fcd7d68` 却停在 accepted、last_observed_at=null，对应 task 为 running。

用户授权后，通过既有 assignment 查询接口触发 Host 状态核对与 `observeRun` 事务，将 assignment/task 同步为 completed；未直接 UPDATE SQL，未重跑任务、修改产物或 Runtime 终态。修正后只读复核四层均 completed。

当次断线的原始网络诱因未知，没有原页面 Network/Console 现场；以下修复针对已复现的断线后错误处理，不将临时网络错误归因为某个未证实的超时或进程崩溃。

## 修复契约

- 前端连接错误与任务失败分开。仅持久化终态事件或 Host-backed Run 状态快照能结束任务；上游轮询失败标为 stream.error。
- 前端保留最后已应用 seq，按 afterSeq 重连并去重。网络/EOF/事件流错误采用 0.5s 至 10s 上限退避，30s 无响应中断当前观察连接后重试；直到确认终态或页面主动停止观察。不重新提交任务、不触发执行恢复或取消。
- 丢失终态包时查询权威状态并尽可能补读事件；已读到最后序号的连接可由 Router 返回 run.snapshot 收尾。快照没有伪造的事件 seq，也不写回 Host 事件历史。
- 页面恢复已有 running 消息时重新订阅。历史缓存中的 failed 若没有终态事件，重新向 Host 核验，允许修正过去的网络误报。连接异常不清空已有进展，也不解锁重复提交同一会话的运行任务。
- Router 在启动时及每批结束 5s 后独立扫描未结 assignment，不依赖浏览器查询。每批至多 100 项、并发 4，按 ID 游标轮转；单次 Host 状态/事件读取超时 10s。不可达保留未知/原状态并下轮重试，不推断失败。
- Router 对账只更新 assignment/task 投影，不 dispatch、cancel、resume 或迁移执行权；既有终态不可被迟到 running 覆盖。进程退出等待本批收尾再关闭数据库。
- SSE 保留空增量时的请求游标，防止退回 seq=0；同一连接最多一个在途轮询，防止慢请求重叠和乱序。

## 验证

改动前 Multi Runtime 测试 69/69 通过。

改动后确定性测试 86/86 通过：69 项原有测试，11 项前端 observer/真实 app 函数测试，6 项 Router 状态与 SSE 测试。
另有真实 HTTP 隔离集成 1/1 通过：真正的 Router HTTP 服务和浏览器使用的 observer 模块，注入 Host 读取异常、客户端连接丢失，确认从 seq=1 补读到 completed、没有重复派发；另一个没有 SSE 客户端的 assignment 由后台对账完成。
合计 87/87，无跳过。HTTP 测试需要 loopback 监听权限；第一次沙箱返回 listen EPERM，授权后成功。

```sh
node --test --test-isolation=process apps/agentloop-multi-runtime/tests/assignment-stream.test.ts apps/agentloop-multi-runtime/tests/assignment-reconciliation.test.ts apps/agentloop-multi-runtime/tests/multi-runtime.test.ts
node --test apps/agentloop-multi-runtime/tests/assignment-http.test.ts
node --check apps/agentloop-multi-runtime/web/app.js
npm run typecheck --workspace agentloop-multi-runtime
```

前端语法检查、git diff --check 通过。类型检查仍只有原有 `multi-runtime.test.ts:56 TS2305`：requiredLocalRuntimePythonModules 缺少相应 .d.mts 声明，本轮未修改该无关问题。
这是确定性/真实 HTTP 集成验证，不是用户浏览器实测，不使用真实 LLM，也没有重演历史 Run。

## 生效与边界

已修正的历史状态立即生效。前端需刷新加载新模块；Router 后台对账及新的 SSE 行为需重启 Router 进程后生效。
本轮没有重启现有 Router/Runtime，也没有提交代码。当前本地启动器管理多个进程，不能为了重载修复而冒险中断其他任务。
保留工作区其他未提交改动，尤其 checkpoint/recovery；它们与本轮同文件 diff 重叠，不应把整个工作区 diff 归入本次修复。

本次新增 assignment-stream.js/.d.ts、assignment-reconciler.ts 和三个 assignment 测试文件；修改前端连接接入/旧缓存核验、Router 查询批次/启动对账/SSE 超时游标，以及完成时清理旧 UI error。原有测试只将已移动到模块的字符串断言改为 observer 接入断言，新增行为测试验证实际故障路径。

## 重启后的排序回归与修正

用户重启后报告“像换了应用、找不到 a7347c8d”。只读核对进程打开的 DB 与当前 Router 返回结果，确认仍为同一数据库、同一会话，数据未丢失。
实际原因是本轮新增后台对账调用既有 observeRun，后者把 task.updated_at 写成观察时间；36 条旧任务在 20:54:08—09 被补同步，污染了按 MAX(task.updated_at) 排序的会话列表，目标会话被挤至第 23 位。这是本轮遗漏的副作用，不是网络或用户缓存问题。

修正：任务活动时间使用 Host finishedAt，终态事件路径携带 event.createdAt；缺少实际时间则保留原活动时间，不制造“现在发生了活动”。观察时间仅保留在 assignment.last_observed_at。running 轮询也不更新 assignment 的接纳时间，避免干扰容量预留。旧 assignment 的迟到结果不得覆盖同一 task 上更新的 continuation。前端采纳服务器向下纠正的排序时间，事件补读不再把回放时刻写成活动时间。

对已受影响的 36 条任务及先前手动同步的 a7347c8d，共 37 条，先保存明确的前后值快照，再以事务/逐行前置校验仅修改 mr_tasks.updated_at；新值来自对应 runs.finished_at。Run 状态、Outcome、事件、产物不变。未匹配这批观察时间和确切 ID 的新任务不受影响。
本地审计快照为 `apps/agentloop-multi-runtime/data/repairs/recency-20260916-205409.json`（包含 ID、状态、时间，无用户输入或密钥）；执行脚本为 `scripts/repair-assignment-recency.mts`，默认 dry-run，只有显式 --apply 才写入。
修正后当前 Router 返回 a7347c8d 会话第 3 位、completed，前两位为更新的真实任务；排序会随新任务正常变化。

新增回归覆盖：晚观察不置顶旧会话、未知完成时间、接纳时间不受轮询影响、终态事件真实时间、旧父 assignment 与新 continuation、服务器纠正浏览器旧排序。此补充修复不需要停掉当前正在执行的任务；数据修正即时生效，浏览器刷新加载新前端，新的后台代码需下次安全重载 Router 后生效。

补充修复后复测：非 HTTP 测试 91/91，隔离 HTTP 1/1，共 92/92 通过；git diff --check 通过，类型检查仍为上述既有 TS2305。
