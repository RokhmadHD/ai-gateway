# Multi-stage Dockerfile for apps/admin.
# Build context = monorepo root.

ARG NODE_VERSION=22-alpine

FROM golang:1.25-alpine AS scraper-build
WORKDIR /src
COPY tools/scraper/go.mod tools/scraper/go.sum ./
RUN go mod download
COPY tools/scraper/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/proxy-scraper .

FROM node:${NODE_VERSION} AS deps
RUN apk add --no-cache python3 make g++ \
    && corepack enable \
    && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml .npmrc package.json turbo.json ./
COPY apps/admin/package.json apps/admin/package.json
COPY apps/proxy/package.json apps/proxy/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/config-runtime/package.json packages/config-runtime/package.json

RUN pnpm install --frozen-lockfile

FROM node:${NODE_VERSION} AS build
RUN apk add --no-cache python3 make g++ \
    && corepack enable \
    && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo

COPY --from=deps /repo/node_modules ./node_modules
COPY . .

RUN pnpm exec turbo run build --filter=@ai-gateway/admin

FROM node:${NODE_VERSION} AS runtime
RUN apk add --no-cache wget \
    && corepack enable \
    && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /repo/pnpm-workspace.yaml /repo/pnpm-lock.yaml /repo/.npmrc /repo/package.json ./
COPY --from=build /repo/apps/admin/package.json ./apps/admin/package.json
COPY --from=build /repo/apps/proxy/package.json ./apps/proxy/package.json
COPY --from=build /repo/packages/db/package.json ./packages/db/package.json
COPY --from=build /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /repo/packages/config-runtime/package.json ./packages/config-runtime/package.json

RUN pnpm install --frozen-lockfile --prod \
    && pnpm store prune

COPY --from=build /repo/apps/admin/dist ./apps/admin/dist
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/packages/config-runtime/dist ./packages/config-runtime/dist
COPY --from=build /repo/packages/db/dist ./packages/db/dist

COPY --from=scraper-build /out/proxy-scraper /usr/local/bin/proxy-scraper

EXPOSE 7780
WORKDIR /app/apps/admin
CMD ["node", "dist/server.js"]
