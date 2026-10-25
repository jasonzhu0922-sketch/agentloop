#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
lineage_similar.py - 血缘相似性分析

根据血缘表 BSTAMSBD00.T_DWD_FACT_BDAQ_DATA_LINEAGE_RELATIONSHIP，找出与目标
API 引用相同表的相似 API。

血缘方向：SRC=上游，DEST=下游。API 引用表 → 记录为 SRC_TYPE='表'、DEST_TYPE='API'。

流程：
    1. 取目标 API 引用的表集合 S（DEST_TABLE_GUID=API_UUID 且 SRC_TYPE='表'）
    2. 反查引用这些表的候选 API
    3. 对每个候选 API 取它的表集合 S'，算 Jaccard = |S∩S'| / |S∪S'|
    4. 降序返回 Top N

公共表过滤：被过多 API 引用的表（如账套密码、合并层级等维度/公共表）会稀释
相似度语义，默认过滤引用 API 数 >= MIN_API_CNT 的表（可调）。
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from query_api import query_dicts, ApiError  # noqa: E402

LINEAGE = "BSTAMSBD00.T_DWD_FACT_BDAQ_DATA_LINEAGE_RELATIONSHIP"
MAIN = "BSTAMOBWSD.T_ODS_TBEDG2221"

# 引用 API 数达到该阈值的表视为公共表，不参与相似度计算
MIN_API_CNT = 50

_common_cache = None


def get_common_tables(min_cnt=MIN_API_CNT):
    """返回被 >= min_cnt 个 API 引用的表名集合（公共表）"""
    global _common_cache
    if _common_cache is not None:
        return _common_cache
    rows = query_dicts(
        f"select SRC_ENAME as T, count(distinct DEST_TABLE_GUID) as C "
        f"from {LINEAGE} where DEST_TYPE = 'API' and SRC_TYPE = '表' "
        f"group by SRC_ENAME having count(distinct DEST_TABLE_GUID) >= {min_cnt}"
    )
    _common_cache = {r["T"] for r in rows if r.get("T")}
    return _common_cache


def get_api_uuid(api_id):
    """按 英文名/API_ID/描述 查主表，返回 {API_ID, API_NAME, API_DESC, API_UUID} 或 None"""
    kw = api_id.replace("'", "''")
    rows = []
    for cond in (
        f"API_NAME = '{kw}'",
        f"API_ID = '{kw}'",
        f"API_DESC like '%{kw}%'",
    ):
        rows = query_dicts(
            f"select API_ID, API_NAME, API_DESC, API_UUID from {MAIN} "
            f"where {cond}"
        )
        if rows:
            break
    return rows[0] if rows else None


def get_api_tables(api_uuid):
    """取某 API 引用的表集合（去重、排除空表名）"""
    uuid_esc = api_uuid.replace("'", "''")
    rows = query_dicts(
        f"select distinct SRC_ENAME as T from {LINEAGE} "
        f"where DEST_TYPE = 'API' and DEST_TABLE_GUID = '{uuid_esc}' "
        f"and SRC_TYPE = '表'"
    )
    return {r["T"] for r in rows if r.get("T")}


def get_candidate_apis(tables):
    """反查引用这些表的候选 API（DEST_ENAME，排除空值）"""
    if not tables:
        return {}
    quoted = ",".join(f"'{t.replace(chr(39), chr(39) * 2)}'" for t in sorted(tables))
    rows = query_dicts(
        f"select distinct DEST_ENAME as N from {LINEAGE} "
        f"where DEST_TYPE = 'API' and SRC_TYPE = '表' "
        f"and SRC_ENAME in ({quoted})"
    )
    return {r["N"] for r in rows if r.get("N")}


def get_tables_by_api_name(api_name):
    """按 API 英文名（DEST_ENAME）取引用的表集合"""
    name_esc = api_name.replace("'", "''")
    rows = query_dicts(
        f"select distinct SRC_ENAME as T from {LINEAGE} "
        f"where DEST_TYPE = 'API' and DEST_ENAME = '{name_esc}' "
        f"and SRC_TYPE = '表'"
    )
    return {r["T"] for r in rows if r.get("T")}


def jaccard(a, b):
    if not a and not b:
        return 0.0
    inter = a & b
    union = a | b
    return len(inter) / len(union) if union else 0.0


_cname_cache = {}


def get_cname(api_name):
    """按 API 英文名（API_NAME）查中文名（API_DESC），带缓存。

    英文名精确匹配优先；查不到时按 API_ID 后缀（血缘表 DEST_ENAME 可能带工作空间前缀）
    兜底。
    """
    if api_name in _cname_cache:
        return _cname_cache[api_name]
    name_esc = api_name.replace("'", "''")
    rows = query_dicts(
        f"select API_DESC as D from {MAIN} where API_NAME = '{name_esc}'"
    )
    if not rows:
        rows = query_dicts(
            f"select API_DESC as D from {MAIN} where API_ID like '%{name_esc}%'"
        )
    desc = (rows[0].get("D") or "").strip() if rows else ""
    _cname_cache[api_name] = desc
    return desc


def find_similar(api_id, top_n=10, min_api_cnt=MIN_API_CNT):
    """返回 (目标信息, 表集合, 公共表集合, [(相似度, API名, 重叠表), ...])"""
    api = get_api_uuid(api_id)
    if not api:
        return None, set(), set(), []

    common = get_common_tables(min_api_cnt)

    tables = get_api_tables(api.get("API_UUID") or "")
    core = tables - common  # 参与相似度计算的核心表（排除公共表）
    if not core:
        # 目标 API 只引用了公共表，退化为用全部表
        core = tables

    candidates = get_candidate_apis(tables)
    candidates.discard(api.get("API_NAME") or "")

    results = []
    for name in candidates:
        s2 = get_tables_by_api_name(name)
        if not s2:
            continue
        core2 = s2 - common
        if not core2:
            core2 = s2
        score = jaccard(core, core2)
        if score > 0:
            overlap = sorted(core & core2)
            results.append((score, name, overlap))

    results.sort(key=lambda x: (-x[0], x[1]))
    return api, tables, common, results[:top_n]


def fmt_result(api, tables, common, results):
    lines = []
    lines.append(f"目标 API：{api.get('API_NAME')}（{api.get('API_DESC')}）")
    core = tables - common
    lines.append(f"引用表({len(tables)})，核心表({len(core)})：")
    for t in sorted(core):
        lines.append(f"  - {t}")
    filtered = sorted(tables & common)
    if filtered:
        lines.append(f"公共表(已排除，不参与相似度)：{', '.join(filtered)}")
    lines.append("")
    if not results:
        lines.append("未找到引用相同核心表的相似 API。")
        return "\n".join(lines)
    lines.append(f"相似 API（Jaccard 降序，Top {len(results)}）：")
    for score, name, overlap in results:
        cname = get_cname(name)
        label = f"{name}（{cname}）" if cname else name
        lines.append(f"  {score:.3f}  {label}")
        lines.append(f"            重叠表({len(overlap)}): {', '.join(overlap)}")
    return "\n".join(lines)


def fmt_similar_brief(tables, common, results):
    """血缘简表：上游引用表 + 相似 API，供 detail 输出平级展示"""
    lines = []
    core = tables - common
    if tables:
        if core:
            lines.append(f"  上游引用表({len(core)}): " + ", ".join(sorted(core)))
        filtered = sorted(tables & common)
        if filtered:
            lines.append(f"  公共表(已排除): " + ", ".join(filtered))
    else:
        lines.append("  （无血缘表数据）")
    if results:
        lines.append("  相似 API：")
        for score, name, overlap in results:
            cname = get_cname(name)
            label = f"{name}（{cname}）" if cname else name
            lines.append(f"    {score:.3f}  {label}")
    else:
        lines.append("  （未找到引用相同核心表的相似 API）")
    return "\n".join(lines)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    api, tables, common, results = find_similar(sys.argv[1])
    if not api:
        print(f"未找到 API：{sys.argv[1]}")
        return 1
    if not tables:
        print(f"API「{api.get('API_NAME')}」无血缘表数据。")
        return 1
    print(fmt_result(api, tables, common, results))
    return 0


if __name__ == "__main__":
    sys.exit(main())
