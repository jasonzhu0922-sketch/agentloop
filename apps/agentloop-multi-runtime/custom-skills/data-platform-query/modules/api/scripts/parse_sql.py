#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
parse_sql.py - MyBatis 动态 SQL 解析器（启发式）

从接口的 EXECUTE_SQL (MyBatis 动态 SQL) 中提取：
    1. 入参       : #param# 、$param$ 、<isNotEmpty property="param"> 等
    2. 表引用     : FROM / JOIN 中的 schema.table [alias] 或裸 table [alias]
    3. 出参       : SELECT 列表字段（含 * 展开标记、别名、聚合/计算列判定）

仅做"够用"的启发式解析，覆盖常见写法（子查询、UNION、CASE WHEN、count/sum、
窗口函数、<![CDATA[]]>、<isNotEmpty>），不保证 100% 精确；解析不清时降级为
"原字段名 + 无法定位中文"。
"""

import re

# ---------------------------------------------------------------------------
# 1. MyBatis 标签清理
# ---------------------------------------------------------------------------

_TAG_RE = re.compile(r"</?is\w+[^>]*>", re.IGNORECASE)          # <isNotEmpty ...> </isNotEmpty>
_CDATA_OPEN_RE = re.compile(r"<!\[CDATA\[", re.IGNORECASE)       # <![CDATA[
_CDATA_CLOSE_RE = re.compile(r"\]\]>", re.IGNORECASE)            # ]]>


def strip_mybatis(sql):
    """去掉 MyBatis 动态标签，返回（纯 SQL, 用于提取 property 的源 SQL）"""
    if sql is None:
        return ""
    s = sql
    s = _CDATA_OPEN_RE.sub(" ", s)
    s = _CDATA_CLOSE_RE.sub(" ", s)
    s = _TAG_RE.sub(" ", s)
    return s


# ---------------------------------------------------------------------------
# 2. 入参提取
# ---------------------------------------------------------------------------

_PROP_RE = re.compile(r'property\s*=\s*["\']([^"\']+)["\']', re.IGNORECASE)


def extract_input_params(sql):
    """提取入参名列表（去重，保持出现顺序）。

    #xxx#  -> 预处理占位符（带类型校验/转义）
    $xxx$  -> 直接字符串替换
    property="xxx" -> isNotEmpty 等条件标签里的可选入参
    """
    params = []
    seen = set()

    def add(name):
        name = name.strip()
        if name and name not in seen:
            seen.add(name)
            params.append(name)

    for m in re.finditer(r"#([A-Za-z0-9_]+)#", sql):
        add(m.group(1))
    for m in re.finditer(r"\$([A-Za-z0-9_]+)\$", sql):
        add(m.group(1))
    for m in _PROP_RE.finditer(sql):
        add(m.group(1))
    return params


# ---------------------------------------------------------------------------
# 3. 表引用提取
# ---------------------------------------------------------------------------

_SQL_KEYWORDS = {
    "SELECT", "FROM", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "FULL", "CROSS",
    "WHERE", "ON", "GROUP", "ORDER", "BY", "HAVING", "UNION", "ALL", "DISTINCT",
    "AS", "AND", "OR", "NOT", "IN", "EXISTS", "BETWEEN", "LIKE", "CASE", "WHEN",
    "THEN", "ELSE", "END", "SET", "VALUES", "INTO", "NULL", "ASC", "DESC",
    "FETCH", "FIRST", "ROWS", "ONLY", "LIMIT", "OFFSET", "IS", "WITH",
}


def _alias_ok(alias):
    return bool(alias) and alias.upper() not in _SQL_KEYWORDS


def extract_tables(sql):
    """提取 FROM/JOIN 中引用的表，返回 [{alias, schema, table}]（去重）。

    识别两种形式：
        schema.table [alias]
        table       [alias]
    忽略子查询别名（子查询里的物理表在递归处理时会单独提取）。
    """
    cleaned = strip_mybatis(sql)
    tables = []
    seen = set()

    # 匹配 FROM|JOIN 后的 "schema.table [alias]" 或 "table [alias]"
    # 先匹配带 schema 的：FROM/JOIN 后跟 id.id [id]
    pat_schema = re.compile(
        r"\b(?:from|join)\s+([A-Za-z_][\w$#]*)\s*\.\s*([A-Za-z_][\w$#]*)\s+([A-Za-z_][\w$#]*)?",
        re.IGNORECASE,
    )
    for m in pat_schema.finditer(cleaned):
        schema = m.group(1).strip()
        table = m.group(2).strip()
        alias = (m.group(3) or "").strip()
        if alias and not _alias_ok(alias):
            alias = ""
        key = (schema.upper(), table.upper(), alias.upper())
        if key not in seen:
            seen.add(key)
            tables.append({"schema": schema, "table": table, "alias": alias})

    # 再匹配裸表名：FROM/JOIN 后跟单个 id [id]
    pat_bare = re.compile(
        r"\b(?:from|join)\s+([A-Za-z_][\w$#]*)\s+([A-Za-z_][\w$#]*)?",
        re.IGNORECASE,
    )
    for m in pat_bare.finditer(cleaned):
        name = m.group(1).strip()
        alias = (m.group(2) or "").strip()
        if name.upper() in _SQL_KEYWORDS:
            continue
        if alias and not _alias_ok(alias):
            alias = ""
        # 跳过已被 schema.table 覆盖的（同 table 名）
        key = (name.upper(), "", alias.upper())
        if key in seen:
            continue
        seen.add(key)
        tables.append({"schema": "", "table": name, "alias": alias})
    return tables


# ---------------------------------------------------------------------------
# 4. 出参提取
# ---------------------------------------------------------------------------

def _split_top_level(s, sep=","):
    """按分隔符切分，忽略括号/引号内的分隔符。"""
    parts = []
    depth = 0
    quote = None
    cur = []
    i = 0
    while i < len(s):
        ch = s[i]
        if quote:
            cur.append(ch)
            if ch == quote:
                quote = None
        elif ch in ("'", '"'):
            quote = ch
            cur.append(ch)
        elif ch == "(":
            depth += 1
            cur.append(ch)
        elif ch == ")":
            depth -= 1
            cur.append(ch)
        elif ch == sep and depth == 0:
            parts.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
        i += 1
    if cur:
        parts.append("".join(cur).strip())
    return [p for p in parts if p]


def _is_computed(expr):
    """判断表达式是否为计算列（函数/聚合/CASE WHEN/子查询等）"""
    e = expr.strip().upper()
    if re.match(r"^(COUNT|SUM|AVG|MIN|MAX|ROUND|CAST|NVL|COALESCE|ROW_NUMBER|CASE|ABS)\b", e):
        return True
    if re.search(r"\(.*\)", e):
        return True
    if " CASE " in e or e.startswith("CASE"):
        return True
    return False


def extract_output_columns(sql):
    """提取 SELECT 列表，返回字段描述列表。

    每个元素: {
        "expr": 原始表达式,
        "alias": 别名(若有),
        "column": 实际字段名(表字段名或别名),
        "qualifier": 表别名前缀(如 "a"),
        "star": 是否为 *,
        "computed": 是否为计算列,
    }
    """
    cleaned = strip_mybatis(sql)
    m = re.search(r"\bselect\b(.*?)\bfrom\b", cleaned, re.IGNORECASE | re.DOTALL)
    if not m:
        return []
    select_list = m.group(1).strip()
    if select_list.startswith("DISTINCT"):
        select_list = select_list[len("DISTINCT"):].strip()

    cols = []
    for part in _split_top_level(select_list):
        if not part:
            continue
        # 处理 "expr [AS] alias"
        alias = ""
        expr = part
        as_match = re.search(r"\s+as\s+([A-Za-z_][\w$]*)\s*$", part, re.IGNORECASE)
        if as_match:
            alias = as_match.group(1)
            expr = part[:as_match.start()].strip()
        else:
            # 无 AS 的隐式别名：最后一个裸标识符
            mm = re.search(r"\s+([A-Za-z_][\w$]*)\s*$", part)
            if mm and part != mm.group(1):
                alias = mm.group(1)
                expr = part[:mm.start()].strip()

        expr = expr.strip()
        if expr == "*":
            cols.append({"expr": expr, "alias": alias, "column": "*",
                         "qualifier": "", "star": True, "computed": False})
            continue

        # 带限定符的字段：a.col 或 "schema".col 等
        qualifier = ""
        column = expr
        mq = re.match(r'^([A-Za-z_][\w$]*)\s*\.\s*"?([A-Za-z_][\w$]*|\*)"?\s*$', expr)
        if mq:
            qualifier = mq.group(1)
            column = mq.group(2)

        # 限定星号：A.* / t.* / schema.table.*
        if column == "*":
            cols.append({"expr": expr, "alias": alias, "column": "*",
                         "qualifier": qualifier, "star": True, "computed": False})
            continue

        computed = _is_computed(expr)
        # column 保留源字段名（供汉化溯源）；计算列用别名/表达式作为显示名
        col_name = (alias or column) if computed else column
        cols.append({
            "expr": expr,
            "alias": alias,
            "column": col_name,
            "qualifier": qualifier,
            "star": False,
            "computed": computed,
        })
    return cols


def parse(sql):
    """一次调用返回全部解析结果"""
    return {
        "sql_clean": strip_mybatis(sql),
        "input_params": extract_input_params(sql),
        "tables": extract_tables(sql),
        "output_columns": extract_output_columns(sql),
    }
