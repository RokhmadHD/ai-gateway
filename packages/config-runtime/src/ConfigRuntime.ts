import { EventEmitter } from "node:events";
import { eq, and, inArray } from "drizzle-orm";
import { getDb, schema } from "@ai-gateway/db";
import { decryptSecret } from "@ai-gateway/shared";
import type {
  ConfigSnapshot,
  ResolvedProvider,
  ResolvedProviderKey,
  ResolvedProxy,
  ResolvedRoute,
  ProviderType,
  ProviderKeyStatus,
  ProxyType,
  RotationStrategy,
} from "@ai-gateway/shared";
import type { RedisConfigBus } from "./RedisConfigBus";

const { providers, providerKeys, proxies, routes, tenants } = schema;

export interface ConfigRuntimeOptions {
  tenantSlug: string;
  pollIntervalMs?: number;
  /** Optional Redis pub/sub bus. When set, polling is treated as a safety
   *  net and runs at a slower cadence (default 5 min) instead of the fast
   *  primary poll. */
  bus?: RedisConfigBus;
}

/**
 * Loads provider/key/route config from Postgres and emits 'update' events.
 *
 * Two refresh triggers:
 *   1. Redis pub/sub (Sprint 3) — instant, doorbell-only payload.
 *   2. Background poll — fallback when bus is absent OR safety net when bus
 *      is present (slow poll ~5min just in case publisher misses an event).
 */
export class ConfigRuntime extends EventEmitter {
  private current: ConfigSnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly tenantSlug: string;
  private readonly pollIntervalMs: number;
  private readonly bus?: RedisConfigBus;
  private versionHash = "";
  private busSubscribed = false;

  constructor(opts: ConfigRuntimeOptions) {
    super();
    this.tenantSlug = opts.tenantSlug;
    this.bus = opts.bus;
    // Bus present → poll slowly as safety net; absent → poll fast as primary.
    const defaultPoll = opts.bus ? 5 * 60_000 : 30_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? defaultPoll;
  }

  /** Load once and return — caller decides whether to call .start() after. */
  async load(): Promise<ConfigSnapshot> {
    const snap = await this.fetchFromDb();
    const hash = hashSnapshot(snap);
    if (hash !== this.versionHash) {
      const previous = this.current;
      this.current = snap;
      this.versionHash = hash;
      this.emit("update", snap, previous);
    }
    return snap;
  }

  /** Return cached snapshot; throws if .load() never succeeded. */
  snapshot(): ConfigSnapshot {
    if (!this.current) {
      throw new Error("ConfigRuntime: .load() must complete before .snapshot()");
    }
    return this.current;
  }

  /** Subscribe to bus + start polling. Both may be active simultaneously. */
  async start(): Promise<void> {
    if (this.bus && !this.busSubscribed) {
      this.bus.on("update", () => {
        void this.load().catch((err) => this.emit("error", err));
      });
      this.bus.on("error", (err) => this.emit("error", err));
      await this.bus.subscribe();
      this.busSubscribed = true;
    }
    if (this.timer) return;
    const tick = async () => {
      try {
        await this.load();
      } catch (err) {
        this.emit("error", err);
      }
    };
    this.timer = setInterval(tick, this.pollIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.busSubscribed && this.bus) {
      await this.bus.close().catch(() => {});
      this.busSubscribed = false;
    }
  }

  private async fetchFromDb(): Promise<ConfigSnapshot> {
    const db = getDb();

    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.slug, this.tenantSlug),
    });
    if (!tenant) {
      throw new Error(`tenant not found: ${this.tenantSlug}`);
    }

    const providerRows = await db.query.providers.findMany({
      where: and(
        eq(providers.tenantId, tenant.id),
        eq(providers.isActive, true),
      ),
    });

    const providerIds = providerRows.map((p) => p.id);
    const keyRows = providerIds.length
      ? await db.query.providerKeys.findMany({
          where: inArray(providerKeys.providerId, providerIds),
        })
      : [];
    const routeRows = await db.query.routes.findMany({
      where: and(eq(routes.tenantId, tenant.id), eq(routes.isActive, true)),
    });

    const proxyRows = await db.query.proxies.findMany({
      where: and(eq(proxies.tenantId, tenant.id), eq(proxies.isActive, true)),
    });

    const keysByProvider = new Map<string, ResolvedProviderKey[]>();
    for (const k of keyRows) {
      if (k.status === "revoked" || k.status === "disabled") continue;
      let secret: string;
      try {
        secret = decryptSecret(k.keyEncrypted);
      } catch {
        // skip unparseable rows so one bad key doesn't poison the whole pool
        continue;
      }
      const list = keysByProvider.get(k.providerId) ?? [];
      list.push({
        id: k.id,
        label: k.label,
        secret,
        status: k.status as ProviderKeyStatus,
        weight: k.weight,
        cooldownUntil: k.cooldownUntil,
        failureCount: k.failureCount,
        successCount: k.successCount,
      });
      keysByProvider.set(k.providerId, list);
    }

    const resolvedProviders: ResolvedProvider[] = providerRows.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      type: p.type as ProviderType,
      baseUrl: p.baseUrl,
      isActive: p.isActive,
      rotationStrategy: p.rotationStrategy as RotationStrategy,
      maxRetries: p.maxRetries,
      timeoutMs: p.timeoutMs,
      config: p.config,
      keys: keysByProvider.get(p.id) ?? [],
    }));

    const resolvedRoutes: ResolvedRoute[] = routeRows.map((r) => ({
      id: r.id,
      pattern: r.pattern,
      primaryProviderId: r.primaryProviderId,
      fallbackProviderIds: r.fallbackProviderIds,
      cacheTtlSeconds: r.cacheTtlSeconds,
      isActive: r.isActive,
      priority: r.priority,
    }));

    const resolvedProxies: ResolvedProxy[] = proxyRows.map((p) => {
      let password: string | null = null;
      if (p.passwordEncrypted) {
        try {
          password = decryptSecret(p.passwordEncrypted);
        } catch {
          password = null;
        }
      }
      return {
        id: p.id,
        type: p.type as ProxyType,
        host: p.host,
        port: p.port,
        label: p.label,
        username: p.username,
        password,
      };
    });

    return {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      providers: resolvedProviders,
      routes: resolvedRoutes,
      proxies: resolvedProxies,
      loadedAt: new Date(),
    };
  }
}

/**
 * Cheap content fingerprint of a snapshot. We compare-by-value to decide
 * whether an 'update' event fires. NOT a cryptographic hash — just a delta
 * detector. Stable across runs because we sort by id.
 */
function hashSnapshot(snap: ConfigSnapshot): string {
  const parts: string[] = [];
  for (const p of [...snap.providers].sort((a, b) => a.id.localeCompare(b.id))) {
    parts.push(`${p.id}|${p.slug}|${p.type}|${p.baseUrl}|${p.maxRetries}`);
    for (const k of [...p.keys].sort((a, b) => a.id.localeCompare(b.id))) {
      parts.push(`  ${k.id}|${k.status}|${k.weight}`);
    }
  }
  for (const r of [...snap.routes].sort((a, b) => a.id.localeCompare(b.id))) {
    parts.push(`${r.id}|${r.pattern}|${r.primaryProviderId}`);
  }
  for (const p of [...snap.proxies].sort((a, b) => a.id.localeCompare(b.id))) {
    parts.push(`px:${p.id}|${p.type}|${p.host}:${p.port}`);
  }
  return parts.join("\n");
}
