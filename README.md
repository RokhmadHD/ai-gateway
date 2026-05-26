# ai-gateway

Multi-tenant LLM proxy + admin API + dashboard. Monorepo (pnpm + Turborepo).

> Status: **Sprints 1–5 done.** Stack lengkap jalan di Docker.

## Support Development

If you find this project useful, consider supporting its development:

[![Saweria](https://img.shields.io/badge/Saweria-Support-orange?style=for-the-badge&logo=ko-fi&logoColor=white)](https://saweria.co/RokhmadHD)

## Architecture

```
                ┌─────────────┐
                │  Dashboard  │ :7790
                │  (Next.js)  │ Tailwind v4 + tRPC React Query
                └──────┬──────┘
                       │ tRPC over HTTP (typed via AppRouter)
                       ▼
                ┌─────────────┐
   Admin token  │   Admin     │ :7780
   (Bearer)  ──▶│  (Hono)     │ Hono + tRPC + zod + bearer auth
                └──────┬──────┘
                       │ Drizzle ORM             ┌──────────┐
                       │                         │  Redis   │ :6380
                       ▼                         │  pub/sub │
                ┌─────────────┐                  └────┬─────┘
                │  Postgres   │ :5433                 │
                └──────┬──────┘                       │
                       │ source of truth              │
                       │                              │
                       ▼ ConfigRuntime.load           ▼ subscribe
                ┌─────────────────────────────────────────────┐
                │              Proxy :7777                    │
                │  Fastify + KeyPool + Rotation               │
                │                                             │
                │  ConfigRuntime ← snapshot ─→ Provider adptr │
                │       ↑                                     │
                │       │ on update (instant via Redis)       │
                │       │ + 5min safety poll                  │
                │       │                                     │
                │  KeyReporter ── async UPDATE ─────────┐     │
                │  (success/fail/cooldown/last_used)    │     │
                │                                       │     │
                │  /v1/messages POST → freemodel.dev    │     │
                └──────────────────────────────────────┴─────┘
                                                        │
                                                        ▼ back to Postgres
```

**Flow lengkap satu mutation:**
1. Dashboard → `providerKeys.setStatus` (tRPC POST)
2. Admin validates bearer token → Drizzle UPDATE → `bus.publish()` ke Redis
3. Proxy subscribed → `config:updated` event → `ConfigRuntime.load()` baca ulang Postgres
4. KeyPool + KeyReporter rebuild snapshot di memory (zero downtime)
5. Request berikutnya pakai pool baru; setiap success/fail di-write back ke Postgres async

## Layout

```
ai-gateway/
├── apps/
│   ├── proxy/             # data-plane :7777 (Fastify)
│   ├── admin/             # control-plane :7780 (Hono + tRPC)
│   └── dashboard/         # UI :7790 (Next.js 15 + Tailwind v4)
├── packages/
│   ├── db/                # Drizzle schema + migrations + seed
│   ├── shared/            # types, crypto, errors
│   └── config-runtime/    # ConfigRuntime + RedisConfigBus + legacy adapter
├── docker/
│   └── tools.Dockerfile   # one-shot Node+pnpm ops container
├── docker-compose.yml
├── pnpm-workspace.yaml
└── turbo.json
```

## Port mapping (host → container)

| Service    | Host port | Container | Notes                                      |
| ---------- | --------: | --------: | ------------------------------------------ |
| dashboard  |      7790 |      7790 | Next.js standalone                         |
| admin      |      7780 |      7780 | tRPC + REST `/healthz`                     |
| proxy      |      7777 |      7777 | OpenAI/Anthropic-compatible passthrough    |
| postgres   |      5433 |      5432 | beda dari instans lain supaya bisa coexist |
| redis      |      6380 |      6379 | pub/sub + future rate-limit                |

## Quick start (Docker-only)

### Automated installation

```bash
./install.sh
```

The script will:
1. Create `.env` from `.env.example` if not exists
2. Build tools container
3. Start Postgres and Redis
4. Install dependencies
5. Generate and run migrations
6. Seed database from `config.toml`
7. Build and start all applications

After installation completes, open http://localhost:7790

### Manual installation

```bash
cd /home/tensanq/ai-gateway

# 1. env (default token = [REDACTED:API key param]
cp .env.example .env

# 2. Infra
docker compose --profile tools build db-tools
docker compose up -d postgres redis
docker compose run --rm db-tools pnpm install
docker compose run --rm db-tools pnpm db:generate
docker compose run --rm db-tools pnpm db:migrate
docker compose run --rm db-tools pnpm db:seed

# 3. Apps
docker compose --profile app build
docker compose --profile app up -d

# 4. Buka dashboard
open http://localhost:7790
```

See [SETUP.md](./SETUP.md) for the full step-by-step incl. troubleshooting.

## Dev workflow

Quick shortcuts (from repo root, requires `pnpm` on host — only used to drive Docker):

```bash
# Hot-reload mode (Next.js / tsx watch). Stops the prod container first.
pnpm dash:dev          # http://localhost:7790 — Next.js fast refresh
pnpm admin:dev         # http://localhost:7780 — tsx watch
pnpm proxy:dev         # http://localhost:7777 — tsx watch

# Rebuild + restart the production image after merging changes
pnpm dash:rebuild
pnpm admin:rebuild
pnpm proxy:rebuild

# Whole-app lifecycle
pnpm app:up            # start dashboard + admin + proxy
pnpm app:down
pnpm app:logs
pnpm app:build         # rebuild all three images
```

Dev mode bind-mounts the host repo into the container at `/workspace`, so editing
in VSCode → save → instant reload. No need to rebuild for code-only changes.
Rebuild only when `package.json` / `Dockerfile` / native deps change.

## Config sources

Proxy reads config via `CONFIG_SOURCE` env:

- `CONFIG_SOURCE=db` (default in compose) — reads `providers` + `provider_keys` + `routes` from Postgres via `ConfigRuntime`. Live reload via Redis pub/sub (`ai-gateway:config:<tenant>`).
- `CONFIG_SOURCE=toml` — legacy mode, reads `config.toml`. Useful for bootstrap / migration.

Seed script (`pnpm db:seed`) parses any existing `config.toml` and populates DB — one-time migration.

## Tech stack

| Layer            | Choice                                  |
| ---------------- | --------------------------------------- |
| Data-plane HTTP  | Fastify 4                               |
| Control-plane    | Hono 4 + @hono/trpc-server              |
| RPC              | tRPC 11 (server + react-query client)   |
| DB               | Postgres 16 + Drizzle ORM 0.36          |
| Cache / pub-sub  | Redis 7 (via ioredis)                   |
| Dashboard        | Next.js 15 + React 19                   |
| Styling          | Tailwind CSS v4 (@tailwindcss/postcss)  |
| Validation       | zod                                     |
| Orchestration    | Turborepo (build graph)                 |
| Packaging        | pnpm workspaces                         |
| Container        | Docker Compose v2                       |

## Features

### Dead Provider Detection

The gateway automatically detects and tracks providers that hit upstream errors (e.g., credit exhaustion, API quota limits):

**Auto-Detection:**
- Detects error 400 with message "Third-party apps now draw from extra usage"
- Detects `upstream_error` type responses
- Marks provider with `isDead: true` flag in attempts
- Does NOT retry dead providers (saves time & resources)

**Logging & Tracking:**
- HTTP response header: `X-AIG-Dead-Providers: provider-slug1,provider-slug2`
- Server logs: Warning with dead provider details
- Usage logs: `metadata.deadProviders` array for aig-auto attempts
- Dashboard badges: Visual indicators showing dead status, reason, and timestamp

**Response Structure:**
```json
{
  "error": {
    "message": "aig-auto: all 3 provider(s) failed: freemodel=400, backup=502",
    "attempts": [
      {
        "provider": "freemodel",
        "status": 400,
        "isDead": true,
        "error": "Upstream error: Third-party apps now draw from extra usage"
      }
    ]
  }
}
```

**Dashboard Integration:**
- Providers page: Dead counter in header, red badges on dead providers
- Provider details: Shows dead reason and timestamp since marked dead
- Logs page: Warning badges on requests with upstream errors

## Sprint roadmap

- [x] **S1** — DB foundation (Drizzle, Postgres, schema, seed)
- [x] **S2** — Port proxy → `apps/proxy/`, DB-backed config, write-back stats
- [x] **S3** — Live config reload via Redis pub/sub
- [x] **S4** — `apps/admin/` (Hono + tRPC, CRUD providers/keys, bearer auth)
- [x] **S5** — `apps/dashboard/` (Next.js + Tailwind v4 + tRPC client)
- [x] **S6** — Real auth (better-auth), RBAC owner/admin/member/viewer, tenant isolation
- [x] **S6.5** — Dead provider detection & tracking (upstream error handling)
- [ ] **S7** — Observability (OTel + Loki/Tempo), Redis rate-limit + quota enforcement
- [ ] **S8** — Usage logs + cost dashboards (charts, CSV export)
- [ ] **S9** — Envelope encryption for `provider_keys.key_encrypted` (replace `plain:base64` placeholder)
- [ ] **S10** — Production hardening (CI, image scanning, deploy automation)

## Auth & multi-tenancy (S6)

The admin/dashboard now uses **better-auth** with sessions, RBAC, and a memberships pattern:

- **Sign-up**: open registration via email/password or Google/GitHub OAuth (configure via `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`). First sign-up auto-creates a personal tenant with the user as owner.
- **Roles**: `owner` → `admin` → `member` → `viewer`. Owners manage members; admins manage providers/keys; members can mint API keys; viewers are read-only.
- **Invitations**: owners/admins invite teammates from `/settings/members`. Invitee opens `/accept-invite?token=...` to join.
- **Tenant switcher**: users in multiple tenants pick the active one from the sidebar dropdown. The choice is stored on the session row (`sessions.active_tenant_id`).
- **Per-tenant gemini/kiro accounts**: tokens are stored on disk under `<base>/<tenant_slug>/acc-*.json`. Run `pnpm db:migrate-accounts` once to move pre-S6 flat files into `default/`.

### Bootstrap (first run)

```bash
pnpm db:migrate            # apply migrations (creates auth tables)
pnpm db:seed               # seed default tenant + providers from config.toml
SEED_OWNER_EMAIL=you@example.com SEED_OWNER_PASSWORD=changeme pnpm db:seed-owner
pnpm db:migrate-accounts   # one-shot: relocate /var/{kiro,gemini}-accounts/*.json into default/
```

Set `BETTER_AUTH_SECRET` (`openssl rand -hex 32`) and `BETTER_AUTH_URL` (public origin of the admin server) before going live.

### Legacy bearer fallback

For migrating an existing S5 deployment without re-onboarding everyone immediately, set `LEGACY_ADMIN_TOKEN_FALLBACK=1`. A request with `Authorization: Bearer ${ADMIN_TOKEN}` is treated as a super-admin of the `default` tenant. Turn this off once your team has signed up.

## Security notes (read before public deploy)

- `BETTER_AUTH_SECRET` must be a strong random value in production. Sessions are signed with it.
- `provider_keys.key_encrypted` uses a `plain:base64(...)` placeholder. **Sprint 9** swaps in real envelope encryption (libsodium + KMS-managed DEK).
- CORS allows `credentials: include` from origins in `CORS_ORIGIN` (comma-separated). Lock this down to your dashboard origin(s) only.
- The Gemini OAuth callback at `/oauth/gemini/callback` is unauthenticated by design (Google redirects an anonymous browser there); the inbound `state` is bound to the in-memory session of the user who initiated the flow. Don't expose this endpoint to untrusted networks beyond your dashboard.
- By default Gemini OAuth redirects to `http://127.0.0.1:<admin-port>/oauth/gemini/callback`. That only works when the browser is on the same machine as the admin server. For Android or another device, set `GEMINI_OAUTH_CALLBACK_BASE` to a reachable admin origin, for example `http://192.168.1.10:7780`, and make sure the matching `/oauth/gemini/callback` redirect URI is allowed by the Google OAuth client you use.
