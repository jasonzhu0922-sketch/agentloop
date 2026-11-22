"""One SQL parse for source-bound entity, project and period verification."""
import sqlglot
from sqlglot import exp
from sqlglot.optimizer.scope import traverse_scope

from entity_binding import EntityBindingError, require, scalar
from gateway.query_parameters import driver_query, tokens, placeholder_starts


def merge_ranges(ranges):
    """Normalize half-open intervals; None denotes an unbounded side."""
    result = []
    for start, end in sorted(ranges, key=lambda r: (r[0] is not None, r[0])):
        if start is not None and end is not None and start >= end:
            continue
        if result and (result[-1][1] is None or start is None or start <= result[-1][1]):
            previous = result[-1]
            upper = None if previous[1] is None or end is None else max(previous[1], end)
            result[-1] = previous[0], upper
        else:
            result.append((start, end))
    return result


class SqlEvidence:
    def __init__(self, sql, params):
        driver_query(sql, params)
        self.params = params
        parts, cursor = [], 0
        for index, start in enumerate(sorted(placeholder_starts(tokens(sql)))):
            parts.extend([sql[cursor:start], ':__bound_param_' + str(index)])
            cursor = start + 2
        parts.append(sql[cursor:])
        try:
            trees = sqlglot.parse(''.join(parts), read='mysql')
            require(len(trees) == 1 and isinstance(trees[0], (exp.Select, exp.SetOperation)),
                    'query_plan_sql_unverified', 'Cannot verify source selectors in this SQL')
            self.scopes = list(traverse_scope(trees[0]))
            # Force ambiguous-source errors before any checks or execution.
            for scope in self.scopes:
                scope.selected_sources
        except EntityBindingError:
            raise
        except Exception:
            raise EntityBindingError('query_plan_sql_unverified', 'Cannot parse SQL for source-bound verification') from None

    def scans(self, table):
        for scope in self.scopes:
            sources = {alias: pair[1] for alias, pair in scope.selected_sources.items()}
            for alias, source in sources.items():
                if (isinstance(source, exp.Table) and source.name.lower() == table['name'].lower()
                        and source.db.lower() == table['schema'].lower()):
                    where = scope.expression.args.get('where')
                    yield alias, where.this if where else None, len(sources) == 1

    def references(self, table, field):
        """Return whether a parsed query references ``table.field``.

        This is used to scope source-level semantic gaps. A gap attached to a
        period field must remain blocking when that field participates in the
        query, but must not block a query that only reads other dimensions.
        Parsing here keeps the decision independent of quoted identifiers,
        aliases, comments, and string literals.
        """
        for scope in self.scopes:
            sources = {alias: pair[1] for alias, pair in scope.selected_sources.items()}
            matching = [(alias, source) for alias, source in sources.items()
                        if (isinstance(source, exp.Table)
                            and source.name.lower() == table['name'].lower()
                            and (source.db or '').lower() == table['schema'].lower())]
            if not matching:
                continue
            aliases = {alias.lower() for alias, _ in matching}
            single = len(sources) == 1
            for column in scope.expression.find_all(exp.Column):
                if column.name.lower() != field.lower():
                    continue
                if not column.table or column.table.lower() in aliases or single:
                    return True
        return False

    def parameter(self, node):
        if isinstance(node, exp.Placeholder) and node.name.startswith('__bound_param_'):
            return self.params[int(node.name[len('__bound_param_'):])]
        return None

    @staticmethod
    def column(node, alias, key, single):
        return (isinstance(node, exp.Column) and node.name.lower() == key.lower()
                and (node.table.lower() == alias.lower() if node.table else single))

    def selector(self, node, alias, key, single):
        def value(n):
            parameter = self.parameter(n)
            return scalar(parameter) if parameter is not None else None
        column = lambda n: self.column(n, alias, key, single)
        if isinstance(node, exp.Paren):
            return self.selector(node.this, alias, key, single)
        if isinstance(node, (exp.And, exp.Or)):
            a, b = (self.selector(n, alias, key, single) for n in (node.this, node.expression))
            if isinstance(node, exp.Or):
                return a | b if a is not None and b is not None else None
            return b if a is None else a if b is None else a & b
        if isinstance(node, exp.EQ):
            for left, right in [(node.this, node.expression), (node.expression, node.this)]:
                if column(left) and value(right) is not None:
                    return {value(right)}
        if isinstance(node, exp.In) and column(node.this) and not node.args.get('query'):
            values = [value(n) for n in node.expressions]
            if values and all(v is not None for v in values):
                return set(values)
        return None

    def pattern_selector(self, node, alias, key, single):
        """Return parameterized LIKE patterns applied to one physical field."""
        def value(n):
            parameter = self.parameter(n)
            return parameter if isinstance(parameter, str) and parameter else None
        column = lambda n: self.column(n, alias, key, single)
        if isinstance(node, exp.Paren):
            return self.pattern_selector(node.this, alias, key, single)
        if isinstance(node, (exp.And, exp.Or)):
            left = self.pattern_selector(node.this, alias, key, single)
            right = self.pattern_selector(node.expression, alias, key, single)
            if isinstance(node, exp.Or):
                return left | right if left is not None and right is not None else left or right
            return right if left is None else left if right is None else left & right
        if isinstance(node, exp.Like):
            for left, right in ((node.this, node.expression), (node.expression, node.this)):
                if column(left) and value(right) is not None:
                    return {value(right)}
        return None

    def time_range(self, node, alias, key, single, canonical_value, allow_date_cast=False):
        """Prove unions/intersections of half-open ranges, rejecting unknown shapes.

        None on a side means unbounded. SQL values must be bound parameters;
        CAST(parameter AS DATE/DATETIME) is also accepted for native dates.
        """
        if node is None:
            return [(None, None)]
        if isinstance(node, exp.Paren):
            return self.time_range(node.this, alias, key, single, canonical_value, allow_date_cast)
        if isinstance(node, (exp.And, exp.Or)):
            a, b = (self.time_range(n, alias, key, single, canonical_value, allow_date_cast)
                    for n in (node.this, node.expression))
            if isinstance(node, exp.Or):
                return merge_ranges(a + b)
            intersections = []
            for left in a:
                for right in b:
                    lower = [v for v in (left[0], right[0]) if v is not None]
                    upper = [v for v in (left[1], right[1]) if v is not None]
                    intersections.append((max(lower) if lower else None, min(upper) if upper else None))
            return merge_ranges(intersections)
        column = lambda n: self.column(n, alias, key, single)
        if isinstance(node, (exp.GTE, exp.LT, exp.GT, exp.LTE)):
            left, right = node.this, node.expression
            reverse = column(right)
            if column(left) or reverse:
                bound = left if reverse else right
                if isinstance(bound, exp.Cast):
                    require(allow_date_cast, 'time_sql_mismatch', 'Text periods use encoded parameters without DATE casts')
                    target = bound.args['to'].sql(dialect='mysql').upper()
                    require(target in ('DATE', 'DATETIME'), 'time_sql_mismatch', 'Unsupported time boundary cast')
                    bound = bound.this
                value = canonical_value(self.parameter(bound))
                lower = isinstance(node, exp.LTE) if reverse else isinstance(node, exp.GTE)
                upper = isinstance(node, exp.GT) if reverse else isinstance(node, exp.LT)
                require(lower or upper, 'time_sql_mismatch', 'Use parameterized >= start AND < end boundaries')
                return [(value, None) if lower else (None, value)]
        require(not (node and any(column(c) for c in node.find_all(exp.Column))),
                'time_sql_mismatch', 'Use physical source time fields with parameterized >= start AND < end boundaries')
        return [(None, None)]
