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
            self.tree = trees[0]
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

    def scoped_scans(self, table):
        for scope in self.scopes:
            sources = {alias: pair[1] for alias, pair in scope.selected_sources.items()}
            for alias, source in sources.items():
                if (isinstance(source, exp.Table) and source.name.lower() == table['name'].lower()
                        and source.db.lower() == table['schema'].lower()):
                    where = scope.expression.args.get('where')
                    yield scope.expression, alias, where.this if where else None, len(sources) == 1

    def physical_sources(self):
        for scope in self.scopes:
            for _, source in scope.selected_sources.values():
                if isinstance(source, exp.Table):
                    yield source

    @staticmethod
    def unwrap(node):
        return node.this if isinstance(node, exp.Paren) else node

    @staticmethod
    def literal_zero(node):
        return isinstance(node, exp.Literal) and not node.is_string and node.this == '0'

    def conditional_sum(self, node, alias, project_field, measure_field, single, *, allow_null_else=False):
        node = self.unwrap(node)
        if not isinstance(node, exp.Sum):
            return None
        case = self.unwrap(node.this)
        if isinstance(case, exp.Case):
            if len(case.args.get('ifs', [])) != 1:
                return None
            branch = case.args['ifs'][0]
            default = case.args.get('default')
            # A missing/NULL numerator branch yields NULL, not zero. It is
            # equivalent only for the NULLIF-protected denominator.
            if not (self.literal_zero(default) or (allow_null_else and
                    (default is None or isinstance(default, exp.Null)))):
                return None
            predicate, measure = branch.this, branch.args.get('true')
        elif isinstance(case, exp.If):
            predicate, measure = case.this, case.args.get('true')
            default = case.args.get('false')
            if not (self.literal_zero(default) or (allow_null_else and
                    (default is None or isinstance(default, exp.Null)))):
                return None
        else:
            return None
        if not self.column(measure, alias, measure_field, single):
            return None
        return self.selector(predicate, alias, project_field, single)

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

    def period_length(self, node, alias, key, single):
        """Prove a bound LENGTH(period)=n predicate on every logical branch."""
        if isinstance(node, exp.Paren):
            return self.period_length(node.this, alias, key, single)
        if isinstance(node, (exp.And, exp.Or)):
            left, right = (self.period_length(n, alias, key, single)
                           for n in (node.this, node.expression))
            if isinstance(node, exp.Or):
                return left | right if left is not None and right is not None else None
            return right if left is None else left if right is None else left & right
        if isinstance(node, exp.EQ):
            for length, value in ((node.this, node.expression), (node.expression, node.this)):
                if (isinstance(length, exp.Length) and len(length.expressions) == 0
                        and self.column(length.this, alias, key, single)):
                    bound = self.parameter(value)
                    if type(bound) is int or (type(bound) is str and bound.isascii()
                                              and bound.isdecimal() and str(int(bound)) == bound):
                        return {int(bound)}
        return None

    def period_length_predicate(self, node, alias, key, single):
        if not isinstance(node, exp.EQ):
            return False
        for length, value in ((node.this, node.expression), (node.expression, node.this)):
            if (isinstance(length, exp.Length) and len(length.expressions) == 0
                    and self.column(length.this, alias, key, single)
                    and (type(self.parameter(value)) is int or
                         (type(self.parameter(value)) is str and self.parameter(value).isascii()
                          and self.parameter(value).isdecimal()
                          and str(int(self.parameter(value))) == self.parameter(value)))):
                return True
        return False

    def time_range(self, node, alias, key, single, canonical_value, allow_date_cast=False,
                   allow_length=False):
        """Prove unions/intersections of half-open ranges, rejecting unknown shapes.

        None on a side means unbounded. SQL values must be bound parameters;
        CAST(parameter AS DATE/DATETIME) is also accepted for native dates.
        """
        if node is None:
            return [(None, None)]
        if isinstance(node, exp.Paren):
            return self.time_range(node.this, alias, key, single, canonical_value, allow_date_cast, allow_length)
        if isinstance(node, (exp.And, exp.Or)):
            a, b = (self.time_range(n, alias, key, single, canonical_value, allow_date_cast, allow_length)
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
                    require(allow_date_cast, 'time_sql_mismatch', 'Text periods use encoded parameters without DATE casts',
                            field='time_bindings.SQL', expected='typed storage parameter without DATE cast',
                            actual='DATE cast on a non-native time field')
                    target = bound.args['to'].sql(dialect='mysql').upper()
                    require(target in ('DATE', 'DATETIME'), 'time_sql_mismatch', 'Unsupported time boundary cast',
                            field='time_bindings.SQL', expected='DATE or DATETIME cast', actual='other cast')
                    bound = bound.this
                value = canonical_value(self.parameter(bound))
                lower = isinstance(node, exp.LTE) if reverse else isinstance(node, exp.GTE)
                upper = isinstance(node, exp.GT) if reverse else isinstance(node, exp.LT)
                require(lower or upper, 'time_sql_mismatch', 'Use parameterized >= start AND < end boundaries',
                        field='time_bindings.SQL', expected='parameterized >= lower and < upper',
                        actual='different comparison operator')
                return [(value, None) if lower else (None, value)]
        require(not (node and any(column(c) for c in node.find_all(exp.Column)))
                or (allow_length and self.period_length_predicate(node, alias, key, single)),
                'time_sql_mismatch', 'Use physical source time fields with parameterized >= start AND < end boundaries',
                field='time_bindings.SQL', expected='parameterized >= and < on physical time field',
                actual='unsupported time predicate')
        return [(None, None)]
