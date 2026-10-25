# 变更日志

> 注：本文件为补建，0.2.1 之前的历史版本变更未记录。

## [0.2.4] - 2026-09-02

### 修复 (Fixed)
- 🐛 路径规范存量治理：SKILL.md 3 处 Windows 盘符绝对路径示例统一改 `<任务目录>/results/shutu-ods-analysis/output/XZ/2` 尖括号占位符（参数约定表、PowerShell 环境变量示例、函数调用示例）

## [0.2.3] - 2026-09-02

### 变更 (Changed)
- 🔧 协同网络声明区块成员清单对齐注册表（补全域公共维度统计与合并分析技能，6/6）——全网络声明区块专项对齐

## [0.2.2] - 2026-08-17

### 变更 (Changed)
- 🔧 执行方式重构为跨平台：Python CLI（`scripts/check-report.py`，与 PowerShell 版同构）提为方式一（推荐，macOS/Linux/Windows 通用），PowerShell 方式降级为 Windows 备选（方式二/三合并场景说明）
- 🔧 `compatibility` 从"需要 PowerShell 5.1"改为"需要 Python 3.10+（跨平台，推荐）；Windows 下可选 PowerShell 5.1"

## [0.2.1] - 2026-08-17

### 新增 (Added)
- ✅ SKILL.md 新增协同网络声明区块（ODS 数据资源盘点，网络5）：声明检查项清单（A 格式/B 内容/C 警告）与分析技能核心原则/报告模板/输出规范的一致性约束及变更同步义务
