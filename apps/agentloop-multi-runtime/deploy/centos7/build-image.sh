#!/usr/bin/env bash
# Run on the build machine.  Produces a Linux image archive that a CentOS 7
# Docker host can load without accessing Git, npm, or an image registry.
set -euo pipefail

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
readonly APP_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
readonly REPOSITORY_ROOT="$(CDPATH= cd -- "$APP_ROOT/../.." && pwd)"
readonly IMAGE="${MULTI_RUNTIME_IMAGE:-agentloop-multi-runtime:centos7}"
readonly PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"
readonly OUTPUT="${1:-$REPOSITORY_ROOT/agentloop-multi-runtime-centos7.tar.gz}"
readonly BUNDLE_OUTPUT="${2:-${OUTPUT%.tar.gz}-deployment.tar.gz}"

command -v docker >/dev/null 2>&1 || { echo 'docker is required' >&2; exit 1; }
docker buildx version >/dev/null 2>&1 || { echo 'Docker buildx is required' >&2; exit 1; }

# --load makes the resulting single-platform image available to docker save.
docker buildx build --platform "$PLATFORM" --target local-runtime --tag "$IMAGE" --load \
  -f "$REPOSITORY_ROOT/apps/agentloop-multi-runtime/Dockerfile" "$REPOSITORY_ROOT"
docker save "$IMAGE" | gzip -1 > "$OUTPUT"

# The server receives this companion package together with the image. It has
# no source code or provider secrets, but includes the tracked Skill package
# required by the read-only Runtime Host mount.
bundle_root="$(mktemp -d)"
trap 'rm -rf "$bundle_root"' EXIT
mkdir -p "$bundle_root/agentloop-centos7-release"
cp -R "$APP_ROOT/deploy" "$bundle_root/agentloop-centos7-release/"
mkdir -p "$bundle_root/agentloop-centos7-release/config"
cp "$APP_ROOT/config/llm-providers.json" "$bundle_root/agentloop-centos7-release/config/"
cp "$APP_ROOT/custom-skills.zip" "$bundle_root/agentloop-centos7-release/"
tar -C "$bundle_root" -czf "$BUNDLE_OUTPUT" agentloop-centos7-release
printf 'created image %s and offline deployment bundle %s for %s (%s)\n' "$OUTPUT" "$BUNDLE_OUTPUT" "$IMAGE" "$PLATFORM"
