import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb, schema } from "@ai-gateway/db";
import { adminProcedure, memberProcedure, router } from "../trpc";
import { notifyConfigChange } from "../notifier";
import { getScraperStatus, runScrape, stopScrape } from "../services/scraperJob";
import pino from "pino";

const scraperLog = pino({ name: "scraper", level: process.env.LOG_LEVEL ?? "info" });

const { proxies } = schema;

const ProxyTypeEnum = z.enum(["http", "https", "socks4", "socks5"]);
const ProxySourceEnum = z.enum(["manual", "scraper"]);
const ProxyStatusEnum = z.enum(["unchecked", "alive", "dead"]);

const proxyInput = z.object({
  label: z.string().max(128).optional().nullable(),
  type: ProxyTypeEnum,
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(128).optional().nullable(),
  passwordEncrypted: z.string().max(512).optional().nullable(),
  source: ProxySourceEnum.default("manual"),
  isActive: z.boolean().default(true),
});

export const proxiesRouter = router({
  list: memberProcedure
    .input(
      z
        .object({
          status: ProxyStatusEnum.optional(),
          source: ProxySourceEnum.optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const rows = await db.query.proxies.findMany({
        where: and(
          eq(proxies.tenantId, ctx.admin.tenantId),
          input?.status ? eq(proxies.status, input.status) : undefined,
          input?.source ? eq(proxies.source, input.source) : undefined,
        ),
        orderBy: (p, { desc }) => [desc(p.createdAt)],
      });
      return rows;
    }),

  get: memberProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const row = await db.query.proxies.findFirst({
        where: and(eq(proxies.id, input.id), eq(proxies.tenantId, ctx.admin.tenantId)),
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return row;
    }),

  create: adminProcedure.input(proxyInput).mutation(async ({ ctx, input }) => {
    const db = getDb();
    const [row] = await db
      .insert(proxies)
      .values({ ...input, tenantId: ctx.admin.tenantId })
      .returning();
    await notifyConfigChange(`admin/${ctx.admin.user.email}`);
    return row;
  }),

  update: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        patch: proxyInput.partial(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [row] = await db
        .update(proxies)
        .set({ ...input.patch, updatedAt: new Date() })
        .where(and(eq(proxies.id, input.id), eq(proxies.tenantId, ctx.admin.tenantId)))
        .returning();
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      await notifyConfigChange(`admin/${ctx.admin.user.email}`);
      return row;
    }),

  setActive: adminProcedure
    .input(z.object({ id: z.string().uuid(), isActive: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [row] = await db
        .update(proxies)
        .set({ isActive: input.isActive, updatedAt: new Date() })
        .where(and(eq(proxies.id, input.id), eq(proxies.tenantId, ctx.admin.tenantId)))
        .returning();
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      await notifyConfigChange(`admin/${ctx.admin.user.email}`);
      return row;
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [row] = await db
        .delete(proxies)
        .where(and(eq(proxies.id, input.id), eq(proxies.tenantId, ctx.admin.tenantId)))
        .returning();
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      await notifyConfigChange(`admin/${ctx.admin.user.email}`);
      return { ok: true, id: row.id };
    }),

  deleteMany: adminProcedure
    .input(z.object({ ids: z.array(z.string().uuid()).min(1).max(50_000) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const rows = await db
        .delete(proxies)
        .where(and(eq(proxies.tenantId, ctx.admin.tenantId), inArray(proxies.id, input.ids)))
        .returning({ id: proxies.id });
      if (rows.length > 0) {
        await notifyConfigChange(`admin/${ctx.admin.user.email}`);
      }
      return { ok: true, deleted: rows.length, ids: rows.map((r) => r.id) };
    }),

  stats: memberProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db.query.proxies.findMany({
      where: eq(proxies.tenantId, ctx.admin.tenantId),
      columns: { status: true, isActive: true, source: true },
    });
    return {
      total: rows.length,
      alive: rows.filter((r) => r.status === "alive").length,
      dead: rows.filter((r) => r.status === "dead").length,
      unchecked: rows.filter((r) => r.status === "unchecked").length,
      active: rows.filter((r) => r.isActive).length,
      manual: rows.filter((r) => r.source === "manual").length,
      scraper: rows.filter((r) => r.source === "scraper").length,
    };
  }),

  scrapeStatus: memberProcedure.query(() => getScraperStatus()),

  scrapeStop: adminProcedure.mutation(() => ({ stopped: stopScrape() })),

  scrapeNow: adminProcedure
    .input(
      z
        .object({
          types: z.string().optional(),
          concurrency: z.number().int().min(1).max(2000).optional(),
        })
        .optional(),
    )
    .mutation(({ ctx, input }) => {
      // Fire and forget — bin runs for minutes. UI polls scrapeStatus.
      void runScrape(scraperLog, {
        tenantId: ctx.admin.tenantId,
        types: input?.types,
        concurrency: input?.concurrency,
      }).catch((e) => scraperLog.error({ err: String(e) }, "scrapeNow failed"));
      return { ok: true };
    }),
});
