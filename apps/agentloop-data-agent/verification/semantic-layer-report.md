# 通用语义层与召回链路验证

生成时间：2026-11-21（Asia/Shanghai）

## 已完成

- 语义对象形成通用父子图：`source`、`object`、`attribute`、`measure`、`time`、`term`、`relation`；当前目录 361 个节点、6 个层级有数据，所有 `parent_ref` 均能解析，来源绑定节点均保持同源。
- 实体执行 ID 与语义对象 ID 已统一为来源字段绑定形式：`entity:<source>:<field>`；带来源字段范围的对象追加 `:scope:<field>`。已修复此前重复拼接 `entity:<source>:entity:<source>...` 的 6 条语义对象和 6 条 source binding。
- 目录校验现在只接受通用 kind，拒绝未知层级、kind/layer 不一致、缺失父对象、父子层级倒置、跨来源父引用和父环；管理页展示可维护对象及运行时投影层级，可从对象来源和自动生成的父来源回溯目录关系。
- 指标保留通用 `aggregation`、`measure_kind`、`observation_type`、`frequency`、`unit`、`time_field`、`time_format`、`grain` 属性；这些属性只参与软排序和定义核验。
- 期间格式支持 `variant_id` 多格式定义。混合样本不写入全局期间定义；两个 `date_time` 探查继续是来源/字段绑定的 `observed_only`。
- 模糊 `candidate-lookup` 与规范名称 `resolve-entity` 分离；候选没有 `selection_evidence` 或 `selected_codes`，精确查证仍由后续执行计划完成。

## 当前目录事实

见 [catalog-integrity.json](./catalog-integrity.json)：7 张表、22 个指标、39 个业务术语、6 个实体、2 个关系、5 个确认期间变体、361 个语义对象、329 个来源绑定、0 个 coverage、2 个 observed_only 探查。业务术语是 `terms` 的唯一人工真源；39 个 `term` 语义节点全部带 `projection_of`，其中 7 个明确绑定来源、32 个保持跨来源定义。父引用闭包和实体 ID 一致性均为通过，禁止的专属运行时类型为 0。

仍有 3 个阻塞缺口：

- `t_ads_fact_bwg_ind_all_02_real.date_time`
- `t_ads_fact_bwg_ind_all_03_real.date_time`
- 当前目录没有公司价格指标绑定

前两个字段探查同时出现 6 位和 8 位值形状，不能自动选择 `YYYYMM` 或 `YYYYMMDD`；需要 HIL/人工确认后再写入期间变体。探查证据包含 query_id、SQL、参数和观察时间，不产生 global coverage。

## 召回与界面

`retrieve-knowledge` 先识别来源、对象、指标、期间和关系候选，再按来源/字段绑定、规范术语和通用指标属性排序；`semantic_object_hierarchy` 会补齐命中节点的持久化父对象。`get-query-context` 只传输所选来源及其计划引用的语义图，保持 `plan_seed` 原样。三轮 TiDB 元数据基准中，三类问题的中位耗时分别为 201→152ms、185→147ms、181→155ms，响应体减少 84.1%、88.6%、81.3%，目标来源均进入 Top5。

settings 页的语义对象面板只展示人员需要维护的可筛选对象定义，并显示来源、编码字段、名称字段和运行时投影计数。普通表单维护对象名称、说明、真实来源字段、适用范围、角色、别名、召回词、状态和证据；系统生成 `object_id`、`kind`、`layer`、`parent_ref`，高级 JSON 仅用于补充扩展字段。业务术语由“业务术语”面板唯一维护，语义图中的 `term` 是自动投影；术语表单可选择来源、状态和定义证据，留空来源表示跨来源术语；指标、关系、时间变体和缺口仍有独立编辑面板。

## 回归与 Run

- Skill Python 回归：完整运行 `111 passed, 11 skipped`，目录管理新增术语投影测试全部通过。
- Node 回归：`20 passed`，TypeScript typecheck、Markdown 校验和设置页端到端验证通过；Step4 语义回归 `2/2 passed`。
- [recent-run-replay.json](./recent-run-replay.json) 审计 `257d3263`、`e7b8a8bb`、`e0516ca1`；三条 Run 的历史终态保持原样，未修改历史 Run。来源绑定、模糊候选与精确 lookup 分离检查通过；其中 `257d3263` 的旧 `plan_step` 仍记录为 `running`，属于不可回写的历史证据，不能据此宣称历史步骤已被重写收敛。

## 仍需 HIL 的场景

期间混合格式、同一术语对应多个来源或指标、组织层级/管理合并关系没有目录或证据支持、以及候选名称对应多条真实编码时，继续请求 HIL；局部 observed_only 探查不会改变全局目录。
