"""Skill-owned root-level data-source configuration."""
import json
from pathlib import Path
from urllib.parse import urlsplit


CONNECTIONS_FILE = Path(__file__).resolve().parent.parent / "connections.json"


class ConnectionConfigurationError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


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
    def tidb_url(url):
        if not isinstance(url, str):
            return False
        try:
            parsed = urlsplit(url)
            return parsed.scheme == "tidb" and bool(parsed.hostname and parsed.username and parsed.path.strip("/")) and (parsed.port is None or parsed.port > 0)
        except ValueError:
            return False
    if not tidb_url(value["catalog_database_url"]) or not isinstance(value["query_databases"], dict) or not value["query_databases"]:
        raise ConnectionConfigurationError("connections_not_configured", "Skill database connections are not configured")
    for identifier, binding in value["query_databases"].items():
        if (not isinstance(identifier, str) or not identifier.strip()
                or not isinstance(binding, dict) or set(binding) != {"query_url", "allowed_relations"}
                or not tidb_url(binding["query_url"])
                or not isinstance(binding["allowed_relations"], list) or not binding["allowed_relations"]
                or any(not isinstance(v, str) for v in binding["allowed_relations"])):
            raise ConnectionConfigurationError("scenario_binding_invalid", "Invalid scenario database binding")
    return value
