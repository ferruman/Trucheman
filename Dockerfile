# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY index.html vite.config.ts tsconfig.json tsconfig.client.json tsconfig.server.json ./
COPY src ./src
COPY tests/helpers ./tests/helpers
RUN npm run build

FROM node:24-bookworm-slim AS production-dependencies
WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts

FROM node:24-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="Trucheman" \
      org.opencontainers.image.description="Local-first EPUB translation" \
      org.opencontainers.image.source="https://github.com/ferruman/Trucheman" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    TRUCHEMAN_HOST=0.0.0.0 \
    TRUCHEMAN_PORT=4173 \
    TRUCHEMAN_DATA_DIR=/app/data

WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json

RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 4173
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4173/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

STOPSIGNAL SIGTERM
CMD ["node", "dist/server/src/server/index.js"]
