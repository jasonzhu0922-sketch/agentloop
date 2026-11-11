"""Skill-owned runtime and root-level data-source configuration."""
import json
import os
from pathlib import Path
import sys


DEPLOYMENT_FILE = Path(__file__).resolve().parent.parent / "config" / "deployment.json"
CONNECTIONS_FILE = Path(__file__).resolve().parent.parent / "connections.json"


class ConnectionConfigurationError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def deployment():
    value = json.loads(DEPLOYMENT_FILE.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or set(value) != {"python_executable"}:
        raise ValueError("Invalid Skill deployment settings")
    for path in value.values():
        if not isinstance(path, str) or not Path(path).is_absolute():
            raise ValueError("Skill deployment paths must be absolute")
    return value


def connections():
    # Runtime stores package files as immutable 0444 copies. File mode is a
    # packaging property, not evidence that the sandbox can expose credentials.
    # Read the host-authorized copy without chmod or writes to the package.
    try:
        value = json.loads(CONNECTIONS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ConnectionConfigurationError("connections_missing", "Skill root connections.json is missing") from None
    except PermissionError:
        raise ConnectionConfigurationError("connections_unreadable", "Skill root connections.json is not readable") from None
    except (ValueError, UnicodeError):
        raise ConnectionConfigurationError("connections_invalid_json", "Skill root connections.json is not valid UTF-8 JSON") from None
    if not isinstance(value, dict) or set(value) != {"catalog_database_url", "query_databases"}:
        raise ConnectionConfigurationError("connections_invalid_shape", "Invalid Skill connection settings")
    def postgres_url(url):
        return isinstance(url, str) and url.startswith(("postgresql://", "postgres://"))
    if not postgres_url(value["catalog_database_url"]) or not isinstance(value["query_databases"], dict) or not value["query_databases"]:
        raise ConnectionConfigurationError("connections_not_configured", "Skill database connections are not configured")
    for identifier, binding in value["query_databases"].items():
        if (not isinstance(identifier, str) or not identifier.strip()
                or not isinstance(binding, dict) or set(binding) != {"query_url", "allowed_relations"}
                or not postgres_url(binding["query_url"])
                or not isinstance(binding["allowed_relations"], list) or not binding["allowed_relations"]
                or any(not isinstance(v, str) for v in binding["allowed_relations"])):
            raise ConnectionConfigurationError("scenario_binding_invalid", "Invalid scenario database binding")
    return value


def use_configured_python():
    executable = Path(deployment()["python_executable"]).resolve(strict=True)
    if executable != Path(sys.executable).resolve():
        os.execv(str(executable), [str(executable), "-B", str(Path(sys.argv[0]).resolve()), *sys.argv[1:]])
