# Keep the default official Docker Hub image, but allow deployments whose
# network cannot reach Docker Hub to select a compatible registry proxy.
ARG NODE_IMAGE=node:26-bookworm
FROM ${NODE_IMAGE} AS application

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

# Each target is a separately publishable deployment role. They share only the
# immutable application build layers; Router, Web, and Runtime Host have no
# shared process or local state contract.
FROM application AS router
CMD ["npm", "run", "start:router"]

# Runtime execution dependencies belong only to the Host image. They are
# installed while the image is built, never after a Host has accepted work.
# Keep the package version explicit so an image can be rebuilt from the same
# local Node base without silently changing the document-processing runtime.
FROM application AS runtime-host-tools
ARG MARKITDOWN_VERSION=0.1.7
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/agentloop-runtime-tools \
  && /opt/agentloop-runtime-tools/bin/pip install --no-cache-dir --index-url "${PIP_INDEX_URL}" "markitdown==${MARKITDOWN_VERSION}" \
  && /opt/agentloop-runtime-tools/bin/markitdown --version

ENV PATH="/opt/agentloop-runtime-tools/bin:${PATH}"

FROM runtime-host-tools AS runtime-host
ENV RUNTIME_REQUIRED_COMMANDS=markitdown
CMD ["npm", "run", "start:runtime-host"]

FROM application AS web
CMD ["npm", "run", "start:web"]
