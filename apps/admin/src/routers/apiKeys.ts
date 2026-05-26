import { z } from "zod";
import { and, eq, desc } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { getDb, schema } from "@ai-gateway/db";
import { adminProcedure, memberProcedure, router } from "../trpc";

const { apiKeys } = schema;

// Token layout: `ap_<32 base32 chars>` → 160 bits of entropy.
// Stored hash is sha256(token); middleware does O(1) lookup on the hash.
const TOKEN_PREFIX = "ap_";
const TOKEN_BODY_LEN = 32;

function generateToken(): { token: string; prefix: string; hash: string } {
  const body = randomBytes(20).toString("base64url").slice(0, TOKEN_BODY_LEN);
  const token = `${TOKEN_PREFIX}${body}`;
  const hash = createHash("sha256").update(token).digest("hex");
  const prefix = body.slice(0, 8);
  return { token, prefix, hash };
}

const safeColumns = {
  id: apiKeys.id,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  status: apiKeys.status,
  lastUsedAt: apiKeys.lastUsedAt,
  revokedAt: apiKeys.revokedAt,
  createdAt: apiKeys.createdAt,
};

export const apiKeysRouter = router({
  list: memberProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db
      .select(safeColumns)
      .from(apiKeys)
      .where(eq(apiKeys.tenantId, ctx.admin.tenantId))
      .orderBy(desc(apiKeys.createdAt));
    return rows;
  }),

  create: adminProcedure
    .input(z.object({ name: z.string().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const { token, prefix, hash } = generateToken();
      const [row] = await db
        .insert(apiKeys)
        .values({
          tenantId: ctx.admin.tenantId,
          createdByUserId: ctx.admin.isLegacyAdmin ? null : ctx.admin.user.id,
          name: input.name,
          prefix,
          keyHash: hash,
        })
        .returning(safeColumns);
      // Plaintext returned ONCE; client must store/copy now.
      return { ...row, token };
    }),

  revoke: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [row] = await db
        .update(apiKeys)
        .set({
          status: "revoked",
          revokedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(apiKeys.id, input.id), eq(apiKeys.tenantId, ctx.admin.tenantId)))
        .returning(safeColumns);
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return row;
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [row] = await db
        .delete(apiKeys)
        .where(and(eq(apiKeys.id, input.id), eq(apiKeys.tenantId, ctx.admin.tenantId)))
        .returning({ id: apiKeys.id });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return { ok: true, id: row.id };
    }),
});
