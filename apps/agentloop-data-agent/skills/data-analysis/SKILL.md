---
name: data-analysis
description: 面向集团经营分析（group），查询分析财务报表、经营指标实际与计划、人力月报、钢联行情和采购合同；支持指标问数、计划完成与差异分析、趋势、排名、分布和对比，按业务口径提供可追溯的数据与结论。仅访问 group 场景的已授权数据，不用于数据写入或数据库管理。
---

# 集团经营问数

本 Skill 固定使用 `group` 场景，只能通过声明的 `scripts/data_client.py` 动作读取目录、探查和执行 SQL。禁止自行连接数据库、读取凭据、调用其他问数服务或运行临时脚本。完整证据保存在当前 Run；默认只向用户展示业务答案。

## 最短流程

1. 调用一次 `retrieve-knowledge`，请求中使用用户原始问题。
2. 优先使用回执中的 `model_summary` 选择来源、指标、实体、术语和歧义。只有 `more=true` 且所需候选确实缺失时，才分页读取保存的 JSON；不得为了看全而读取大文件或调用 `read_result`。
3. 对选中的来源调用一次 `get-query-context`，同时传入已知的 `catalog_revision`、`metric_refs`、`term_refs` 和必要字段。优先使用其 `model_summary` 中的 `context_id`、表、列、指标和期间格式；摘要缺少写 SQL 所需字段时才读取上下文文件。
4. 生成参数化、单条、只读、有限结果的 TiDB/MySQL SQL。聚合在数据库侧完成，不拉明细给模型自行汇总。
5. 执行时首选在 `--request-json` 内传 `query_plan:{"context_id":"ctx_..."}`，不要同时传 `--query-plan`，也不要复制或重建 `plan_seed`。执行成功且结果直接回答问题时不要追加验证查询。
6. 先给业务结论。单值问题通常一两句话；只补充会改变答案的期间、主体或口径。

已有同版本上下文时直接复用，不重复检索。请求结构见 [输入契约](references/input-contract.md)，知识动作见 [检索契约](references/retrieval-contract.md)，业务绑定规则见 [规划与口径](references/planning.md)。仅在当前问题确实需要相应细节时读取这些 references。

## 自主查证与 HIL

- 知识未命中、多个候选、字段格式未知、样本编码混合或一次 SQL 失败，都先由系统查证，不直接询问用户。
- 缺字段或定义时批量补取；实体名称用 `candidate-lookup` 查候选，确认规范名称时用 `resolve-entity`；字段实际编码用有界 `probe-values`。探查证据只适用于当前来源，不能升级为全局定义。
- 用户已给出物理编码时可直接参数化过滤，不强制生成 `entity_bindings`。
- 只有查证后仍存在多个合理业务解释、且不同选择会改变答案并必须由用户决定时，才请求结构化 HIL。
- 技术错误读取 `error.diagnostic` 后针对性修复一次；相同命令、参数和错误组合不得重复提交。不得把故障说成没有数据。

## 查询约束

- 使用目录中的真实 `database.table`、字段、指标定义、关系和期间格式；不得从字段名或模型记忆猜口径。
- 时间筛选使用参数化半开区间；统一 `%s` 占位符，不把值拼进 SQL。
- `context_id` 是不透明引用。只读取 `get-query-context` 自己声明的输出文件，不猜 `.data-agent-contexts` 路径。
- 指标、时间、术语、实体和探查绑定必须与当前 SQL 一致；执行器会校验目录版本、来源签名和语义证据，不能靠删绑定、换表或降低粒度绕过。
- 成功回执含完整 `content` 或 `dataset` 时直接使用；否则只按 `read_contract` 指针读取所需部分。不猜 `/sql`、`/sources` 等路径。
- 结果需要有限派生汇总时使用 `compute-result`；不得用临时 Python/Node 脚本处理查询结果。

## 文件交付

只有用户明确要求文件时才生成。先完成并核对查询，再从真实结果写一个 `data-agent.file-export/v1` JSON 规格，并调用固定生成器：

`python3 scripts/file_export.py build --format <xlsx|csv|docx|pdf|pptx|html|markdown> --spec <规格> --output <文件>`

不得为了导出重新查询、改口径或编造数据，不得写临时可执行脚本。生成后绑定交付目标并完成文件验收。

## 回复

- 开头直接给结果，避免描述内部步骤、SQL、物理表、文件路径、目录版本和工具回执。
- 未指定期间时查明最新可得一期，并写清具体日期或月份。
- 趋势、对比、排名等复杂问题按用户要求展开；不自动添加无关趋势、极值或免责声明。
- 空集合、NULL、策略拒绝和执行失败必须区分。只有确实影响结论的限制才简短说明。
