"""TiDB connections selected exclusively by the Skill's explicit URL binding."""
from urllib.parse import unquote, urlsplit

import pymysql


def connect(url):
    parsed = urlsplit(url)
    if parsed.scheme != "tidb" or not parsed.hostname or not parsed.username or not parsed.path.strip("/"):
        raise ValueError("A configured tidb:// connection is required")
    connection = pymysql.connect(
        host=parsed.hostname, port=parsed.port or 4000,
        user=unquote(parsed.username), password=unquote(parsed.password or ""),
        database=unquote(parsed.path.lstrip("/")), charset="utf8mb4",
        autocommit=False, connect_timeout=5, read_timeout=15, write_timeout=5,
        cursorclass=pymysql.cursors.DictCursor,
    )
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT VERSION() AS version")
            if "TiDB" not in cursor.fetchone()["version"]:
                raise ValueError("The configured server is not TiDB")
        return connection
    except Exception:
        connection.close()
        raise
