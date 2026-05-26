import { ConfigRuntime } from "@ai-gateway/config-runtime";
import { getDb, schema } from "@ai-gateway/db";
import type {
  ProviderType,
  ProviderKeyStatus,
  RotationStrategy,
  ResolvedRoute,
} from "@ai-gateway/shared";
import { and, desc, eq, gte } from "drizzle-orm";
import { adminProcedure, memberProcedure, router } from "../trpc";
import { notifyConfigChange } from "../notifier";

const { usageLogs } = schema;

/** Public wire shape of the snapshot endpoint. Declared explicitly to keep
 *  tRPC's output type inference from bailing into `{}` — the underlying
 *  ConfigRuntime types are too deep for the inferrer to track. */
export interface SnapshotKeyView {
  id: string;
  label: string | null;
  status: ProviderKeyStatus;
  weight: number;
  cooldownUntil: Date | null;
  failureCount: number;
  successCount: number;
  secretPreview: string;
}

export interface SnapshotProviderView {
  id: string;
  slug: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  isActive: boolean;
  isDead: boolean;
  deadReason: string | null;
  deadSince: Date | null;
  rotationStrategy: RotationStrategy;
  keys: SnapshotKeyView[];
}

export interface SnapshotPayload {
  tenantId: string;
  tenantSlug: string;
  loadedAt: Date;
  deadProviderCount: number;
  providers: SnapshotProviderView[];
  routes: ResolvedRoute[];
}

function isProviderDeadError(errorMessage: string | null): boolean {
  if (!errorMessage) return false;
  return (
    errorMessage.includes("Third-party apps now draw from extra usage") ||
    errorMessage.includes("upstream_error")
  );
}

export const metaRouter = router({
  /** Returns the live snapshot the way the proxy sees it (decrypted secrets stripped). */
  snapshot: memberProcedure.query(async ({ ctx }): Promise<SnapshotPayload> => {
    const rt = new ConfigRuntime({ tenantSlug: ctx.admin.tenantSlug });
    const snap = await rt.load();
    const db = getDb();
    const since = new Date(Date.now() - 7 * 24 * 60 * 60_000);
    const recentRows = await db
      .select({
        providerId: usageLogs.providerId,
        status: usageLogs.status,
        errorMessage: usageLogs.errorMessage,
        metadata: usageLogs.metadata,
        createdAt: usageLogs.createdAt,
      })
      .from(usageLogs)
      .where(and(eq(usageLogs.tenantId, ctx.admin.tenantId), gte(usageLogs.createdAt, since)))
      .orderBy(desc(usageLogs.createdAt), desc(usageLogs.id))
      .limit(1000);
    const slugByProviderId = new Map(snap.providers.map((p) => [p.id, p.slug]));
    const loneAnthropicProvider = snap.providers.filter(
      (p) =>
        p.isActive &&
        (p.type === "anthropic" ||
          p.type === "anthropic_passthrough" ||
          p.type === "custom_anthropic"),
    );
    const latestByProviderSlug = new Map<
      string,
      { isDead: boolean; deadReason: string | null; deadSince: Date | null }
    >();
    for (const row of recentRows) {
      const providerSlug = row.providerId ? slugByProviderId.get(row.providerId) : undefined;
      if (providerSlug && !latestByProviderSlug.has(providerSlug)) {
        const isDead = row.status !== "success" && isProviderDeadError(row.errorMessage);
        latestByProviderSlug.set(providerSlug, {
          isDead,
          deadReason: isDead ? row.errorMessage : null,
          deadSince: isDead ? row.createdAt : null,
        });
      }
      const metadata = row.metadata as { deadProviders?: unknown } | null;
      const deadProviders = Array.isArray(metadata?.deadProviders)
        ? metadata.deadProviders.filter((p): p is string => typeof p === "string")
        : [];
      for (const slug of deadProviders) {
        if (latestByProviderSlug.has(slug)) continue;
        latestByProviderSlug.set(slug, {
          isDead: true,
          deadReason: row.errorMessage ?? "aig-auto marked this provider dead",
          deadSince: row.createdAt,
        });
      }
      if (
        !row.providerId &&
        deadProviders.length === 0 &&
        isProviderDeadError(row.errorMessage) &&
        loneAnthropicProvider.length === 1 &&
        !latestByProviderSlug.has(loneAnthropicProvider[0].slug)
      ) {
        latestByProviderSlug.set(loneAnthropicProvider[0].slug, {
          isDead: true,
          deadReason: row.errorMessage,
          deadSince: row.createdAt,
        });
      }
    }
    const deadProviderCount = snap.providers.filter(
      (p) => latestByProviderSlug.get(p.slug)?.isDead === true,
    ).length;
    return {
      tenantId: snap.tenantId,
      tenantSlug: snap.tenantSlug,
      loadedAt: snap.loadedAt,
      deadProviderCount,
      providers: snap.providers.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        type: p.type,
        baseUrl: p.baseUrl,
        isActive: p.isActive,
        isDead: latestByProviderSlug.get(p.slug)?.isDead ?? false,
        deadReason: latestByProviderSlug.get(p.slug)?.deadReason ?? null,
        deadSince: latestByProviderSlug.get(p.slug)?.deadSince ?? null,
        rotationStrategy: p.rotationStrategy,
        keys: p.keys.map((k) => ({
          id: k.id,
          label: k.label,
          status: k.status,
          weight: k.weight,
          cooldownUntil: k.cooldownUntil,
          failureCount: k.failureCount,
          successCount: k.successCount,
          secretPreview: `${k.secret.slice(0, 4)}…${k.secret.slice(-4)}`,
        })),
      })),
      routes: snap.routes,
    };
  }),

  /** Publishes a doorbell event to Redis without changing DB. */
  reload: adminProcedure.mutation(async ({ ctx }) => {
    await notifyConfigChange(
      `admin-reload/${ctx.admin.user.email} tenant=${ctx.admin.tenantSlug}`,
    );
    return { ok: true, publishedAt: new Date().toISOString() };
  }),
});
