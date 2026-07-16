FROM node:22-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-bookworm-slim

ARG BUILD_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/Enntity/lloom" \
      org.opencontainers.image.revision="${BUILD_REF}" \
      org.opencontainers.image.description="LLooM curated community registry"

ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --gid 10001 lloom && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin lloom
COPY --from=dependencies --chown=lloom:lloom /app/node_modules ./node_modules
COPY --chown=lloom:lloom backends ./backends
COPY --chown=lloom:lloom bin ./bin
COPY --chown=lloom:lloom community ./community
COPY --chown=lloom:lloom config ./config
COPY --chown=lloom:lloom schemas ./schemas
COPY --chown=lloom:lloom src ./src
COPY --chown=lloom:lloom package.json ./package.json
COPY --chown=lloom:lloom deploy/community/config.production.json ./deploy/community/config.production.json

USER 10001:10001
EXPOSE 8110
ENTRYPOINT ["node", "bin/lloom-host.mjs", "serve", "--config", "/app/deploy/community/config.production.json", "--host", "0.0.0.0", "--port", "8110"]
