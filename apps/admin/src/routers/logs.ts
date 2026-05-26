import { z } from "zod";
import { and, desc, eq, gte, lt, or, ilike } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
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

const StatusFilter = z.enum(["all", "success", "error"]);

export const logsRouter = router({
  /** Paginated, filterable usage_logs list. */
  list: memberProcedure
    .input(
      z.object({
        window: z.enum(["1h", "24h", "7d", "all"]).default("24h"),
        status: StatusFilter.default("all"),
        endpoint: z.string().optional(),
        providerSlug: z.string().optional(),
        apiKeyId: z.string().uuid().optional(),
        search: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z
          .object({ createdAt: z.string(), id: z.string() })
          .optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const tenantId = ctx.admin.tenantId;
      const start = windowStart(input.window);

      const filters = [eq(usageLogs.tenantId, tenantId)];
      if (start) filters.push(gte(usageLogs.createdAt, start));
      if (input.status === "success") filters.push(eq(usageLogs.status, "success"));
      if (input.status === "error")
        filters.push(
          or(
            eq(usageLogs.status, "provider_error"),
            eq(usageLogs.status, "rate_limited"),
            eq(usageLogs.status, "client_error"),
            eq(usageLogs.status, "timeout"),
            eq(usageLogs.status, "blocked"),
          )!,
        );
      if (input.endpoint) filters.push(eq(usageLogs.endpoint, input.endpoint));
      if (input.apiKeyId) filters.push(eq(usageLogs.apiKeyId, input.apiKeyId));
      if (input.search)
        filters.push(
          or(
            ilike(usageLogs.requestId, `%${input.search}%`),
            ilike(usageLogs.modelName, `%${input.search}%`),
            ilike(usageLogs.errorMessage, `%${input.search}%`),
          )!,
        );

      // Cursor: rows older than the cursor (createdAt, id) tuple.
      if (input.cursor) {
        filters.push(lt(usageLogs.createdAt, new Date(input.cursor.createdAt)));
      }

      let where = and(...filters);

      // Optional providerSlug filter: resolve to providerId
      if (input.providerSlug) {
        const p = await db.query.providers.findFirst({
          where: and(
            eq(providers.tenantId, tenantId),
            eq(providers.slug, input.providerSlug),
          ),
        });
        if (!p) return { items: [], nextCursor: null };
        where = and(where!, eq(usageLogs.providerId, p.id));
      }

      const rows = await db
        .select({
          id: usageLogs.id,
          createdAt: usageLogs.createdAt,
          requestId: usageLogs.requestId,
          endpoint: usageLogs.endpoint,
          status: usageLogs.status,
          httpStatus: usageLogs.httpStatus,
          modelName: usageLogs.modelName,
          latencyMs: usageLogs.latencyMs,
          firstTokenLatencyMs: usageLogs.firstTokenLatencyMs,
          promptTokens: usageLogs.promptTokens,
          completionTokens: usageLogs.completionTokens,
          totalTokens: usageLogs.totalTokens,
          cachedTokens: usageLogs.cachedTokens,
          costUsd: usageLogs.costUsd,
          errorCode: usageLogs.errorCode,
          errorMessage: usageLogs.errorMessage,
          providerId: usageLogs.providerId,
          providerKeyId: usageLogs.providerKeyId,
          apiKeyId: usageLogs.apiKeyId,
          providerSlug: providers.slug,
          providerName: providers.name,
          keyLabel: providerKeys.label,
          apiKeyName: apiKeys.name,
          apiKeyPrefix: apiKeys.prefix,
        })
        .from(usageLogs)
        .leftJoin(providers, eq(usageLogs.providerId, providers.id))
        .leftJoin(providerKeys, eq(usageLogs.providerKeyId, providerKeys.id))
        .leftJoin(apiKeys, eq(usageLogs.apiKeyId, apiKeys.id))
        .where(where)
        .orderBy(desc(usageLogs.createdAt), desc(usageLogs.id))
        .limit(input.limit + 1);

      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      const last = items[items.length - 1];
      const nextCursor =
        hasMore && last
          ? { createdAt: last.createdAt.toISOString(), id: last.id }
          : null;

      return { items, nextCursor };
    }),

  /** Single log row with full detail (incl. metadata jsonb, client info). */
  get: memberProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const tenantId = ctx.admin.tenantId;

      const [row] = await db
        .select({
          id: usageLogs.id,
          createdAt: usageLogs.createdAt,
          requestId: usageLogs.requestId,
          endpoint: usageLogs.endpoint,
          status: usageLogs.status,
          httpStatus: usageLogs.httpStatus,
          modelName: usageLogs.modelName,
          latencyMs: usageLogs.latencyMs,
          firstTokenLatencyMs: usageLogs.firstTokenLatencyMs,
          promptTokens: usageLogs.promptTokens,
          completionTokens: usageLogs.completionTokens,
          totalTokens: usageLogs.totalTokens,
          cachedTokens: usageLogs.cachedTokens,
          costUsd: usageLogs.costUsd,
          errorCode: usageLogs.errorCode,
          errorMessage: usageLogs.errorMessage,
          clientIp: usageLogs.clientIp,
          userAgent: usageLogs.userAgent,
          metadata: usageLogs.metadata,
          requestBody: usageLogs.requestBody,
          responseBody: usageLogs.responseBody,
          providerId: usageLogs.providerId,
          providerKeyId: usageLogs.providerKeyId,
          apiKeyId: usageLogs.apiKeyId,
          providerSlug: providers.slug,
          providerName: providers.name,
          keyLabel: providerKeys.label,
          keyFingerprint: providerKeys.keyFingerprint,
          apiKeyName: apiKeys.name,
          apiKeyPrefix: apiKeys.prefix,
        })
        .from(usageLogs)
        .leftJoin(providers, eq(usageLogs.providerId, providers.id))
        .leftJoin(providerKeys, eq(usageLogs.providerKeyId, providerKeys.id))
        .leftJoin(apiKeys, eq(usageLogs.apiKeyId, apiKeys.id))
        .where(and(eq(usageLogs.tenantId, tenantId), eq(usageLogs.id, input.id)))
        .limit(1);

      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "log not found" });
      }
      return row;
    }),

  /** Distinct endpoint values for filter dropdown. */
  endpoints: memberProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const tenantId = ctx.admin.tenantId;
    const rows = await db
      .selectDistinct({ endpoint: usageLogs.endpoint })
      .from(usageLogs)
      .where(eq(usageLogs.tenantId, tenantId));
    return rows.map((r) => r.endpoint).sort();
  }),
});
