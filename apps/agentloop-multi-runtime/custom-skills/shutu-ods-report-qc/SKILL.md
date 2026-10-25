---
name: shutu-ods-report-qc
description: "ODS 分析报告质量检查技能。检查指定目录下ODS分析报告的格式完整性、内容完整性，并自动补齐缺失内容，生成检查报告。触发场景包括：检查报告质量、验证报告完整性、补齐报告缺失内容、批量检查报告等。"
license: MIT
compatibility: "需要 Python 3.10+（跨平台，推荐）；Windows 下可选 PowerShell 5.1。"
metadata:
  version: "0.2.4"
  author: "shutu"
  labels: "汇数-数据资源盘点, 养数, 监督"
---

# ODS 分析报告质量检查

对指定目录下已生成的 ODS 分析报告进行**格式完整性**和**内容完整性**严格检查，输出质量检查报告 Markdown 文件。

本技能不修改原始报告，仅输出检查结论和问题清单，供人工复核。

> **协同网络**：ODS 数据资源盘点（网络 5）
> - 成员：DB2 资产目录 ODS 导出技能（上游导出）、ODS 单表建模分析技能（中游分析枢纽）、ODS 分析报告结构校验技能（配套质检）、本技能（配套质检：内容质量）、ODS→DDM 建模全流程技能（下游产出收数标准）、全域公共维度统计与合并分析技能（全域下游，产出公共维度清单）
> - 一致性约束：本技能的检查项清单（A 格式/B 内容/C 警告）须与分析技能的核心原则/报告模板/输出规范一致
> - 变更同步：分析技能改强制规则（必备章节/字段覆盖率/关联验证状态/事实推断分离等）→ 本技能同步检查项

## 依赖

- **脚本**：`scripts/check-report.ps1`
- **检查依据**：`shutu-ods-analysis` SKILL.md 中的核心原则、分析流程、报告模板、输出规范

## 参数约定

| 参数 | 说明 | 示例 |
|:---|:---|:---|
| `report_dir` | 报告所在目录（必填） | `<任务目录>/results/shutu-ods-analysis/output/XZ/2` |
| `report_file` | 指定单个报告文件名（可选） | `BSTADODURP_T_ODS_AMS_FONDS_分析报告.md` |
| `output_dir` | 检查报告输出目录 | `{report_dir}\qc-reports`（默认） |
| `check_type` | 检查类型 | `all`（默认） / `format` / `content` |

---

## 核心原则

### 1. 严格对照分析技能标准

所有检查项直接映射 `shutu-ods-analysis` 技能中的强制规则，不搞独立标准。

### 2. 问题分级

- **必改问题（FAIL）**：违反强制规则，报告不达标
- **警告项（WARNING）**：存在质量风险，建议优化
- **通过（PASS）**：符合规范

### 3. 可追溯

每次检查生成独立报告，记录检查时间、检查项、发现的问题、涉及文件。

---

## 检查项目清单

### A. 格式完整性检查（FAIL 级）

| 检查项 | 判定标准 | 属于分析技能中... |
|:---|:---|:---|
| 必备章节 | 必须包含：一、基本信息；二、关键字段；三、扩展与预留字段；四、直接关联表；五、关系图；六、样例与关键分布；七、建模结论 | 报告模板 |
| 基本信息表 | 必须包含：Schema、表名、中文备注、数据层级、总记录数、总列数、显式主键/唯一索引、候选逻辑主键、对象判断、数据粒度、字段覆盖率 | 报告模板 Step4 |
| 关键字段表 | 必须按语义角色分组列出字段，且包含字段类型、建模用途、判定依据列 | 报告模板 |
| 扩展与预留字段 | 必须有已命名扩展字段和未命名预留字段摘要 | 报告模板 |
| 直接关联表 | 必须有角色、关联字段、关系说明、验证依据列 | 报告模板 |
| ASCII 关系图 | 五、关系图中必须有 ASCII 文本格式关系图 | 输出规范 |
| 建模结论 | 必须包含：查询事实、建模推断（含表类型/业务对象/逻辑主键/数据粒度/属性命名风险/字段类型风险）、风险与缺口、是否建议进入候选模型 | 报告模板 |

### B. 内容质量检查（FAIL 级）

| 检查项 | 判定标准 | 属于分析技能中... |
|:---|:---|:---|
| 字段覆盖率 | 报告中出现的关键字段唯一数 / 总列数 >= 90%；否则 FAIL | Step4 列覆盖率自检 |
| 关联关系验证状态 | 关联关系必须标注"已验证（命中 N 条）"或"无关联关系"；存在"待验证"则 FAIL（0行表除外） | Step2 强制验证规则 |
| 事实与推断分离 | 建模结论中必须同时出现"查询事实"和"建模推断"分区；未分离则 FAIL | 核心原则 2 |
| 候选模型结论 | 必须有明确的"建议 / 有条件建议 / 暂不建议"结论；缺失则 FAIL | 报告模板 |
| 数据来源错误 | 使用 SYSCAT.CARD 替代 COUNT(*) → FAIL；人工计数 SYSCAT.COLUMNS 行数 → FAIL | Step1 注意事项 / 输出规范 |
| 同前缀默认关联 | 将同前缀表直接写成已确认关系，未给出字段级 JOIN 验证 → FAIL | Step2 核心原则 8 |
| 样例数据缺失 | 六、样例与关键分布中缺少 FETCH FIRST 10 样例数据 → FAIL | Step3 / 输出规范 |

### C. 内容质量检查（WARNING 级）

| 检查项 | 判定标准 | 属于分析技能中... |
|:---|:---|:---|
| 字段类型标注 | 关键字段未显式标注：主标识字段 / 外部引用字段 / 准标识字段 / 数据类型字段 | 核心原则 7 |
| 标识字段样例支撑 | ID/UUID/CODE/NO/NAME/ENAME 类字段缺少样例值体系判定依据 | Step3 / logic-entity-modeling-rules |
| 关键分布统计 | 缺少 1~3 个关键分布统计 | Step3 / 输出规范 |
| 审计字段规范化 | 存在 CREATED/UPDATED 类字段但未使用规范化命名（记录创建时间/记录修订者等） | logic-entity-modeling-rules 共性字段规范化 |
| COLCOUNT 引用 | 未在报告中明确引用 SYSCAT.TABLES.COLCOUNT 作为总列数权威来源 | Step1 权威列数 / 注意事项 |
| 逻辑主键 | 建模推断中未提及逻辑主键 | 报告模板 |
| 表类型 | 建模推断中未明确表类型（主表/明细表/快照表/维表） | 报告模板 |

---

## 检查流程

### Step 1：读取报告目录

确定待检查的报告文件列表（*.md）。

### Step 2：逐文件执行检查

对每份报告调用 `scripts/check-report.ps1` 中的检查逻辑，按上述 A/B/C 分类判定问题。

### Step 3：生成 QC 报告

汇总所有检查结果，输出为 Markdown 文件：`QCReport_{domain}_{yyyyMMdd_HHmmss}.md`

同时输出 JSON 明细：`QCReport_{domain}_{yyyyMMdd_HHmmss}.json`

---

## 输出规范

- 检查报告输出至 `{report_dir}/qc-reports/`
- 检查报告命名：`QCReport_{domain}_{yyyyMMdd_HHmmss}.md`
- 保留原始报告不做修改
- QC 报告包含：基本信息、汇总统计、问题汇总（必改列表）、逐文件详细检查结果、检查标准说明

---

## 执行方式

### 方式一（推荐，跨平台）：Python CLI

`scripts/check-report.py` 与 PowerShell 版检查逻辑同构，macOS/Linux/Windows 通用：

```bash
# 单次检查单份报告
python scripts/check-report.py --report-dir results/shutu-ods-analysis/output/XZ/2 \
  --report-file "BSTADODURP_T_ODS_AMS_FONDS_分析报告.md" --check-type all

# 批量检查目录下所有报告
python scripts/check-report.py --report-dir results/shutu-ods-analysis/output/XZ/2 --check-type all
```

参数：`--report-dir`（必填）、`--report-file`（可选，指定单份报告）、`--output-dir`（可选，默认 `{report_dir}/qc-reports/`）、`--check-type`（`all`/`format`/`content`，默认 `all`）。

### 方式二（Windows/PowerShell）：单次或批量检查

```powershell
$env:REPORT_DIR = "<任务目录>/results/shutu-ods-analysis/output/XZ/2"
$env:CHECK_TYPE = "all"
.\scripts\check-report.ps1
```

单份报告时额外设置 `$env:REPORT_FILE = "<报告文件名>"`。

### 方式三（Windows/PowerShell）：直接调用函数

```powershell
Import-Module .\scripts\check-report.ps1
Invoke-ReportQualityCheck -ReportDir "<任务目录>/results/shutu-ods-analysis/output/XZ/2" -CheckType "all"
```

---

## 注意事项

- 检查脚本按 UTF-8 编码读取报告文件
- 文件名含特殊字符时，建议通过 `ReportDir` 批量扫描，避免直接传 `ReportFile`
- 本技能仅做静态文本检查，不涉及数据库连接验证 SQL 结果真实性
- 若报告的实际 SQL 查询结果与文字描述矛盾，本技能无法检出，需人工复核

---

## 参考文件

| 文件 | 用途 |
|:---|:---|
| `../shutu-ods-analysis/SKILL.md` | 分析技能标准（检查依据来源） |
| `../shutu-ods-analysis/references/logic-entity-modeling-rules.md` | 逻辑实体建模判定规则 |
