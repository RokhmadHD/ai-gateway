import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const REQUIRED = ["DATABASE_URL"] as const;

export interface DbEnv {
  DATABASE_URL: string;
}

// Lightweight .env loader so scripts like `pnpm db:migrate` and `db:seed` work
// without requiring the caller to export DATABASE_URL in their shell. Skips
// keys already present in process.env (real env always wins). Loads from both
// packages/db/.env (DB-specific) and the monorepo root .env (shared secrets
// like SEED_OWNER_*, BETTER_AUTH_*).
function loadDotEnv(): void {
  const candidates = [
    resolve(__dirname, "../.env"), // packages/db/.env
    resolve(__dirname, "../../../.env"), // monorepo root .env
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        if (process.env[key]) continue;
        let value = trimmed.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        process.env[key] = value;
      }
    } catch {
      // ignore — fall through to REQUIRED check
    }
  }
}

export function loadDbEnv(): DbEnv {
  loadDotEnv();
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars: ${missing.join(", ")}. ` +
        `Copy packages/db/.env.example to packages/db/.env and adjust.`,
    );
  }
  return {
    DATABASE_URL: process.env.DATABASE_URL!,
  };
}
