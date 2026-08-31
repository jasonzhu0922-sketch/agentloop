---
name: "dq-platform"
description: "数据质量分析平台整体能力。当用户需要了解、使用、修改或扩展本项目（DCMM-DQ-AI 数据质量分析平台）的整体功能、数据流、模块结构、指标口径、缓存刷新、分析页面或报告生成时使用。"
agentloop:
  roles:
    - source_provider
  artifactKinds:
    - document
    - none
  sourceKinds:
    - database
    - document
  qaKinds: []
---

# 数据质量分析平台（DCMM-DQ-AI）

## 项目概述

基于【宝武集团数据质量规则平台】的规则定义与执行结果数据，构建的数据质量分析平台。核心能力：**表数据缓存生成 → 数据质量综合分析（可视化）→ 质量分析报告生成（含 AI 实时分析与 Word/Markdown 导出）**，落地 DCMM 数据管理能力成熟度评估。

## 项目结构

```
DCMM-DQ-AI/
├── combined_dq_analysis.py   # 主应用（Streamlit，5 个 Tab，含报告生成）
├── api.py                    # API 调用模块（LLM + 外部数据平台）
├── config.py                 # 配置模块（从 .env 读取）
├── data.py                   # 数据获取模块（分页拉取 + 本地 Parquet 缓存）
├── refresh_check_30d.py      # 刷新规则执行结果表缓存（最近 30 天）
├── gen_ws_mapping.py         # 生成工作空间对照表 ws_mapping.json
├── gen_knowledge_v2.py       # 生成二期收数知识库.md
├── parse_procurement_rules.py# 解析采购规则字段
├── .env / .env.example       # 敏感配置
├── *.parquet + *_meta.json   # 本地缓存（两张表）
├── ws_mapping.json           # 工作空间代码→中文名/管理员/数据域
├── DQ_KNOWLEDGE_BASE.md      # 数据质量规则知识库
├── 二期收数知识库.md          # 二期收数质量规则知识库
├── 数据质量分析报告.docx       # 报告模板（格式参考）
└── .opencode/skills/         # 子技能（dq-report 等）
```

## 数据源

| 数据源 | 用途 |
|--------|------|
| 外部数据平台 API（`https://eplat.baocloud.cn`） | 拉取规则定义/执行结果原始数据 |
| `BSTAMSBD00_T_DWD_FACT_SZQA_QLTRULE_DETAIL_SZ.parquet` | 规则定义表（本地缓存） |
| `BSTAMSBD00_T_DWD_FACT_SZQA_QLTRULE_CHECK_DETAIL_SZ.parquet` | 规则执行结果表（本地缓存） |
| LLM API（`deepseek-v4-pro`，`http://10.251.26.100:3000/v1`） | AI 实时分析报告 |
| `ws_mapping.json` / `工作空间对照表.xlsx` | 工作空间对照 |
| `集团经营数据标准指导规范/` | 8 数据域字段标准（知识库来源） |

## 核心模块

| 模块 | 关键函数 | 职责 |
|------|----------|------|
| `api.py` | `call_llm()` | 调用 LLM（OpenAI 兼容，支持 reasoning 模型） |
| | `call_metrci_api()` / `get_api_payload()` | 调用外部数据平台 API |
| `data.py` | `_fetch_all_table_data()` | 分页拉取整张表（PAGE_SIZE=10000，自动重试） |
| | `cache_table_data()` | 按表名生成 Parquet 缓存（可 `days`/`time_col` 过滤） |
| | `load_table_cache()` | 读取缓存，过期自动刷新 |
| | `_cache_expired()` / `_read_cache_meta()` / `_write_cache_meta()` | 缓存时效管理（默认 1 天过期） |
| `combined_dq_analysis.py` | `load_check()` / `load_detail()` | 加载缓存并映射中文字段（`_file_mtime` 作缓存键） |
| | `build_report_data(ws)` | 计算全部指标 |
| | `generate_ai_analysis()` | AI 实时报告（读取 dq-report 技能作 system prompt） |
| | `build_root_cause_diagram()` | 鱼骨图/故障树图形 |
| | `build_report_docx()` / `ai_report_to_docx()` | Word 导出 |
| `refresh_check_30d.py` | — | 带 WHERE 条件的 30 天缓存刷新（避免全表扫描） |

## 数据流转

```
外部数据平台 API
   │  data.py 分页拉取（call_metrci_api，分页 + 重试）
   ▼
本地 Parquet 缓存（*.parquet + *_meta.json，1 天过期）
   │  combined_dq_analysis.py 读取（load_check / load_detail）
   ▼
指标计算（build_report_data）
   ├─ 页面可视化（5 个 Tab）
   ├─ AI 实时报告（generate_ai_analysis → call_llm）
   └─ 导出（Word / Markdown）
```

## 关键字段语义

| 字段 | 含义 |
|------|------|
| `X_DS_RST` | 0=质量通过，-1=有质量问题，-2=规则运行失败（非数据问题） |
| `X_DS_RLID` / `X_DS_TBID` | 规则 ID / 被检表 ID（去重键） |
| `X_DS_CTIME` | 校验时间（取最新用） |
| `X_DS_ALCNT` | **全部记录数**（规则校验的全部记录数量） |
| `X_DS_ABCNT` | **异常记录数** |
| `X_DS_AV` | **实际异常数**（实际值） |
| `X_DS_RQCATID` | 六性：integrity/accuracy/authenticity/timeliness/consistency/soleNature |

## 指标口径

### 规则/表指标（X_DS_RLID 取最新 X_DS_CTIME 后去重）
- 运行规则数 = X_DS_RLID 去重
- 被检表数 = X_DS_TBID 去重
- 运行规则通过数 = X_DS_RST=0 的 X_DS_RLID 去重
- 运行规则有质量问题数 = X_DS_RST=-1 的 X_DS_RLID 去重
- 运行规则报错数 = X_DS_RST=-2 的 X_DS_RLID 去重

### 记录指标（X_DS_TBID + X_DS_RLID 取最新 X_DS_CTIME）
- 运行规则报错的表数 = X_DS_RST∈(-1,-2) 的 X_DS_TBID 去重
- 执行记录总数 = X_DS_ALCNT 之和
- 有质量问题记录数(-1) = X_DS_RST=-1 的 X_DS_AV 之和

### 派生指标
- 通过率 = 运行规则通过数 ÷ 运行规则数 × 100%
- DQAR =（1 - 有质量问题记录数 ÷ 执行记录总数）× 100%
- DRS = 六性通过率均值

## 主要功能（5 个 Tab）

1. **规则定义表（DETAIL）**：规则定义概览、六性分布、启用情况、创建时间趋势、规则模板
2. **执行结果表（CHECK_DETAIL）**：运行走势、未运行规则、工作空间分布、状态分布、-1/-2 重点分析、每表异常数、按表下钻
3. **数据质量知识库**：展示 `DQ_KNOWLEDGE_BASE.md`
4. **二期收数知识库**：展示 `二期收数知识库.md`
5. **质量分析报告**：按工作空间生成完整报告（见子技能 `dq-report`）

## 配置

| 项目 | 环境变量 | 默认值 |
|------|----------|--------|
| LLM 地址 | `DASHSCOPE_BASE_URL` | `http://10.251.26.100:3000/v1` |
| LLM 模型 | `DASHSCOPE_MODEL` | `deepseek-v4-pro` |
| 外部数据平台 | `API_BASE_URL` / `API_METRIC_URL` | `https://eplat.baocloud.cn/...` |
| 客户端凭据 | `API_CLIENT_ID` / `API_CLIENT_SECRET` / `API_MODEL_ID` / `API_USER_ID` | 从 `.env` 读取 |
| 缓存时效 | `CACHE_EXPIRE_DAYS` | 1 天 |
| 端口 | `STREAMLIT_PORT` | 8503 |

> 敏感信息（`DASHSCOPE_API_KEY`、`API_CLIENT_SECRET`、`DB_PASS`）必须从 `.env` 读取，严禁硬编码或写入日志。

## 常用操作

| 操作 | 命令 / 函数 |
|------|-------------|
| 启动应用 | `streamlit run combined_dq_analysis.py --server.port 8503` |
| 刷新规则执行结果缓存（30 天） | `python refresh_check_30d.py` |
| 生成任意表缓存 | `data.cache_table_data('schema.table')` |
| 生成工作空间对照 | `python gen_ws_mapping.py` |
| 生成二期知识库 | `python gen_knowledge_v2.py` |

## 严格规则

1. 不编造数据，所有指标须来自 `build_report_data()` 计算结果
2. 字段语义严格遵循：`X_DS_ALCNT`=全部记录数、`X_DS_ABCNT`=异常记录数、`X_DS_AV`=实际异常数
3. 状态码 `-2` 是"规则运行失败"（执行失败），与 `-1`"有质量问题"严格区分
4. 缓存文件名严格按"表名去点加 `.parquet`"规则生成，字段名须用 API 返回的 `meta.columns.name`
5. 缓存有效期内严禁重复请求 API，必须走本地缓存

## 相关子技能

| 子技能 | 位置 | 用途 |
|--------|------|------|
| `dq-report` | `.opencode/skills/dq-report/SKILL.md` | 质量分析报告完整生成流程（指标口径、根因图、AI 报告、导出） |

## 启动方式

```powershell
streamlit run combined_dq_analysis.py --server.port 8503
```
