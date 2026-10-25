#!/usr/bin/env python3
"""
Markdown 文件完整性检查程序

以 skills/shutu-ods-analysis/references/sample-report.md 为标准模板，
对目标 Markdown 文件进行章节结构和内容完整性校验，输出详细检查报告。
"""

import argparse
import csv
import glob
import os
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple


class MarkdownHeading:
    """Markdown 标题节点"""

    def __init__(self, level: int, text: str, line_number: int):
        self.level = level
        self.text = text
        self.line_number = line_number
        self.children: List["MarkdownHeading"] = []
        self.parent: Optional["MarkdownHeading"] = None

    def __repr__(self):
        return f"Heading(L{self.level}, '{self.text}', Ln{self.line_number})"


class ContentBlock:
    """内容块（表格、代码块、引用块、列表等）"""

    def __init__(self, block_type: str, start_line: int, end_line: int):
        self.type = block_type
        self.start_line = start_line
        self.end_line = end_line
        self.table_lines: List[str] = []  # 表格的原始行内容

    def has_meaningful_table_data(self) -> bool:
        """检查表格是否有实际数据（非占位值、非纯说明表格）"""
        if self.type != "table" or not self.table_lines:
            return True
        placeholders = {
            "-", "--", "---", "—", "–",
            "待补全", "待补充", "待查询", "待数据查询", "待执行查询",
            "待确认", "缺失", "无数据", "暂无",
            "N/A", "n/a", "null", "NULL", "无", "",
        }
        note_headers = {"说明", "备注", "描述", "说明/备注", "Note", "note", "Description"}
        # 跳过分隔线行（:--- 行）
        data_lines = [l for l in self.table_lines if not re.match(r"^\|[\s\-:|]+\|$", l.strip())]
        if len(data_lines) <= 1:
            return False  # 只有表头无数据
        # 检查表头：单列"说明"类表格视为非数据表
        header_cells = [c.strip() for c in data_lines[0].split("|")[1:-1]]
        if len(header_cells) == 1 and header_cells[0] in note_headers:
            return False
        # 检查数据行
        for line in data_lines[1:]:
            cells = [c.strip() for c in line.split("|")[1:-1]]
            for cell in cells:
                if cell not in placeholders and cell not in note_headers:
                    return True
        return False


class MarkdownDocument:
    """解析后的 Markdown 文档"""

    def __init__(self, filepath: str):
        self.filepath = filepath
        self.lines: List[str] = []
        self.headings: List[MarkdownHeading] = []
        self.heading_tree: List[MarkdownHeading] = []
        self.content_blocks: List[ContentBlock] = []
        self._parse()

    def _parse(self) -> None:
        with open(self.filepath, "r", encoding="utf-8") as f:
            self.lines = f.readlines()

        self._extract_headings()
        self._build_tree()
        self._extract_content_blocks()

    def _extract_headings(self) -> None:
        for i, line in enumerate(self.lines):
            m = re.match(r"^(#{1,6})\s+(.+)$", line)
            if m:
                level = len(m.group(1))
                text = m.group(2).strip()
                self.headings.append(MarkdownHeading(level, text, i + 1))

    def _build_tree(self) -> None:
        root = MarkdownHeading(0, "ROOT", 0)
        stack: List[MarkdownHeading] = [root]

        for h in self.headings:
            while stack and stack[-1].level >= h.level:
                stack.pop()
            parent = stack[-1]
            h.parent = parent
            parent.children.append(h)
            stack.append(h)

        self.heading_tree = root.children

    def _extract_content_blocks(self) -> None:
        in_code = False
        in_table = False
        table_start = 0
        table_line_list: List[str] = []

        i = 0
        while i < len(self.lines):
            stripped = self.lines[i].strip()

            if stripped.startswith("```"):
                if not in_code:
                    in_code = True
                    code_start = i + 1
                else:
                    self.content_blocks.append(
                        ContentBlock("code_block", code_start, i + 1)
                    )
                    in_code = False
                i += 1
                continue

            if in_code:
                i += 1
                continue

            pipe_count = stripped.count("|")
            if pipe_count >= 2 and not in_table:
                if i + 1 < len(self.lines) and re.match(
                    r"^\|[\s\-:|]+\|$", self.lines[i + 1].strip()
                ):
                    in_table = True
                    table_start = i + 1
                    table_line_list = [self.lines[i], self.lines[i + 1]]
                    i += 2
                    continue

            if in_table:
                if pipe_count >= 2:
                    table_line_list.append(self.lines[i])
                if pipe_count < 2 or i == len(self.lines) - 1:
                    block = ContentBlock("table", table_start, i + 1)
                    block.table_lines = table_line_list
                    self.content_blocks.append(block)
                    in_table = False
                    table_line_list = []
                i += 1
                continue

            if re.match(r"^\s*\d+\.\s", stripped):
                list_start = i + 1
                j = i + 1
                while j < len(self.lines):
                    ls = self.lines[j].strip()
                    if re.match(r"^\s*\d+\.\s", ls):
                        j += 1
                    else:
                        break
                self.content_blocks.append(
                    ContentBlock("ordered_list", list_start, j)
                )
                i = j
                continue

            stripped_bq = stripped
            if re.match(r"^>\s*", stripped_bq):
                bq_start = i + 1
                j = i + 1
                while j < len(self.lines):
                    if re.match(r"^>\s*", self.lines[j].strip()):
                        j += 1
                    else:
                        break
                self.content_blocks.append(
                    ContentBlock("blockquote", bq_start, j)
                )
                i = j
                continue

            i += 1

    def get_block_in_range(
        self, start_ln: int, end_ln: int, block_type: Optional[str] = None
    ) -> List[ContentBlock]:
        """获取指定行范围内指定类型的内容块"""
        result = []
        for b in self.content_blocks:
            if b.start_line >= start_ln and b.end_line <= end_ln:
                if block_type is None or b.type == block_type:
                    result.append(b)
        return result

    def get_total_rows(self) -> int:
        """从一、基本信息中提取总记录数，找不到返回 -1"""
        h2s = [h for h in self.headings if h.level == 2 and "基本信息" in self._norm(h.text)]
        if not h2s:
            return -1
        start, end = (h2s[0].line_number, len(self.lines))
        # find end of this section
        idx = self.headings.index(h2s[0])
        for j in range(idx + 1, len(self.headings)):
            if self.headings[j].level <= 2:
                end = self.headings[j].line_number - 1
                break
        for i in range(start, end):
            m = re.match(r"^\|[\s\*]*总记录数[\s\*]*\|\s*([\d,]+)\s*\|", self.lines[i].strip())
            if m:
                return int(m.group(1).replace(",", ""))
        return -1

    @staticmethod
    def _norm(title: str) -> str:
        normalized = re.sub(r"（[^）]*）", "", title)
        normalized = re.sub(r"\([^)]*\)", "", normalized)
        return normalized.strip()

    def get_headings_at_level(self, level: int) -> List[MarkdownHeading]:
        return [h for h in self.headings if h.level == level]

    def _get_section_range(self, heading: MarkdownHeading) -> Tuple[int, int]:
        """获取标题所辖范围的行号 (start, end)，到下一个同级或更高级标题为止"""
        start = heading.line_number
        idx = self.headings.index(heading)
        for j in range(idx + 1, len(self.headings)):
            if self.headings[j].level <= heading.level:
                return start, self.headings[j].line_number - 1
        return start, len(self.lines)


class StructureStandard:
    """从样本报告提取的结构标准"""

    def __init__(self, sample_doc: MarkdownDocument):
        self.sample_doc = sample_doc
        self.h2_sections: Dict[str, dict] = {}
        self._extract_standard()

    def _normalize_section_title(self, title: str) -> str:
        """规范化章节标题，去除括号内可变部分"""
        # Remove parenthetical details like (4张), (前10条关键业务字段)
        normalized = re.sub(r"（[^）]*）", "", title)
        normalized = re.sub(r"\([^)]*\)", "", normalized)
        # Remove leading numbers with dots like "1. "
        normalized = re.sub(r"^\d+\.\s*", "", normalized)
        # Remove trailing whitespace
        normalized = normalized.strip()
        return normalized

    def _extract_h2_subs(self, h2: MarkdownHeading) -> dict:
        """提取 H2 章节下的子结构信息"""
        info = {
            "h3_required": [],  # 必需的 H3 标题（规范化后）
            "h3_original": {},  # 规范化标题 -> 原始标题的映射
            "h4_required": [],  # 必需的 H4 标题
            "content_types": set(),  # 该章节内期望的内容类型
        }

        start, end = self.sample_doc._get_section_range(h2)

        blocks = self.sample_doc.get_block_in_range(start, end)
        for b in blocks:
            info["content_types"].add(b.type)

        for child in h2.children:
            if child.level == 3:
                norm = self._normalize_section_title(child.text)
                info["h3_required"].append(norm)
                info["h3_original"][norm] = child.text
                for gc in child.children:
                    if gc.level == 4:
                        info["h4_required"].append(
                            self._normalize_section_title(gc.text)
                        )

        return info

    def _extract_standard(self) -> None:
        all_h2 = [h for h in self.sample_doc.headings if h.level == 2]

        for h2 in all_h2:
            key = self._normalize_section_title(h2.text)
            self.h2_sections[key] = {
                "original_title": h2.text,
                "level": h2.level,
                "line_number": h2.line_number,
                "_sample_h2": h2,
                "substructure": self._extract_h2_subs(h2),
            }

        h1s = [h for h in self.sample_doc.headings if h.level == 1]
        if h1s:
            self.h1_title = h1s[0].text
            self.h1_level = h1s[0].level

    def get_h2_keys(self) -> List[str]:
        return list(self.h2_sections.keys())


class CompletenessChecker:
    """完整性检查器"""

    SAMPLE_PATH: Optional[str] = None

    def __init__(self, target_path: str, sample_path: Optional[str] = None):
        self.target_path = target_path
        self.sample_path = sample_path or _default_sample_path()
        self.target_doc: Optional[MarkdownDocument] = None
        self.sample_doc: Optional[MarkdownDocument] = None
        self.standard: Optional[StructureStandard] = None
        self.issues: List[dict] = []

    def load(self) -> bool:
        """加载样本和目标文件"""
        try:
            if not os.path.exists(self.sample_path):
                print(f"错误: 样本文件不存在: {self.sample_path}")
                return False

            self.sample_doc = MarkdownDocument(self.sample_path)
            self.standard = StructureStandard(self.sample_doc)

            if not os.path.exists(self.target_path):
                print(f"错误: 目标文件不存在: {self.target_path}")
                return False

            self.target_doc = MarkdownDocument(self.target_path)
            return True

        except IOError as e:
            print(f"文件读取错误: {e}")
            return False
        except Exception as e:
            print(f"文件解析异常: {e}")
            return False

    H3_ALIASES = {
        # '建模建议' 与 '是否建议进入候选模型' 互为等价（样本用前者，模板用后者）
        "建模建议": "是否建议进入候选模型",
        "是否建议进入候选模型": "建模建议",
    }

    # H3 子章节名称灵活可变的 H2 章节（不要求 H3 名称完全对标样本）
    FLEXIBLE_H3_SECTIONS = {"关键字段", "关键分布"}

    def _normalize(self, title: str) -> str:
        """规范化标题，去除可变部分"""
        normalized = re.sub(r"（[^）]*）", "", title)
        normalized = re.sub(r"\([^)]*\)", "", normalized)
        normalized = normalized.strip()
        return normalized

    def _h3_aliases_match(self, a: str, b: str) -> bool:
        """检查两个 H3 名称是否等价（支持别名）"""
        if a == b:
            return True
        if self.H3_ALIASES.get(a) == b:
            return True
        # fuzzy: one contains the other
        if a in b or b in a:
            return True
        return False

    def _section_has_permission_block(self, start_ln: int, end_ln: int) -> bool:
        """检查章节范围内是否存在因权限问题无法获取/验证数据的描述"""
        text = "".join(self.target_doc.lines[start_ln - 1 : end_ln])
        patterns = [
            r"无.*权限",
            r"权限受限",
            r"无法.*执行",
            r"无法获取",
        ]
        for p in patterns:
            if re.search(p, text):
                return True
        return False

    def _section_has_inferred_data(self, start_ln: int, end_ln: int) -> bool:
        """检查章节范围内数据是否为推断/推测而非实际查询"""
        text = "".join(self.target_doc.lines[start_ln - 1 : end_ln])
        patterns = [
            r"推断.*数据",
            r"推断样例",
            r"预期分布",
            r"基于字段.*推断",
            r"基于字段语义推断",
            r"无法获取样例",
        ]
        for p in patterns:
            if re.search(p, text):
                return True
        return False

    def _fuzzy_match_h2(
        self, target_title: str, standard_keys: List[str]
    ) -> Optional[str]:
        """模糊匹配目标 H2 标题到标准 H2 标题"""
        target_norm = self._normalize(target_title)

        for key in standard_keys:
            if key == target_norm:
                return key

        # Try fuzzy: one contains the other
        for key in standard_keys:
            if key in target_norm or target_norm in key:
                return key

        # Try numeric prefix matching: 一、 二、 etc.
        target_num = re.match(r"^([一二三四五六七八九十]+)[、，]", target_norm)
        if target_num:
            prefix = target_num.group(1)
            for key in standard_keys:
                key_num = re.match(r"^([一二三四五六七八九十]+)[、，]", key)
                if key_num and key_num.group(1) == prefix:
                    return key

        return None

    def check(self) -> List[dict]:
        """执行完整性检查"""
        if not self.target_doc or not self.standard:
            return []

        self.issues = []

        self._check_heading_structure()
        self._check_section_content_completeness()

        return self.issues

    def _check_heading_structure(self) -> None:
        """检查标题层级结构"""
        standard = self.standard
        target = self.target_doc

        # Check H1 (title) exists
        h1s = target.get_headings_at_level(1)
        if not h1s:
            self.issues.append(
                {
                    "type": "missing_heading",
                    "severity": "ERROR",
                    "location": "一级标题",
                    "description": "缺少一级标题（报告标题），样本中有 '# 示例报告：...'",
                }
            )
        elif len(h1s) > 1:
            self.issues.append(
                {
                    "type": "extra_heading",
                    "severity": "WARNING",
                    "location": "一级标题",
                    "description": f"存在 {len(h1s)} 个一级标题，样本中仅 1 个",
                }
            )

        # Check H2 sections
        target_h2s = target.get_headings_at_level(2)
        target_h2_norms = {self._normalize(h.text): h for h in target_h2s}
        standard_keys = standard.get_h2_keys()

        # Find missing H2 sections
        for key in standard_keys:
            matched = self._fuzzy_match_h2(key, list(target_h2_norms.keys()))
            if matched is None:
                orig = standard.h2_sections[key]["original_title"]
                self.issues.append(
                    {
                        "type": "missing_heading",
                        "severity": "ERROR",
                        "location": f"## {orig}",
                        "description": f"缺少必要章节: ## {orig}",
                    }
                )

        # Find extra/unknown H2 sections
        # (有些可能只是用中文字序不同但含义相同，这里只报那些完全匹配不到的)
        known_matched = set()
        for key in standard_keys:
            matched = self._fuzzy_match_h2(key, list(target_h2_norms.keys()))
            if matched:
                known_matched.add(matched)

        for tnorm, th in target_h2_norms.items():
            if tnorm not in known_matched:
                # Check if this might be a variant of a known section
                maybe = self._fuzzy_match_h2(th.text, standard_keys)
                if maybe is None:
                    self.issues.append(
                        {
                            "type": "extra_heading",
                            "severity": "WARNING",
                            "location": f"## {th.text}",
                            "description": f"目标文件中有未知的二级章节: ## {th.text}",
                        }
                    )

        # Check H3 subsections under matched H2s
        for key in standard_keys:
            matched = self._fuzzy_match_h2(key, list(target_h2_norms.keys()))
            if matched is None:
                continue

            target_h2 = target_h2_norms[matched]
            std_h3s = standard.h2_sections[key]["substructure"]["h3_required"]

            target_h3_children = [
                c for c in target_h2.children if c.level == 3
            ]
            target_h3_norms = {self._normalize(c.text): c for c in target_h3_children}

            # For H2 sections with flexible H3 names, only check that H3 subsections exist
            is_flexible = any(flex in key for flex in self.FLEXIBLE_H3_SECTIONS)

            if is_flexible:
                if std_h3s and not target_h3_children:
                    orig_h2 = standard.h2_sections[key]["original_title"]
                    self.issues.append(
                        {
                            "type": "missing_heading",
                            "severity": "WARNING",
                            "location": f"## {orig_h2}",
                            "description": f"在章节 '## {orig_h2}' 下缺少三级子章节（样本中有子章节划分）",
                        }
                    )
                continue

            for h3_key in std_h3s:
                h3_matched = None
                # Exact match first
                if h3_key in target_h3_norms:
                    h3_matched = h3_key
                else:
                    # Fuzzy match using aliases
                    for tn, tc in target_h3_norms.items():
                        if self._h3_aliases_match(tn, h3_key):
                            h3_matched = tn
                            break

                if h3_matched is None:
                    orig_h2 = standard.h2_sections[key]["original_title"]
                    orig_h3 = standard.h2_sections[key]["substructure"]["h3_original"].get(h3_key, h3_key)
                    self.issues.append(
                        {
                            "type": "missing_heading",
                            "severity": "WARNING",
                            "location": f"## {orig_h2} > ### {h3_key}",
                            "description": f"在章节 '## {orig_h2}' 下缺少三级子章节 '{h3_key}'",
                        }
                    )

        # Check H4 subsections under 关键分布
        for key in standard_keys:
            matched = self._fuzzy_match_h2(key, list(target_h2_norms.keys()))
            if matched is None:
                continue
            if "样例" not in key and "分布" not in key:
                # Only check H4 under 样例与关键分布
                continue

            target_h2 = target_h2_norms[matched]
            std_h4s = standard.h2_sections[key]["substructure"]["h4_required"]

            if std_h4s:
                target_h4_norms = set()
                for h3 in target_h2.children:
                    if h3.level == 3:
                        for h4 in h3.children:
                            if h4.level == 4:
                                target_h4_norms.add(self._normalize(h4.text))

                for h4_key in std_h4s:
                    if not any(h4_key in t or t in h4_key for t in target_h4_norms):
                        self.issues.append(
                            {
                                "type": "missing_heading",
                                "severity": "INFO",
                                "location": f"分布子章节",
                                "description": f"样本在 '样例与关键分布' 下有四级分布子章节，目标文件中缺少类似结构",
                            }
                        )
                        break

    def _check_section_content_completeness(self) -> None:
        """检查章节内容完整性"""
        standard = self.standard
        target = self.target_doc

        target_h2s = target.get_headings_at_level(2)
        target_h2_norms = {self._normalize(h.text): h for h in target_h2s}

        for key in standard.get_h2_keys():
            matched_h2_norm = self._fuzzy_match_h2(key, list(target_h2_norms.keys()))
            if matched_h2_norm is None:
                continue

            target_h2 = target_h2_norms[matched_h2_norm]
            start, end = target._get_section_range(target_h2)
            std_info = standard.h2_sections[key]
            expected_types = std_info["substructure"]["content_types"]

            blocks = target.get_block_in_range(start, end)

            # Check for expected content types
            found_types = set(b.type for b in blocks)

            # 一、基本信息: must have a table
            if "基本信息" in key and "table" not in found_types:
                self.issues.append(
                    {
                        "type": "missing_content",
                        "severity": "ERROR",
                        "location": f"## {standard.h2_sections[key]['original_title']}",
                        "description": "该章节缺少表格内容，样本中该章节以一个属性表呈现",
                    }
                )
            # 一、基本信息: 总记录数不应因权限受限而为近似值
            if "基本信息" in key:
                section_text = "".join(target.lines[start - 1 : end])
                if re.search(
                    r"≈.*记录数|COUNT\(\*\).*权限|近似值.*COUNT|SYSCAT.*CARD.*近似",
                    section_text,
                ) and re.search(r"权限受限|无.*权限|无法.*执行", section_text):
                    self.issues.append(
                        {
                            "type": "permission_blocked",
                            "severity": "ERROR",
                            "location": f"## {standard.h2_sections[key]['original_title']}",
                            "description": "总记录数使用系统表近似值（SYSCAT.TABLES.CARD），因权限受限无法执行精确COUNT(*)，不符合规范要求",
                        }
                    )

            # 二、关键字段: must have tables in subsections
            if "关键字段" in key and "table" not in found_types:
                self.issues.append(
                    {
                        "type": "missing_content",
                        "severity": "WARNING",
                        "location": f"## {standard.h2_sections[key]['original_title']}",
                        "description": "该章节缺少表格内容，样本中以表格列出关键字段信息",
                    }
                )

            # 三、扩展与预留字段: must have tables
            if "扩展" in key and "table" not in found_types:
                self.issues.append(
                    {
                        "type": "missing_content",
                        "severity": "WARNING",
                        "location": f"## {standard.h2_sections[key]['original_title']}",
                        "description": "该章节缺少表格内容，样本中以表格列出扩展字段",
                    }
                )

            # 四、直接关联表: must have a table
            if "关联表" in key and "table" not in found_types:
                self.issues.append(
                    {
                        "type": "missing_content",
                        "severity": "ERROR",
                        "location": f"## {standard.h2_sections[key]['original_title']}",
                        "description": "该章节缺少表格内容，样本中以表格列出关联表信息",
                    }
                )
            # 四、直接关联表: 关联关系不应因权限问题仅基于推断
            if "关联表" in key and "table" in found_types:
                section_text = "".join(target.lines[start - 1 : end])
                if self._section_has_permission_block(start, end) and re.search(
                    r"JOIN.*无法|关联关系.*推断|验证.*无法.*执行|无法.*验证",
                    section_text,
                ):
                    self.issues.append(
                        {
                            "type": "permission_blocked",
                            "severity": "ERROR",
                            "location": f"## {standard.h2_sections[key]['original_title']}",
                            "description": "关联关系因无权限无法执行JOIN验证，关联关系基于推断而非实际数据验证，不符合规范要求",
                        }
                    )

            # 五、关系图: must have a code block
            if "关系图" in key and "code_block" not in found_types:
                self.issues.append(
                    {
                        "type": "missing_content",
                        "severity": "WARNING",
                        "location": f"## {standard.h2_sections[key]['original_title']}",
                        "description": "该章节缺少代码块（ASCII关系图），样本中包含 ``` 代码块绘制关系图",
                    }
                )

            # 六、样例与关键分布: tables with meaningful data + blockquotes
            # 总记录数为 0 时，样例数据可以为空
            if "样例" in key:
                total_rows = target.get_total_rows()
                if total_rows == 0:
                    continue
                tables = [b for b in blocks if b.type == "table"]
                if not tables:
                    self.issues.append(
                        {
                            "type": "missing_content",
                            "severity": "ERROR",
                            "location": f"## {standard.h2_sections[key]['original_title']}",
                            "description": "该章节缺少表格内容，样本中以表格展示样例数据和分布统计",
                        }
                    )
                else:
                    note_tables = [t for t in tables if not t.has_meaningful_table_data()]
                    meaningful_tables = [t for t in tables if t.has_meaningful_table_data()]
                    if not meaningful_tables:
                        if note_tables:
                            self.issues.append(
                                {
                                    "type": "empty_table",
                                    "severity": "ERROR",
                                    "location": f"## {standard.h2_sections[key]['original_title']}",
                                    "description": "该章节表格仅含'说明'类描述或占位数据（如'待补全'、'-'），缺少实际样例和分布统计数据",
                                }
                            )
                        else:
                            self.issues.append(
                                {
                                    "type": "empty_table",
                                    "severity": "ERROR",
                                    "location": f"## {standard.h2_sections[key]['original_title']}",
                                    "description": "该章节表格仅含占位数据（如'待补全'、'-'），缺少实际样例和分布统计数据",
                                }
                            )
                    elif note_tables:
                        self.issues.append(
                            {
                                "type": "empty_table",
                                "severity": "ERROR",
                                "location": f"## {standard.h2_sections[key]['original_title']}",
                                "description": "该章节存在'说明'类描述表格替代实际数据，样例数据缺失",
                            }
                        )
                # 样例数据不应为推断数据（因无权限无法获取实际数据）
                if self._section_has_inferred_data(start, end):
                    self.issues.append(
                        {
                            "type": "inferred_data",
                            "severity": "ERROR",
                            "location": f"## {standard.h2_sections[key]['original_title']}",
                            "description": "样例数据和关键分布为推断/预期数据（因无权限或未执行实际查询），缺少实际查询的样例和分布统计数据",
                        }
                    )

            # 七、建模结论: tables + ordered lists
            if "建模结论" in key or "结论" in key:
                if "table" not in found_types:
                    self.issues.append(
                        {
                            "type": "missing_content",
                            "severity": "WARNING",
                            "location": f"## {standard.h2_sections[key]['original_title']}",
                            "description": "该章节缺少表格（建模推断表），样本中以表格呈现建模推断结论",
                        }
                    )
                if "ordered_list" not in found_types:
                    self.issues.append(
                        {
                            "type": "missing_content",
                            "severity": "WARNING",
                            "location": f"## {standard.h2_sections[key]['original_title']}",
                            "description": "该章节缺少有序列表（查询事实/风险项），样本中使用编号列表",
                        }
                    )
                # 建模结论不应因权限受限导致全部结论为推断
                section_text = "".join(target.lines[start - 1 : end])
                if self._section_has_permission_block(start, end) and re.search(
                    r"报告.*结论.*推断|结论.*推断|均为推断|无法.*验证.*权限|权限.*无法.*验证",
                    section_text,
                ):
                    self.issues.append(
                        {
                            "type": "permission_blocked",
                            "severity": "ERROR",
                            "location": f"## {standard.h2_sections[key]['original_title']}",
                            "description": "建模结论因权限受限无法基于实际数据验证，报告结论基于推断而非实际数据，不符合规范要求",
                        }
                    )


def generate_report(
    target_path: str,
    sample_path: str,
    issues: List[dict],
    target_doc: Optional[MarkdownDocument],
) -> str:
    """生成检查报告 (Markdown 格式)"""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    target_name = os.path.basename(target_path)

    # Count by severity
    error_count = sum(1 for i in issues if i["severity"] == "ERROR")
    warning_count = sum(1 for i in issues if i["severity"] == "WARNING")
    info_count = sum(1 for i in issues if i["severity"] == "INFO")

    if error_count == 0 and warning_count == 0:
        grade = "合格"
    elif error_count == 0:
        grade = "基本合格（有警告）"
    else:
        grade = "不合格"

    lines = []
    lines.append(f"# {target_name} — 结构完整性校验报告")
    lines.append("")
    lines.append("## 校验概要")
    lines.append("")
    lines.append("| 项目 | 值 |")
    lines.append("|:---|:---|")
    lines.append(f"| 校验时间 | {now} |")
    lines.append(f"| 目标文件 | {target_name} |")
    lines.append(f"| 样本文件 | {os.path.basename(sample_path)} |")
    lines.append(f"| 等级 | **{grade}** |")
    lines.append(f"| 问题总数 | {len(issues)} |")
    lines.append(f"| 错误数 | {error_count} |")
    lines.append(f"| 警告数 | {warning_count} |")
    lines.append(f"| 提示数 | {info_count} |")
    lines.append("")

    # Summary of H2 sections found in target
    if target_doc:
        target_h2s = target_doc.get_headings_at_level(2)
        lines.append("### 目标文件章节结构")
        lines.append("")
        for h in target_h2s:
            indent = "  "
            lines.append(f"- **## {h.text}** (行 {h.line_number})")
            for child in h.children:
                if child.level == 3:
                    lines.append(f"  {indent}- ### {child.text} (行 {child.line_number})")
                    for gc in child.children:
                        if gc.level == 4:
                            lines.append(
                                f"    {indent}  - #### {gc.text} (行 {gc.line_number})"
                            )

    lines.append("")
    lines.append("---")
    lines.append("")

    if issues:
        lines.append("## 问题详情")
        lines.append("")

        # Group by severity
        for severity, label in [("ERROR", "错误"), ("WARNING", "警告"), ("INFO", "提示")]:
            group = [i for i in issues if i["severity"] == severity]
            if not group:
                continue

            lines.append(f"### {label}")
            lines.append("")
            lines.append("| # | 类型 | 位置 | 描述 |")
            lines.append("|:---|:---|:---|:---|")

            for idx, issue in enumerate(group, 1):
                loc = issue.get("location", "-")
                desc = issue.get("description", "-")
                itype = issue.get("type", "-")
                lines.append(f"| {idx} | {itype} | {loc} | {desc} |")

            lines.append("")
    else:
        lines.append("## 问题详情")
        lines.append("")
        lines.append("无问题发现，目标文件结构完整。")
        lines.append("")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Markdown 文件完整性检查程序 - 以 ODS 分析样本报告为标准模板",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python check_md_completeness.py target_report.md
  python check_md_completeness.py target_report.md -o report.md
  python check_md_completeness.py target_report.md -s custom_sample.md
  python check_md_completeness.py results/shutu-ods-analysis/output/ --batch --summary-md summary.md --csv failed.csv
        """,
    )
    parser.add_argument(
        "target",
        help="目标 Markdown 文件路径 (单文件模式) 或目录路径 (--batch 批量模式)",
    )
    parser.add_argument(
        "-s",
        "--sample",
        default=None,
        help="样本文件路径 (默认: 从当前目录向上查找 .opencode/skills/shutu-ods-analysis/references/sample-report.md)",
    )
    parser.add_argument(
        "-o",
        "--output",
        default=None,
        help="单文件模式: 校验报告输出路径 (默认: 打印到标准输出)",
    )
    parser.add_argument(
        "--batch",
        action="store_true",
        help="批量模式: target 为目录，批量检查目录下所有 .md 文件",
    )
    parser.add_argument(
        "--summary-md",
        default="results/shutu-ods-analysis-validate/output/batch_check_summary.md",
        help="批量模式: 汇总报告 Markdown 输出路径 (默认: results/shutu-ods-analysis-validate/output/batch_check_summary.md)",
    )
    parser.add_argument(
        "--csv",
        default="results/shutu-ods-analysis-validate/output/batch_check_failed.csv",
        help="批量模式: 不合格文件 CSV 清单输出路径 (默认: results/shutu-ods-analysis-validate/output/batch_check_failed.csv)",
    )

    args = parser.parse_args()

    target_path = os.path.abspath(args.target)
    sample_path = args.sample or _default_sample_path()

    if args.batch:
        _run_batch(target_path, sample_path, args.summary_md, args.csv)
    else:
        _run_single(target_path, sample_path, args.output)


_SAMPLE_REL = os.path.join(
    ".opencode", "skills", "shutu-ods-analysis", "references", "sample-report.md"
)


def _find_sample_path() -> str:
    """从当前工作目录向上查找样本报告文件"""
    search_dir = os.getcwd()
    for _ in range(10):
        candidate = os.path.join(search_dir, _SAMPLE_REL)
        if os.path.exists(candidate):
            return os.path.abspath(candidate)
        parent = os.path.dirname(search_dir)
        if parent == search_dir:
            break
        search_dir = parent
    return ""


def _default_sample_path() -> str:
    path = _find_sample_path()
    if path:
        return path
    raise FileNotFoundError(
        f"找不到样本报告文件，请使用 -s 参数指定路径。\n"
        f"期望的相对路径: {_SAMPLE_REL}"
    )


def _extract_table_name(filename: str) -> str:
    """从文件名中提取 T_ODS_xxx 表名"""
    basename = os.path.basename(filename)
    basename = basename.replace("_分析报告.md", "").replace("_分析报告", "")
    # 匹配 T_ODS_ 开头的部分
    m = re.search(r"(T_ODS_\S+)", basename)
    if m:
        return m.group(1)
    # fallback: 取最后一个 _ 之后的部分
    parts = basename.rsplit("_", 1)
    return parts[-1] if len(parts) > 1 else basename


def _extract_schema(filename: str) -> str:
    """从文件名中提取 schema 名（T_ODS_ 之前的部分）"""
    basename = os.path.basename(filename)
    basename = basename.replace("_分析报告.md", "").replace("_分析报告", "")
    m = re.match(r"^(\S+?)_T_ODS_", basename)
    if m:
        return m.group(1)
    return ""


def _summarize_issues(issues: List[dict]) -> str:
    """将问题列表概括为简短的逻辑分区描述"""
    if not issues:
        return "无问题"
    errors = [i for i in issues if i["severity"] == "ERROR"]
    warnings = [i for i in issues if i["severity"] == "WARNING"]
    if errors:
        descs = {e["description"] for e in errors}
        return "、".join(descs)
    if warnings:
        descs = {w["description"] for w in warnings}
        return "、".join(descs)
    return "无严重问题"


def _compute_item_results(issues: List[dict]) -> dict:
    """从问题列表计算各检查项的通过/不通过结果"""
    results = {
        "A1": "通过", "A2": "通过", "A3": "通过",
        "A4": "通过", "A5": "通过", "A6": "通过", "A7": "通过",
    }

    item_map = {
        "基本信息": "A1",
        "关键字段": "A2",
        "扩展": "A3",
        "关联表": "A4",
        "关系图": "A5",
        "样例": "A6",
        "建模结论": "A7",
        "结论": "A7",
    }

    for issue in issues:
        if issue["severity"] != "ERROR":
            continue
        location = issue.get("location", "")
        for keyword, item in item_map.items():
            if keyword in location:
                results[item] = "不通过"
                break

    return results


def _run_single(target_path: str, sample_path: str, output: Optional[str]):
    checker = CompletenessChecker(target_path, sample_path)
    if not checker.load():
        sys.exit(1)

    issues = checker.check()
    report = generate_report(target_path, sample_path, issues, checker.target_doc)

    if output:
        output_path = os.path.abspath(output)
        try:
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            with open(output_path, "w", encoding="utf-8") as f:
                f.write(report)
            print(f"检查报告已输出到: {output_path}")
        except IOError as e:
            print(f"写入报告文件失败: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        print(report)

    error_count = sum(1 for i in issues if i["severity"] == "ERROR")
    if error_count > 0:
        # 不合格时追加写入 CSV
        if output:
            csv_path = os.path.join(
                os.path.dirname(os.path.abspath(output)), "不完整报告清单.csv"
            )
            _append_single_csv(target_path, issues, csv_path)
        sys.exit(1)


def _append_single_csv(filepath: str, issues: List[dict], csv_path: str):
    """单文件校验模式下，将不合格报告追加写入 CSV"""
    os.makedirs(os.path.dirname(os.path.abspath(csv_path)) or ".", exist_ok=True)
    basename = os.path.basename(filepath)
    table_name = _extract_table_name(basename)
    schema = _extract_schema(basename)
    item_results = _compute_item_results(issues)
    failed_items = [k for k, v in item_results.items() if v == "不通过"]

    file_exists = os.path.exists(csv_path)
    with open(csv_path, "a", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        if not file_exists:
            writer.writerow([
                "文件路径", "Schema", "表名",
                "A1_基本信息", "A2_关键字段", "A3_扩展预留",
                "A4_直接关联", "A5_关系图", "A6_样例分布", "A7_建模结论",
                "等级", "缺失章节",
            ])
        writer.writerow([
            basename, schema, table_name,
            item_results["A1"], item_results["A2"], item_results["A3"],
            item_results["A4"], item_results["A5"], item_results["A6"], item_results["A7"],
            "不合格",
            ",".join(failed_items) if failed_items else "",
        ])
    print(f"不合格报告已追加到 CSV: {csv_path}")


def _run_batch(
    target_dir: str,
    sample_path: str,
    summary_md_path: str,
    csv_path: str,
):
    if not os.path.isdir(target_dir):
        print(f"错误: 批量模式下 target 必须是目录: {target_dir}", file=sys.stderr)
        sys.exit(1)

    md_files = sorted(glob.glob(os.path.join(target_dir, "*.md")))
    if not md_files:
        print(f"错误: 目录下没有 .md 文件: {target_dir}", file=sys.stderr)
        sys.exit(1)

    results = []
    for f in md_files:
        checker = CompletenessChecker(f, sample_path)
        if not checker.load():
            results.append((f, None, [], "加载失败"))
            continue
        issues = checker.check()
        result = (f, checker.target_doc, issues, _summarize_issues(issues))
        results.append(result)

    # Generate summary markdown
    _write_summary_md(results, summary_md_path, sample_path)

    # Generate CSV for failed files only
    _write_failed_csv(results, csv_path)

    error_count = sum(
        1 for _, _, issues, _ in results
        if issues and any(i["severity"] == "ERROR" for i in issues)
    )
    total = len(results)
    pass_count = total - error_count

    print(f"批量检查完成: {total} 个文件, {pass_count} 合格, {error_count} 不合格")
    print(f"汇总报告: {os.path.abspath(summary_md_path)}")
    print(f"CSV清单:  {os.path.abspath(csv_path)}")


def _write_summary_md(results, output_path, sample_path):
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    total = len(results)
    pass_count = sum(1 for _, _, issues, _ in results if not issues or all(i["severity"] != "ERROR" for i in issues))
    fail_count = total - pass_count

    lines = []
    lines.append("# 批量结构完整性校验汇总")
    lines.append("")
    lines.append(f"**校验时间**: {now}  ")
    lines.append(f"**样本文件**: {os.path.basename(sample_path)}  ")
    lines.append("")
    lines.append("| 指标 | 数值 |")
    lines.append("|:---|:---|")
    lines.append(f"| 检查文件数 | {total} |")
    lines.append(f"| 合格 | {pass_count} |")
    lines.append(f"| 不合格 | {fail_count} |")
    lines.append("")

    # Detail table for all files
    lines.append("## 逐文件检查结果")
    lines.append("")
    lines.append("| # | 文件 | 表名 | 逻辑分区 | 等级 | 错误 | 警告 | 问题摘要 |")
    lines.append("|:---|:---|:---|:---|:---|:---|:---|:---|")

    for idx, (filepath, target_doc, issues, summary) in enumerate(results, 1):
        basename = os.path.basename(filepath)
        table_name = _extract_table_name(basename)
        schema = _extract_schema(basename)
        e_count = sum(1 for i in issues if i["severity"] == "ERROR")
        w_count = sum(1 for i in issues if i["severity"] == "WARNING")
        if e_count == 0 and w_count == 0:
            grade = "合格"
        elif e_count == 0:
            grade = "基本合格"
        else:
            grade = "不合格"
        lines.append(
            f"| {idx} | {basename} | {table_name} | {schema} | **{grade}** | {e_count} | {w_count} | {summary} |"
        )

    lines.append("")

    # Failed files detail
    failed = [(f, td, iss, summ) for f, td, iss, summ in results if iss and any(i["severity"] == "ERROR" for i in iss)]
    if failed:
        lines.append("## 不合格文件详情")
        lines.append("")
        for filepath, target_doc, issues, summary in failed:
            basename = os.path.basename(filepath)
            table_name = _extract_table_name(basename)
            lines.append(f"### {table_name} ({_extract_schema(basename)})")
            lines.append("")
            lines.append(f"**文件**: {basename}")
            lines.append("")
            lines.append("| # | 类型 | 位置 | 描述 |")
            lines.append("|:---|:---|:---|:---|")
            for i, issue in enumerate(issues, 1):
                if issue["severity"] in ("ERROR", "WARNING"):
                    lines.append(
                        f"| {i} | {issue['type']} | {issue.get('location', '-')} | {issue.get('description', '-')} |"
                    )
            lines.append("")

    os.makedirs(os.path.dirname(os.path.abspath(output_path)) or ".", exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def _write_failed_csv(results, output_path):
    os.makedirs(os.path.dirname(os.path.abspath(output_path)) or ".", exist_ok=True)
    with open(output_path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "文件路径", "Schema", "表名",
            "A1_基本信息", "A2_关键字段", "A3_扩展预留",
            "A4_直接关联", "A5_关系图", "A6_样例分布", "A7_建模结论",
            "等级", "缺失章节",
        ])
        for filepath, target_doc, issues, summary in results:
            if not issues:
                continue
            if all(i["severity"] != "ERROR" for i in issues):
                continue
            basename = os.path.basename(filepath)
            table_name = _extract_table_name(basename)
            schema = _extract_schema(basename)
            item_results = _compute_item_results(issues)
            failed_items = [k for k, v in item_results.items() if v == "不通过"]
            writer.writerow([
                basename, schema, table_name,
                item_results["A1"], item_results["A2"], item_results["A3"],
                item_results["A4"], item_results["A5"], item_results["A6"], item_results["A7"],
                "不合格",
                ",".join(failed_items) if failed_items else "",
            ])


if __name__ == "__main__":
    main()
