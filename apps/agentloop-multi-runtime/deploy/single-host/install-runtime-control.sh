#!/usr/bin/env bash
# Install the host-only controller for the existing agentloop-mr Docker stack.
set -euo pipefail
if [ "$#" -ne 1 ] || [ "$1" != --apply ]; then
  echo 'Usage: sudo bash install-runtime-control.sh --apply'
  exit 2
fi
test "$(id -u)" = 0 || { echo 'Root is required.' >&2; exit 1; }
root=/home/baoadmin/agentloop-mr
test -d "$root/config" && test -d "$root/custom-skills"
command -v docker >/dev/null
command -v python3 >/dev/null
command -v systemctl >/dev/null
source_dir=$(cd "$(dirname "$0")" && pwd)
unit=/etc/systemd/system/agentloop-mr-runtime-control.service
if [ -e "$unit" ]; then cp -p "$unit" "$unit.pre-install"; fi
install -d -m 700 "$root/runtime-control" "$root/control"
install -d -m 750 /run/agentloop-mr-control
install -m 600 "$source_dir/../production/runtime-control.py" "$root/runtime-control/runtime-control.py"
install -m 700 "$source_dir/server-operations.sh" "$root/runtime-control/server-operations.sh"
install -m 600 "$source_dir/server-operations.py" "$root/runtime-control/server-operations.py"
token_file=$root/runtime-control/operator-token
if [ ! -f "$token_file" ]; then
  (umask 077; python3 -c 'import secrets; print(secrets.token_hex(32))' > "$token_file")
fi
chmod 600 "$token_file"
cat > "$unit" <<UNIT
[Unit]
Description=AgentLoop MR host Runtime control
After=docker.service
Requires=docker.service

[Service]
Type=simple
UMask=0077
ExecStartPre=$(command -v install) -d -m 750 /run/agentloop-mr-control
ExecStart=$(command -v python3) $root/runtime-control/runtime-control.py --root $root --socket /run/agentloop-mr-control/control.sock --helper $root/runtime-control/server-operations.sh --token-file $token_file
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable agentloop-mr-runtime-control.service
systemctl restart agentloop-mr-runtime-control.service
systemctl is-active --quiet agentloop-mr-runtime-control.service
echo 'Runtime controller installed; operator token remains in a root-only file.'
