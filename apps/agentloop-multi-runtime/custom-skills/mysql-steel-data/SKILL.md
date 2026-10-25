---
name: mysql-steel-data
description: 读取部署映射的钢材指标目录和原始时序。用于 steel-market-analysis 的取数委派，或用户明确索取目录、候选或原始记录；不生成趋势结论、不接受任意 SQL。
---

# MySQL 钢材指标数据

本 Skill 是钢材数据库的只读取数边界。SQL 的生成和执行属于本下层 Skill：它将已映射的业务选择器编译为受控目录查询或 `INDEX_CODE` 精确时序查询，并返回可引用的原始回执；不决定研究方法、价格统计或市场解释。

## 入口边界

趋势、涨跌、峰谷、区间、比较、研判或其他数值结论由 `steel-market-analysis` 承担：先加载主 Skill，再由它委派本 Skill。只有用户明确只需要目录、候选、字段语义或原始时序时，才能直接使用本 Skill。

不要执行或生成任意 SQL，不要访问未映射的库、表或字段，不要写入数据库，也不要把相近字段、样例值或模型常识当作目录事实。

## 受控取数

- 映射缺失或需要确认表字段时，用 `inspect-schema`；映射由数据库所有者维护，Skill 不改写 `schema-map.json`。
- 需要理解请求与目录字段的精确对应时，用 `preflight-catalog --query`。需要多个候选或显式目录审阅时，用 `discover-indicators`。
- 单日与时间段是两条不同的取数链路：单日用 `locate-day` 或 `resolve-and-locate-day`，返回该日全部原始观测；多日才用 `locate-series` 或 `resolve-and-locate-series`，且起止日期必须不同。单日多条值不是重复或代表价，不能擅自取第一条、最后一条或均值。
- 已有一个日期明确、可唯一定位的多日序列时，用 `resolve-and-locate-series`；它是取数原语，不是分析方法或默认路线。
- 上层已选择多项数据或比较方法时，执行其 Run 工作区中的 `agentloop.steelMarketQueryPlan/v1`，再调用 `execute-query-plan`：每项只允许一组已映射过滤条件，或一个目录回执签发的精确 `INDEX_CODE` 加 `selectionToken`。
- 只有唯一 `INDEX_CODE` 才读取观测。候选不唯一时返回可区分候选；无观测时返回该指标和日期窗口的事实，不以相近指标填补。

## 指标代码的选择证明

`INDEX_CODE` 不是模型可编造的名称。唯一候选的目录结果会携带 `agentloop.steelIndicatorSelection/v1` 的 `indicatorId` 和不透明 `selectionToken`。后续直接读取必须使用 `query-day-by-selection` 或 `query-series-by-selection` 并原样带回这两个值；无令牌、令牌与代码不匹配、或自行改写的代码一律拒绝。

这不是把选择语义交给 Runtime：目录、指标身份和令牌都由本数据 Skill 产生和验证。`locate-day`/`locate-series` 在同一次动作中完成唯一候选到精确 ID 的转换，因此也不会接受模型输入的裸代码。

多日回执必须保留其 `contentLocation.path`、选择依据、日期范围、行数、实际覆盖、截断和限制。它是上层 `analyze-series` 的输入；摘要、stdout 或单独读取工具的文本不是可用交接。单日回执交付的是同一日期的原始观测集合及其行数/多值限制，不是趋势分析输入，也不声称一个唯一日价格。

## 完成边界

目录预检、候选列表和字段发现只是取数中的中间结果；步骤目标是原始时序时，必须继续到精确查询、明确的无观测回执，或需要用户区分的真实候选。不要将未执行的 `INDEX_CODE` 查询伪装成已完成的取数。

本 Skill 交付的是原始事实与限制，不计算均值、首末变化、峰谷、同比或市场结论。上述派生事实由主分析 Skill 的 `analyze-series` 或 Runtime 通用计算协议生成。

## 按需参考

- 需要字段、粒度、关联或选择器含义时，读取 [数据语义](references/data-semantics.md)。
- 需要确认受控选择器如何编译或如何解释空结果时，读取 [NL2SQL 查询边界](references/nl2sql-query-patterns.md)。
