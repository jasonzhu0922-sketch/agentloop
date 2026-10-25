---
name: shutu-ods-analysis-validate
description: "校验 ODS 单表建模分析报告的结构完整性，判断是否满足 shutu-ods-analysis 规范的章节与子结构要求，输出合规性评分和问题清单。当用户要求检查分析报告结构、验证报告章节是否完整、批量校验建模报告时使用此技能。"
license: MIT
compatibility: "需要 Python 3.10+"
metadata:
  version: "0.11.2"
  author: "shutu"
  labels: "汇数-数据资源盘点, 养数, 监督"
---

# ODS 分析报告结构完整性校验

对 `shutu-ods-analysis` 生成的建模分析报告做结构完整性校验。**全部校验逻辑由 `scripts/check_md_completeness.py` 程序完成，Agent 仅负责调用该程序并传递正确参数，不得自行判断报告完整性。**

> **协同网络**：ODS 数据资源盘点（网络 5）
> - 成员：DB2 资产目录 ODS 导出技能（上游导出）、ODS 单表建模分析技能（中游分析枢纽）、本技能（配套质检：结构校验）、ODS 分析报告质量检查技能（配套质检）、ODS→DDM 建模全流程技能（下游产出收数标准）、全域公共维度统计与合并分析技能（全域下游，产出公共维度清单）
> - 一致性约束：本技能的校验基准（样本报告七大章节/H1-H4 层级）须与分析技能的报告结构规范一致
> - 变更同步：分析技能改报告章节结构/样本报告 → 本技能同步比对基准

## 使用时机

- 用户要求检查某个 ODS 分析报告的结构是否完整
- 用户要求验证建模报告章节是否齐全
- 用户要求批量校验多个建模分析报告
- 用户提到"检查报告""校验报告""验证报告""报告完整性"等关键词

## 依赖

- **校验程序**：`scripts/check_md_completeness.py`
- **样本模板**：`.opencode/skills/shutu-ods-analysis/references/sample-report.md`

## 操作步骤

### 1. 激活 Python 环境

```bash
conda activate ontoflow_fde_shutu
```

### 2. 确定校验模式与路径

#### 单文件模式

校验单个报告文件，输出校验报告到 `results/shutu-ods-analysis-validate/output/` 目录：

```bash
python scripts/check_md_completeness.py <目标报告路径> -o results/shutu-ods-analysis-validate/output/<报告文件名>_校验报告.md
```

如果不指定 `-o`，校验结果打印到标准输出。

#### 批量模式

校验目录下所有 `.md` 报告文件，输出汇总报告和 CSV 清单：

```bash
python scripts/check_md_completeness.py <报告目录路径> --batch \
  --summary-md results/shutu-ods-analysis-validate/output/batch_check_summary.md \
  --csv results/shutu-ods-analysis-validate/output/batch_check_failed.csv
```

### 3. 输出说明

- 单文件：校验报告输出到 `results/shutu-ods-analysis-validate/output/` 目录，与 `shutu-ods-analysis` 的 `results/shutu-ods-analysis/output/` 目录同级
- 批量：汇总报告和 CSV 清单同样输出到 `results/shutu-ods-analysis-validate/output/` 目录
- 程序返回码：有 ERROR 时退出码为 1，无 ERROR 时为 0

## 完整参数说明

| 参数 | 说明 | 默认值 |
|:---|:---|:---|
| `target` | 目标 Markdown 文件路径或目录路径 | 必填 |
| `-s, --sample` | 样本报告路径 | 从当前目录向上查找 `.opencode/skills/shutu-ods-analysis/references/sample-report.md` |
| `-o, --output` | 单文件校验报告输出路径 | 打印到标准输出 |
| `--batch` | 批量模式 | 关闭 |
| `--summary-md` | 批量模式汇总报告路径 | `results/shutu-ods-analysis-validate/output/batch_check_summary.md` |
| `--csv` | 批量模式不合格文件 CSV 清单路径 | `results/shutu-ods-analysis-validate/output/batch_check_failed.csv` |

## 校验维度

程序自动检查以下两大维度（无需 Agent 干预），分三个严重等级：

| 严重等级 | 说明 |
|:---|:---|
| ERROR | 结构性缺失，如缺少必填章节、缺少必填内容 |
| WARNING | 内容不完整，如缺少表格、缺少列表 |
| INFO | 格式建议，如缺少分布子章节 |

### 标题结构检查

- H1：是否存在且唯一
- H2：七大章节是否对标样本报告
- H3：各 H2 下的子章节是否完整
- H4：分布章节下的子章节

### 内容完整性检查

程序对各章节检查期望的内容类型（表格、代码块、有序列表、引用块），判断是否包含实际数据而非占位值。

## 注意事项

- 全部校验判断由 Python 程序完成，Agent 不得自行判定报告是否合格
- 程序不会自动创建输出目录，Agent 应在执行前 `mkdir -p results/shutu-ods-analysis-validate/output/`
- 总记录数为 0 时，样例与关键分布章节可为空，不报错（仅限空表本身无数据的情况）
- **权限阻断规则**：因数据库 SELECT 权限受限导致数据为推断/模拟/近似值的章节（如样例数据、关键分布、关联关系、总记录数近似值），相关检查项判定为**不通过**，不适用"不适用"豁免
- "关键字段"和"关键分布"的 H3 子标题支持灵活命名，不强制与样本一致
- H3 章节支持别名匹配（如"建模建议"与"是否建议进入候选模型"等价）
- 批量模式的 CSV 清单仅列出有 ERROR 的不合格文件
