import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { eq, and } from "drizzle-orm";
import { getDb, closeDb } from "./client";
import {
  tenants,
  providers,
  providerKeys,
  models,
  routes,
} from "./schema";
import type { providerTypeEnum } from "./schema/enums";

type ProviderType = (typeof providerTypeEnum.enumValues)[number];

interface TomlConfig {
  providers?: {
    default?: string;
    openai?: { api_key?: string; base_url?: string };
    anthropic?: { api_key?: string; base_url?: string };
    custom?: Record<
      string,
      {
        base_url?: string;
        api_keys?: string[];
        endpoint_type?: string;
        rotation?: { max_retries?: number };
      }
    >;
  };
  passthrough?: { target?: string };
}

const CONFIG_PATH = resolve(process.cwd(), "../../config.toml");
const DEFAULT_TENANT_SLUG = "default";

function fingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 32);
}

/**
 * Placeholder envelope-encryption stub.
 * TODO(security): replace with libsodium/age + KMS-managed DEK before prod.
 * For dev-seed we simply mark the value as plaintext-tagged so a later
 * migration can identify rows that still need re-encryption.
 */
function encryptPlaceholder(secret: string): string {
  return `plain:${Buffer.from(secret, "utf8").toString("base64")}`;
}

function mapEndpointType(endpointType: string | undefined): ProviderType {
  switch (endpointType) {
    case "openai":
      return "custom_openai";
    case "anthropic":
      return "custom_anthropic";
    default:
      return "custom_openai";
  }
}

async function ensureTenant(db: ReturnType<typeof getDb>) {
  const existing = await db.query.tenants.findFirst({
    where: eq(tenants.slug, DEFAULT_TENANT_SLUG),
  });
  if (existing) return existing;
  const [row] = await db
    .insert(tenants)
    .values({
      slug: DEFAULT_TENANT_SLUG,
      name: "Default Tenant",
    })
    .returning();
  console.log(`+ tenant: ${row.slug}`);
  return row;
}

async function upsertProvider(
  db: ReturnType<typeof getDb>,
  tenantId: string,
  slug: string,
  name: string,
  type: ProviderType,
  baseUrl: string,
  maxRetries: number,
) {
  const existing = await db.query.providers.findFirst({
    where: and(eq(providers.tenantId, tenantId), eq(providers.slug, slug)),
  });
  if (existing) {
    console.log(`= provider: ${slug} (exists)`);
    return existing;
  }
  const [row] = await db
    .insert(providers)
    .values({ tenantId, slug, name, type, baseUrl, maxRetries })
    .returning();
  console.log(`+ provider: ${slug} → ${baseUrl}`);
  return row;
}

async function upsertProviderKey(
  db: ReturnType<typeof getDb>,
  providerId: string,
  label: string,
  secret: string,
) {
  const fp = fingerprint(secret);
  const existing = await db.query.providerKeys.findFirst({
    where: and(
      eq(providerKeys.providerId, providerId),
      eq(providerKeys.keyFingerprint, fp),
    ),
  });
  if (existing) return existing;
  const [row] = await db
    .insert(providerKeys)
    .values({
      providerId,
      label,
      keyEncrypted: encryptPlaceholder(secret),
      keyFingerprint: fp,
    })
    .returning();
  console.log(`  + key: ${label} (fp=${fp.slice(0, 8)}…)`);
  return row;
}

async function main() {
  const db = getDb();

  let raw: string;
  try {
    raw = await readFile(CONFIG_PATH, "utf8");
  } catch {
    console.warn(`⚠  ${CONFIG_PATH} not found — skipping config-driven seed.`);
    return;
  }

  const cfg = parseToml(raw) as TomlConfig;
  const tenant = await ensureTenant(db);

  // OpenAI
  if (cfg.providers?.openai?.api_key) {
    const p = await upsertProvider(
      db,
      tenant.id,
      "openai",
      "OpenAI",
      "openai",
      cfg.providers.openai.base_url ?? "https://api.openai.com/v1",
      3,
    );
    await upsertProviderKey(db, p.id, "primary", cfg.providers.openai.api_key);
  }

  // Anthropic
  if (cfg.providers?.anthropic?.api_key) {
    const p = await upsertProvider(
      db,
      tenant.id,
      "anthropic",
      "Anthropic",
      "anthropic",
      cfg.providers.anthropic.base_url ?? "https://api.anthropic.com",
      3,
    );
    await upsertProviderKey(
      db,
      p.id,
      "primary",
      cfg.providers.anthropic.api_key,
    );
  }

  // Custom providers (e.g. freemodel)
  for (const [slug, custom] of Object.entries(cfg.providers?.custom ?? {})) {
    if (!custom.base_url) continue;
    const p = await upsertProvider(
      db,
      tenant.id,
      slug,
      slug.charAt(0).toUpperCase() + slug.slice(1),
      mapEndpointType(custom.endpoint_type),
      custom.base_url,
      custom.rotation?.max_retries ?? 3,
    );
    for (const [i, key] of (custom.api_keys ?? []).entries()) {
      await upsertProviderKey(db, p.id, `key-${i + 1}`, key);
    }
  }

  // Suppress unused-import warnings until catalog seed is filled in.
  void models;
  void routes;

  console.log("\n✓ seed complete");
}

main()
  .catch((err) => {
    console.error("✗ seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
