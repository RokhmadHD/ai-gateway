# @ai-proxy/db

Skema + migrations + seed untuk AI Proxy (Drizzle + Postgres).

## Setup

```bash
# 1. Spin up Postgres (port 5433 di host)
docker compose up -d postgres

# 2. Copy env
cp packages/db/.env.example packages/db/.env
# edit DATABASE_URL kalau perlu (default: localhost:5433)

# 3. Generate migration (sekali, ketika schema berubah)
pnpm db:generate

# 4. Apply migration
pnpm db:migrate

# 5. Seed dari config.toml lama
pnpm db:seed

# 6. (opsional) Inspect via Drizzle Studio
pnpm db:studio
```

## Layout

```
src/
├── client.ts        # postgres.js pool + drizzle binding
├── env.ts           # env validation (lazy load)
├── migrate.ts       # runs ./drizzle/*.sql
├── seed.ts          # idempotent seed dari config.toml
├── drop.ts          # ⚠ DROP SCHEMA public (dev only)
└── schema/
    ├── enums.ts
    ├── tenants.ts        # tenants, users
    ├── apiKeys.ts        # api_keys (client → proxy)
    ├── providers.ts      # providers, provider_keys, models, routes
    ├── usage.ts          # usage_logs, quotas, audit_logs
    └── index.ts
```

## Konvensi

- Semua tabel `snake_case` lewat `drizzle({ casing: "snake_case" })`.
- Primary key: `uuid` random.
- Tenant-scoped: setiap tabel domain punya `tenant_id` + cascading delete.
- Timestamps: `with time zone`, default `now()`.
- Provider credentials: stored encrypted (`plain:base64(...)` placeholder untuk seed; ganti dengan envelope encryption sebelum prod).
- Usage logs: append-only, denormalized `model_name` & pricing snapshot.
