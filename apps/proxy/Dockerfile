# Multi-stage Dockerfile untuk apps/proxy.
# Build context = monorepo root (ai-gateway/). Lihat docker-compose.yml.

ARG NODE_VERSION=22-alpine

# ─────────────── deps ───────────────
FROM node:${NODE_VERSION} AS deps
RUN apk add --no-cache python3 make g++ \
    && corepack enable \
    && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml .npmrc package.json turbo.json ./
COPY apps/proxy/package.json apps/proxy/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/config-runtime/package.json packages/config-runtime/package.json

RUN pnpm install --frozen-lockfile

# ─────────────── build ──────────────
FROM node:${NODE_VERSION} AS build
RUN apk add --no-cache python3 make g++ \
    && corepack enable \
    && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo

COPY --from=deps /repo/node_modules ./node_modules
COPY . .

RUN pnpm exec turbo run build --filter=@ai-gateway/proxy

# ─────────────── runtime ────────────
FROM node:${NODE_VERSION} AS runtime
RUN apk add --no-cache wget \
    && corepack enable \
    && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /repo/pnpm-workspace.yaml /repo/pnpm-lock.yaml /repo/.npmrc /repo/package.json ./
COPY --from=build /repo/apps/proxy/package.json ./apps/proxy/package.json
COPY --from=build /repo/packages/db/package.json ./packages/db/package.json
COPY --from=build /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /repo/packages/config-runtime/package.json ./packages/config-runtime/package.json

# Prod-install: drops devDeps but keeps workspace symlinks pointing at packages/*.
RUN pnpm install --frozen-lockfile --prod \
    && pnpm store prune

# Copy each package's BUILT dist/ — that's what require('@ai-gateway/X') resolves to via "main".
COPY --from=build /repo/apps/proxy/dist ./apps/proxy/dist
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/packages/config-runtime/dist ./packages/config-runtime/dist
COPY --from=build /repo/packages/db/dist ./packages/db/dist

EXPOSE 7777
WORKDIR /app/apps/proxy
CMD ["node", "dist/server.js"]
