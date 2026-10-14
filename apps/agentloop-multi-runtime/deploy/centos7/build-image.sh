#!/usr/bin/env bash
# Run on the build machine.  Produces a Linux image archive that a CentOS 7
# Docker host can load without accessing Git, npm, or an image registry.
set -euo pipefail

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
readonly APP_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
readonly REPOSITORY_ROOT="$(CDPATH= cd -- "$APP_ROOT/../.." && pwd)"
readonly RELEASE_REVISION="${RELEASE_REVISION:-$(git -C "$REPOSITORY_ROOT" rev-parse --verify main^{commit})}"
readonly RELEASE_SHORT_SHA="$(git -C "$REPOSITORY_ROOT" rev-parse --short=12 "$RELEASE_REVISION")"
readonly IMAGE="${MULTI_RUNTIME_IMAGE:-agentloop-multi-runtime:${RELEASE_SHORT_SHA}}"
readonly PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"
readonly NODE_IMAGE="${NODE_IMAGE:-node:26-bookworm}"
readonly PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST:-}"
readonly OUTPUT="${1:-$REPOSITORY_ROOT/agentloop-multi-runtime-${RELEASE_SHORT_SHA}.tar.gz}"
readonly BUNDLE_OUTPUT="${2:-${OUTPUT%.tar.gz}-deployment.tar.gz}"
readonly CACHE_DIRECTORY="${AGENTLOOP_BUILD_CACHE_DIR:-$REPOSITORY_ROOT/.docker-build-cache/multi-runtime-${PLATFORM//\//-}}"

command -v docker >/dev/null 2>&1 || { echo 'docker is required' >&2; exit 1; }
docker buildx version >/dev/null 2>&1 || { echo 'Docker buildx is required' >&2; exit 1; }
git -C "$REPOSITORY_ROOT" cat-file -e "${RELEASE_REVISION}^{commit}"

# Release from the exact main commit, never from a developer's dirty working
# tree. The persistent BuildKit cache keeps source-only releases incremental.
source_root="$(mktemp -d)"
trap 'rm -rf "$source_root"' EXIT
git -C "$REPOSITORY_ROOT" archive --format=tar "$RELEASE_REVISION" | tar -C "$source_root" -xf -
mkdir -p "$CACHE_DIRECTORY"
cache_arguments=(--cache-to "type=local,dest=${CACHE_DIRECTORY},mode=max")
if [ -f "$CACHE_DIRECTORY/index.json" ]; then
  cache_arguments+=(--cache-from "type=local,src=${CACHE_DIRECTORY}")
fi

# --load makes the resulting single-platform image available to docker save.
docker buildx build --platform "$PLATFORM" --target local-runtime --tag "$IMAGE" --load \
  --build-arg "NODE_IMAGE=$NODE_IMAGE" \
  --build-arg "PLAYWRIGHT_DOWNLOAD_HOST=$PLAYWRIGHT_DOWNLOAD_HOST" \
  "${cache_arguments[@]}" \
  -f "$source_root/apps/agentloop-multi-runtime/Dockerfile" "$source_root"
docker save "$IMAGE" | gzip -1 > "$OUTPUT"

# The server receives this companion package together with the image. It has
# no source code or provider secrets, but includes the tracked Skill package
# required by the read-only Runtime Host mount.
bundle_root="$(mktemp -d)"
trap 'rm -rf "$source_root" "$bundle_root"' EXIT
mkdir -p "$bundle_root/agentloop-centos7-release"
release_app_root="$source_root/apps/agentloop-multi-runtime"
cp -R "$release_app_root/deploy" "$bundle_root/agentloop-centos7-release/"
mkdir -p "$bundle_root/agentloop-centos7-release/config"
cp "$release_app_root/config/llm-providers.json" "$bundle_root/agentloop-centos7-release/config/"
cp "$release_app_root/custom-skills.zip" "$bundle_root/agentloop-centos7-release/"
cat > "$bundle_root/agentloop-centos7-release/release-manifest.env" <<EOF
RELEASE_REVISION=$RELEASE_REVISION
MULTI_RUNTIME_IMAGE=$IMAGE
DOCKER_PLATFORM=$PLATFORM
NODE_IMAGE=$NODE_IMAGE
PLAYWRIGHT_DOWNLOAD_HOST=$PLAYWRIGHT_DOWNLOAD_HOST
EOF
tar -C "$bundle_root" -czf "$BUNDLE_OUTPUT" agentloop-centos7-release
printf 'created release %s: image %s and deployment bundle %s for %s (%s)\n' "$RELEASE_REVISION" "$OUTPUT" "$BUNDLE_OUTPUT" "$IMAGE" "$PLATFORM"
