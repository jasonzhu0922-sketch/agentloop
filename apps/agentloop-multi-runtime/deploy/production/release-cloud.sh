#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$script_dir" rev-parse --show-toplevel)
server=root@47.101.178.145
ref=HEAD
apply=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) server=$2; shift 2 ;;
    --ref) ref=$2; shift 2 ;;
    --apply) apply=true; shift ;;
    --dry-run) apply=false; shift ;;
    -h|--help) echo "Usage: bash $0 [--ref COMMIT] [--server USER@HOST] [--dry-run|--apply]"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ "$server" =~ ^[a-zA-Z0-9_.@-]+$ ]] || exit 2
sha=$(git -C "$repo" rev-parse --verify "$ref^{commit}")
printf 'Cloud release: %s -> %s:/opt/agentloop\n' "$sha" "$server"
echo 'Uses committed source only; preserves production config, ports and secrets, and publishes committed custom Skills.'
echo 'Builds with the previous release base-image digest and BuildKit cache; backs up PostgreSQL before switching.'
if [ "$apply" = false ]; then echo 'Preview only. Add --apply to build and deploy.'; exit 0; fi
job=$(mktemp -d "${TMPDIR:-/tmp}/agentloop-cloud-release.XXXXXX")
git -C "$repo" -c tar.umask=0022 archive --format=tar.gz --output="$job/source.tar.gz" "$sha"
digest=$(shasum -a 256 "$job/source.tar.gz" | awk '{print $1}')
remote_job=$(ssh "$server" 'umask 077; mktemp -d /tmp/agentloop-cloud-release.XXXXXX')
[[ "$remote_job" =~ ^/tmp/agentloop-cloud-release\.[a-zA-Z0-9]+$ ]] || exit 1
scp "$job/source.tar.gz" "$script_dir/server-operations.sh" "$server:$remote_job/"
ssh "$server" "bash '$remote_job/server-operations.sh' cloud '$remote_job' '$sha' '$digest'"
echo "Local source archive: $job/source.tar.gz"
