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
readonly COMPOSE_FILE="$SCRIPT_DIR/compose.yaml"
readonly ENV_FILE="$DEPLOY_ROOT/.env"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }

require_command() { command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"; }

compose() {
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
  if [ ! -f "$DEPLOY_ROOT/config/llm-providers.json" ]; then
    cp "$APP_ROOT/config/llm-providers.json" "$DEPLOY_ROOT/config/llm-providers.json"
    note "created editable provider configuration: $DEPLOY_ROOT/config/llm-providers.json"
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
      printf 'PUBLIC_WEB_ORIGIN=http://%s\nPUBLIC_ROUTER_URL=http://%s:8788\n' "$public_host" "$public_host"
      printf 'WEB_BIND_ADDRESS=0.0.0.0\nWEB_PORT=80\nROUTER_BIND_ADDRESS=127.0.0.1\nROUTER_PORT=8788\n'
      printf 'RUNTIME_DISPATCH_TOKEN=%s\n' "$(random_token)"
      printf 'RUNTIME_ATTACHMENT_TOKEN=%s\n' "$(random_token)"
      printf 'DEPLOY_ROOT=%s\n' "$DEPLOY_ROOT"
      printf 'RUNTIME_ENV_FILE=%s/secrets/runtime.env\n' "$DEPLOY_ROOT"
      printf 'LLM_PROVIDER_CONFIG_FILE=%s/config/llm-providers.json\n' "$DEPLOY_ROOT"
      printf 'CUSTOM_SKILLS_HOST_PATH=%s/config/custom-skills\n' "$DEPLOY_ROOT"
      printf 'RUNTIME_WORKSPACE_HOST_PATH=%s/data/workspace\n' "$DEPLOY_ROOT"
      printf 'AGENTLOOP_STATE_DRIVER=sqlite\nAGENTLOOP_STATE_SQLITE_PATH=./data/state/agentloop.db\n'
      printf 'MAX_CONCURRENT_RUNS=20\nPLANNING_MAX_TURNS=4\nSTEP_MAX_TURNS=32\nHEARTBEAT_INTERVAL_MS=1000\nAGENTLOOP_LOG_COLOR=never\n'
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    note "created deployment configuration: $ENV_FILE"
  fi
  note "next: verify $ENV_FILE (PUBLIC_WEB_ORIGIN and PUBLIC_ROUTER_URL) and fill $DEPLOY_ROOT/secrets/runtime.env (provider keys)"
}

build() {
  ensure_docker
  [ -f "$ENV_FILE" ] || die "run: $0 init"
  local image
  image="$(dotenv_value MULTI_RUNTIME_IMAGE "$ENV_FILE")"
  [ -n "$image" ] || die "MULTI_RUNTIME_IMAGE is missing from $ENV_FILE"
  [ -f "$REPOSITORY_ROOT/package.json" ] || die "this is an offline deployment bundle; load a prebuilt image instead of running build"
  docker build --target local-runtime --tag "$image" -f "$REPOSITORY_ROOT/apps/agentloop-multi-runtime/Dockerfile" "$REPOSITORY_ROOT"
}

load_image() {
  ensure_docker
  [ "$#" -eq 1 ] || die "usage: $0 load-image /absolute/path/agentloop-image.tar[.gz]"
  [ -f "$1" ] || die "image archive does not exist: $1"
  docker load -i "$1"
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
  compose config -q
}

up() {
  ensure_docker
  validate
  compose up -d --no-build --remove-orphans
  health
}

health() {
  validate
  # Verify the direct Agent route and the browser->Web->Router proxy route.
  local router_port web_port public_web_origin attempt
  router_port="$(dotenv_value ROUTER_PORT "$ENV_FILE")"
  web_port="$(dotenv_value WEB_PORT "$ENV_FILE")"
  public_web_origin="$(dotenv_value PUBLIC_WEB_ORIGIN "$ENV_FILE")"
  router_port="${router_port:-8788}"
  web_port="${web_port:-80}"
  require_command curl
  for attempt in $(seq 1 30); do
    if curl --fail --silent --show-error "http://127.0.0.1:${router_port}/healthz" >/dev/null \
      && curl --fail --silent --show-error "http://127.0.0.1:${web_port}/" >/dev/null \
      && curl --fail --silent --show-error "http://127.0.0.1:${web_port}/api/healthz" >/dev/null; then
      compose ps
      note "healthy: ${public_web_origin}"
      return
    fi
    sleep 2
  done
  compose ps
  compose logs --tail 100
  die "services did not become healthy within 60 seconds"
}

case "${1:-}" in
  init) [ "$#" -eq 1 ] || die "usage: $0 init"; init ;;
  build) [ "$#" -eq 1 ] || die "usage: $0 build"; build ;;
  load-image) shift; load_image "$@" ;;
  validate) [ "$#" -eq 1 ] || die "usage: $0 validate"; validate ;;
  up) [ "$#" -eq 1 ] || die "usage: $0 up"; up ;;
  health) [ "$#" -eq 1 ] || die "usage: $0 health"; health ;;
  logs) shift; compose logs -f "$@" ;;
  refresh-skills) [ "$#" -eq 1 ] || die "usage: $0 refresh-skills"; extract_skills true ;;
  *)
    cat >&2 <<USAGE
usage: $0 {init|build|load-image ARCHIVE|validate|up|health|logs [SERVICE...]|refresh-skills}

Set AGENTLOOP_DEPLOY_ROOT to override the default parent directory of the Git checkout.
USAGE
    exit 2
    ;;
esac
