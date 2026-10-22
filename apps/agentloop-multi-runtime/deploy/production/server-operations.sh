#!/usr/bin/env bash
# Internal server helper, uploaded by release-cloud.sh / update-cloud-llm.sh.
set -Eeuo pipefail
export LC_ALL=C
operation=${1:?operation required}
job=${2:?job directory required}
root=${AGENTLOOP_DEPLOY_ROOT:-/opt/agentloop}
test -d "$job"
test "$(id -u)" = 0 || { echo 'Run as root on the production Docker host.' >&2; exit 1; }
exec 9>"$root/.production-release.lock"
flock -n 9 || { echo 'Another production operation holds the lock.' >&2; exit 1; }
chmod 700 "$job"
find "$job" -maxdepth 1 -type f -exec chmod 600 {} +
compose_file=$(docker inspect agentloop-router-1 --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}')
test -f "$compose_file" || { echo 'Expected exactly one current Compose file.' >&2; exit 1; }
previous_compose=$compose_file
image=$(docker inspect agentloop-router-1 --format '{{.Config.Image}}')
dc() { docker compose --project-directory "$root" --env-file "$root/.env" -f "$compose_file" "$@"; }
load_services() {
  local service services
  services=$(dc config --services)
  runtime_services=(); runtime_names=()
  while IFS= read -r service; do
    if [[ "$service" =~ ^runtime-general-[0-9]{2,3}$ ]]; then
      runtime_services+=("$service")
      runtime_names+=("agentloop-$service-1")
    fi
  done <<< "$services"
  [ "${#runtime_services[@]}" -gt 0 ] || { echo 'No Runtime services in current deployment.' >&2; return 1; }
  all_names=(agentloop-router-1 agentloop-web-1 "${runtime_names[@]}")
}
load_services
previous_services=("${runtime_services[@]}")
previous_names=("${all_names[@]}")
# Generated Compose files point back to their release templates. Legacy
# deployments keep their templates next to the active Compose file.
template_dir=$(python3 - "$previous_compose" <<'TOPOLOGY_PY'
from pathlib import Path
import json,sys
p=Path(sys.argv[1]).resolve(); m=p.parent/'topology.json'
print(json.loads(m.read_text())['templateDirectory'] if m.is_file() else p.parent)
TOPOLOGY_PY
)
render_topology() {
  python3 "$1/render-topology.py" --root "$root" --env-file "$2"
}

idle() {
  local driver count
  driver=$(docker exec "${runtime_names[0]}" printenv AGENTLOOP_RUNTIME_STATE_DRIVER)
  test "$driver" = postgres || { echo 'This production procedure requires PostgreSQL.' >&2; return 1; }
  # Current production database; the pg_dump names below use the same contract.
  count=$(sudo -u postgres psql -d agentloop_runtime -Atc "select count(*) from runs where status not in ('completed','failed','cancelled');")
  test "$count" = 0 || { echo "Active/nonterminal Runs: $count; retry after they finish." >&2; return 1; }
}
ready() {
  local name
  for name in "$@"; do
    docker exec "$name" node -e '
      const port=process.env.WEB_PORT??process.env.PORT;
      const path=process.env.WEB_PORT?"/":"/healthz";
      let ready=false;
      for(let i=0;i<60;i++){
        try {const r=await fetch(`http://127.0.0.1:${port}${path}`,{signal:AbortSignal.timeout(2000)}); if(r.ok){ready=true;break;}}catch{}
        await new Promise(r=>setTimeout(r,1000));
      }
      if(!ready) throw Error("Container readiness timed out");
    '
    echo "Ready: $name"
  done
}
config_path=$(docker inspect "${runtime_names[0]}" --format '{{range .Mounts}}{{if eq .Destination "/run/config/llm-providers.json"}}{{.Source}}{{end}}{{end}}')
test -f "$config_path"
environment_path=$(python3 - "$root/.env" <<'PY'
from pathlib import Path
import sys
values=[l.split('=',1)[1].strip().strip('"\x27') for l in Path(sys.argv[1]).read_text().splitlines() if l.startswith('RUNTIME_ENV_FILE=')]
assert len(values)==1 and values[0].startswith('/') and '$' not in values[0]
print(values[0])
PY
)
test -f "$environment_path"
backup=
make_backup() {
  backup=$root/backups/$operation-$(date +%Y%m%d%H%M%S)-$$
  install -d -m 700 "$backup"
  cp -p "$root/.env" "$backup/deployment.env"
  if [ "$operation" != llm ]; then
    # The operator may already have edited the desired count. Rollback must
    # restore the count actually running before this operation.
    python3 - "$backup/deployment.env" "${#previous_services[@]}" <<'TOPOLOGY_PY'
from pathlib import Path
import re,sys
p=Path(sys.argv[1]); lines=p.read_text().splitlines()
lines=[l for l in lines if not re.match(r'^\s*RUNTIME_COUNT\s*=',l)]
p.write_text('\n'.join(lines+['RUNTIME_COUNT='+sys.argv[2]])+'\n')
TOPOLOGY_PY
  fi
  cp -p "$config_path" "$backup/llm-providers.json"
  cp -p "$environment_path" "$backup/runtime.env"
  {
    echo '#!/usr/bin/env bash'
    echo 'set -euo pipefail'
    printf 'exec 9>%q\nflock -n 9\n' "$root/.production-release.lock"
    if [ "$operation" != llm ]; then
      printf 'cp -p %q %q\n' "$backup/deployment.env" "$root/.env"
    else
      printf 'cp -p %q %q\n' "$backup/llm-providers.json" "$config_path"
      printf 'cp -p %q %q\n' "$backup/runtime.env" "$environment_path"
    fi
    printf 'docker compose --project-directory %q --env-file %q -f %q up -d --no-build' "$root" "$root/.env" "$previous_compose"
    if [ "$operation" = llm ]; then
      printf ' --no-deps --force-recreate'
      printf ' %q' "${previous_services[@]}"
    else
      printf ' --remove-orphans'
    fi
    printf '\n'
  } > "$backup/rollback.sh"
  chmod 700 "$backup/rollback.sh"
  echo "Backup and rollback: $backup"
}
rollback() {
  local status=$?
  trap - ERR
  echo "Operation failed. Restoring backup: $backup" >&2
  # Release the lock for the explicit rollback script, which acquires it again.
  flock -u 9
  if ! bash "$backup/rollback.sh"; then
    echo 'ROLLBACK FAILED; inspect production containers before further changes.' >&2
    exit "$status"
  fi
  if ! ready "${previous_names[@]}"; then echo 'ROLLBACK READINESS FAILED' >&2; fi
  exit "$status"
}
if [ "$operation" = cloud ]; then
  sha=${3:?commit SHA required}
  digest=${4:?source digest required}
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] && [[ "$digest" =~ ^[0-9a-f]{64}$ ]]
  printf '%s  %s\n' "$digest" "$job/source.tar.gz" | sha256sum -c -
  release=$root/releases/$sha
  source_dir=$release/source
  # Reuse the serving release's immutable build inputs, not a floating tag.
  python3 - "$template_dir/compose.yaml" "$job/build-inputs.env" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]).resolve()
manifest=next((a/'release-manifest.env' for a in p.parents if (a/'release-manifest.env').is_file()),None)
assert manifest, 'Previous release manifest required'
allowed=['NODE_IMAGE','APT_MIRROR','PIP_INDEX_URL','PIP_FALLBACK_INDEX_URL','PLAYWRIGHT_DOWNLOAD_HOST']
values=dict(l.split('=',1) for l in manifest.read_text().splitlines() if '=' in l)
assert '@sha256:' in values.get('NODE_IMAGE',''), 'Previous NODE_IMAGE must be pinned to a digest'
assert all(k in values for k in allowed), 'Incomplete build inputs'
Path(sys.argv[2]).write_text('\n'.join(k+'='+values[k] for k in allowed)+'\n')
PY
  image=agentloop-multi-runtime:$sha
  if [ -e "$source_dir" ]; then
    test -f "$release/source-sha256.txt"
    test "$(awk 'NR==1 {print $1}' "$release/source-sha256.txt")" = "$digest" || { echo 'Existing release source digest differs.' >&2; exit 1; }
  else
    umask 022
    mkdir -p "$source_dir"
    tar --no-same-owner -xzf "$job/source.tar.gz" -C "$source_dir"
    chmod -R go-w "$source_dir"
    printf '%s  %s\n' "$digest" "$job/source.tar.gz" > "$release/source-sha256.txt"
  fi
  if [ ! -f "$release/BUILD_SUCCEEDED" ]; then
    args=()
    while IFS= read -r line; do args+=(--build-arg "$line"); done < "$job/build-inputs.env"
    cache=$root/.docker-build-cache/multi-runtime-linux-amd64
    test -s "$cache/index.json"
    docker buildx build --builder agentloop-release-builder --platform linux/amd64 \
      --target local-runtime --tag "$image" --load --progress=plain "${args[@]}" \
      --cache-from "type=local,src=$cache" --cache-to "type=local,dest=$cache,mode=max" \
      -f "$source_dir/apps/agentloop-multi-runtime/Dockerfile" "$source_dir" 2>&1 | tee "$release/build.log"
    { printf 'RELEASE_REVISION=%s\nMULTI_RUNTIME_IMAGE=%s\nDOCKER_PLATFORM=linux/amd64\n' "$sha" "$image"; cat "$job/build-inputs.env"; } > "$release/release-manifest.env"
    docker image inspect "$image" --format '{{.Id}}' > "$release/image-id.txt"
    touch "$release/BUILD_SUCCEEDED"
  fi
  docker image inspect "$image" >/dev/null
  template_dir=$source_dir/apps/agentloop-multi-runtime/deploy/centos7
  compose_file=$(render_topology "$template_dir" "$root/.env")
  idle
  umask 077
  make_backup
  sudo -u postgres pg_dump -Fc agentloop_router > "$backup/agentloop_router.dump"
  sudo -u postgres pg_dump -Fc agentloop_runtime > "$backup/agentloop_runtime.dump"
  sudo -u postgres pg_restore --list < "$backup/agentloop_router.dump" >/dev/null
  sudo -u postgres pg_restore --list < "$backup/agentloop_runtime.dump" >/dev/null
  trap rollback ERR
  python3 - "$root/.env" "$image" <<'PY'
from pathlib import Path
import os,sys
p=Path(sys.argv[1]); lines=p.read_text().splitlines()
assert sum(l.startswith('MULTI_RUNTIME_IMAGE=') for l in lines)==1
t=p.with_name('.env.release-'+str(os.getpid()))
t.write_text('\n'.join('MULTI_RUNTIME_IMAGE='+sys.argv[2] if l.startswith('MULTI_RUNTIME_IMAGE=') else l for l in lines)+'\n')
t.chmod(0o600); t.replace(p)
PY
  dc config -q
  dc up -d --no-build --remove-orphans
  load_services
  ready "${all_names[@]}"
  for name in "${all_names[@]}"; do test "$(docker inspect "$name" --format '{{.Config.Image}}')" = "$image"; done
  AGENTLOOP_DEPLOY_ROOT="$root" bash "$template_dir/deploy.sh" health
  printf '%s\n' "$backup" > "$release/backup-path.txt"
  touch "$release/DEPLOY_SUCCEEDED"
elif [ "$operation" = topology ]; then
  # Optional explicit values are applied to a private candidate env first.
  # Without them, deploy.sh up applies the deployment-owned .env settings.
  candidate=$job/deployment.env
  cp -p "$root/.env" "$candidate"
  python3 - "$candidate" "${3:-}" "${4:-}" <<'TOPOLOGY_PY'
from pathlib import Path
import re,sys
p=Path(sys.argv[1]); lines=p.read_text().splitlines()
for name,value,maximum in [('RUNTIME_COUNT',sys.argv[2],256),('MAX_CONCURRENT_RUNS',sys.argv[3],3600000)]:
    if not value: continue
    assert re.fullmatch('[0-9]+',value) and 1 <= int(value) <= maximum, 'Invalid '+name
    lines=[l for l in lines if not re.match(r'^\s*'+name+r'\s*=',l)]
    lines.append(name+'='+str(int(value)))
p.write_text('\n'.join(lines)+'\n')
TOPOLOGY_PY
  template_dir=${5:-$template_dir}
  compose_file=$(render_topology "$template_dir" "$candidate")
  # Validate desired config without changing the live deployment env.
  docker compose --project-directory "$root" --env-file "$candidate" -f "$compose_file" config -q
  idle
  umask 077
  make_backup
  trap rollback ERR
  install -m 600 "$candidate" "$root/.env"
  dc up -d --no-build --remove-orphans
  load_services
  ready "${all_names[@]}"
  AGENTLOOP_DEPLOY_ROOT="$root" bash "$template_dir/deploy.sh" health
  echo "Runtime count: ${#runtime_services[@]}; topology: $compose_file"
elif [ "$operation" = llm ]; then
  # Validate against the serving image with candidate env contents in stdin.
  # Secrets never appear in command arguments or output.
  python3 - "$job" "$environment_path" <<'PY' | docker exec -i "${runtime_names[0]}" node --input-type=module -e '
    import fs from "node:fs";
    import {parseEnv} from "node:util";
    import {LlmProviderRegistry} from "@zhujun/agentloop";
    try {
      const input=JSON.parse(fs.readFileSync(0,"utf8"));
      const env={...process.env};
      if(input.newEnvironment!==null){for(const key of Object.keys(parseEnv(input.oldEnvironment))) delete env[key]; Object.assign(env,parseEnv(input.newEnvironment));}
      const p=LlmProviderRegistry.fromConfigObject(input.config,env);
      for(const key of p.modelKeys()){try{p.create(key);}catch{console.error(`Model cannot be configured: ${key}; check its credential variable.`);process.exit(1);}}
      console.log(`Validated ${p.modelKeys().length} model profiles and credential presence.`);
    } catch { console.error("Invalid LLM schema or Runtime env file; production unchanged.");process.exit(1); }
  '
from pathlib import Path
import json,sys
j=Path(sys.argv[1]); n=j/'runtime.env'
print(json.dumps(dict(config=json.loads((j/'llm-providers.json').read_text()),oldEnvironment=Path(sys.argv[2]).read_text(),newEnvironment=n.read_text() if n.exists() else None)))
PY
  idle
  umask 077
  make_backup
  trap rollback ERR
  install -m 600 "$job/llm-providers.json" "$config_path"
  if [ -f "$job/runtime.env" ]; then install -m 600 "$job/runtime.env" "$environment_path"; fi
  dc config -q
  dc up -d --no-deps --no-build --force-recreate "${runtime_services[@]}"
  ready "${runtime_names[@]}"
  # Recheck the effective environment loaded by all recreated containers.
  for name in "${runtime_names[@]}"; do
    docker exec "$name" node --input-type=module -e '
      import {LlmProviderRegistry} from "@zhujun/agentloop";
      try{const p=await LlmProviderRegistry.fromConfigFile(process.env.LLM_PROVIDER_CONFIG_PATH);for(const key of p.modelKeys()) p.create(key);console.log("Effective model configuration OK");}
      catch{console.error("Effective model configuration invalid");process.exit(1);}
    '
  done
  if [ -f "$job/runtime.env" ]; then rm -- "$job/runtime.env"; fi
else
  echo "Unsupported operation: $operation" >&2; exit 2
fi
trap - ERR
echo "Applied $operation. Rollback: bash $backup/rollback.sh"
echo 'Readiness/configuration checks passed. A fresh model-backed Run is a separate acceptance check.'
