"""Credential-free query diagnostics shared by the gateway and its adapters."""


class QueryParameterError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class QueryExecutionError(RuntimeError):
    def __init__(self, error, phase):
        super().__init__("Read-only query execution failed")
        self.diagnostic = query_diagnostic(error, phase)


def query_diagnostic(error, phase="query.execute"):
    if isinstance(error, QueryExecutionError):
        return dict(error.diagnostic)
    diagnostic = {"phase": phase, "code": "query_execution_failed",
                  "exception_type": type(error).__name__}
    if isinstance(error, QueryParameterError):
        diagnostic.update(phase="query.bind", code=error.code)
    # Driver errors may be wrapped by the connection layer. Retain only typed
    # server codes and positions; never raw messages, SQL values or credentials.
    current, seen = error, set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if type(current).__module__.split('.')[0] == 'pymysql' and current.args and type(current.args[0]) is int:
            diagnostic['vendor_code'] = current.args[0]
        state = getattr(current, "sqlstate", None)
        if isinstance(state, str) and len(state) == 5 and state.isascii() and state.isalnum():
            diagnostic["sqlstate"] = state
            position = getattr(getattr(current, "diag", None), "statement_position", None)
            if isinstance(position, (int, str)) and str(position).isascii() and str(position).isdigit():
                diagnostic["position"] = int(position)
            break
        current = current.__cause__
    return diagnostic
