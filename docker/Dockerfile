# syntax=docker/dockerfile:1.7
# Deployment repo image: clone the upstream source at a pinned ref inside the
# build, then stage the standalone runtime. The deployment repo itself contains
# only these deployment files; no upstream source or secrets are stored here.
#
#   docker build -f docker/Dockerfile -t ofm-standalone:2.7.2 .
#
# Override at build time:
#   --build-arg OFM_SOURCE_REPO=... --build-arg OFM_SOURCE_REF=v2.7.2

ARG OFM_SOURCE_REPO=https://github.com/Ebony-Vinyl/dsh-our-free-model.git
ARG OFM_SOURCE_REF=v2.7.2

FROM node:22-bookworm-slim AS source
ARG OFM_SOURCE_REPO
ARG OFM_SOURCE_REF
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git init /src \
 && cd /src \
 && git remote add origin "$OFM_SOURCE_REPO" \
 && git fetch --depth 1 origin "$OFM_SOURCE_REF" \
 && git checkout --detach FETCH_HEAD \
 && test -f scripts/prepare-desktop.mjs \
 && test -f packages/standalone/service.mjs \
 && rm -rf /src/.git

FROM node:22-bookworm-slim AS stage
COPY --from=source /src /src
COPY docker/ /src/docker/
WORKDIR /src
# stageDesktopService writes magpie metadata to a sibling of its destination;
# stage into /out/service and fold the sibling into the app root.
RUN node --input-type=module -e "import('./scripts/prepare-desktop.mjs').then(m => m.stageDesktopService('/out/service', { requireWorkspace: false }))" \
 && mv /out/vendor/magpie /out/service/vendor/magpie \
 && rmdir /out/vendor

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tini tzdata passwd \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 1000 ofm \
 && useradd --uid 1000 --gid ofm --home-dir /data/home --shell /bin/sh ofm

COPY --from=stage /out/service /app
COPY docker/serve.mjs /app/docker/serve.mjs
COPY docker/ui-proxy.mjs /app/docker/ui-proxy.mjs
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh \
 && mkdir -p /data/home \
 && chown -R ofm:ofm /app /data

ENV OFM_HOME=/data \
    HOME=/data/home \
    NODE_ENV=production \
    TZ=Asia/Shanghai \
    OFM_PORT=18900 \
    OFM_LAN=1 \
    OFM_LAN_PORT=18901

WORKDIR /app
USER ofm
EXPOSE 18900 18901

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${OFM_PORT}/health" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["node", "/app/docker/serve.mjs"]
