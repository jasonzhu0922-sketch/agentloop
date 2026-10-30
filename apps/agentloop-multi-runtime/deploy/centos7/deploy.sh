#!/usr/bin/env bash
# A small, host-local launcher for the single-host Compose topology.  It never
# writes secrets into the Git checkout and it deliberately has no `down -v`
# command: state is retained unless an operator explicitly manages volumes.
set -euo pipefail

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
# The source tree and the offline release bundle deliberately share this
# layout: <app-root>/deploy/centos7.  `init` therefore works without Git.
readonly APP_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
readonly REPOSITORY_ROOT="$(CDPATH= cd -- "$APP_ROOT/../.." && pwd)"
readonly DEPLOY_ROOT="${AGENTLOOP_DEPLOY_ROOT:-/opt/agentloop}"
COMPOSE_FILE=
readonly ENV_FILE="$DEPLOY_ROOT/.env"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }

require_command() { command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"; }

active_compose() {
  docker inspect agentloop-router-1 --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' 2>/dev/null
}

render_topology() {
  require_command python3
  COMPOSE_FILE=$(python3 "$SCRIPT_DIR/render-topology.py" --root "$DEPLOY_ROOT" --env-file "$ENV_FILE") || return
}

compose() {
  if [ -z "$COMPOSE_FILE" ]; then
    COMPOSE_FILE=$(active_compose) || die "no active deployment; run validate or up first"
    [ -f "$COMPOSE_FILE" ] || die "active Compose file is unavailable"
  fi
  docker compose --project-directory "$DEPLOY_ROOT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

random_token() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32; return; fi
  die "openssl is required to generate deployment tokens"
}

# Compose reads .env itself. Do not source it as shell code: a database URL or
# API credential may legally contain shell-significant characters.
dotenv_value() {
  local key="$1" file="$2"
  sed -n "s/^${key}=//p" "$file" | tail -n 1
}

release_image() {
  local manifest="$1" image revision
  [ -f "$manifest" ] || die "release manifest does not exist: $manifest"
  image="$(dotenv_value MULTI_RUNTIME_IMAGE "$manifest")"
  revision="$(dotenv_value RELEASE_REVISION "$manifest")"
  [[ "$image" =~ ^agentloop-multi-runtime:[0-9a-f]{12,64}$ ]] || die "release manifest has an invalid image tag"
  [[ "$revision" =~ ^[0-9a-f]{40,64}$ ]] || die "release manifest has an invalid revision"
  printf '%s\n' "$image"
}

select_image() {
  local image="$1" backup staging
  docker image inspect "$image" >/dev/null 2>&1 || die "release image is not loaded locally: $image"
  mkdir -p "$DEPLOY_ROOT/backups"
  backup="$DEPLOY_ROOT/backups/deployment.env.$(date +%Y%m%d%H%M%S)"
  cp "$ENV_FILE" "$backup"
  staging="$(mktemp "$DEPLOY_ROOT/.env.XXXXXX")"
  awk -v image="$image" '
    BEGIN { replaced = 0 }
    /^MULTI_RUNTIME_IMAGE=/ { print "MULTI_RUNTIME_IMAGE=" image; replaced = 1; next }
    { print }
    END { if (!replaced) print "MULTI_RUNTIME_IMAGE=" image }
  ' "$ENV_FILE" > "$staging"
  chmod 600 "$staging"
  mv "$staging" "$ENV_FILE"
  printf '%s\n' "$backup"
}

ensure_docker() {
  require_command docker
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 plugin is required (docker compose)"
  docker info >/dev/null 2>&1 || die "Docker daemon is not reachable by the current user"
}

extract_skills() {
  local replace="${1:-false}" zip staging target backup
  zip="$APP_ROOT/custom-skills.zip"
  target="$DEPLOY_ROOT/config/custom-skills"
  [ -f "$zip" ] || die "tracked Skill package is missing: $zip"
  if [ -e "$target" ] && [ "$replace" != true ]; then return; fi
  require_command unzip
  staging="$(mktemp -d "$DEPLOY_ROOT/.skills.XXXXXX")"
  trap 'rm -rf "$staging"' RETURN
  unzip -qq "$zip" -d "$staging"
  [ -d "$staging/custom-skills" ] || die "Skill package has no custom-skills directory"
  if [ -e "$target" ]; then
    backup="$DEPLOY_ROOT/backups/custom-skills.$(date +%Y%m%d%H%M%S)"
    mkdir -p "$DEPLOY_ROOT/backups"
    mv "$target" "$backup"
    note "previous custom Skills preserved at $backup"
  fi
  mv "$staging/custom-skills" "$target"
  rm -rf "$staging/__MACOSX"
  trap - RETURN
  rmdir "$staging" 2>/dev/null || true
}

init() {
  ensure_docker
  local public_host
  public_host="${AGENTLOOP_PUBLIC_HOST:-SERVER_IP}"
  umask 077
  mkdir -p "$DEPLOY_ROOT/config" "$DEPLOY_ROOT/data/workspace" "$DEPLOY_ROOT/secrets" "$DEPLOY_ROOT/backups"
  mkdir -p "$DEPLOY_ROOT/downloads/catalog" "$DEPLOY_ROOT/downloads/installers"
  if [ ! -f "$DEPLOY_ROOT/downloads/catalog/releases.json" ]; then
    cp "$APP_ROOT/config/local-agent-releases.example.json" "$DEPLOY_ROOT/downloads/catalog/releases.json"
  fi
  if [ ! -f "$DEPLOY_ROOT/config/llm-providers.json" ]; then
    cp "$APP_ROOT/config/llm-providers.example.json" "$DEPLOY_ROOT/config/llm-providers.json"
    note "created editable provider configuration: $DEPLOY_ROOT/config/llm-providers.json"
  fi
  if [ ! -f "$DEPLOY_ROOT/config/mcp-servers.json" ]; then
    cp "$APP_ROOT/config/mcp-servers.example.json" "$DEPLOY_ROOT/config/mcp-servers.json"
    chmod 600 "$DEPLOY_ROOT/config/mcp-servers.json"
    note "created editable MCP configuration: $DEPLOY_ROOT/config/mcp-servers.json"
  fi
  if [ ! -f "$DEPLOY_ROOT/secrets/runtime.env" ]; then
    cp "$SCRIPT_DIR/runtime.env.example" "$DEPLOY_ROOT/secrets/runtime.env"
    chmod 600 "$DEPLOY_ROOT/secrets/runtime.env"
    note "created Runtime secret template: $DEPLOY_ROOT/secrets/runtime.env"
  fi
  extract_skills false
  if [ ! -f "$ENV_FILE" ]; then
    {
      printf 'MULTI_RUNTIME_IMAGE=agentloop-multi-runtime:centos7\n'
      printf 'PUBLIC_WEB_ORIGIN=http://%s:3001\nPUBLIC_ROUTER_URL=http://%s:5001\n' "$public_host" "$public_host"
      printf 'WEB_BIND_ADDRESS=0.0.0.0\nWEB_PORT=3001\nROUTER_BIND_ADDRESS=0.0.0.0\nROUTER_PORT=5001\n'
      printf 'RUNTIME_DISPATCH_TOKEN=%s\n' "$(random_token)"
      printf 'RUNTIME_ATTACHMENT_TOKEN=%s\n' "$(random_token)"
      printf 'DEPLOY_ROOT=%s\n' "$DEPLOY_ROOT"
      printf 'RUNTIME_ENV_FILE=%s/secrets/runtime.env\n' "$DEPLOY_ROOT"
      printf 'LLM_PROVIDER_CONFIG_FILE=%s/config/llm-providers.json\n' "$DEPLOY_ROOT"
      printf 'MCP_SERVERS_CONFIG_FILE=%s/config/mcp-servers.json\n' "$DEPLOY_ROOT"
      printf 'CUSTOM_SKILLS_HOST_PATH=%s/config/custom-skills\n' "$DEPLOY_ROOT"
      printf 'RUNTIME_WORKSPACE_HOST_PATH=%s/data/workspace\n' "$DEPLOY_ROOT"
      printf 'AGENTLOOP_STATE_DRIVER=sqlite\nAGENTLOOP_STATE_SQLITE_PATH=./data/state/agentloop.db\n'
      printf 'RUNTIME_COUNT=2\nMAX_CONCURRENT_RUNS=20\nPLANNING_MAX_TURNS=4\nSTEP_MAX_TURNS=32\nHEARTBEAT_INTERVAL_MS=1000\nAGENTLOOP_LOG_COLOR=never\n'
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    note "created deployment configuration: $ENV_FILE"
  fi
  note "next: verify $ENV_FILE (PUBLIC_WEB_ORIGIN and PUBLIC_ROUTER_URL) and fill $DEPLOY_ROOT/secrets/runtime.env (provider keys)"
}

build() {
  ensure_docker
  [ -f "$ENV_FILE" ] || die "run: $0 init"
  local image name
  local -a build_arguments=()
  image="$(dotenv_value MULTI_RUNTIME_IMAGE "$ENV_FILE")"
  [ -n "$image" ] || die "MULTI_RUNTIME_IMAGE is missing from $ENV_FILE"
  [ -f "$REPOSITORY_ROOT/package.json" ] || die "this is an offline deployment bundle; load a prebuilt image instead of running build"
  for name in NODE_IMAGE APT_MIRROR PIP_INDEX_URL PIP_FALLBACK_INDEX_URL; do
    if [ -n "${!name:-}" ]; then
      build_arguments+=(--build-arg "$name=${!name}")
    fi
  done
  docker build "${build_arguments[@]}" --target local-runtime --tag "$image" -f "$REPOSITORY_ROOT/apps/agentloop-multi-runtime/Dockerfile" "$REPOSITORY_ROOT"
}

load_image() {
  ensure_docker
  [ "$#" -eq 1 ] || die "usage: $0 load-image /absolute/path/agentloop-image.tar[.gz]"
  [ -f "$1" ] || die "image archive does not exist: $1"
  docker load -i "$1"
}

release() {
  [ "$#" -eq 2 ] || die "usage: $0 release /absolute/path/agentloop-image.tar[.gz] /absolute/path/release-manifest.env"
  [ -f "$ENV_FILE" ] || die "run: $0 init"
  local image backup previous
  previous=$(active_compose) || previous=
  image="$(release_image "$2")"
  load_image "$1"
  backup="$(select_image "$image")"
  if ( up ); then
    note "released: $image"
    return
  fi
  note "release failed; restoring prior deployment configuration"
  cp "$backup" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  COMPOSE_FILE=$previous
  if [ -n "$previous" ]; then compose up -d --no-build --remove-orphans || true; fi
  die "release failed; previous image selection was restored from $backup"
}

validate() {
  [ -f "$ENV_FILE" ] || die "run: $0 init"
  [ -f "$DEPLOY_ROOT/secrets/runtime.env" ] || die "missing Runtime secret file"
  [ -f "$DEPLOY_ROOT/config/llm-providers.json" ] || die "missing provider configuration"
  [ -d "$DEPLOY_ROOT/config/custom-skills" ] || die "missing unpacked custom Skills"
  local image
  image="$(dotenv_value MULTI_RUNTIME_IMAGE "$ENV_FILE")"
  [ -n "$image" ] || die "MULTI_RUNTIME_IMAGE is missing from $ENV_FILE"
  docker image inspect "$image" >/dev/null 2>&1 || die "image is not loaded locally: $image"
  if [ -z "$COMPOSE_FILE" ]; then render_topology || return; fi
  compose config -q
}

up() {
  ensure_docker
  local previous driver job
  previous=$(active_compose) || previous=
  if [ -n "$previous" ]; then
    driver=$(docker exec agentloop-runtime-general-01-1 printenv AGENTLOOP_RUNTIME_STATE_DRIVER) || return
    if [ "$driver" = postgres ]; then
      job=$(mktemp -d "${TMPDIR:-/tmp}/agentloop-topology.XXXXXX")
      AGENTLOOP_DEPLOY_ROOT="$DEPLOY_ROOT" bash "$SCRIPT_DIR/../production/server-operations.sh" topology "$job" '' '' "$SCRIPT_DIR" || return
      COMPOSE_FILE=$(active_compose) || return
      health
      return
    fi
  fi
  render_topology || return
  validate || return
  if compose up -d --no-build --remove-orphans && health; then return; fi
  if [ -n "$previous" ]; then
    COMPOSE_FILE=$previous
    compose up -d --no-build --remove-orphans || return
  fi
  return 1
}

health() {
  if [ -z "$COMPOSE_FILE" ]; then COMPOSE_FILE=$(active_compose) || return; fi
  [ -f "$COMPOSE_FILE" ] || die "active Compose file is unavailable"
  validate
  # Verify the direct Agent route and the browser->Web->Router proxy route.
  local router_port web_port public_web_origin attempt service container services runtime_ready
  services=$(compose config --services) || return
  router_port="$(dotenv_value ROUTER_PORT "$ENV_FILE")"
  web_port="$(dotenv_value WEB_PORT "$ENV_FILE")"
  public_web_origin="$(dotenv_value PUBLIC_WEB_ORIGIN "$ENV_FILE")"
  router_port="${router_port:-5001}"
  web_port="${web_port:-3001}"
  require_command curl
  for attempt in $(seq 1 30); do
    if curl --fail --silent --show-error "http://127.0.0.1:${router_port}/healthz" >/dev/null \
      && curl --fail --silent --show-error "http://127.0.0.1:${web_port}/" >/dev/null \
      && curl --fail --silent --show-error "http://127.0.0.1:${web_port}/api/healthz" >/dev/null; then
      runtime_ready=true
      while IFS= read -r service; do
        if [[ "$service" =~ ^runtime-general-[0-9]{2,3}$ ]]; then
          container=$(compose ps -q "$service") || return
          if [ -z "$container" ] || ! docker exec "$container" node -e '
            fetch(`http://127.0.0.1:${process.env.PORT}/healthz`, {signal:AbortSignal.timeout(2000)})
              .then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))
          '; then runtime_ready=false; break; fi
        fi
      done <<< "$services"
      if [ "$runtime_ready" = false ]; then sleep 2; continue; fi
      compose ps
      note "healthy: ${public_web_origin}"
      return
    fi
    sleep 2
  done
  compose ps
  compose logs --tail 100
  note "services did not become healthy within 60 seconds" >&2
  return 1
}

case "${1:-}" in
  init) [ "$#" -eq 1 ] || die "usage: $0 init"; init ;;
  build) [ "$#" -eq 1 ] || die "usage: $0 build"; build ;;
  load-image) shift; load_image "$@" ;;
  release) shift; release "$@" ;;
  validate) [ "$#" -eq 1 ] || die "usage: $0 validate"; validate; note "rendered topology: $COMPOSE_FILE" ;;
  up) [ "$#" -eq 1 ] || die "usage: $0 up"; up ;;
  health) [ "$#" -eq 1 ] || die "usage: $0 health"; health ;;
  logs) shift; compose logs -f "$@" ;;
  refresh-skills) [ "$#" -eq 1 ] || die "usage: $0 refresh-skills"; extract_skills true ;;
  *)
    cat >&2 <<USAGE
usage: $0 {init|build|load-image ARCHIVE|release IMAGE_ARCHIVE RELEASE_MANIFEST|validate|up|health|logs [SERVICE...]|refresh-skills}

Set AGENTLOOP_DEPLOY_ROOT to override the default parent directory of the Git checkout.
USAGE
    exit 2
    ;;
esac
