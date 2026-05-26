/**
 * One-shot migration: move flat <base>/acc-*.json files into <base>/default/
 * to match the new per-tenant layout introduced in S6.
 *
 * Run after upgrading admin to S6:
 *   pnpm tsx apps/admin/scripts/migrate-accounts-to-tenant.ts
 *
 * Idempotent: skips files already inside subdirectories.
 */
import {
  readdirSync,
  statSync,
  mkdirSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TENANT_SLUG = process.env.MIGRATE_TENANT_SLUG ?? "default";

function migrate(baseDir: string) {
  if (!existsSync(baseDir)) {
    console.log(`[skip] ${baseDir} does not exist`);
    return;
  }
  const targetDir = join(baseDir, TENANT_SLUG);
  let moved = 0;
  for (const entry of readdirSync(baseDir)) {
    if (!entry.endsWith(".json")) continue;
    const src = join(baseDir, entry);
    const stat = statSync(src);
    if (!stat.isFile()) continue;
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    const dest = join(targetDir, entry);
    if (existsSync(dest)) {
      console.log(`[skip] ${dest} already exists`);
      continue;
    }
    renameSync(src, dest);
    moved++;
    console.log(`[move] ${src} -> ${dest}`);
  }
  console.log(`[done] ${baseDir}: ${moved} file(s) moved into ${TENANT_SLUG}/`);
}

const kiroBase =
  process.env.KIRO_ACCOUNTS_DIR ??
  (process.env.NODE_ENV === "production"
    ? "/var/kiro-accounts"
    : join(homedir(), ".kiro-accounts"));

const geminiBase =
  process.env.GEMINI_ACCOUNTS_DIR ??
  (process.env.NODE_ENV === "production"
    ? "/var/gemini-accounts"
    : join(homedir(), ".gemini-accounts"));

migrate(kiroBase);
migrate(geminiBase);
