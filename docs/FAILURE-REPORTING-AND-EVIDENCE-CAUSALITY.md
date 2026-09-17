# 循环失败后的目标总结与证据缺口归因

日期：2026-09-16

## 行为契约

执行循环因超预算、无进展、不满足要求而结束时，不应只交付错误字符串。确认 Run 要终止后，保留原始失败状态和错误码，再用一次无执行工具的模型回合，围绕原始目标、当前成果、剩余缺口进行总结。

- 总结不是 completion candidate，不重新送 Assessment，不产生成功交付回执，不重启执行循环。
- 总结必须区分可用结果、未经验证的材料、局限及其对目标的影响；不能用未验证文件或缺乏来源的结论填充结果。
- 当前 leaf 失败不等于 Run 失败。若 Runtime 仍能通过既有计划修订恢复，先走恢复；只有真正提交失败时才生成总结。`CompletionFailure` 延迟且至多生成一次报告。
- 主动取消、等待用户、权限拒绝、Host 执行权丢失不是追加模型回合的入口。
- 模型/Assessment 报错也可走同一收尾入口；最后整理本身报错、空输出、截断或请求工具时，不再重试，不把旧的拒绝候选当成已验证结果展示，只保留明确的未完成说明。
- 整理回合使用已有上下文与证据，不追加取数。输出上限 4096 tokens（受模型自身上限约束），单独超时 30 秒，继承用户取消信号。
- 主执行、计划修订后的失败和恢复执行的终止均保留报告。Run/Outcome 继续为 `failed`，沿用已有 `output` 字段，无数据库 schema 迁移。
- `failure_report.generated` 不是终态提交。前端以持久化 `run.failed.output` 或刷新得到的 `run.output` 显示“阶段性结果（任务未完成）”，错误原因仍单独保留。

没有修改历史 Run；既有失败记录不会自动补生成报告。进程已经死亡时也不能承诺补跑一轮。

## 64272a5d 的根因修正

1. MySQL Skill 的 `resolve-and-locate-series` 保留预检 `dataContract` 与完整回执，并合并真实 facts、来源、局限、证据类型；组合回执记录 component receipt IDs 并生成新的 ID。
2. 合并动作没有取得唯一序列时仍保留真实预检事实，但不能声明已取得时序；真实预检失败仍传播错误。
3. Assessment 独立判断 `explicit_caveats` 的已记录证据，不再继承 `schema_summary` 等无关 gate 的成败。空 caveats 数组是明确记录“无工具局限”，不同于完全未记录。
4. 拒绝反馈按条件报告，区分“尚无绑定证据证明”与“操作未执行/内容不存在”，说明改写正文不能创建操作回执。

这一切片不等于完成整个阶段 4：回执只能证明局限已记录，不能证明模型最终文字充分表达了局限。本次没有新增逐句语义审查，也没有全面重写 Assessment profile 路由。不能把本次修复解释为所有内容质量问题已解决。

## 部署边界

`custom-skills/mysql-steel-data` 是被 Git 忽略的本地部署 Skill。当前本机脚本已修正；为避免仅保留本机修改，版本管理补丁位于：

`apps/agentloop-multi-runtime/patches/mysql-steel-data-composite-evidence.patch`

对尚未应用该补丁、接口相同的部署副本，在仓库根目录先检查再应用：

```sh
git apply --check --directory=apps/agentloop-multi-runtime/custom-skills/mysql-steel-data apps/agentloop-multi-runtime/patches/mysql-steel-data-composite-evidence.patch
git apply --directory=apps/agentloop-multi-runtime/custom-skills/mysql-steel-data apps/agentloop-multi-runtime/patches/mysql-steel-data-composite-evidence.patch
```

已应用的本机通过 `git apply --reverse --check` 核对。补丁不是新的 Skill 发布源，也不包含凭证。部署版本不匹配时应处理冲突，不应强行应用。本次未自动重启共享 Host、Router 或前端；重载后需要新 Run 验证，不能据离线测试宣称线上已生效。

## 已执行验证

- 新增根因、收尾、前端测试，加 `assignment-stream`、`multi-runtime`：98/98 通过。
- Assessment 独立条件、原有自动修复/针对性修复、安全恢复、预算收敛测试：16/16 通过。
- 独立部署 Skill 组合证据测试：4/4 通过；本机 Skill 原测试：15/15 通过。
- Kernel `tsc --noEmit` 通过；补丁反向应用检查通过。
- Agent-loop 全文件：61/62 通过。剩余 `artifact progress policy does not require a semantic source receipt after process artifacts exist` 已在阶段 2/3 基线记录，未放宽该断言。
- Planning-runtime 全文件在最新并发工作区快照为 207/215 通过；8 项失败名称均属于阶段 2/3 已记录的 Planner 提示、能力契约及 Skill 路径基线。自动修复两条回归保持通过，没有把可恢复 leaf 提前终止。
- Multi Runtime 类型检查仍受既有 `requiredLocalRuntimePythonModules` 声明缺失阻塞。本次工作区存在并发 Planner/能力解析修改，以上结果仅代表执行时快照，不代表全仓放行。

主要验证命令：

```sh
node --test packages/agentloop/tests/failure-report.test.ts packages/agentloop/tests/evidence-gate-causality.test.ts apps/agentloop-multi-runtime/tests/partial-result-projection.test.ts apps/agentloop-multi-runtime/tests/assignment-stream.test.ts apps/agentloop-multi-runtime/tests/multi-runtime.test.ts
python3 -m unittest discover -s apps/agentloop-multi-runtime/tests -p 'test_mysql_composite_evidence.py'
npx tsc -p packages/agentloop/tsconfig.json --noEmit
```
