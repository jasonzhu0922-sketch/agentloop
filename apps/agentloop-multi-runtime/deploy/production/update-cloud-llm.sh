#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "$0")" && pwd)
server=root@47.101.178.145
config=
environment_file=
apply=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) server=$2; shift 2 ;;
    --config) config=$2; shift 2 ;;
    --env-file) environment_file=$2; shift 2 ;;
    --apply) apply=true; shift ;;
    --dry-run) apply=false; shift ;;
    -h|--help) echo "Usage: bash $0 --config llm-providers.json [--env-file COMPLETE-runtime.env] [--server USER@HOST] [--dry-run|--apply]"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ "$server" =~ ^[a-zA-Z0-9_.@-]+$ ]] || exit 2
[ -n "$config" ] && [ -f "$config" ] || { echo '--config must name an existing JSON file' >&2; exit 2; }
python3 - "$config" <<'PY'
import json,sys
from pathlib import Path
c=json.loads(Path(sys.argv[1]).read_text())
assert isinstance(c.get('providers'),dict) and c['providers'], 'providers required'
assert isinstance(c.get('models'),dict) and c['models'], 'models required'
assert c.get('defaultModelKey') in c['models'], 'invalid defaultModelKey'
for m in c['models'].values():
    assert m.get('providerKey') in c['providers'], 'invalid model providerKey'
print('JSON references OK; production image validates full schema and credentials before applying.')
PY
if [ -n "$environment_file" ]; then
  [ -f "$environment_file" ] || exit 2
  echo 'The supplied --env-file replaces the COMPLETE Runtime env file; it is not a partial key patch.'
fi
printf 'Cloud LLM config: %s -> %s; all currently deployed Runtime containers will be recreated.\n' "$config" "$server"
if [ "$apply" = false ]; then echo 'Preview only. Add --apply to upload, validate, back up and activate.'; exit 0; fi
remote_job=$(ssh "$server" 'umask 077; mktemp -d /tmp/agentloop-llm-config.XXXXXX')
[[ "$remote_job" =~ ^/tmp/agentloop-llm-config\.[a-zA-Z0-9]+$ ]] || exit 1
scp "$config" "$server:$remote_job/llm-providers.json"
if [ -n "$environment_file" ]; then scp "$environment_file" "$server:$remote_job/runtime.env"; fi
scp "$script_dir/server-operations.sh" "$server:$remote_job/server-operations.sh"
ssh "$server" "bash '$remote_job/server-operations.sh' llm '$remote_job'"
