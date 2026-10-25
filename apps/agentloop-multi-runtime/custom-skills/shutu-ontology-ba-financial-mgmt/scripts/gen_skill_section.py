#!/usr/bin/env python3
"""业财事项汇总表 Excel → SKILL.md「业务流程识别」章节文本生成脚本（本地维护脚本）。

用途：Excel（重新）导入时，生成交付给 SKILL.md「业务流程识别」章节的替换文本
（18 流程 + 各流程代表性动作 + BR 双向引用索引）。**不直接修改 SKILL.md**——
输出文本由维护者人工审阅后替换章节（防覆盖人工润色）。

⚠️ 重跑风险：本脚本全量重生成章节文本。若 SKILL.md 章节曾被人工润色
（改描述、增删代表动作、调整 BR 挂接），重跑输出会丢失这些修改——重跑前
先 diff 现章节与输出，人工合并后再替换；替换后须重跑四步门卫。

三处财务域知识映射维护点（随业务演进人工更新）：
- FLOW_DESC：流程定位语（lint L3 描述必填）
- REP_ACTIONS：每流程代表性动作清单（名称须与 Excel「业财事项类型」逐字一致，
  否则脚本报错；与附录同名时 SKILL.md 描述优先）
- BR_MAP：动作 → 业务规则挂接（动作内「相关规则」+ 章节末反向索引表）

依赖：Python 3.10+；openpyxl（conda activate ontoflow_agents_oc_jtbc）

用法：
    python gen_skill_section.py --xlsx <Excel路径> [--out section_md.txt]   # 缺省 stdout
"""
import argparse
import sys
from pathlib import Path

from gen_annex import load_rows, flow_name, group_flows  # 同目录复用载入/分组逻辑

# 流程定位（人工撰写，lint L3 要求描述必填）
FLOW_DESC = {
    "借款管理": "银行借款全生命周期核算——合同签订、本金借入、还本付息、利息预提与结转，及对应红冲事项",
    "资金运作": "金融投资运作核算——定期存款、交易账户资金调拨、金融资产（股票/基金/债券等）购入处置与重估、商品/货币衍生品、外汇购汇结汇",
    "票据管理": "应收/应付票据业务核算——收取、兑现、贴现、背书、质押、退票，应付票据出具与承兑，票据保证金",
    "资产管理": "长期资产全生命周期核算——固定资产、投资性房地产、无形资产、长期待摊费用、递延收益、使用权资产、租赁负债、长期股权投资的验收/转入、变动、折旧摊销、减值与处置",
    "成本管理": "产品成本核算——辅助生产成本分配、生产成本结转、产品成本计算、待摊费用摊销",
    "委托贷款": "委托贷款业务核算——本金发放与收回、利息计提与收取、减值计提",
    "债券管理": "债券融资核算——发行收款、利息计提、付息",
    "总账": "总账核心核算——费用结转（7/8 归属）、利润结转、开关账、期初切换、账务调整，及税费/暂估/红冲等报账类事项",
    "财务服务平台": "财务服务平台通用手工报账",
    "通宝管理": "应收/应付通宝（集团独立结算工具）业务核算——收取、兑现、贴现、背书、出具、承兑",
    "信用证管理": "应收/应付信用证业务核算——开立、收取、交单、收款、付款、贴现/福费廷",
    "资金平台": "股份现金平台内部资金核算——平台资金调拨、利息预提与结算",
    "应付管理": "应付业务全流程核算——预支/预付、采购与费用报支、尾款、付款指令（对公/对私）、出国业务、债务转移、负数发票",
    "薪酬核算": "职工薪酬发放核算",
    "在建工程": "在建工程核算——暂估与转固",
    "库存核算": "存货收发存核算——期初切换、各类出入库、减值准备、业财对账",
    "应收管理": "应收业务核算——销售收款与核销、退款转款、销售结算（外销）、暂估与预计",
    "现金管理": "银行间划款核算",
}

# 每流程代表性动作（名称须与业财事项类型逐字一致）
REP_ACTIONS = {
    "借款管理": ["银行借款合同签订", "银行借款本金借入", "银行借款还本付息", "银行借款利息预提",
               "银行借款本金借入红冲", "银行借款利息预提红冲"],
    "资金运作": ["定期存款存入", "定期存款本息收回", "交易账户资金转入", "交易账户资金转出",
               "金融资产购入", "金融资产处置", "商品衍生品购入", "外汇购汇、结汇"],
    "票据管理": ["应收票据收取", "应收票据兑现", "应收票据贴现", "应收票据背书", "应付票据出具", "票据保证金转入"],
    "资产管理": ["固定资产验收", "固定资产折旧", "固定资产处置", "固定资产报废", "投资性房地产新增/转入",
               "无形资产摊销", "长期待摊费用摊销计算", "递延收益转入", "使用权资产转入",
               "长期股权投资购入（按类型细分）", "长期股权投资权益确认"],
    "成本管理": ["辅助生产成本分配", "生产成本结转", "产品成本计算", "待摊费用摊销"],
    "委托贷款": ["委托贷款本金发放", "委托贷款利息计提", "委托贷款利息收取", "委托贷款本金收回", "委托贷款减值计提"],
    "债券管理": ["债券发行收款", "债券利息计提", "债券付息"],
    "总账": ["7归属费用结转", "8归属费用结转", "本年利润结转", "汇兑损益结转", "总账月度开关账",
           "总账年度关账", "期初余额切换", "总账调整", "所得税计提", "税费支付", "账务红冲", "进项税暂估"],
    "财务服务平台": ["手工报账（通用）"],
    "通宝管理": ["应收通宝收取", "应收通宝兑现", "应收通宝背书", "应付通宝出具"],
    "信用证管理": ["信用证收取", "信用证收款", "信用证付款（见单付款）"],
    "资金平台": ["平台资金调拨", "平台资金利息预提", "平台资金利息结算"],
    "应付管理": ["预付报支", "预付款核销", "采购/费用报支", "业务活动费报支", "差旅费报支",
               "尾款报支", "对公付款", "负数发票抵付", "债务转移"],
    "薪酬核算": ["职工薪酬发放"],
    "在建工程": ["在建工程暂估", "在建工程转固"],
    "库存核算": ["存货期初切换", "存货外购入库", "存货暂估入库", "存货销售出库", "存货领用出库", "存货减值准备计提"],
    "应收管理": ["销售收款", "收款核销", "收款核销红冲", "销售退款", "账套内转款", "销售结算", "销售暂估", "销售预计"],
    "现金管理": ["银行间划款"],
}

# BR 挂接（动作名 → 相关规则；双向导航）
BR_MAP = {
    "银行借款合同签订": ["BR-21"], "银行借款本金借入": ["BR-21"],
    "委托贷款本金发放": ["BR-21"],
    "应收票据收取": ["BR-33"], "应收票据兑现": ["BR-12", "BR-33"], "应收票据贴现": ["BR-12"],
    "应收票据背书": ["BR-35"],
    "固定资产处置": ["BR-07"], "固定资产报废": ["BR-07"], "固定资产折旧": ["BR-57"],
    "7归属费用结转": ["BR-26", "BR-27"], "8归属费用结转": ["BR-26", "BR-27"],
    "本年利润结转": ["BR-43"],
    "总账月度开关账": ["BR-11"], "总账年度关账": ["BR-11"],
    "所得税计提": ["BR-15"], "税费支付": ["BR-15"], "账务红冲": ["BR-24"],
    "手工报账（通用）": ["BR-53", "BR-54"],
    "应收通宝收取": ["BR-36"], "应收通宝兑现": ["BR-36"],
    "预付报支": ["BR-22"], "预付款核销": ["BR-13", "BR-22"],
    "采购/费用报支": ["BR-34", "BR-45", "BR-46", "BR-56"],
    "差旅费报支": ["BR-34", "BR-46"],
    "负数发票抵付": ["BR-40"],
    "销售收款": ["BR-16", "BR-52"], "收款核销": ["BR-42"], "收款核销红冲": ["BR-42"],
    "销售退款": ["BR-47", "BR-48"],
    "销售结算": ["BR-30", "BR-58"],
}


def action_desc(d: dict) -> str:
    parts = []
    if d["单据类型"] and d["单据类型"] != "-":
        parts.append(f"单据：{d['单据类型']}")
    if d["关联业务对象"] and d["关联业务对象"] != "-":
        parts.append(f"关联业务对象：{d['关联业务对象']}")
    if d["会计事务类型"] and d["会计事务类型"] != "-":
        parts.append(f"会计事务：{d['会计事务类型']}")
    if d["相应会计事务"] and d["相应会计事务"] != "-":
        parts.append(f"相应会计事务：{d['相应会计事务']}")
    if d["抛账功能点"] and d["抛账功能点"] != "-":
        parts.append(f"抛账功能点：{d['抛账功能点']}")
    if d["通用单据"] == "是":
        parts.append("通用单据（手工凭证）")
    if d["备注"]:
        parts.append(f"备注：{d['备注']}")
    brs = BR_MAP.get(d["业财事项类型"])
    if brs:
        parts.append("相关规则：" + "、".join(brs))
    return "；".join(parts)


def main():
    ap = argparse.ArgumentParser(description="业财事项汇总表 → 业务流程识别章节文本")
    ap.add_argument("--xlsx", required=True, help="Excel 文件路径")
    ap.add_argument("--sheet", default="Sheet1", help="工作表名（默认 Sheet1）")
    ap.add_argument("--out", default=None, help="输出文件路径（缺省打印到 stdout）")
    args = ap.parse_args()

    xlsx = Path(args.xlsx).resolve()
    if not xlsx.exists():
        sys.exit(f"ERROR Excel 不存在：{xlsx}")
    rows = load_rows(xlsx, args.sheet)
    procs, by_flow = group_flows(rows)

    # 流程名集合一致性（Excel 归纳流程 vs 三映射维护点）
    flow_names = {p["name"] for p in procs}
    stale = (set(FLOW_DESC) | set(REP_ACTIONS)) - flow_names
    if stale:
        sys.exit(f"ERROR FLOW_DESC/REP_ACTIONS 含 Excel 中不存在的流程（Excel 流程集变化，请同步映射表）：{sorted(stale)}")
    missing = flow_names - (set(FLOW_DESC) & set(REP_ACTIONS))
    if missing:
        sys.exit(f"ERROR Excel 新增流程未维护 FLOW_DESC/REP_ACTIONS：{sorted(missing)}")

    # 代表动作名须与 Excel 业财事项类型逐字一致
    for p in procs:
        names = {r["业财事项类型"] for r in by_flow[p["name"]]}
        for a in REP_ACTIONS[p["name"]]:
            if a not in names:
                sys.exit(f"ERROR 流程「{p['name']}」无事项「{a}」。该流程事项：{sorted(names)}")
    br_names = {r["业财事项类型"] for r in rows}
    stale_br = set(BR_MAP) - br_names
    if stale_br:
        sys.exit(f"ERROR BR_MAP 含 Excel 中不存在的动作：{sorted(stale_br)}")

    L = []
    L.append("## 业务流程识别")
    L.append("")
    total_rep = sum(len(v) for v in REP_ACTIONS.values())
    L.append(f"> **全量明细**：`docs/业财事项汇总表.md`（{len(procs)} 流程 × {len(rows)} 业财事项；本章节收录各流程代表性动作 {total_rep} 项，未收录事项见全量明细；RDF 镜像经附录机制并入全量 {len(rows)} 个动作）")
    L.append(f"> 素材来源：财务领域专家提供《业财事项汇总表》（2026-08-27），按「财务应用」归纳 {len(procs)} 个流程；流程描述与代表性动作经业务整理，完整明细以附录文件为准。")
    L.append("")
    for i, p in enumerate(procs, 1):
        fname = p["name"]
        items = by_flow[fname]
        L.append(f"### {i}. {fname}")
        L.append("")
        L.append(f"- **名称**：{fname}")
        L.append(f"- **描述**：{FLOW_DESC[fname]}。完整 {len(items)} 项业财事项见 `docs/业财事项汇总表.md`")
        L.append("")
        for a in REP_ACTIONS[fname]:
            d = next(r for r in items if r["业财事项类型"] == a)
            L.append(f"#### {a}")
            L.append("")
            L.append(f"- **名称**：{a}")
            L.append(f"- **描述**：{action_desc(d)}")
            L.append("")

    # 反向索引（BR → 动作，双向导航）
    L.append("**业务规则关联索引**（业务规则 → 流程/动作反向导航，与动作条目内「相关规则」互为双向引用；规则全文见「业务规则」章节）")
    L.append("")
    br_index: dict[str, list[str]] = {}
    for i, p in enumerate(procs, 1):
        for a in REP_ACTIONS[p["name"]]:
            for br in BR_MAP.get(a, []):
                br_index.setdefault(br, []).append(f"{a}（流程{i}·{p['name']}）")
    L.append("| 业务规则 | 关联动作（流程） |")
    L.append("|---|---|")
    for br in sorted(br_index, key=lambda x: int(x.split("-")[1])):
        L.append(f"| {br} | {'；'.join(br_index[br])} |")
    L.append("")

    text = "\n".join(L)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"流程 {len(procs)} | 代表动作 {total_rep} | BR 挂接动作 {len(BR_MAP)} | 涉及 BR {len(br_index)} → {args.out}", file=sys.stderr)
    else:
        print(text)


if __name__ == "__main__":
    main()
