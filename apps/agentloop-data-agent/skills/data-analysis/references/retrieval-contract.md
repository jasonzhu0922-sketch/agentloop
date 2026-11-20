# 知识检索与精准元数据接口

检索业务知识、定位表和指标、补齐字段后，再由当前 Agent 制定领域计划并生成 SQL。所有动作在本 Skill 内执行，不调用第二套模型、不使用 Memory。维护的定义来自 TiDB 场景目录；检索输出、上下文及完整大结果保存在工作区磁盘，Run 保留版本、引用和回执。

## 调用方式

统一入口 `python3 scripts/data_client.py <动作> --scenario-id group --request-json '<JSON>' --output <workspace-file>`。Runtime 工具使用 `command=python3`、`cwd=@skills/data-analysis`，每个参数独立放入 `args`；输出参数为 `@workspace/<相对路径>`。不创建中间请求文件、不读取连接配置。

| 动作 | 请求 JSON | 用途 |
| --- | --- | --- |
| `retrieve-knowledge` | `{"question":"问题"}` | 首次检索术语、表与指标候选、关系线索、歧义和缺口 |
| `search-tables` | `{"question":"问题","limit":5,"offset":0}` | 扩展候选来源，保留无摘要或低分表的可发现性 |
| `search-metrics` | `{"question":"业务指标或别名","source_ids":["表"]}` | 找源绑定的指标身份；`source_ids` 可省略 |
| `get-metrics` | `{"metric_refs":[{"source_id":"表","metric_id":"指标name"}]}` | 批量读取完整公式、单位、项目条件、粒度和依赖字段 |
| `search-columns` | `{"question":"组织名称","source_ids":["表"]}` | 只查所选表的真实字段，返回相关字段定义与分页 |
| `get-columns` | `{"columns":[{"source_id":"表","names":["字段1","字段2"]}]}` | 批量获取已知字段的完整定义和表签名 |
| `get-query-context` | `{"question":"问题","source_ids":["表"],"metric_refs":[{"source_id":"表","metric_id":"指标name"}],"columns":[{"source_id":"表","names":["分组字段"]}],"catalog_revision":"检索返回的版本"}` | 一次补齐指标和必要字段、组织/期间定义、关系及计划种子；`metric_refs/columns` 按需省略 |

所有动作可传 `catalog_revision`；版本不一致时明确拒绝。搜索动作支持 `limit=1..50`、`offset`，默认返回 5 项；响应分页对象为 `{items,total,offset,next_offset,complete}`。`complete=false` 表示还有候选，不能据此宣布不存在或遗漏必要来源。表排序保留零分候选供翻页；指标和字段搜索返回词法命中，未命中可换用目录中的正式词、精确身份或其他候选表核查。

不强制逐个调用所有动作。通常先 `retrieve-knowledge`，再一次 `get-query-context`；只有缺口明确时追加指标或字段动作。`catalog` 保留为用户要求完整目录或排查目录内容时的广范围检查动作。

## 返回与解释

响应统一为 `nl2sql.semantic-metadata/v1`，含 `operation/scenario_id/catalog_revision/schema_verification`。小结果在 stdout 文件回执的 `/content`，大结果按 `read_contract.file_pointers` 读取磁盘原响应；不要猜文件根有 `/content`。

- `retrieve-knowledge.sources.items` 提供表身份、分数、命中线索、相关 `metric_refs`；`terms` 提供完整术语定义和命中文字；`metrics.items` 提供源绑定的指标身份、命中术语与定义引用。`ambiguities` 是候选提示，是否影响答案由 Agent 依据定义判断；不能因为候选分数高就确认口径。
- `definition_ref` 包含定义类型、来源、身份和目录版本。完整定义保留 `provenance/evidence_ids`，候选表的 `business_context` 保留记录粒度与适用限制，`matched_fields` 仅为词法字段线索。`no_metric_definition_matched` 只表示此次词法检索未命中，不代表业务没有数据或指标。
- `stored_snapshot_only` 使用 TiDB 维护目录，无物理结构查询。该目录是检索依据，仍需核对目标源。`selected_sources_live` 只刷新明确选中表的真实结构；上下文中陈旧或无效摘要会被排除并给出诊断。
- `get-query-context.tables[].columns` 只包含显式字段、指标依赖、匹配字段及实体/期间/已选关系依赖。`available_column_count/columns_complete` 明示投影范围；缺失维度按名称批量补取。`metrics[].definition` 保留完整业务口径；`required_fields` 保留公式、项目条件和粒度依赖。字段的 `semantic_roles` 与 `metric_refs` 从已维护定义派生，分别标记期间、实体键/名称、指标依赖/项目条件、粒度与关联键；不从字段名猜业务角色。
- `relationships` 可能指向其他授权来源，需扩展上下文并核对粒度后才能使用。存在关系不等于 JOIN 不会放大度量。

## 从上下文生成 SQL

`plan_seed` 的结构为：

```json
{"schema":"nl2sql.query-plan/v1","scenario_id":"group","catalog_revision":"返回值","source_signatures":{"所选表":"返回的完整签名"},"metric_bindings":[{"source_id":"所选表","metric_id":"采用的正式指标"}],"entity_bindings":[],"time_bindings":[]}
```

在此基础上补充本题真实需要的实体和时间绑定，再与 SQL、独立参数数组在同一次 `execute` 请求中传入。指标项目条件、单位、聚合粒度仍按完整定义落实。不能把期间字段的 `format/granularity` 直接塞进 `time_bindings`；有具体区间时才绑定 `{source_id,field,start,end}`（ISO 日期，左闭右开）。仅求最新月份、探查值域等查询可以只带表签名。

执行时重新核对维护知识版本和 SQL 所用表的真实结构；签名发生变化返回 `query_schema_changed`，SQL 引用未绑定来源返回 `query_source_unbound`。重取受影响上下文并重新规划，不能删签名、删条件或更换聚合来绕过。

## HTTP

仅在用户明确需要 HTTP 时启动 Skill 自带服务。同一逻辑通过 `POST /api/data/metadata/<动作>?scenario_id=group` 提供，请求体就是上表 JSON。未知动作返回 404，非法选择或知识版本变化返回 400 并携带明确代码；连接故障返回 503。CLI 与 HTTP 的定义、版本、授权边界相同。

## 验证与测量

离线回归：`python3 -m unittest discover -s scripts -p 'test_*.py'`。真实 TiDB 检索、精准上下文及 SQL 验证：`DATA_ANALYSIS_TIDB_LIVE=1 python3 -B scripts/test_semantic_live.py`，只读业务数据并沿用查询审计。

元数据路径对比：`python3 -B scripts/benchmark_retrieval.py --cases <cases.json> --rounds 3 --output <workspace-benchmark.json>`。cases 为 `[{"question":"问题","source_ids":["预期表"]}]`，比较广范围目录与检索＋按需上下文的耗时、物理元数据调用/表列数、返回字节和目标表 Top5 覆盖。该测量不调用模型或业务 SQL；返回字节不等于模型 token，少量样本不能证明 P95 或 SQL 正确率。结果直接保存到磁盘。
