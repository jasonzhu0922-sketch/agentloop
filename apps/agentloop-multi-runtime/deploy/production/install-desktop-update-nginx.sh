#!/usr/bin/env bash
set -euo pipefail
root=/opt/agentloop
conf=/etc/nginx/conf.d/agentloop-tls.conf
snippet=/etc/nginx/snippets/agentloop-desktop-updates.conf
source_snippet=${1:?usage: install-desktop-update-nginx.sh /path/to/desktop-update-nginx.conf}
expected_previous_sha256=${2:-}
test -f "$source_snippet"
test -f "$conf"
exec 9>"$root/.production-release.lock"
flock -n 9 || { echo 'Another production operation holds the lock.' >&2; exit 1; }
install -d -m 755 "$root/desktop-updates" "$root/desktop-updates/objects" "$root/desktop-updates/installers" /etc/nginx/snippets
install -d -m 700 "$root/backups"
backup=$(mktemp -d "$root/backups/desktop-update-nginx.XXXXXXXX")
cp -p "$conf" "$backup/agentloop-tls.conf"
if [ -e "$snippet" ]; then
  if ! cmp -s "$snippet" "$source_snippet"; then
    [[ "$expected_previous_sha256" =~ ^[a-f0-9]{64}$ ]] || { echo 'Updating an existing Desktop snippet requires its reviewed SHA-256.' >&2; exit 1; }
    actual_previous_sha256=$(sha256sum "$snippet" | cut -d ' ' -f 1)
    [ "$actual_previous_sha256" = "$expected_previous_sha256" ] || { echo 'Desktop snippet changed since review; refusing replacement.' >&2; exit 1; }
  fi
  cp -p "$snippet" "$backup/previous-snippet.conf"
fi
rollback() {
  cp -p "$backup/agentloop-tls.conf" "$conf"
  if [ -f "$backup/previous-snippet.conf" ]; then cp -p "$backup/previous-snippet.conf" "$snippet"; else rm -f "$snippet"; fi
  nginx -t && systemctl reload nginx || true
  echo "Desktop update Nginx change failed; restored configuration from $backup" >&2
}
trap rollback ERR
install -m 644 "$source_snippet" "$snippet"
python3 - "$conf" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); s=p.read_text(); marker='    include /etc/nginx/snippets/agentloop-desktop-updates.conf;\n'
if marker not in s:
    assert s.count('    listen 3001 ssl;') == 1 and s.count('    location / {') >= 1, 'Unexpected Nginx topology'
    at=s.index('    location / {',s.index('    listen 3001 ssl;'))
    s=s[:at]+marker+'\n'+s[at:]
    tmp=p.with_name('.agentloop-tls.desktop-update.tmp');tmp.write_text(s);tmp.chmod(0o644);tmp.replace(p)
PY
nginx -t
systemctl reload nginx
trap - ERR
echo "Desktop update hosting enabled; configuration backup: $backup"
