---
name: shutu-ods-ddm-modeling
description: "ODS表分析 → DDM（数据域模型）建模全流程自动化。基于ODS层表分析报告，使用graphify图谱分析识别业务域边界，提取业务对象与逻辑实体，生成详尽的Markdown建模报告和收数标准Excel。触发：/ods-ddm-modeling，或用户提到ODS分析、DDM建模、数据域建模、收数标准、维度建模、业务对象提取、逻辑实体设计等场景时也应主动使用。适用于企业数据中台ODS→DDM层建模场景。"
license: MIT
compatibility: "需要 graphify 技能、ODS 单表分析报告，以及 Python 3.10+ 和 openpyxl 用于生成 Excel。"
metadata:
  version: "0.1.3"
  author: "shutu"
  labels: "汇数-数据资源盘点, 养数"
---

# ODS → DDM 建模全流程技能

将ODS层表分析报告转化为完整的DDM（Data Domain Model）建模成果，包括Markdown建模报告和收数标准Excel。

> **协同网络**：ODS 数据资源盘点（网络 5）
> - 成员：DB2 资产目录 ODS 导出技能（上游导出）、ODS 单表建模分析技能（中游分析枢纽）、ODS 分析报告结构校验技能、ODS 分析报告质量检查技能（配套质检）、本技能（下游产出收数标准）、全域公共维度统计与合并分析技能（全域下游）
> - 一致性约束：本技能的输入解析须与分析技能产出的 Markdown 报告结构一致；本技能总览报告（Phase 5）命名与统计字段格式 → 维度分析技能的输入解析
> - 变更同步：分析技能改报告结构 → 本技能同步输入解析；本技能改总览报告格式 → 维度分析技能同步
> - 跨网络衔接（← 网络 6）：本技能通过 tp-search MCP 服务检索单表特征档案图谱，获取跨表语义关联参考，辅助业务域建模

## 前置依赖

- **graphify 技能**：必须先运行 `/graphify` 完成ODS表的图谱分析，图谱的社区检测结果直接决定业务域边界
- **ODS表分析报告**：通常是Markdown格式，每个ODS表一份报告，包含字段定义、行数、Schema等信息

## 输入参数

通过 `/shutu-ods-ddm-modeling` 命令后跟参数，或由用户对话中提取：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `source_dir` | ODS表分析报告目录 | `results/shutu-ods-analysis/output/` |
| `graph_report` | graphify图谱分析报告路径 | `{source_dir}/graphify-out/GRAPH_REPORT.md` |
| `output_dir` | Markdown报告输出目录 | `results/shutu-ods-ddm-modeling/output/` |
| `excel_output` | Excel报告输出路径 | `results/shutu-ods-ddm-modeling/output/收数标准设计_{业务域}_DDM建模报告.xlsx` |
| `sample_excel` | 样例Excel格式参考（可选） | - |
| `domain_config` | 业务域定义（可选，不提供则自动检测） | - |

---

## 执行流程

### Phase 1：图谱分析（graphify前置）【不可跳过】

**为什么先做图谱**：ODS表之间的外键关系和共享字段模式，能揭示真实的业务域边界。仅靠表名模式分类会遗漏跨域关系和枢纽表。

> [!important] 前置依赖强制检查
> graphify 图谱分析是**不可跳过**的前置步骤，智能体不得以"表名前缀分类已足够清晰"等理由跳过。若 graphify 不可用（未安装、对 Markdown 报告产出 0 节点等）或执行失败，必须：
> 1. 向用户报告工具不可用的事实和原因
> 2. 提供降级方案（如基于 networkx + Louvain 的自定义社区检测）并明确说明降级风险（可能遗漏跨域关系）
> 3. **获得用户同意后再继续**，不得静默降级
>
> 历史教训：曾有会话中智能体未报告就跳过 graphify，用户质问"跳过graphify图谱分析的原因是什么？"，智能体承认"没有正当理由"。

1. 确认graphify已运行：检查 `{source_dir}/graphify-out/GRAPH_REPORT.md` 是否存在
2. 若不存在，先执行 `/graphify {source_dir}` 生成图谱分析
3. 读取GRAPH_REPORT.md，提取：
   - 总体统计（节点数、边数、社区数）
   - 社区列表及其包含的表
   - 枢纽Schema和连接表
   - 跨社区关系

### Phase 2：业务域分类

**分类依据**（优先级从高到低）：
1. graphify社区检测结果（最可靠）
2. Schema归属（同一Schema的表倾向属于同一域）
3. 表名前缀模式（如TADFE* → 预算域）
4. 字段共享模式（共享ACCT_TITLE_CODE的表倾向属于总账/会计相关域）

**输出**：domain_classification.json，格式：
```json
{
  "YS": {"name": "预算", "tables": 19, "schemas": ["BFMSXAAD"], "row_estimate": 383},
  "CB": {"name": "成本", "tables": 112, "schemas": ["BFMSXAAC"], "row_estimate": 3057286}
}
```

**大域拆分**：当某域超过100张表时，必须提出子域拆分方案（参考graphify社区结构），例如：
- ZJ资金域580表 → 票据管理/委贷融资/银行账户/资金计划/担保/结算/征信 7个子域
- GL总账域258表 → 凭证/余额/合并报表/工作底稿/科目映射/报表模板 6个子域

### Phase 3：业务对象提取

**这是最核心也最耗时的步骤**。对每个业务域，需要逐表阅读ODS分析报告，按业务语义聚合表。

**识别模式**：
- **主从结构**：头表+行项目表（如TAAAAA1凭证头 + TAAAAA2凭证明细）
- **生命周期**：同一业务的不同状态表（如验收→在用→折旧→报废）
- **维度共享**：共享相同主键结构的表属于同一对象

**每个业务对象需定义**：
```
业务对象名: 预算科目 (BudgetItem)
来源表: BFMSXAAD.TADFER1 (1,748行)
对象标识: COMPANY_CODE + BUDGET_YEAR + BUDGET_ITEM
逻辑实体:
  - 预算科目主表 (维度表)
核心度量: (无)
维度引用: DIM_COMPANY, DIM_COST_CENTER
```

**并行策略**：按域分配给并行子代理，每个代理负责1-2个域的业务对象提取和报告生成。域较大的（如ZJ 580表、GL 258表）独占一个代理。

### Phase 4：一致性维度识别

扫描所有域的字段，识别跨6+域出现的字段，统一建设为一致性维度：

| 维度 | 识别信号 | SCD策略 |
|------|---------|---------|
| DIM_COMPANY | COMPANY_CODE出现频率>50% | Type 2（并购重组） |
| DIM_ACCT_PERIOD | ACCT_PERIOD_NO跨域 | Type 1 |
| DIM_ACCT_TITLE | ACCT_TITLE_CODE跨域 | Type 2（科目调整） |
| DIM_CURRENCY | CURRENCY_CODE跨域 | Type 1 |
| DIM_COST_CENTER | COST_CENTER跨域 | Type 2（组织调整） |
| DIM_VENDOR | VENDOR_CODE跨域 | Type 2（客商变更） |
| DIM_DATE | 各日期字段 | Type 1 |
| DIM_INVOICE | INVOICE_NO跨域 | 退化维度 |

**审计字段统一**：不同Schema的审计字段命名不一致（如REC_CREATOR vs CREATE_PERSON），需映射到统一的ETL_CREATE_BY等字段。

### Phase 5：Markdown报告生成

使用并行代理，每个域一个代理。报告模板：

```
# {域代码} {域名称} DDM 建模报告

| 属性 | 值 |
|------|-----|
| 域代码 | {code} |
| 域名称 | {name} |
| ODS 表总数 | {count} |
| 业务对象数 | {obj_count} |
| 报告版本 | v1.0 |

## 1. 域概述
### 1.1 业务范围
### 1.2 核心大表清单（含行数、业务角色）
### 1.3 业务对象清单

## 2. 业务对象详细建模
### 2.N 业务对象：{name}（{en_name}）
#### 2.N.1 业务定位与识别依据
#### 2.N.2 来源 ODS 表清单
#### 2.N.3 逻辑实体定义
#### 2.N.4 字段级详细说明
| 字段英文名 | 中文名称 | 数据类型 | 长度 | 精度 | 值域 | 约束 | 度量类型 | 安全等级 | ODS来源表.字段 |
#### 2.N.5 ODS映射关系（代码块格式）

## 3. 一致性维度引用
## 4. 建模建议与注意事项
```

**总览报告**（00_xxx总览报告.md）在所有域报告完成后生成，汇总：
- 10域统计数据
- 一致性维度总线架构图（ASCII art）
- 跨域关联枢纽分析
- 建设优先级建议（P0→P3）

### Phase 6：Excel报告生成

参考样例Excel格式（如果用户提供了sample_excel）。生成Python脚本并执行。

**必须包含的Sheet**：
1. `总体说明` — 目的、范围、方法、优先级
2. `统计` — 每域：对象数、实体数、表数、数据量、频度
3. `收数清单` — 所有逻辑实体的主清单
4. `{域名}（{代码}）` — 每域一个Sheet，16列字段详情
5. `值域-{名称}` — 值域参考数据

**域Sheet的16列结构**：
```
业务对象中文名 | 表中文名 | 字段英文名 | 字段中文名 | 字段描述
字段类型 | 长度 | 精度 | 值域 | 计量单位 | 表达格式
安全等级 | 是否集团层面统一 | 标准覆盖范围 | 承接报送需求 | ODS来源表.字段
```

**值域Sheet数据来源**：从ODS分析报告中实际提取值域枚举值（如票据类型AC01=银承/AC02=商承），不要硬编码。

### Phase 7：质量校验（不要跳过！）

这是容易遗漏但至关重要的步骤：

1. **完整性校验**
   - 所有域Sheet都应有数据行（不能只有表头）
   - 收数清单行数应与所有域的逻辑实体总数一致
   - 统计Sheet中的对象数/实体数应与各Sheet实际行数匹配

2. **覆盖度校验**
   - Top 20大表（按行数）必须被纳入某域的业务对象
   - 业务对象总数应合理（通常每100张表约5-10个对象）
   - 一致性维度的跨域频次应与GRAPH_REPORT中的边密度一致

3. **一致性校验**
   - 同名字段（如COMPANY_CODE）在各域的类型应一致
   - ODS来源表.字段 应可追溯到实际ODS分析报告
   - 主键/外键标记应与对象标识定义一致

4. **Excel格式校验**
   - 所有Sheet都有样式（表头蓝色、边框）
   - 列宽适中，中文内容不被截断
   - 数值类型字段标记了度量

---

## 并行执行策略

整个流程中，以下步骤适合并行：

| 步骤 | 并行方式 |
|------|---------|
| Phase 3 业务对象提取 | 按域分配给子代理（大域独占，小域合并） |
| Phase 5 Markdown报告 | 按域分配，与Phase 3合并执行（提取完即生成报告） |
| Phase 6 Excel | 单代理完成（需要汇总所有域数据） |
| Phase 7 质量校验 | 多维校验可并行 |

**推荐代理分配**（以10域为例）：
- Agent 1: YS + CB + ZJ（3域）
- Agent 2: ZC + ZQ（2域）
- Agent 3: ZW + SW（2域）
- Agent 4: GL（1域，数据量大需独占）
- Agent 5: FY + ZB + 总览报告（3域）
- Agent 6: Excel脚本生成 + 执行（等所有域数据就绪）

---

## 注意事项

1. **大表分区策略**：超过1亿行的表（如凭证表16亿行）必须在报告中建议分区方案
2. **VARCHAR存数值**：ODS层常见VARCHAR(50)存金额/日期，DDM层需标注类型转换需求
3. **预留字段处理**：TEMP1~TEMP10等预留字段需逐表确认是否被业务复用
4. **主键缺失**：ODS表极少有显式主键，DDM需基于业务键建立唯一约束
5. **跨域共享表**：同一张ODS表可能被多个域引用（如T_CGCG010在ZW和FY域都用），需在报告中标注共享策略
