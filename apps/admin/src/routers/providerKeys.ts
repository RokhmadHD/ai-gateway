import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { getDb, schema } from "@ai-gateway/db";
import { encryptSecret } from "@ai-gateway/shared";
import { adminProcedure, memberProcedure, router } from "../trpc";
import { notifyConfigChange } from "../notifier";

const { providerKeys, providers } = schema;

const ProviderKeyStatusEnum = z.enum([
  "active",
  "disabled",
  "cooldown",
  "exhausted",
  "revoked",
]);

const keyInput = z.object({
  providerId: z.string().uuid(),
  label: z.string().min(1).max(128).optional(),
  secret: z.string().min(1).max(2048),
  weight: z.number().int().min(0).max(1000).default(1),
  status: ProviderKeyStatusEnum.default("active"),
  rpmLimit: z.number().int().min(0).optional(),
  tpmLimit: z.number().int().min(0).optional(),
});

function fingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 32);
}

async function assertProviderInTenant(providerId: string, tenantId: string) {
  const db = getDb();
  const row = await db.query.providers.findFirst({
    where: and(eq(providers.id, providerId), eq(providers.tenantId, tenantId)),
  });
  if (!row) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "providerId does not belong to tenant",
    });
  }
}

const safeColumns = {
  id: providerKeys.id,
  providerId: providerKeys.providerId,
  label: providerKeys.label,
  keyFingerprint: providerKeys.keyFingerprint,
  status: providerKeys.status,
  weight: providerKeys.weight,
  cooldownUntil: providerKeys.cooldownUntil,
  lastUsedAt: providerKeys.lastUsedAt,
  failureCount: providerKeys.failureCount,
  successCount: providerKeys.successCount,
  createdAt: providerKeys.createdAt,
  updatedAt: providerKeys.updatedAt,
} as const;

export const providerKeysRouter = router({
  list: memberProcedure
    .input(z.object({ providerId: z.string().uuid().optional() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      if (input.providerId) {
        await assertProviderInTenant(input.providerId, ctx.admin.tenantId);
        const rows = await db
          .select(safeColumns)
          .from(providerKeys)
          .where(eq(providerKeys.providerId, input.providerId));
        return rows;
      }
      // No providerId: only keys whose provider belongs to this tenant.
      const rows = await db
        .select(safeColumns)
        .from(providerKeys)
        .innerJoin(providers, eq(providerKeys.providerId, providers.id))
        .where(eq(providers.tenantId, ctx.admin.tenantId));
      return rows;
    }),

  create: adminProcedure.input(keyInput).mutation(async ({ ctx, input }) => {
    const db = getDb();
    await assertProviderInTenant(input.providerId, ctx.admin.tenantId);
    const fp = fingerprint(input.secret);
    const [row] = await db
      .insert(providerKeys)
      .values({
        providerId: input.providerId,
        label: input.label,
        keyEncrypted: encryptSecret(input.secret),
        keyFingerprint: fp,
        status: input.status,
        weight: input.weight,
        rpmLimit: input.rpmLimit,
        tpmLimit: input.tpmLimit,
      })
      .returning(safeColumns);
    await notifyConfigChange(`admin/${ctx.admin.user.email}`);
    return row;
  }),

  setStatus: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        status: ProviderKeyStatusEnum,
        clearCooldown: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const key = await db.query.providerKeys.findFirst({
        where: eq(providerKeys.id, input.id),
      });
      if (!key) throw new TRPCError({ code: "NOT_FOUND" });
      await assertProviderInTenant(key.providerId, ctx.admin.tenantId);

      const patch: Record<string, unknown> = {
        status: input.status,
        updatedAt: new Date(),
      };
      if (input.clearCooldown) patch.cooldownUntil = null;

      const [row] = await db
        .update(providerKeys)
        .set(patch)
        .where(eq(providerKeys.id, input.id))
        .returning(safeColumns);
      await notifyConfigChange(`admin/${ctx.admin.user.email}`);
      return row;
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const key = await db.query.providerKeys.findFirst({
        where: eq(providerKeys.id, input.id),
      });
      if (!key) throw new TRPCError({ code: "NOT_FOUND" });
      await assertProviderInTenant(key.providerId, ctx.admin.tenantId);

      const [row] = await db
        .delete(providerKeys)
        .where(eq(providerKeys.id, input.id))
        .returning(safeColumns);
      await notifyConfigChange(`admin/${ctx.admin.user.email}`);
      return { ok: true, id: row.id };
    }),
});
