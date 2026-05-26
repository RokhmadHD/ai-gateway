# Sprint 1 — Quick Start (Docker-only)

Tujuan: setup Postgres + Redis + jalankan migration & seed dari config.toml lama.
✗ install apa-apa di host. Semua via Docker.

Catatan: ai-proxy lama (port 3000) tetap jalan — kita ✗ menyentuhnya.

## Prasyarat
- Docker & Docker Compose v2 (`docker compose version` → v2.x). ✓
- Disk free ≥ 1 GB (image node:22-alpine ~ 200 MB, postgres + redis ~ 250 MB).

## Step-by-step

**Semua perintah dijalankan dari `/home/tensanq/ai-gateway/`.**

### 1. Siapkan env
```bash
cd /home/tensanq/ai-gateway
cp .env.example .env
```
(Tidak perlu edit kalau pakai default.)

### 2. Nyalakan Postgres + Redis
```bash
docker compose up -d postgres redis
```
Tunggu sampai healthy (cek dengan `docker compose ps`).

### 3. Build image tools (sekali)
```bash
docker compose --profile tools build db-tools
```
Image ini = node:22-alpine + pnpm. Source repo bind-mounted ke `/workspace`.

### 4. Install dependencies (di dalam container)
```bash
docker compose run --rm db-tools pnpm install
```
Output: pnpm-lock.yaml + node_modules di-cache lewat named volume
(`tools_node_modules`, `tools_db_node_modules`). Aman ✗ "bocor" ke host.

### 5. Generate migration SQL dari schema
```bash
docker compose run --rm db-tools pnpm db:generate
```
Output: file `packages/db/drizzle/0000_*.sql` (akan muncul di host karena
bind-mount).

### 6. Apply migration ke Postgres
```bash
docker compose run --rm db-tools pnpm db:migrate
```
Expected output: `✓ migrations applied`

### 7. Seed dari config.toml lama
```bash
docker compose run --rm db-tools pnpm db:seed
```
Expected output:
```
+ tenant: default
+ provider: freemodel → https://cc.freemodel.dev/v1
  + key: key-1 (fp=...)
  + key: key-2 (fp=...)
  + key: key-3 (fp=...)
✓ seed complete
```

### 8. Verifikasi via psql (opsional)
```bash
docker compose exec postgres psql -U ai_gateway -d ai_gateway \
  -c "SELECT slug, name, type, base_url FROM providers;"
docker compose exec postgres psql -U ai_gateway -d ai_gateway \
  -c "SELECT pk.label, pk.status, p.slug FROM provider_keys pk JOIN providers p ON p.id=pk.provider_id;"
```

### 9. (Opsional) Drizzle Studio
```bash
docker compose run --rm -p 4983:4983 db-tools pnpm db:studio
```
Buka [http://localhost:4983](http://localhost:4983).

---

## Troubleshooting

| Gejala | Sebab | Fix |
|---|---|---|
| `pnpm: command not found` di container | Image belum di-build | Step 3 |
| `connection refused` ke postgres | Container belum healthy | `docker compose ps` cek status |
| `DATABASE_URL` undefined | Compose env hilang | Cek `.env` di root ai-gateway |
| Migration nge-loop / error duplicate | Sudah pernah migrate | `docker compose run --rm db-tools pnpm --filter @ai-gateway/db db:drop` lalu ulang dari step 6 |

## Reset penuh (kalau mau mulai dari nol)
```bash
docker compose down -v          # hapus volume postgres/redis/node_modules
docker compose --profile tools build --no-cache db-tools
# lalu ulang dari step 2
```

---

## Apa yang sudah jadi setelah Sprint 1
- Postgres + Redis running di Docker
- Schema multi-tenant lengkap (tenants, users, api_keys, providers, provider_keys, models, routes, usage_logs, quotas, audit_logs)
- Seed: config.toml → DB
- Tooling container reusable untuk Sprint berikutnya

**Sprint 2** (selanjutnya, ✗ sekarang): port `src/` → `apps/proxy/`, baca config dari DB, tambah Redis pub/sub.
