/**
 * Provider type — discriminator that tells the proxy which adapter to use.
 * Mirrors `provider_type` enum in @ai-gateway/db.
 */
export type ProviderType =
  | "openai"
  | "anthropic"
  | "anthropic_passthrough"
  | "google"
  | "deepseek"
  | "openrouter"
  | "custom_openai"
  | "custom_anthropic"
  | "kiro"
  | "gemini";

export type ProviderKeyStatus =
  | "active"
  | "disabled"
  | "cooldown"
  | "exhausted"
  | "revoked";

export type RotationStrategy =
  | "round_robin"
  | "weighted"
  | "least_used"
  | "sticky"
  | "random";

/**
 * One credential in a provider's key pool. The `secret` field is plaintext
 * after envelope decryption — never log it; redact via [[obscureKey]].
 */
export interface ResolvedProviderKey {
  id: string;
  label: string | null;
  secret: string;
  status: ProviderKeyStatus;
  weight: number;
  cooldownUntil: Date | null;
  failureCount: number;
  successCount: number;
}

/**
 * Provider snapshot used by the proxy runtime. Equivalent to one
 * `[providers.custom.X]` block in the old config.toml.
 */
export interface ResolvedProvider {
  id: string;
  slug: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  isActive: boolean;
  rotationStrategy: RotationStrategy;
  maxRetries: number;
  timeoutMs: number;
  config: Record<string, unknown>;
  keys: ResolvedProviderKey[];
}

export interface ResolvedRoute {
  id: string;
  pattern: string;
  primaryProviderId: string;
  fallbackProviderIds: string[];
  cacheTtlSeconds: number;
  isActive: boolean;
  priority: number;
}

export type ProxyType = "http" | "https" | "socks4" | "socks5";

/**
 * Proxy snapshot from DB — what the runtime should hand to ProxyPool.replace().
 * Excludes auth fields by default; if present the proxy app builds the URI
 * with embedded credentials.
 */
export interface ResolvedProxy {
  id: string;
  type: ProxyType;
  host: string;
  port: number;
  label: string | null;
  username: string | null;
  password: string | null;
}

/**
 * Whole-config snapshot — one tenant.
 */
export interface ConfigSnapshot {
  tenantId: string;
  tenantSlug: string;
  providers: ResolvedProvider[];
  routes: ResolvedRoute[];
  proxies: ResolvedProxy[];
  loadedAt: Date;
}

export function obscureKey(secret: string): string {
  if (secret.length <= 8) return "********";
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}
