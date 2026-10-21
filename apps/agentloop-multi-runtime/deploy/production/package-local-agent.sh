#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$script_dir" rev-parse --show-toplevel)
ref=HEAD
version=
router=https://47.101.178.145:5001
web=https://47.101.178.145:3001
output=$repo/apps/agentloop-multi-runtime/release/local-agent
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref) ref=$2; shift 2 ;;
    --version) version=$2; shift 2 ;;
    --router-url) router=$2; shift 2 ;;
    --web-origin) web=$2; shift 2 ;;
    --output) output=$2; shift 2 ;;
    -h|--help) echo "Usage: bash $0 [--ref COMMIT] [--version X.Y.Z] [--router-url HTTPS_URL] [--web-origin HTTPS_URL] [--output DIR]"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo 'This script builds macOS arm64 PKG on Apple Silicon.' >&2; exit 1; }
node -e 'if(Number(process.versions.node.split(".")[0])<26) throw Error("Node 26 or newer is required")'
output=$(python3 - "$output" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).resolve())
PY
)
sha=$(git -C "$repo" rev-parse --verify "$ref^{commit}")
job=$(mktemp -d "${TMPDIR:-/tmp}/agentloop-local-package.XXXXXX")
git -C "$repo" -c tar.umask=0022 archive --format=tar.gz --output="$job/source.tar.gz" "$sha"
mkdir "$job/source"
tar -xzf "$job/source.tar.gz" -C "$job/source"
python3 - "$job/source" "$version" <<'PY'
import json,re,sys
from pathlib import Path
root=Path(sys.argv[1]); v=sys.argv[2]
if v:
    assert re.fullmatch(r'\d+\.\d+\.\d+',v), 'version must be X.Y.Z'
    p=root/'apps/agentloop-multi-runtime/package.json'
    d=json.loads(p.read_text()); d['version']=v; p.write_text(json.dumps(d,indent=2)+'\n')
    p=root/'package-lock.json'; d=json.loads(p.read_text())
    d['packages']['apps/agentloop-multi-runtime']['version']=v
    p.write_text(json.dumps(d,indent=2)+'\n')
PY
cd "$job/source"
npm ci --no-audit --no-fund
AGENTLOOP_RELEASE_ENV=production AGENTLOOP_ROUTER_URL="$router" AGENTLOOP_WEB_ORIGIN="$web" npm run package:local-agent:mac
pkg=$(find apps/agentloop-multi-runtime/release/local-agent/macos-arm64 -maxdepth 1 -name '*.pkg' -type f)
[ -n "$pkg" ] || exit 1
version=$(node -p "JSON.parse(require('node:fs').readFileSync('apps/agentloop-multi-runtime/package.json')).version")
destination=$output/$version-${sha:0:12}
mkdir -p "$destination"
cp -n "$pkg" "$destination/"
cmp "$pkg" "$destination/$(basename "$pkg")"
/usr/sbin/pkgutil --expand-full "$pkg" "$job/expanded"
/usr/bin/codesign --verify --deep --strict "$job/expanded/Payload/Applications/AgentLoop Local Runtime.app"
python3 - "$job/expanded/Payload/Applications/AgentLoop Local Runtime.app" "$router" "$web" <<'PY'
from pathlib import Path
import json,sys
r=Path(sys.argv[1])/'Contents/Resources'
m=json.loads((r/'agentloop-local-runtime.manifest.json').read_text())
assert m['routerUrl']==sys.argv[2] and m['webOrigin']==sys.argv[3], 'Wrong embedded production endpoints'
for p in r.rglob('*'):
    assert p.name not in {'.env','agentloop.db','supervisor.db','device-identity.json','config.zip','custom-skills.zip'}, 'Unexpected private state in installer'
PY
python3 - "$destination" "$sha" "$router" "$web" "$pkg" <<'PY'
import hashlib,json,sys
from pathlib import Path
dest,sha,router,web,pkg=sys.argv[1:]; p=Path(pkg)
d=dict(revision=sha,routerUrl=router,webOrigin=web,fileName=p.name,size=p.stat().st_size,sha256=hashlib.sha256(p.read_bytes()).hexdigest(),nativeInstallAndPairingVerified=False)
Path(dest,'build-manifest.json').write_text(json.dumps(d,indent=2)+'\n')
print(json.dumps(d,indent=2))
PY
echo "Installer: $destination/$(basename "$pkg")"
echo "Build workspace retained: $job (contains committed source and build-time version override only)."
echo 'This command packages only; publishing the installer catalog is a separate operation.'
