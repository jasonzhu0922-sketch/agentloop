"""Read data-platform settings only from this Skill's root .env file."""

from pathlib import Path


ENV_FILE = Path(__file__).resolve().parents[1] / ".env"
CONFIG_KEYS = ("DAM_TEST_SQL_ENDPOINT", "DAM_TEST_CLIENT_ID", "DAM_TEST_CLIENT_SECRET")


def load_config() -> dict[str, str]:
    try:
        lines = ENV_FILE.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise ValueError("data-platform-query: Skill 根目录 .env 不存在或不可读") from exc
    values: dict[str, str] = {}
    for number, raw in enumerate(lines, 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if not separator:
            raise ValueError(f"data-platform-query: .env 第 {number} 行格式无效")
        if key not in CONFIG_KEYS:
            continue
        if key in values:
            raise ValueError(f"data-platform-query: .env 重复配置 {key}")
        if value.startswith(("'", '"')):
            if len(value) < 2 or value[-1] != value[0]:
                raise ValueError(f"data-platform-query: .env 第 {number} 行引号未闭合")
            value = value[1:-1]
        else:
            value = value.split(" #", 1)[0].rstrip()
        values[key] = value
    missing = [key for key in CONFIG_KEYS if not values.get(key, "").strip()]
    if missing:
        raise ValueError("data-platform-query: .env 缺少配置 " + ", ".join(missing))
    return values
