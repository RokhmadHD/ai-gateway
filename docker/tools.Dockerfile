# Tooling image: Node 22 + pnpm via corepack.
# Used by docker-compose `db-tools` service to run pnpm install / migrate / seed
# without polluting the host. No app code is baked in — source is bind-mounted.
FROM node:22-alpine

RUN apk add --no-cache git bash && \
    corepack enable && \
    corepack prepare pnpm@9.15.0 --activate

WORKDIR /workspace

# Default: drop the user into a shell so they can run any pnpm script.
# Override via `docker compose run --rm db-tools <cmd>`.
CMD ["sh"]
