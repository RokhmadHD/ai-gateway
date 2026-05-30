import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb, schema } from "@ai-gateway/db";
import { adminProcedure, memberProcedure, router } from "../trpc";
import { notifyConfigChange } from "../notifier";

const { providers } = schema;

const ProviderTypeEnum = z.enum([
  "openai",
  "anthropic",
  "anthropic_passthrough",
  "google",
  "deepseek",
  "openrouter",
  "custom_openai",
  "custom_anthropic",
  "kiro",
  "gemini",
]);

const RotationStrategyEnum = z.enum([
  "round_robin",
  "weighted",
  "least_used",
  "sticky",
  "random",
]);

const providerInput = z.object({
  slug: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  type: ProviderTypeEnum,
  baseUrl: z.string().url().or(z.literal("")).default(""),
  isActive: z.boolean().default(true),
  rotationStrategy: RotationStrategyEnum.default("round_robin"),
  maxRetries: z.number().int().min(1).max(20).default(3),
  timeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
  config: z.record(z.unknown()).default({}),
});

function withProviderDefaults(input: z.infer<typeof providerInput>) {
  const config = { ...input.config };
  if (input.type === "kiro" && typeof config.account_dir !== "string") {
    config.account_dir = process.env.KIRO_ACCOUNTS_DIR ?? "/var/kiro-accounts";
  }
  if (input.type === "gemini" && typeof config.account_dir !== "string") {
    config.account_dir = process.env.GEMINI_ACCOUNTS_DIR ?? "/var/gemini-accounts";
  }
  return { ...input, config };
}

export const providersRouter = router({
  list: memberProcedure.query(async ({ ctx }) => {
    const db = getDb();
    return db.query.providers.findMany({
      where: eq(providers.tenantId, ctx.admin.tenantId),
      orderBy: (p, { asc }) => [asc(p.slug)],
    });
  }),

  get: memberProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const row = await db.query.providers.findFirst({
        where: and(eq(providers.id, input.id), eq(providers.tenantId, ctx.admin.tenantId)),
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return row;
    }),

  create: adminProcedure
    .input(providerInput)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [row] = await db
        .insert(providers)
        .values({ ...withProviderDefaults(input), tenantId: ctx.admin.tenantId })
        .returning();
      await notifyConfigChange(`admin/${ctx.admin.user.email}`);
      return row;
    }),

  update: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        patch: providerInput.partial(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const patch = input.patch.type ? withProviderDefaults(input.patch as z.infer<typeof providerInput>) : input.patch;
      const [row] = await db
        .update(providers)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(providers.id, input.id), eq(providers.tenantId, ctx.admin.tenantId)))
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
        .delete(providers)
        .where(and(eq(providers.id, input.id), eq(providers.tenantId, ctx.admin.tenantId)))
        .returning();
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      await notifyConfigChange(`admin/${ctx.admin.user.email}`);
      return { ok: true, id: row.id };
    }),
});
