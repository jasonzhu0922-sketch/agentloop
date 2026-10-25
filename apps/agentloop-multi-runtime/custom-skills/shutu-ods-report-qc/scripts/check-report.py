#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ODS Analysis Report Quality Checker
Strictly checks generated markdown reports against shutu-ods-analysis SKILL standards.
"""

import os
import re
import sys
import json
from datetime import datetime
from pathlib import Path


def invoke_check(report_dir: str, report_file: str = None, output_dir: str = None, check_type: str = "all"):
    report_path = Path(report_dir)
    if not report_path.exists():
        print(f"Report directory not found: {report_dir}")
        sys.exit(1)

    files = []
    if report_file:
        p = report_path / report_file
        if p.exists():
            files.append(p)
        else:
            print(f"File not found: {p}")
    else:
        files = sorted(report_path.glob("*.md"))

    if not files:
        print(f"No markdown reports found in {report_dir}")
        sys.exit(1)

    results = []
    pass_count = fail_count = warn_count = 0

    for f in files:
        print(f"Checking: {f.name}")
        content = f.read_text(encoding="utf-8")
        r = check_single_report(f.name, content, check_type)
        results.append(r)
        if r["overall_status"] == "PASS":
            pass_count += 1
        elif r["overall_status"] == "FAIL":
            fail_count += 1
        else:
            warn_count += 1

    out_path = Path(output_dir) if output_dir else report_path / "qc-reports"
    out_path.mkdir(parents=True, exist_ok=True)

    domain = report_path.name
    timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
    md_file = out_path / f"QCReport_{domain}_{timestamp_str}.md"
    json_file = out_path / f"QCReport_{domain}_{timestamp_str}.json"

    md_content = generate_qc_report(results, str(report_dir), domain, pass_count, fail_count, warn_count)
    md_file.write_text(md_content, encoding="utf-8")
    json_file.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\nQC Report saved to: {md_file}")
    print(f"JSON detail saved to: {json_file}")
    print(f"Summary: PASS={pass_count}, FAIL={fail_count}, WARNING={warn_count}, Total={len(results)}")
    return results


def check_single_report(filename: str, content: str, check_type: str) -> dict:
    issues = []
    warnings = []
    info = {}

    # ---- A. Format completeness ----
    required_sections = [
        ("一、基本信息", r"##\s*一\s*、\s*基本信息"),
        ("二、关键字段", r"##\s*二\s*、\s*关键字段"),
        ("三、扩展与预留字段", r"##\s*三\s*、\s*扩展与预留字段"),
        ("四、直接关联表", r"##\s*四\s*、\s*直接关联表"),
        ("五、关系图", r"##\s*五\s*、\s*关系图"),
        ("六、样例与关键分布", r"##\s*六\s*、\s*样例与关键分布"),
        ("七、建模结论", r"##\s*七\s*、\s*建模结论"),
    ]
    for name, pat in required_sections:
        if not re.search(pat, content, re.IGNORECASE):
            issues.append(f"缺失必备章节: {name}")

    # ---- Basic info table ----
    basic_match = re.search(
        r"##\s*一\s*、\s*基本信息\s*\n([\s\S]*?)(?=\n##(?!\#)|\Z)",
        content, re.IGNORECASE
    )
    if basic_match:
        basic_block = basic_match.group(1)
        required_basic_fields = ["Schema", "表名", "中文备注", "数据层级", "总记录数", "总列数", "显式主键", "候选逻辑主键", "对象判断", "数据粒度"]
        for f in required_basic_fields:
            if f not in basic_block:
                issues.append(f"基本信息表缺失字段行: {f}")

        # Extract total columns
        m = re.search(r"总列数.*?(\d+)", basic_block)
        info["total_cols"] = int(m.group(1)) if m else None

        # Extract coverage
        cm = re.search(r"字段覆盖率.*?\d+\s*/\s*\d+.*?\((\d+)%\)", basic_block)
        if not cm:
            cm = re.search(r"字段覆盖率.*?(\d+)%", basic_block)
        info["coverage"] = int(cm.group(1)) if cm else None

        if info["coverage"] is None:
            warnings.append("未找到字段覆盖率指标")
        elif info["coverage"] < 90:
            issues.append(f"字段覆盖率不足90%: {info['coverage']}%")
    else:
        issues.append("未找到基本信息章节")

    # ---- Key fields ----
    key_match = re.search(
        r"##\s*二\s*、\s*关键字段\s*\n([\s\S]*?)(?=\n##\s*三\s*、|\Z)",
        content, re.IGNORECASE
    )
    if key_match:
        key_block = key_match.group(1)
        field_type_keywords = ["主标识字段", "外部引用字段", "准标识字段", "数据类型字段"]
        has_field_type = any(kw in key_block for kw in field_type_keywords)
        if not has_field_type:
            issues.append("关键字段未标注字段类型(主标识/外部引用/准标识/数据类型)")

        # Count unique column names in tables (first column of each data row)
        rows = re.findall(r"^\|([^\n|]+)\|", key_block, re.MULTILINE)
        uniq_cols = set()
        for row in rows:
            first = row.split("|")[0].strip()
            if first and not first.startswith("-") and first not in ("字段名", "项目"):
                # heuristic: skip markdown header rows and non-field rows
                if re.match(r"^[A-Za-z_]", first):
                    uniq_cols.add(first)
        reported_cols = len(uniq_cols)
        info["reported_cols"] = reported_cols

        if info.get("total_cols") and reported_cols > 0:
            calc_cov = int((reported_cols / info["total_cols"]) * 100)
            if info.get("coverage") and abs(info["coverage"] - calc_cov) > 5:
                warnings.append(f"字段覆盖率声明值({info['coverage']}%)与章节统计({calc_cov}%)偏差超过5%")

        # Sample value support for ID/CODE/NO/NAME fields
        id_code_rows = re.findall(r"^\|\s*(\w*(?:ID|UUID|CODE|NO|NAME|ENAME)\w*)\s*\|", key_block, re.MULTILINE | re.IGNORECASE)
        if id_code_rows:
            if not re.search(r"样例值|值体系|样例|命中|NOT NULL.*值|默认.*值", key_block):
                warnings.append("标识类/准标识类字段可能缺少样例值体系判定依据")
    else:
        issues.append("未找到关键字段章节")

    # ---- Direct relations ----
    rel_match = re.search(
        r"##\s*四\s*、\s*直接关联表\s*\n([\s\S]*?)(?=\n##\s*五\s*、|\Z)",
        content, re.IGNORECASE
    )
    if rel_match:
        rel_block = rel_match.group(1)
        unverified = re.findall(r"待验证|待确认|可能关联|疑似关联", rel_block)
        if unverified:
            issues.append(f"存在未验证的关联关系(待验证/待确认/可能/疑似): {len(unverified)}处")
        if not re.search(r"已验证|无关联关系", rel_block) and re.search(r"\w+_\w+", rel_block):
            warnings.append("关联关系未明确标注验证状态(已验证/无关联关系)")
        if re.search(r"同前缀.*确认|前缀.*即为关联|同名.*关联", rel_block, re.IGNORECASE):
            issues.append("存在将同前缀表直接当作已确认关系的表述")
    else:
        issues.append("未找到直接关联表章节")

    # ---- ASCII diagram ----
    dia_match = re.search(
        r"##\s*五\s*、\s*关系图\s*\n([\s\S]*?)(?=\n##\s*六\s*、|\Z)",
        content, re.IGNORECASE
    )
    if dia_match:
        dia_block = dia_match.group(1)
        has_ascii = re.search(r"[┌┐└┘│─┤├┬┴┼>→←↑↓]|[\+\|\-]{3,}", dia_block)
        if not has_ascii:
            warnings.append("关系图章节缺少ASCII图形表示")
    else:
        issues.append("缺失关系图章节")

    # ---- Sample data & distribution ----
    sample_match = re.search(
        r"##\s*六\s*、\s*样例与关键分布\s*\n([\s\S]*?)(?=\n##\s*七\s*、|\Z)",
        content, re.IGNORECASE
    )
    if sample_match:
        sample_block = sample_match.group(1)
        if not re.search(r"样例数据|样例|前\s*\d+\s*条", sample_block):
            issues.append("缺少样例数据展示")
        if not re.search(r"分布|GROUP BY|统计", sample_block, re.IGNORECASE):
            warnings.append("缺少关键分布统计(1~3个)")
    else:
        issues.append("缺失样例与关键分布章节")

    # ---- Modeling conclusion ----
    conc_match = re.search(
        r"##\s*七\s*、\s*建模结论\s*\n([\s\S]*?)(?=\n##(?!\#)|\Z)",
        content, re.IGNORECASE
    )
    if conc_match:
        conc_block = conc_match.group(1)
        for part in ["查询事实", "建模推断", "风险与缺口", "是否建议进入候选模型"]:
            if part not in conc_block:
                issues.append(f"建模结论缺少部分: {part}")
        if not ("查询事实" in conc_block and "建模推断" in conc_block):
            issues.append("建模结论未明确区分查询事实与建模推断")
        if not re.search(r"建议\s*进入|有条件建议|暂不建议", conc_block, re.IGNORECASE):
            issues.append("建模结论缺少明确的候选模型建议(建议/有条件建议/暂不建议)")
        if "逻辑主键" not in conc_block:
            warnings.append("建模结论未提及逻辑主键")
        if not re.search(r"表类型|主表|明细表|快照表|维表", conc_block):
            warnings.append("建模结论未明确表类型(主表/明细表/快照表/维表)")
    else:
        issues.append("缺失建模结论章节")

    # ---- Content quality checks ----
    if re.search(r"SYSCAT\.CARD|CARD\s*=", content, re.IGNORECASE):
        issues.append("使用 SYSCAT.CARD 作为记录数来源(规范要求使用 COUNT(*))")
    if re.search(r"人工计数|手动计数|肉眼计数", content):
        warnings.append("报告中提到人工计数列数的方式")
    if not re.search(r"COLCOUNT|SYSCAT\.TABLES", content, re.IGNORECASE):
        warnings.append("未引用 SYSCAT.TABLES.COLCOUNT 作为总列数权威来源")

    audit_pattern = r"记录创建时间|记录创建者|记录修订时间|记录修订者|记录归档标记|记录归档日期"
    if re.search(r"CREATED|CREATE_TIME|MODIFIED|REVISOR|REC_CREATE|REC_REVISOR", content, re.IGNORECASE) \
       and not re.search(audit_pattern, content):
        warnings.append("存在审计字段但未使用规范化命名(记录创建时间/记录修订者等)")

    overall = "FAIL" if issues else ("WARNING" if warnings else "PASS")

    return {
        "file_name": filename,
        "overall_status": overall,
        "issue_count": len(issues),
        "warning_count": len(warnings),
        "issues": issues,
        "warnings": warnings,
        "info": info,
    }


def generate_qc_report(results, report_dir, domain, pass_count, fail_count, warn_count):
    total = len(results)
    problem_reports = [r for r in results if r["overall_status"] != "PASS"]
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    lines = []
    lines.append("# ODS 分析报告质量检查报告")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## 一、检查基本信息")
    lines.append("")
    lines.append("| 属性 | 值 |")
    lines.append("|:---|:---|")
    lines.append(f"| **检查时间** | {timestamp} |")
    lines.append(f"| **报告目录** | {report_dir} |")
    lines.append(f"| **检查报告总数** | {total} |")
    lines.append(f"| **通过报告数** | {pass_count} |")
    lines.append(f"| **警告报告数** | {warn_count} |")
    lines.append(f"| **不通过报告数** | {fail_count} |")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## 二、汇总统计")
    lines.append("")
    lines.append("| 指标 | 数值 |")
    lines.append("|:---|:---|")
    lines.append(f"| 格式与内容完整通过 | {pass_count} |")
    lines.append(f"| 存在警告项 | {warn_count} |")
    lines.append(f"| 存在必改问题 | {fail_count} |")
    pct = round((fail_count / total) * 100, 1) if total else 0
    lines.append(f"| 必改问题占比 | {pct}% |")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## 三、问题汇总")
    lines.append("")

    if not problem_reports:
        lines.append("所有报告检查通过，无问题。")
    else:
        lines.append("### 必改问题报告列表")
        lines.append("")
        lines.append("| # | 报告文件名 | 状态 | 问题数 | 警告数 | 问题简述 |")
        lines.append("|:---|:---|:---|:---|:---|:---|")
        for idx, r in enumerate(problem_reports, start=1):
            issue_summary = "；".join(r["issues"]) if r["issues"] else "-"
            if len(issue_summary) > 60:
                issue_summary = issue_summary[:60] + "..."
            lines.append(
                f"| {idx} | {r['file_name']} | {r['overall_status']} | {r['issue_count']} | {r['warning_count']} | {issue_summary} |"
            )

    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## 四、详细检查结果")
    lines.append("")

    for r in results:
        lines.append(f"### {r['file_name']}")
        lines.append("")
        lines.append("| 检查项 | 状态 | 说明 |")
        lines.append("|:---|:---|:---|")

        def cell(items):
            return "；".join(items) if items else "通过"

        def status(flag_issue, flag_warn):
            if flag_issue:
                return "❌ 不通过"
            if flag_warn:
                return "⚠️ 需关注"
            return "✅ 通过"

        all_text_issues = " ".join(r["issues"])
        all_text_warns = " ".join(r["warnings"])
        all_text = all_text_issues + " " + all_text_warns

        sec_ok = not ("必备章节" in all_text)
        basic_ok = not ("基本信息" in all_text)
        cov_stat = status("字段覆盖率" in all_text_issues, "字段覆盖率" in all_text_warns)
        fld_stat = status("字段类型" in all_text_issues, "字段类型" in all_text_warns)
        rel_stat = status("关联" in all_text_issues, "关联" in all_text_warns)
        fact_stat = status("查询事实" in all_text_issues or "建模推断" in all_text_issues, False)
        conc_stat = status("建模结论" in all_text_issues, "建模结论" in all_text_warns or "逻辑主键" in all_text_warns or "表类型" in all_text_warns)
        samp_stat = status("样例" in all_text_issues, "样例" in all_text_warns)
        rec_stat = status("SYSCAT.CARD" in all_text_issues or "人工计数" in all_text_issues, "COLCOUNT" in all_text_warns or "审计字段" in all_text_warns)

        lines.append(f"| 章节完整性 | {'✅ 通过' if sec_ok else '❌ 不通过'} | 一~七章节是否齐全 |")
        lines.append(f"| 基本信息表 | {'✅ 通过' if basic_ok else '⚠️ 需关注'} | Schema/表名/记录数/列数/粒度等 |")
        lines.append(f"| 字段覆盖率 | {cov_stat} | 是否 >= 90% 且统计准确 |")
        lines.append(f"| 字段类型标注 | {fld_stat} | 主标识/外部引用/准标识/数据类型 |")
        lines.append(f"| 关联关系验证 | {rel_stat} | 是否已验证，无待验证残留 |")
        lines.append(f"| 事实推断分离 | {fact_stat} | 查询事实与建模推断是否分离 |")
        lines.append(f"| 建模结论 | {conc_stat} | 表类型/逻辑主键/建议结论 |")
        lines.append(f"| 样例与分布 | {samp_stat} | 样例数据 + 关键分布统计 |")
        lines.append(f"| 数据来源规范 | {rec_stat} | COUNT(*)/COLCOUNT/审计字段 |")

        if r["issues"]:
            lines.append("")
            lines.append("**必改问题：**")
            for issue in r["issues"]:
                lines.append(f"- ❌ {issue}")
        if r["warnings"]:
            lines.append("")
            lines.append("**警告项：**")
            for warn in r["warnings"]:
                lines.append(f"- ⚠️ {warn}")
        lines.append("")
        lines.append("---")
        lines.append("")

    lines.append("## 五、检查标准说明")
    lines.append("")
    lines.append("本检查严格依据 `shutu-ods-analysis` 技能的以下核心原则执行：")
    lines.append("- **事实与推断分离**：关键结论必须区分查询事实与建模推断")
    lines.append("- **列覆盖 >= 90%**：报告中覆盖字段数 / 实际总列数 >= 90%")
    lines.append("- **关联必须验证**：关联关系必须 SQL JOIN 命中验证后输出，不得保留待验证（0行表除外）")
    lines.append("- **字段类型显式判定**：关键字段必须区分 主标识 / 外部引用 / 准标识 / 数据类型")
    lines.append("- **数据来源规范**：总列数来自 SYSCAT.TABLES.COLCOUNT，记录数来自 COUNT(*)")
    lines.append("- **审计字段规范化**：CREATED/UPDATED 等字段应规范化为记录创建时间/记录修订者等")
    lines.append("")
    lines.append(f"> 生成时间: {timestamp}")
    return "\n".join(lines)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="ODS Report QC Checker")
    parser.add_argument("--report-dir", required=True, help="Directory containing markdown reports")
    parser.add_argument("--report-file", default=None, help="Specific report file to check")
    parser.add_argument("--output-dir", default=None, help="Output directory for QC reports")
    parser.add_argument("--check-type", default="all", choices=["all", "format", "content"])
    args = parser.parse_args()

    invoke_check(args.report_dir, args.report_file, args.output_dir, args.check_type)
