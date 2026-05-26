#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

log() {
  printf '\n==> %s\n' "$1"
}

die() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

run() {
  printf '+ %s\n' "$*"
  "$@"
}

command -v docker >/dev/null 2>&1 || die "Docker not found. Please install Docker first."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 not found. Please install Docker Compose v2."

echo "=== AI Gateway Installation ==="

if [[ ! -f .env ]]; then
  [[ -f .env.example ]] || die ".env.example not found."
  log "Creating .env from .env.example"
  run cp .env.example .env
else
  log ".env already exists"
fi

log "Building tools container"
run docker compose --profile tools build db-tools

log "Starting Postgres and Redis"
run docker compose up -d postgres redis

log "Installing dependencies"
run docker compose run --rm db-tools pnpm install

log "Generating migrations"
run docker compose run --rm db-tools pnpm db:generate

log "Running migrations"
run docker compose run --rm db-tools pnpm db:migrate

log "Seeding database"
run docker compose run --rm db-tools pnpm db:seed

log "Building app containers"
run docker compose --profile app build

log "Starting applications"
run docker compose --profile app up -d

echo
echo "=== Installation Complete ==="
echo "Services:"
echo "  Dashboard: http://localhost:7790"
echo "  Admin API: http://localhost:7780"
echo "  Proxy:     http://localhost:7777"
echo
echo "Useful commands:"
echo "  docker compose --profile app logs -f    # View logs"
echo "  docker compose --profile app down       # Stop services"
echo "  docker compose --profile app restart    # Restart services"
