"""Keep MySQL parser placeholders separate from PyMySQL's positional format."""
import sqlglot
from sqlglot.tokens import TokenType
from query_errors import QueryParameterError


def tokens(sql):
    return sqlglot.Dialect.get_or_raise("mysql").tokenize(sql)


def placeholder_starts(items):
    return {token.start for token, following in zip(items, items[1:])
            if token.token_type == TokenType.MOD and following.token_type == TokenType.VAR
            and following.text == "s" and following.start == token.end + 1}


def parser_sql(sql):
    starts = placeholder_starts(tokens(sql))
    return "".join("?" if index in starts else character
                   for index, character in enumerate(sql) if index - 1 not in starts)


def driver_query(sql, params):
    items = tokens(sql)
    if any(token.token_type == TokenType.VAR and token.text.startswith("$")
           and token.text[1:].isdigit() for token in items):
        raise QueryParameterError("unsupported_parameter_style",
                                  "Use positional %s placeholders with a separate params array; $n placeholders are not supported")
    starts = placeholder_starts(items)
    if len(starts) != len(params):
        raise QueryParameterError("parameter_count_mismatch",
                                  f"SQL has {len(starts)} positional %s placeholders but params has {len(params)} values")
    if not params:
        return sql, None
    return "".join("%%" if character == "%" and index not in starts else character
                   for index, character in enumerate(sql)), params
