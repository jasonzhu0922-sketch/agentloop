---
name: hr-report-data
description: 读取部署配置的 Eplat 人事法人汇总报表原始行。用于 hr-report-analysis 的取数委派，或用户明确索取原始记录、组织匹配、可用月份或指标定义；不生成分析结论。
---

# 人事报表数据

本 Skill 是人事法人汇总报表的只读取数边界。它把受控月份、指标和组织选择编译为固定表 `BSTAMSHR00.V_FAWHZHSS0401` 的只读 DB2 查询，并通过 Eplat 返回原始行。它不执行模型提供的 SQL，也不计算分布占比、变化、排名或管理结论。

部署从 Runtime 私有配置文件读取 `HR_REPORT_EPLAT_URL`、`HR_REPORT_EPLAT_CLIENT_ID`、`HR_REPORT_EPLAT_CLIENT_SECRET` 和 `HR_REPORT_EPLAT_MODEL_ID`。凭据不属于 Skill 包、命令参数或模型上下文。

## 使用边界

需要人数结论、结构分布、占比、排名、跨月变化或组织比较时，先加载 `hr-report-analysis`，由它确定口径并委派本 Skill。只有用户明确要求原始行、可用月份、组织匹配或指标定义时，才能直接交付本 Skill 的结果。

支持的八类、23 个固定 `REPORT_ITEM_DES` 值见 [数据语义](references/data-semantics.md)，精确名称可由 `describe-catalog` 返回。指标覆盖说明可读取什么，不扩大本 Skill 的取数职责。政治面貌中的群众/团员、民族、年龄段、工龄、司龄、绩效、离职、个人级画像、部门明细和薪资不在本表支持范围内。

## 受控流程

1. 未指定月份时先调用 `latest-period`，不要按系统日期假设数据库已有数据。
2. 用户点名公司时调用 `resolve-organizations --query`，保留用户原始的组织表述和范围限定，不自行添加“总部”等限定词。组织名称只按 `org-hierarchy.json` 中完整 `baseName`、`hqName` 或 `alias` 匹配；不得猜测代码。返回 `ambiguous` 或 `no_match` 时不要查询。
3. 调用 `query-report --request-json`。请求只允许月份范围、指标目录中的精确名称、可选组织选择回执，或无点名组织时的 `full_company` / `headquarters` / `both` 范围。
4. 点名组织的查询必须原样携带 resolver 返回的 `codes` 和 `selectionToken`。无令牌、代码变化或令牌不匹配都会被拒绝。
5. 保留工具返回的完整查询回执文件引用，交给 `hr-report-analysis/analyze-report`。通过 `computer_run_command` 执行时使用 `stdoutRef.path` 指向的完整原始文件；`stdout` 可能只是预览。不要猜测路径，也不要手工复制部分行作为分析输入。

通过 `computer_run_command` 执行包脚本时，`command` 是可执行程序，`args` 仅包含其参数，二者必须分开。例如：`{"command":"python3","args":["scripts/hr_report_data.py","query-report","--request-json","<request-json>"],"cwd":"@skills/hr-report-data"}`。不要把 `python3` 放进 `args`，也不要省略 `command`；参数校验被拒绝表示脚本没有运行，须修正结构后再调用。

`full_company` 表示四位公司代码，包含下属单位的汇总口径；`headquarters` 表示对应 `XXXX00` 总部口径；`both` 会同时返回两者，二者存在范围重叠，不能相加。

## 完成边界

`query-report` 返回的每行粒度为 `NY + ORG_CODE + REPORT_ITEM_DES`，字段仅有 `month`、`organization_code`、`organization_name`、`metric`、`amount`。空结果、截断和接口限制必须如实保留。原始行不是结构占比、趋势或管理判断。

向主 Skill 或后续步骤交接时，在步骤结果中保留原始查询 Result 的引用、完整回执文件路径及其哈希、月份、组织范围、指标覆盖、行数和限制。只写“已取得多少条数据”的概况不能供下游分析。取数完成后仍由 `hr-report-analysis` 负责计算和业务交付；不要用取数概况代替用户要求的分析结果。

## 按需参考

- 需要指标值、数据粒度和组织口径时，读取 [数据语义](references/data-semantics.md)。
- 需要理解源 Skill 的组织映射时，读取 [组织层级映射](references/org-hierarchy.json)。

