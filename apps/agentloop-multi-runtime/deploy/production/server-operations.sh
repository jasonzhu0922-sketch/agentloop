#!/usr/bin/env bash
# Internal server helper, uploaded by release-cloud.sh / update-cloud-llm.sh.
set -Eeuo pipefail
# Production CentOS 7 hosts use Python 3.6 for archive extraction. Keep
# deterministic shell behavior while enabling UTF-8 filesystem paths in Skill
# packages (the archive contract permits non-ASCII filenames).
export LC_ALL=en_US.utf8
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
# MCP configuration is deployment-owned state. New topologies bind this file
# into every Runtime; the fallback container path lets the first upgrade
# migrate an older image-owned configuration without losing its contents.
mcp_config_path=${MCP_SERVERS_CONFIG_FILE:-}
if [ -z "$mcp_config_path" ] && [ -f "$root/.env" ]; then
  mcp_config_path=$(python3 - "$root/.env" <<'PY'
from pathlib import Path
import sys
for line in Path(sys.argv[1]).read_text().splitlines():
    if line.startswith('MCP_SERVERS_CONFIG_FILE='):
        print(line.split('=', 1)[1].strip().strip('"\x27'))
        break
PY
)
fi
mcp_config_path=${mcp_config_path:-$root/config/mcp-servers.json}
mcp_container_config_path=/app/apps/agentloop-multi-runtime/config/mcp-servers.json
read_mcp_configuration() {
  if [ -f "$mcp_config_path" ]; then
    cat "$mcp_config_path"
  else
    docker exec "${runtime_names[0]}" cat "$mcp_container_config_path"
  fi
}
ensure_mcp_configuration_file() {
  if [ -f "$mcp_config_path" ]; then return; fi
  install -d -m 700 "$(dirname "$mcp_config_path")"
  local staging
  staging=$(mktemp "${mcp_config_path}.XXXXXX")
  if ! read_mcp_configuration > "$staging"; then
    rm -f "$staging"
    return 1
  fi
  chmod 600 "$staging"
  mv "$staging" "$mcp_config_path"
}
skills_path=$(docker inspect "${runtime_names[0]}" --format '{{range .Mounts}}{{if eq .Destination "/app/apps/agentloop-multi-runtime/custom-skills"}}{{.Source}}{{end}}{{end}}')
test -n "$skills_path" && test -d "$skills_path"
verify_models() {
  local name
  for name in "${runtime_names[@]}"; do
    docker exec "$name" node --input-type=module -e '
      import {LlmProviderRegistry} from "@zhujun/agentloop";
      try {
        const p=await LlmProviderRegistry.fromConfigFile(process.env.LLM_PROVIDER_CONFIG_PATH);
        for(const key of p.modelKeys()) p.create(key);
        const expected=p.modelCatalog().map(({key,displayName})=>({key,displayName})).sort((a,b)=>a.key.localeCompare(b.key));
        const r=await fetch(`http://127.0.0.1:${process.env.PORT}/v1/models`,{signal:AbortSignal.timeout(5000)});
        if(!r.ok) throw Error();
        const actual=(await r.json()).models.sort((a,b)=>a.key.localeCompare(b.key));
        if(JSON.stringify(actual)!==JSON.stringify(expected)) throw Error();
        console.log("Effective model configuration OK; live Runtime catalog matches saved configuration");
      } catch {console.error("Live Runtime model catalog does not match saved configuration");process.exit(1);}
    '
  done
  python3 - "$config_path" "$job/applied-models.json" <<'PY'
import json,sys
c=json.load(open(sys.argv[1]))
models=[dict(key=k,displayName=v.get('displayName',v['providerModel'])) for k,v in c['models'].items()]
with open(sys.argv[2],'w') as f: json.dump(sorted(models,key=lambda m:m['key']),f)
PY
}
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
  if [ "$operation" = mcp ]; then
    cp -p "$mcp_config_path" "$backup/mcp-servers.json"
  fi
  if [ "$operation" = cloud ] || [ "$operation" = skills ] || [ "$operation" = skills-remove ]; then
    cp -a "$skills_path" "$backup/custom-skills"
  fi
  {
    echo '#!/usr/bin/env bash'
    echo 'set -euo pipefail'
    printf 'exec 9>%q\nflock -n 9\n' "$root/.production-release.lock"
    if [ "$operation" = mcp ]; then
      printf 'cp -p %q %q\n' "$backup/mcp-servers.json" "$mcp_config_path"
    elif [ "$operation" != llm ]; then
      printf 'cp -p %q %q\n' "$backup/deployment.env" "$root/.env"
    else
      printf 'cp -p %q %q\n' "$backup/llm-providers.json" "$config_path"
      printf 'cp -p %q %q\n' "$backup/runtime.env" "$environment_path"
    fi
    if [ "$operation" = cloud ] || [ "$operation" = skills ] || [ "$operation" = skills-remove ]; then
      printf 'rm -rf %q\n' "$skills_path"
      printf 'cp -a %q %q\n' "$backup/custom-skills" "$skills_path"
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
allowed=['NODE_IMAGE','APT_MIRROR','PIP_INDEX_URL','PIP_FALLBACK_INDEX_URL']
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
  cloud_skill_archive=$source_dir/apps/agentloop-multi-runtime/custom-skills.zip
  test -f "$cloud_skill_archive" || { echo "Published source is missing custom-skills.zip: $cloud_skill_archive" >&2; exit 1; }
  cloud_validated_archive=$job/validated-cloud-custom-skills.zip
  # Validate with the newly built image so a code release and its Skill
  # contract are checked together. The old serving image may not contain the
  # current canonical validator.
  docker run --rm -i --entrypoint node "$image" \
    /app/apps/agentloop-multi-runtime/deploy/production/validate-skill-archive.mjs \
    < "$cloud_skill_archive" > "$cloud_validated_archive"
  cloud_skill_root=$job/cloud-skill-root
  rm -rf "$cloud_skill_root"
  python3 - "$cloud_validated_archive" "$cloud_skill_root" "$skills_path" <<'PY'
import shutil,sys,zipfile
from pathlib import Path, PurePosixPath
archive,stage,old=sys.argv[1:]
stage=Path(stage); old=Path(old); stage.mkdir(parents=True)
with zipfile.ZipFile(archive) as z:
    for raw in z.namelist():
        path=PurePosixPath(raw)
        if raw.endswith('/'): continue
        if path.is_absolute() or '..' in path.parts or '\\' in raw or not raw:
            raise SystemExit('Invalid normalized custom Skill archive: unsafe path')
        target=stage / path
        target.parent.mkdir(parents=True,exist_ok=True)
        with z.open(raw) as src, target.open('wb') as dst: shutil.copyfileobj(src,dst)
# Production Skill credentials are server-owned and are deliberately not
# committed. Preserve an existing .env only when that Skill still exists in
# the committed archive; removed Skills and their secrets are not carried
# forward.
if old.is_dir():
    for env in old.rglob('.env'):
        relative=env.relative_to(old); destination=stage/relative
        if destination.parent.is_dir() and not destination.exists(): shutil.copy2(env,destination)
PY
  template_dir=$source_dir/apps/agentloop-multi-runtime/deploy/centos7
  ensure_mcp_configuration_file
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
  rm -rf "$skills_path.previous"
  mv "$skills_path" "$skills_path.previous"
  cp -a "$cloud_skill_root" "$skills_path"
  rm -rf "$skills_path.previous"
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
  ensure_mcp_configuration_file
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
elif [ "$operation" = configuration ]; then
  cat "$config_path"
  exit 0
elif [ "$operation" = reload ]; then
  # Use Compose's effective env_file/environment and fresh bind mounts, rather
  # than validating against the old environment of a running container.
  dc config -q
  dc config --format json > "$job/effective-compose.json"
  for service in "${runtime_services[@]}"; do
    expected_image=$(python3 - "$job/effective-compose.json" "$service" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))['services'][sys.argv[2]]['image'])
PY
)
    actual_image=$(docker inspect "agentloop-$service-1" --format '{{.Config.Image}}')
    test "$expected_image" = "$actual_image" || { echo 'Runtime image selection changed; use the code release procedure instead of reload.' >&2; exit 1; }
  done
  idle
  for service in "${runtime_services[@]}"; do
    dc run --rm --no-deps -T --entrypoint node "$service" --input-type=module -e '
      import {LlmProviderRegistry} from "@zhujun/agentloop";
      try{const p=await LlmProviderRegistry.fromConfigFile(process.env.LLM_PROVIDER_CONFIG_PATH);for(const key of p.modelKeys()) p.create(key);console.log("Runtime configuration validated");}
      catch{console.error("Invalid model configuration or missing credential; no Runtime was reloaded.");process.exit(1);}
    '
  done
  idle
  # No config files are overwritten here. An operator who already replaced
  # them must retain their previous files for rollback.
  dc up -d --no-deps --no-build --force-recreate "${runtime_services[@]}"
  ready "${runtime_names[@]}"
  verify_models
  echo "Reloaded ${#runtime_services[@]} Runtime(s); readiness and effective model configuration checks passed."
  echo 'A fresh model-backed Run is a separate acceptance check.'
  exit 0
elif [ "$operation" = mcp-configuration ]; then
  read_mcp_configuration
  exit 0
elif [ "$operation" = mcp ]; then
  candidate=$job/mcp-servers.json
  test -f "$candidate"
  # Validate the neutral configuration contract in the serving image before
  # touching the persisted file. This checks schema and credential references,
  # but does not connect to an MCP server or expose its values in output.
  docker exec -i "${runtime_names[0]}" node --input-type=module -e "
    import fs from 'node:fs';
    import {parseMcpServersConfig} from '@zhujun/agentloop';
    try { parseMcpServersConfig(JSON.parse(fs.readFileSync(0, \"utf8\"))); }
    catch { console.error(\"Invalid MCP configuration; production unchanged.\"); process.exit(1); }
  " < "$candidate"
  ensure_mcp_configuration_file
  idle
  umask 077
  make_backup
  trap rollback ERR
  install -m 600 "$candidate" "$mcp_config_path"
  dc config -q
  dc up -d --no-deps --no-build --force-recreate "${runtime_services[@]}"
  ready "${runtime_names[@]}"
  python3 - "$mcp_config_path" "$job/applied-mcp.json" <<'PY'
import json,sys
config=json.load(open(sys.argv[1]))
json.dump([dict(key=s['key'],displayName=s.get('displayName',s['key'])) for s in config.get('servers',[])],open(sys.argv[2],'w'),ensure_ascii=False)
PY
  echo "Reloaded ${#runtime_services[@]} Runtime(s); MCP configuration and readiness checks passed."
  echo 'MCP server reachability and a fresh model-backed Run are separate acceptance checks.'
  exit 0
elif [ "$operation" = skills-configuration ]; then
  python3 - "$skills_path" <<'PY'
import hashlib,json,sys
from pathlib import Path
root=Path(sys.argv[1])
items=[]
for skill_dir in sorted((p for p in root.iterdir() if p.is_dir()), key=lambda p:p.name):
    entry=skill_dir/'SKILL.md'
    if not entry.is_file(): continue
    files=[p for p in skill_dir.rglob('*') if p.is_file()]
    digest=hashlib.sha256(); total=0
    for path in sorted(files):
        data=path.read_bytes(); total+=len(data); digest.update(path.relative_to(skill_dir).as_posix().encode()); digest.update(b'\0'); digest.update(data)
    description=''
    for line in entry.read_text(errors='replace').splitlines():
        if line.startswith('description:'):
            description=line.split(':',1)[1].strip(); break
    items.append(dict(name=skill_dir.name, description=description, packageHash=digest.hexdigest(), fileCount=len(files), totalBytes=total, hasEnvironment=(skill_dir/'.env').is_file()))
print(json.dumps(items,ensure_ascii=False))
PY
  exit 0
elif [ "$operation" = skills ] || [ "$operation" = skills-remove ]; then
  if [ "$operation" = skills-remove ]; then
    skill_name=$(cat "$job/skill-name")
    [[ "$skill_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]
    test -d "$skills_path/$skill_name" || { echo "Skill not found: $skill_name" >&2; exit 1; }
    idle
    umask 077
    make_backup
    trap rollback ERR
    rm -rf "$skills_path.previous"
    mv "$skills_path" "$skills_path.previous"
    cp -a "$skills_path.previous" "$skills_path"
    rm -rf "$skills_path/$skill_name"
    rm -rf "$skills_path.previous"
    dc up -d --no-deps --no-build --force-recreate "${runtime_services[@]}"
    ready "${runtime_names[@]}"
    python3 - "$skills_path" "$job/applied-skills.json" <<'PY'
import hashlib,json,sys
from pathlib import Path
root=Path(sys.argv[1]); result=[]
for d in sorted(p for p in root.iterdir() if p.is_dir()):
    if not (d/'SKILL.md').is_file(): continue
    files=[p for p in d.rglob('*') if p.is_file()]; h=hashlib.sha256(); total=0
    for p in sorted(files):
        data=p.read_bytes(); total+=len(data); h.update(p.relative_to(d).as_posix().encode()); h.update(b'\0'); h.update(data)
    result.append(dict(name=d.name,packageHash=h.hexdigest(),fileCount=len(files),totalBytes=total))
json.dump(result,open(sys.argv[2],'w'),ensure_ascii=False)
PY
    echo "Removed Skill $skill_name; reloaded ${#runtime_services[@]} Runtime(s); Skill package inventory and readiness checks passed."
    exit 0
  fi
  archive=$job/custom-skills.zip
  test -f "$archive"
  dc config -q
  dc config --format json > "$job/effective-compose.json"
  for service in "${runtime_services[@]}"; do
    expected_image=$(python3 - "$job/effective-compose.json" "$service" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))['services'][sys.argv[2]]['image'])
PY
)
    actual_image=$(docker inspect "agentloop-$service-1" --format '{{.Config.Image}}')
    test "$expected_image" = "$actual_image" || { echo 'Runtime image selection changed; use the code release procedure instead of Skill reload.' >&2; exit 1; }
  done
  validated_archive=$job/validated-custom-skills.zip
  docker exec -i "${runtime_names[0]}" env SKILL_ARCHIVE_NAME=custom-skills.zip \
    node /app/apps/agentloop-multi-runtime/deploy/production/validate-skill-archive.mjs \
    < "$archive" > "$validated_archive"
  python3 - "$validated_archive" "$job/skill-root" "$skills_path" <<'PY'
import shutil,sys,zipfile
from pathlib import Path, PurePosixPath
archive,stage,old=sys.argv[1:]
stage=Path(stage); old=Path(old); stage.mkdir(parents=True)
with zipfile.ZipFile(archive) as z:
    names=z.namelist(); files=[]
    for raw in names:
        path=PurePosixPath(raw)
        if raw.endswith('/'): continue
        if path.is_absolute() or '..' in path.parts or '\\' in raw:
            raise SystemExit('Invalid normalized custom Skill archive: unsafe path')
        files.append(raw)
    for raw in files:
        target=stage/raw; target.parent.mkdir(parents=True,exist_ok=True)
        with z.open(raw) as src, target.open('wb') as dst: shutil.copyfileobj(src,dst)
    for env in old.rglob('.env'):
        relative=env.relative_to(old); destination=stage/relative
        if destination.parent.is_dir() and not destination.exists(): shutil.copy2(env,destination)
PY
  idle
  umask 077
  make_backup
  trap rollback ERR
  rm -rf "$skills_path.previous"
  mv "$skills_path" "$skills_path.previous"
  mv "$job/skill-root" "$skills_path"
  rm -rf "$skills_path.previous"
  dc up -d --no-deps --no-build --force-recreate "${runtime_services[@]}"
  ready "${runtime_names[@]}"
  python3 - "$skills_path" "$job/applied-skills.json" <<'PY'
import hashlib,json,sys
from pathlib import Path
root=Path(sys.argv[1]); result=[]
for d in sorted(p for p in root.iterdir() if p.is_dir()):
    if not (d/'SKILL.md').is_file(): continue
    files=[p for p in d.rglob('*') if p.is_file()]; h=hashlib.sha256(); total=0
    for p in sorted(files):
        data=p.read_bytes(); total+=len(data); h.update(p.relative_to(d).as_posix().encode()); h.update(b'\0'); h.update(data)
    result.append(dict(name=d.name,packageHash=h.hexdigest(),fileCount=len(files),totalBytes=total))
json.dump(result,open(sys.argv[2],'w'),ensure_ascii=False)
PY
  echo "Reloaded ${#runtime_services[@]} Runtime(s); Skill package inventory and readiness checks passed."
  exit 0
elif [ "$operation" = llm ]; then
  if [ -f "$job/credential-updates.json" ]; then
    # Merge only explicitly entered Provider keys, under the production lock.
    # Preserve all other model, Skill and MCP variables on the server.
    umask 077
    source_env=$environment_path
    if [ -f "$job/runtime.env" ]; then source_env=$job/runtime.env; fi
    python3 - "$source_env" "$job/credential-updates.json" <<'PY' | docker exec -i "${runtime_names[0]}" node --input-type=module -e '
      import fs from "node:fs";
      import {mergeEnvLines} from "./web/pages/cloud-model-config.js";
      const input=JSON.parse(fs.readFileSync(0,"utf8"));
      process.stdout.write(mergeEnvLines(input.environment.split(/\r?\n/),Object.entries(input.updates)).join("\n")+"\n");
    ' > "$job/merged-runtime.env"
from pathlib import Path
import json,sys
print(json.dumps(dict(environment=Path(sys.argv[1]).read_text(),updates=json.loads(Path(sys.argv[2]).read_text()))))
PY
    mv "$job/merged-runtime.env" "$job/runtime.env"
  fi
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
  verify_models
  if [ -f "$job/runtime.env" ]; then rm -- "$job/runtime.env"; fi
else
  echo "Unsupported operation: $operation" >&2; exit 2
fi
trap - ERR
echo "Applied $operation. Rollback: bash $backup/rollback.sh"
echo 'Readiness/configuration checks passed. A fresh model-backed Run is a separate acceptance check.'
