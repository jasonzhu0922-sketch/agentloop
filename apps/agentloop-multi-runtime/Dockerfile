# Keep the default official Docker Hub image, but allow deployments whose
# network cannot reach Docker Hub to select a compatible registry proxy.
ARG NODE_IMAGE=node:26-bookworm
FROM ${NODE_IMAGE} AS node-base

# These are build-only proxy arguments for npm. They are intentionally not
# persisted with ENV in the final image.
FROM node-base AS dependencies
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
# Alibaba Cloud's public npm mirror (npmmirror). Override only for an
# approved enterprise registry.
ARG NPM_REGISTRY=https://registry.npmmirror.com

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/agentloop/package.json ./packages/agentloop/package.json
COPY packages/agentloop-artifact-preview/package.json ./packages/agentloop-artifact-preview/package.json
COPY packages/agentloop-plan-template/package.json ./packages/agentloop-plan-template/package.json
COPY packages/agentloop-skills/package.json ./packages/agentloop-skills/package.json
COPY apps/agentloop-app/package.json ./apps/agentloop-app/package.json
COPY apps/agentloop-multi-runtime/package.json ./apps/agentloop-multi-runtime/package.json
RUN npm config set registry "${NPM_REGISTRY}" \
  # Preserve third-party/private tarball origins recorded in package-lock.json.
  # Only normal npmjs.org entries may be remapped to the configured mirror.
  && npm config set replace-registry-host npmjs \
  && npm ci --registry="${NPM_REGISTRY}" --ignore-scripts --no-audit --no-fund --loglevel=info \
  && npm config delete registry \
  && npm config delete replace-registry-host

# Source changes must not invalidate the npm dependency installation above.
FROM dependencies AS application
WORKDIR /app
COPY packages ./packages
COPY apps/agentloop-multi-runtime ./apps/agentloop-multi-runtime
RUN npm run build --workspace @zhujun/agentloop \
  && npm run build --workspace @zhujun/agentloop-artifact-preview \
  && npm run build --workspace @zhujun/agentloop-plan-template \
  && npm run build --workspace @zhujun/agentloop-skills \
  && npm rebuild sharp --workspace agentloop-multi-runtime --foreground-scripts

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
FROM node-base AS runtime-host-tools
ARG APT_MIRROR
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
ARG PIP_FALLBACK_INDEX_URL=https://pypi.org/simple/
ARG PLAYWRIGHT_DOWNLOAD_HOST
COPY apps/agentloop-multi-runtime/requirements.txt /tmp/requirements.txt
RUN if [ -n "${APT_MIRROR}" ]; then sed -i "s|http://deb.debian.org/debian|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; fi \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg fonts-noto-cjk ghostscript pandoc \
    poppler-utils python3 python3-venv qpdf tesseract-ocr unzip zip \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/agentloop-runtime-tools \
  # A mirror can retain an index entry after its cached wheel disappeared.
  && ( /opt/agentloop-runtime-tools/bin/pip install --no-cache-dir --index-url "${PIP_INDEX_URL}" -r /tmp/requirements.txt \
    || /opt/agentloop-runtime-tools/bin/pip install --no-cache-dir --index-url "${PIP_FALLBACK_INDEX_URL}" -r /tmp/requirements.txt ) \
  && if [ -n "${PLAYWRIGHT_DOWNLOAD_HOST}" ]; then export PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST}"; fi \
  && /opt/agentloop-runtime-tools/bin/python -m playwright install --with-deps chromium \
  && /opt/agentloop-runtime-tools/bin/markitdown --version \
  && /opt/agentloop-runtime-tools/bin/python -c 'import anthropic, defusedxml, imageio, lxml, mcp, numpy, openpyxl, pandas, pdf2image, pdfplumber, PIL, playwright, pymysql, pypdf, pytesseract, reportlab'

ENV PATH="/opt/agentloop-runtime-tools/bin:${PATH}"

FROM runtime-host-tools AS runtime-host
COPY --from=application /app /app
WORKDIR /app/apps/agentloop-multi-runtime
ENV RUNTIME_REQUIRED_COMMANDS=markitdown,pandoc,pdftoppm,pdftotext,pdfinfo,qpdf,gs,tesseract,ffmpeg,unzip,zip
ENV RUNTIME_REQUIRED_PYTHON_MODULES=anthropic,defusedxml,imageio,lxml,mcp,numpy,openpyxl,pandas,pdf2image,pdfplumber,PIL,playwright,pymysql,pypdf,pytesseract,reportlab
ENV RUNTIME_REQUIRED_NODE_MODULES=docx,pptxgenjs,react,react-dom,react-icons,sharp,@zhujun/agentloop-plan-template
CMD ["npm", "run", "start:runtime-host"]

FROM application AS web
CMD ["npm", "run", "start:web"]

# Compose runs Router, Web, and Runtime Host from one local image.  Keep the
# default target Host-capable so `docker compose up --build` cannot publish a
# Web-only image that later fails a Host dependency preflight.
FROM runtime-host AS local-runtime
