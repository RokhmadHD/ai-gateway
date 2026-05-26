# Multi-stage Dockerfile untuk apps/dashboard (Next.js 15 standalone).
# Build context = monorepo root.

ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS deps
RUN apk add --no-cache python3 make g++ \
    && corepack enable \
    && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml .npmrc package.json turbo.json ./
COPY apps/dashboard/package.json apps/dashboard/package.json
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

# Build admin first so AppRouter types resolve to dist/.
RUN pnpm exec turbo run build --filter=@ai-gateway/admin
RUN pnpm --filter @ai-gateway/dashboard build

FROM node:${NODE_VERSION} AS runtime
RUN apk add --no-cache wget
WORKDIR /app
ENV NODE_ENV=production

# Next.js standalone bundles everything it needs into .next/standalone.
COPY --from=build /repo/apps/dashboard/.next/standalone ./
COPY --from=build /repo/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=build /repo/apps/dashboard/public ./apps/dashboard/public

EXPOSE 7790
ENV PORT=7790
ENV HOSTNAME=0.0.0.0
WORKDIR /app/apps/dashboard
CMD ["node", "server.js"]
