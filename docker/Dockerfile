# Setup base image
FROM ubuntu:noble-20251013 AS base

# Build arguments
ARG ARG_UID=1000
ARG ARG_GID=1000

FROM base AS build-arm64
RUN echo "Preparing build of AnythingLLM image for arm64 architecture"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Install system dependencies
# hadolint ignore=DL3008,DL3013
RUN DEBIAN_FRONTEND=noninteractive apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -yq --no-install-recommends \
        unzip curl gnupg libgfortran5 libgbm1 tzdata netcat-openbsd \
        libasound2t64 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 \
        libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 \
        libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 \
        libxss1 libxtst6 ca-certificates fonts-liberation libappindicator3-1 libnss3 lsb-release \
        xdg-utils git build-essential ffmpeg poppler-utils fontconfig \
        libreoffice-writer libreoffice-core libreoffice-java-common \
        fonts-noto-cjk fonts-noto-color-emoji fonts-dejavu && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_18.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    # Install node and yarn
    apt-get install -yq --no-install-recommends nodejs && \
    curl -fL https://github.com/yarnpkg/yarn/releases/download/v1.22.19/yarn_1.22.19_all.deb -o yarn_1.22.19_all.deb \
        && echo "666cc8c015bb9e36236fc355816711fbc88bbba97ce8344d3ea2a36debcf7424  yarn_1.22.19_all.deb" | sha256sum -c - \
        && dpkg -i yarn_1.22.19_all.deb \
        && rm yarn_1.22.19_all.deb && \
    # Install uvx (pinned to 0.6.10) for MCP support
    curl -LsSf https://astral.sh/uv/0.6.10/install.sh -o /tmp/uv-install.sh && \
        echo "16bc7443117084db0835e0fc041ba253a47f10ac6e819933ed9f80612f8c2347  /tmp/uv-install.sh" | sha256sum -c - && \
        sh /tmp/uv-install.sh && rm /tmp/uv-install.sh && \
        mv /root/.local/bin/uv /usr/local/bin/uv && \
        mv /root/.local/bin/uvx /usr/local/bin/uvx && \
        echo "Installed uvx! $(uv --version)" && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create a group and user with specific UID and GID
# First, remove any existing user/group with the target UID/GID to avoid conflicts
RUN (getent passwd "$ARG_UID" && userdel -f "$(getent passwd "$ARG_UID" | cut -d: -f1)") || true && \
    (getent group "$ARG_GID" && groupdel "$(getent group "$ARG_GID" | cut -d: -f1)") || true && \
    groupadd -g "$ARG_GID" anythingllm && \
    useradd -l -u "$ARG_UID" -m -d /app -s /bin/bash -g anythingllm anythingllm && \
    mkdir -p /app/frontend/ /app/server/ /app/collector/ && chown -R anythingllm:anythingllm /app

# Copy docker helper scripts
COPY ./docker/docker-entrypoint.sh /usr/local/bin/
COPY ./docker/docker-healthcheck.sh /usr/local/bin/
COPY --chown=anythingllm:anythingllm ./docker/.env.example /app/server/.env

# Ensure the scripts are executable
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && \
    chmod +x /usr/local/bin/docker-healthcheck.sh

USER anythingllm
WORKDIR /app

# Puppeteer does not ship with an ARM86 compatible build for Chromium
# so web-scraping would be broken in arm docker containers unless we patch it
# by manually installing a compatible chromedriver.
RUN echo "Need to patch Puppeteer x Chromium support for ARM86 - installing dep!" && \
    curl -fSL https://webassets.anythingllm.com/chromium-1088-linux-arm64.zip -o chrome-linux.zip && \
    echo "eac918179f53579675dddf79cac7ab5ecd32f26b7f05735cd15171a2bba6a4ef  chrome-linux.zip" | sha256sum -c - && \
    unzip chrome-linux.zip && \
    rm -rf chrome-linux.zip

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV CHROME_PATH=/app/chrome-linux/chrome
ENV PUPPETEER_EXECUTABLE_PATH=/app/chrome-linux/chrome

RUN echo "Done running arm64 specific installation steps"

#############################################

# amd64-specific stage
FROM base AS build-amd64
RUN echo "Preparing build of AnythingLLM image for non-ARM architecture"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Install system dependencies
# hadolint ignore=DL3008,DL3013
RUN DEBIAN_FRONTEND=noninteractive apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -yq --no-install-recommends \
        curl gnupg libgfortran5 libgbm1 tzdata netcat-openbsd \
        libasound2t64 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 \
        libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 \
        libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 \
        libxss1 libxtst6 ca-certificates fonts-liberation libappindicator3-1 libnss3 lsb-release \
        xdg-utils git build-essential ffmpeg poppler-utils fontconfig \
        libreoffice-writer libreoffice-core libreoffice-java-common \
        fonts-noto-cjk fonts-noto-color-emoji fonts-dejavu && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_18.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    # Install node and yarn
    apt-get install -yq --no-install-recommends nodejs && \
    curl -fL https://github.com/yarnpkg/yarn/releases/download/v1.22.19/yarn_1.22.19_all.deb -o yarn_1.22.19_all.deb \
        && echo "666cc8c015bb9e36236fc355816711fbc88bbba97ce8344d3ea2a36debcf7424  yarn_1.22.19_all.deb" | sha256sum -c - \
        && dpkg -i yarn_1.22.19_all.deb \
        && rm yarn_1.22.19_all.deb && \
    # Install uvx (pinned to 0.6.10) for MCP support
    curl -LsSf https://astral.sh/uv/0.6.10/install.sh -o /tmp/uv-install.sh && \
        echo "16bc7443117084db0835e0fc041ba253a47f10ac6e819933ed9f80612f8c2347  /tmp/uv-install.sh" | sha256sum -c - && \
        sh /tmp/uv-install.sh && rm /tmp/uv-install.sh && \
        mv /root/.local/bin/uv /usr/local/bin/uv && \
        mv /root/.local/bin/uvx /usr/local/bin/uvx && \
        echo "Installed uvx! $(uv --version)" && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create a group and user with specific UID and GID
# First, remove any existing user/group with the target UID/GID to avoid conflicts
RUN (getent passwd "$ARG_UID" && userdel -f "$(getent passwd "$ARG_UID" | cut -d: -f1)") || true && \
    (getent group "$ARG_GID" && groupdel "$(getent group "$ARG_GID" | cut -d: -f1)") || true && \
    groupadd -g "$ARG_GID" anythingllm && \
    useradd -l -u "$ARG_UID" -m -d /app -s /bin/bash -g anythingllm anythingllm && \
    mkdir -p /app/frontend/ /app/server/ /app/collector/ && chown -R anythingllm:anythingllm /app

# Copy docker helper scripts
COPY ./docker/docker-entrypoint.sh /usr/local/bin/
COPY ./docker/docker-healthcheck.sh /usr/local/bin/
COPY --chown=anythingllm:anythingllm ./docker/.env.example /app/server/.env

# Ensure the scripts are executable
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && \
    chmod +x /usr/local/bin/docker-healthcheck.sh

#############################################
# COMMON BUILD FLOW FOR ALL ARCHS
#############################################

# hadolint ignore=DL3006
FROM build-${TARGETARCH} AS build
RUN echo "Running common build flow of AnythingLLM image for all architectures"

USER anythingllm
WORKDIR /app

# Install & Build frontend layer
# Use BUILDPLATFORM to run on the native host architecture (not emulated).
# This avoids esbuild crashing under QEMU when cross-compiling.
# The output (static HTML/CSS/JS) is platform-independent.
FROM --platform=$BUILDPLATFORM node:18-slim AS frontend-build
WORKDIR /app/frontend
COPY ./frontend/package.json ./frontend/yarn.lock ./
RUN yarn install --network-timeout 100000 --ignore-engines && yarn cache clean
COPY ./frontend/ ./
RUN NODE_OPTIONS=--max-old-space-size=3072 yarn build
WORKDIR /app

# Install server layer
# Also pull and build collector deps (chromium issues prevent bad bindings)
FROM build AS backend-build
COPY --chown=anythingllm:anythingllm ./server /app/server/
WORKDIR /app/server
RUN yarn install --production --network-timeout 100000 --ignore-engines && yarn cache clean
WORKDIR /app

# Install collector dependencies
COPY --chown=anythingllm:anythingllm ./collector/ ./collector/
WORKDIR /app/collector
ENV PUPPETEER_DOWNLOAD_BASE_URL=https://storage.googleapis.com/chrome-for-testing-public
RUN yarn install --production --network-timeout 100000 --ignore-engines && yarn cache clean

WORKDIR /app
USER anythingllm

# Since we are building from backend-build we just need to move built frontend into server/public
FROM backend-build AS production-build
WORKDIR /app
RUN rm -rf /app/server/public && mkdir -p /app/server/public
COPY --chown=anythingllm:anythingllm --from=frontend-build /app/frontend/dist /app/server/public

# Setup the environment
ENV NODE_ENV=production
ENV ANYTHING_LLM_RUNTIME=docker
ENV DEPLOYMENT_VERSION=2.1.1

# Setup the healthcheck
HEALTHCHECK --interval=1m --timeout=10s --start-period=1m \
  CMD /bin/bash /usr/local/bin/docker-healthcheck.sh || exit 1

# Run the server
# CMD ["sh", "-c", "tail -f /dev/null"] # For development: keep container open
ENTRYPOINT ["/bin/bash", "/usr/local/bin/docker-entrypoint.sh"]

FROM backend-build AS api-production-build
WORKDIR /app
ENV NODE_ENV=production
ENV ANYTHING_LLM_RUNTIME=docker
ENV ATHENA_RUNTIME_ROLE=api
ENV ATHENA_API_ONLY=true
ENV ATHENA_COLLECTOR_INLINE=false
ENV ATHENA_BACKGROUND_INLINE=false
ENV DEPLOYMENT_VERSION=2.1.1
HEALTHCHECK --interval=1m --timeout=10s --start-period=1m \
  CMD /bin/bash /usr/local/bin/docker-healthcheck.sh || exit 1
ENTRYPOINT ["/bin/bash", "/usr/local/bin/docker-entrypoint.sh"]

FROM backend-build AS background-worker-build
WORKDIR /app
ENV NODE_ENV=production
ENV ANYTHING_LLM_RUNTIME=docker
ENV ATHENA_RUNTIME_ROLE=background-worker
ENV ATHENA_API_ONLY=true
ENV ATHENA_COLLECTOR_INLINE=false
ENV ATHENA_BACKGROUND_INLINE=false
ENV BACKGROUND_WORKER_PORT=3012
ENV DEPLOYMENT_VERSION=2.1.1
HEALTHCHECK --interval=1m --timeout=10s --start-period=1m \
  CMD curl --silent --fail "http://localhost:${BACKGROUND_WORKER_PORT}/health" || exit 1
ENTRYPOINT ["/bin/bash", "/usr/local/bin/docker-entrypoint.sh"]

FROM backend-build AS realtime-gateway-build
WORKDIR /app
ENV NODE_ENV=production
ENV ANYTHING_LLM_RUNTIME=docker
ENV ATHENA_RUNTIME_ROLE=realtime-gateway
ENV ATHENA_API_ONLY=true
ENV ATHENA_COLLECTOR_INLINE=false
ENV ATHENA_BACKGROUND_INLINE=false
ENV REALTIME_GATEWAY_PORT=3013
ENV DEPLOYMENT_VERSION=2.1.1
HEALTHCHECK --interval=1m --timeout=10s --start-period=1m \
  CMD curl --silent --fail "http://localhost:${REALTIME_GATEWAY_PORT}/health" || exit 1
ENTRYPOINT ["/bin/bash", "/usr/local/bin/docker-entrypoint.sh"]

FROM backend-build AS reader-worker-build
WORKDIR /app
ENV NODE_ENV=production
ENV ANYTHING_LLM_RUNTIME=docker
ENV ATHENA_RUNTIME_ROLE=reader-worker
ENV ATHENA_API_ONLY=true
ENV ATHENA_COLLECTOR_INLINE=false
ENV READER_WORKER_PORT=3011
ENV DEPLOYMENT_VERSION=2.1.1
HEALTHCHECK --interval=1m --timeout=10s --start-period=1m \
  CMD curl --silent --fail "http://localhost:${READER_WORKER_PORT}/health" || exit 1
ENTRYPOINT ["/bin/bash", "/usr/local/bin/docker-entrypoint.sh"]

FROM backend-build AS collector-build
WORKDIR /app
ENV NODE_ENV=production
ENV ANYTHING_LLM_RUNTIME=docker
ENV ATHENA_RUNTIME_ROLE=collector
ENV COLLECTOR_PORT=8888
ENV DEPLOYMENT_VERSION=2.1.1
HEALTHCHECK --interval=1m --timeout=10s --start-period=1m \
  CMD curl --silent --fail "http://localhost:${COLLECTOR_PORT}/health" || exit 1
ENTRYPOINT ["/bin/bash", "/usr/local/bin/docker-entrypoint.sh"]

FROM nginx:1.27-alpine AS web-production-build
ENV ATHENA_WEB_PORT=3000
ENV ATHENA_API_UPSTREAM=http://anything-llm-api:3001
ENV ATHENA_REALTIME_UPSTREAM=http://anything-llm-api:3001
COPY ./docker/nginx-web.conf.template /etc/nginx/templates/default.conf.template
COPY --from=frontend-build /app/frontend/dist /usr/share/nginx/html
