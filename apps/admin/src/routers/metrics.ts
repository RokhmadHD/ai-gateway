import { z } from "zod";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@ai-gateway/db";
import { memberProcedure, router } from "../trpc";

const { usageLogs, apiKeys, providers, providerKeys } = schema;

function windowStart(window: "1h" | "24h" | "7d" | "all"): Date | null {
  const now = Date.now();
  switch (window) {
    case "1h":
      return new Date(now - 60 * 60_000);
    case "24h":
      return new Date(now - 24 * 60 * 60_000);
    case "7d":
      return new Date(now - 7 * 24 * 60 * 60_000);
    case "all":
      return null;
  }
}

const windowInput = z.object({
  window: z.enum(["1h", "24h", "7d", "all"]).default("24h"),
});

export const metricsRouter = router({
  /** KPI totals for one window (requests, tokens, errors, p50/p95 latency). */
  summary: memberProcedure.input(windowInput).query(async ({ ctx, input }) => {
    const db = getDb();
    const tenantId = ctx.admin.tenantId;
    const start = windowStart(input.window);
    const where = start
      ? and(eq(usageLogs.tenantId, tenantId), gte(usageLogs.createdAt, start))
      : eq(usageLogs.tenantId, tenantId);

    const [row] = await db
      .select({
        requests: sql<number>`count(*)::int`,
        successes: sql<number>`count(*) filter (where ${usageLogs.status} = 'success')::int`,
        errors: sql<number>`count(*) filter (where ${usageLogs.status} <> 'success')::int`,
        promptTokens: sql<number>`coalesce(sum(${usageLogs.promptTokens}), 0)::bigint`,
        completionTokens: sql<number>`coalesce(sum(${usageLogs.completionTokens}), 0)::bigint`,
        totalTokens: sql<number>`coalesce(sum(${usageLogs.totalTokens}), 0)::bigint`,
        cachedTokens: sql<number>`coalesce(sum(${usageLogs.cachedTokens}), 0)::bigint`,
        avgLatencyMs: sql<number>`coalesce(avg(${usageLogs.latencyMs}), 0)::int`,
        p95LatencyMs: sql<number>`coalesce(percentile_disc(0.95) within group (order by ${usageLogs.latencyMs}), 0)::int`,
      })
      .from(usageLogs)
      .where(where);

    return {
      window: input.window,
      requests: Number(row?.requests ?? 0),
      successes: Number(row?.successes ?? 0),
      errors: Number(row?.errors ?? 0),
      promptTokens: Number(row?.promptTokens ?? 0),
      completionTokens: Number(row?.completionTokens ?? 0),
      totalTokens: Number(row?.totalTokens ?? 0),
      cachedTokens: Number(row?.cachedTokens ?? 0),
      avgLatencyMs: Number(row?.avgLatencyMs ?? 0),
      p95LatencyMs: Number(row?.p95LatencyMs ?? 0),
    };
  }),

  /** Per-API-key breakdown. */
  byApiKey: memberProcedure.input(windowInput).query(async ({ ctx, input }) => {
    const db = getDb();
    const tenantId = ctx.admin.tenantId;
    const start = windowStart(input.window);
    const where = start
      ? and(eq(usageLogs.tenantId, tenantId), gte(usageLogs.createdAt, start))
      : eq(usageLogs.tenantId, tenantId);

    const rows = await db
      .select({
        apiKeyId: usageLogs.apiKeyId,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        requests: sql<number>`count(*)::int`,
        successes: sql<number>`count(*) filter (where ${usageLogs.status} = 'success')::int`,
        totalTokens: sql<number>`coalesce(sum(${usageLogs.totalTokens}), 0)::bigint`,
        promptTokens: sql<number>`coalesce(sum(${usageLogs.promptTokens}), 0)::bigint`,
        completionTokens: sql<number>`coalesce(sum(${usageLogs.completionTokens}), 0)::bigint`,
        lastUsedAt: sql<Date | null>`max(${usageLogs.createdAt})`,
      })
      .from(usageLogs)
      .leftJoin(apiKeys, eq(usageLogs.apiKeyId, apiKeys.id))
      .where(where)
      .groupBy(usageLogs.apiKeyId, apiKeys.name, apiKeys.prefix)
      .orderBy(desc(sql`count(*)`));

    return rows.map((r) => ({
      apiKeyId: r.apiKeyId,
      name: r.name ?? "(deleted)",
      prefix: r.prefix,
      requests: Number(r.requests),
      successes: Number(r.successes),
      promptTokens: Number(r.promptTokens),
      completionTokens: Number(r.completionTokens),
      totalTokens: Number(r.totalTokens),
      lastUsedAt: r.lastUsedAt,
    }));
  }),

  /** Per-provider-key breakdown. */
  byProviderKey: memberProcedure.input(windowInput).query(async ({ ctx, input }) => {
    const db = getDb();
    const tenantId = ctx.admin.tenantId;
    const start = windowStart(input.window);
    const where = start
      ? and(eq(usageLogs.tenantId, tenantId), gte(usageLogs.createdAt, start))
      : eq(usageLogs.tenantId, tenantId);

    const rows = await db
      .select({
        providerKeyId: usageLogs.providerKeyId,
        providerId: usageLogs.providerId,
        providerName: providers.name,
        keyLabel: providerKeys.label,
        requests: sql<number>`count(*)::int`,
        successes: sql<number>`count(*) filter (where ${usageLogs.status} = 'success')::int`,
        totalTokens: sql<number>`coalesce(sum(${usageLogs.totalTokens}), 0)::bigint`,
      })
      .from(usageLogs)
      .leftJoin(providers, eq(usageLogs.providerId, providers.id))
      .leftJoin(providerKeys, eq(usageLogs.providerKeyId, providerKeys.id))
      .where(where)
      .groupBy(usageLogs.providerKeyId, usageLogs.providerId, providers.name, providerKeys.label)
      .orderBy(desc(sql`count(*)`));

    return rows.map((r) => ({
      providerKeyId: r.providerKeyId,
      providerId: r.providerId,
      providerName: r.providerName ?? "(unknown)",
      keyLabel: r.keyLabel ?? "(unlabeled)",
      requests: Number(r.requests),
      successes: Number(r.successes),
      totalTokens: Number(r.totalTokens),
    }));
  }),

  /** Hourly time-series for charts (last N hours). */
  timeSeries: memberProcedure
    .input(z.object({ window: z.enum(["24h", "7d"]).default("24h") }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const tenantId = ctx.admin.tenantId;
      const bucket = input.window === "24h" ? "hour" : "day";
      const start = windowStart(input.window);

      const rows = await db
        .select({
          bucket: sql<Date>`date_trunc(${bucket}, ${usageLogs.createdAt})`,
          requests: sql<number>`count(*)::int`,
          totalTokens: sql<number>`coalesce(sum(${usageLogs.totalTokens}), 0)::bigint`,
          errors: sql<number>`count(*) filter (where ${usageLogs.status} <> 'success')::int`,
        })
        .from(usageLogs)
        .where(and(eq(usageLogs.tenantId, tenantId), gte(usageLogs.createdAt, start!)))
        .groupBy(sql`date_trunc(${bucket}, ${usageLogs.createdAt})`)
        .orderBy(sql`date_trunc(${bucket}, ${usageLogs.createdAt})`);

      return {
        bucket,
        points: rows.map((r) => ({
          t: r.bucket,
          requests: Number(r.requests),
          totalTokens: Number(r.totalTokens),
          errors: Number(r.errors),
        })),
      };
    }),
});
