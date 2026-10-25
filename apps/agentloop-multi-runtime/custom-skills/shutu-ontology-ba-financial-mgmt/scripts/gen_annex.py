#!/usr/bin/env python3
"""业财事项汇总表 Excel → 附录明细 Markdown 导入脚本（本地维护脚本）。

用途：把财务领域专家提供的《业财事项汇总表》Excel 生成为技能
`docs/业财事项汇总表.md`（附录明细事实源，RDF 镜像经附录机制并入其全量动作，
机制见业务架构开发技能 docs/RDF格式规范.md 9.5 节）。

适用场景：Excel 发新版需重新导入时重跑。重跑会整体重写附录文件——
若附录曾被人工修改，重跑前先 diff 保留人工变更。

依赖：Python 3.10+；openpyxl（conda activate ontoflow_agents_oc_jtbc）

用法：
    python gen_annex.py --xlsx <Excel绝对或相对路径> --out <附录md输出路径> \
        [--sheet Sheet1] [--source-note "YYYY-MM-DD 用户提供"] [--expect-count 236]

规范化规则（与 2026-08-27 首版导入一致，重跑保持零漂移）：
- 「模块/系统」列按合并单元格语义向下填充
- 「财务应用」去掉中文括号后缀 → 流程名（资金运作 8 种变体合并），流程序按首现顺序
- 第 12 列（源表无表头）命名「备注」，原样保留
- 单元格内换行折叠为空格
"""
import argparse
import re
import sys
from pathlib import Path

import openpyxl

COLS = ["模块/系统", "业务对象分类", "业务对象", "财务应用", "单据类型", "关联业务对象",
        "业财事项类型", "会计事务类型", "相应会计事务", "抛账功能点", "通用单据", "备注"]


def norm(v) -> str:
    """单元格规范化：None→空；换行/制表符→空格；连续空白折叠；首尾去空。"""
    if v is None:
        return ""
    s = str(v).replace("\n", " ").replace("\r", " ").replace("\t", " ")
    return re.sub(r" {2,}", " ", s).strip()


def flow_name(app: str) -> str:
    """财务应用 → 流程名：去掉中文括号后缀（资金运作（期货）→ 资金运作）。"""
    return re.sub(r"（.*$", "", app).strip()


def load_rows(xlsx: Path, sheet: str) -> list[dict]:
    wb = openpyxl.load_workbook(xlsx, data_only=True)
    ws = wb[sheet]
    rows, module = [], ""
    for r in ws.iter_rows(min_row=2, values_only=True):
        if all(v is None or norm(v) == "" for v in r):
            continue
        vals = [norm(v) for v in r[:12]]
        if vals[0]:
            module = vals[0]  # 向下填充
        vals[0] = module
        rows.append(dict(zip(COLS, vals)))
    return rows


def group_flows(rows: list[dict]) -> tuple[list[dict], dict[str, list[dict]]]:
    """按流程名分组（首现顺序）。返回 (流程元信息列表, {流程名: 行列表})。"""
    procs: list[dict] = []
    by_flow: dict[str, list[dict]] = {}
    meta: dict[str, dict] = {}
    for row in rows:
        fn = flow_name(row["财务应用"])
        if fn not in by_flow:
            by_flow[fn] = []
            meta[fn] = {"name": fn, "apps": [], "objects": []}
            procs.append(meta[fn])
        p = meta[fn]
        if row["财务应用"] not in p["apps"]:
            p["apps"].append(row["财务应用"])
        if row["业务对象"] not in p["objects"]:
            p["objects"].append(row["业务对象"])
        by_flow[fn].append(row)
    return procs, by_flow


def render_annex_md(xlsx_rel: str, source_note: str, rows: list[dict],
                    procs: list[dict], by_flow: dict[str, list[dict]]) -> str:
    L = []
    L.append("# 业财事项汇总表")
    L.append("")
    note = f"（{source_note}，{len(rows)} 项业财事项）" if source_note else f"（{len(rows)} 项业财事项）"
    L.append(f"> 来源：`{xlsx_rel}`{note}")
    L.append("> 定位：集团财务管理业务架构技能「业务流程识别」章节的**附录明细事实源**——SKILL.md 收录各流程代表性动作，本文件为全量明细；RDF 镜像（`rdf/cwm1.ttl`）经附录机制并入本文件全部动作")
    L.append(f"> 规范化：「模块/系统」列按合并单元格语义向下填充；「财务应用」去掉括号后缀归纳为 {len(procs)} 个流程（资金运作 8 种括号变体合并，变体原值保留在「财务应用」列）；「备注」列源表无表头（7N/1Y/1 附件说明），按用户口径保留为备注；单元格内换行折叠为空格")
    L.append("")
    L.append(f"全量统计：{len(procs)} 流程 × {len(rows)} 业财事项。")
    L.append("")
    for i, p in enumerate(procs, 1):
        items = by_flow[p["name"]]
        L.append(f"## {i}. {p['name']}")
        L.append("")
        apps = "、".join(p["apps"])
        objs = "、".join(p["objects"])
        L.append(f"{len(items)} 项。财务应用原值：{apps}。业务对象：{objs}。")
        L.append("")
        L.append("| " + " | ".join(COLS) + " |")
        L.append("|" + "---|" * len(COLS))
        for row in items:
            L.append("| " + " | ".join(row[c] for c in COLS) + " |")
        L.append("")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser(description="业财事项汇总表 Excel → 附录明细 Markdown")
    ap.add_argument("--xlsx", required=True, help="Excel 文件路径")
    ap.add_argument("--out", required=True, help="附录 md 输出路径（如技能 docs/业财事项汇总表.md）")
    ap.add_argument("--sheet", default="Sheet1", help="工作表名（默认 Sheet1）")
    ap.add_argument("--source-note", default="", help="来源行附加说明（如 '2026-08-27 用户提供'）")
    ap.add_argument("--expect-count", type=int, default=None, help="期望数据行数校验（缺省不校验）")
    args = ap.parse_args()

    xlsx = Path(args.xlsx).resolve()
    if not xlsx.exists():
        sys.exit(f"ERROR Excel 不存在：{xlsx}")
    rows = load_rows(xlsx, args.sheet)
    if args.expect_count is not None and len(rows) != args.expect_count:
        sys.exit(f"ERROR 数据行数 {len(rows)} ≠ 期望 {args.expect_count}")

    procs, by_flow = group_flows(rows)
    md = render_annex_md(args.xlsx, args.source_note, rows, procs, by_flow)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    old = out.read_text(encoding="utf-8") if out.exists() else None
    out.write_text(md, encoding="utf-8")
    drift = "" if old is None else ("（零漂移 ✓" if old == md else "（内容有变化，请 diff 审查人工变更）") + ")"
    print(f"流程 {len(procs)} | 事项 {len(rows)} → {out}{drift}")
    for i, p in enumerate(procs, 1):
        print(f"  {i:>2}. {p['name']}  {len(by_flow[p['name']]):>2} 项")
    if old is not None and old != md:
        sys.exit(1)


if __name__ == "__main__":
    main()
