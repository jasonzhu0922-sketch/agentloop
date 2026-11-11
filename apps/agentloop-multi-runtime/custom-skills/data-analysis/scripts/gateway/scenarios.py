"""Call-local scenario binding, independent of any external application."""
from contextlib import contextmanager
from contextvars import ContextVar
_current = ContextVar('data_analysis_scenario', default=None)

def current_scenario():
    return _current.get()

def scenario_id():
    value = current_scenario()
    if not value:
        raise ValueError('An explicit scenario is required')
    return value['id']

@contextmanager
def scenario_scope(scenario):
    token = _current.set(scenario)
    try:
        yield
    finally:
        _current.reset(token)
