# Keep the default official Docker Hub image, but allow deployments whose
# network cannot reach Docker Hub to select a compatible registry proxy.
ARG NODE_IMAGE=node:26-bookworm
FROM ${NODE_IMAGE}

# These are build-only proxy arguments for npm. They are intentionally not
# persisted with ENV in the final image.
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
# Alibaba Cloud's public npm mirror (npmmirror). Override only for an
# approved enterprise registry.
ARG NPM_REGISTRY=https://registry.npmmirror.com

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/agentloop-app/package.json ./apps/agentloop-app/package.json
COPY apps/agentloop-multi-runtime ./apps/agentloop-multi-runtime
RUN npm config set registry "${NPM_REGISTRY}" \
  && npm config set replace-registry-host always \
  && npm ci --registry="${NPM_REGISTRY}" --ignore-scripts --no-audit --no-fund --loglevel=info \
  && npm run build --workspace @zhujun/agentloop \
  && npm run build --workspace @zhujun/agentloop-artifact-preview \
  && npm run build --workspace @zhujun/agentloop-skills \
  && npm config delete registry \
  && npm config delete replace-registry-host

WORKDIR /app/apps/agentloop-multi-runtime
