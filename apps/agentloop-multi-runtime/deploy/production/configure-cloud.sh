#!/usr/bin/env bash
# Resize an existing production deployment without rebuilding its image.
set -euo pipefail
script_dir=$(cd "$(dirname "$0")" && pwd)
server=root@47.101.178.145
count=
capacity=
apply=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) server=$2; shift 2 ;;
    --runtime-count) count=$2; shift 2 ;;
    --max-concurrent-runs) capacity=$2; shift 2 ;;
    --apply) apply=true; shift ;;
    --dry-run) apply=false; shift ;;
    -h|--help) echo "Usage: bash $0 [--runtime-count N] [--max-concurrent-runs N] [--server USER@HOST] [--dry-run|--apply]"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ "$server" =~ ^[a-zA-Z0-9_.@-]+$ ]] || exit 2
[ -n "$count$capacity" ] || { echo 'Specify --runtime-count or --max-concurrent-runs.' >&2; exit 2; }
python3 - "$count" "$capacity" <<'PY'
import re,sys
for name,value,limit in [('runtime-count',sys.argv[1],256),('max-concurrent-runs',sys.argv[2],3600000)]:
    if value and (not re.fullmatch('[0-9]+',value) or not 1 <= int(value) <= limit):
        sys.exit('Invalid --'+name+' (1..'+str(limit)+')')
PY
printf 'Cloud topology -> %s; RUNTIME_COUNT=%s; MAX_CONCURRENT_RUNS=%s\n' "$server" "${count:-unchanged}" "${capacity:-unchanged}"
echo 'Uses templates and image from the serving release. Run a code release first to install topology support.'
echo 'Backs up deployment settings, waits for idle, recreates services and retains removed Runtime volumes.'
if [ "$apply" = false ]; then echo 'Preview only. Add --apply to activate.'; exit 0; fi
remote_job=$(ssh "$server" 'umask 077; mktemp -d /tmp/agentloop-topology.XXXXXX')
[[ "$remote_job" =~ ^/tmp/agentloop-topology\.[a-zA-Z0-9]+$ ]] || exit 1
scp "$script_dir/server-operations.sh" "$server:$remote_job/server-operations.sh"
ssh "$server" "bash '$remote_job/server-operations.sh' topology '$remote_job' '$count' '$capacity'"
