#!/usr/bin/env bash
# Run once on the Docker host. This does not recreate any application service.
set -euo pipefail
if [ "${1:-}" = --help ]; then
  echo "Usage: bash $0 [--apply] (on the production Docker host)"
  exit 0
fi
if [ "${1:-}" != --apply ] || [ "$#" -ne 1 ]; then
  echo 'Preview only. Installs a local Unix-socket Runtime control service; add --apply on the Docker host.'
  exit 0
fi
test "$(id -u)" = 0 || { echo 'Run as root on the Docker host.' >&2; exit 1; }
command -v python3 >/dev/null
command -v systemctl >/dev/null
script_dir=$(cd "$(dirname "$0")" && pwd)
root=${AGENTLOOP_DEPLOY_ROOT:-/opt/agentloop}
# Paths are embedded in a systemd unit, not interpreted as shell expressions.
[[ "$root" =~ ^/[a-zA-Z0-9_./-]+$ ]] || exit 2
install -d -m 700 "$root/runtime-control" "$root/control"
install -d -m 750 /run/agentloop-control
install -m 600 "$script_dir/runtime-control.py" "$root/runtime-control/runtime-control.py"
install -m 600 "$script_dir/server-operations.sh" "$root/runtime-control/server-operations.sh"
token_file=$root/runtime-control/operator-token
if [ ! -f "$token_file" ]; then
  (umask 077; python3 -c 'import secrets; print(secrets.token_hex(32))' > "$token_file")
fi
chmod 600 "$token_file"
cat > /etc/systemd/system/agentloop-runtime-control.service <<UNIT
[Unit]
Description=AgentLoop host Runtime control
After=docker.service
Requires=docker.service

[Service]
Type=simple
UMask=0077
ExecStartPre=$(command -v install) -d -m 750 /run/agentloop-control
ExecStart=$(command -v python3) $root/runtime-control/runtime-control.py --root $root --helper $root/runtime-control/server-operations.sh --token-file $token_file
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable agentloop-runtime-control.service
systemctl restart agentloop-runtime-control.service
systemctl is-active --quiet agentloop-runtime-control.service
echo "Installed Runtime control. Operator credential file: $token_file (not printed)."
echo 'Mount /run/agentloop-control into Web and recreate Web once to enable the page button; see OPERATIONS.md.'
