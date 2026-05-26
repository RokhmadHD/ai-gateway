import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb, schema } from "@ai-gateway/db";
import { protectedProcedure, router } from "../trpc";

/**
 * Caller-scoped read endpoints (session, memberships, tenant switch).
 *
 * Lives on the same admin tRPC router so the dashboard only needs one client.
 * Authentication itself runs over Better Auth's `/api/auth/*` REST endpoints.
 */
export const meRouter = router({
  /** Active session view used by the dashboard layout / topbar. */
  whoami: protectedProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const memberships = await db
      .select({
        id: schema.memberships.id,
        tenantId: schema.memberships.tenantId,
        tenantSlug: schema.tenants.slug,
        tenantName: schema.tenants.name,
        role: schema.memberships.role,
      })
      .from(schema.memberships)
      .innerJoin(schema.tenants, eq(schema.memberships.tenantId, schema.tenants.id))
      .where(eq(schema.memberships.userId, ctx.admin.user.id));

    return {
      user: ctx.admin.user,
      activeTenant: {
        id: ctx.admin.tenantId,
        slug: ctx.admin.tenantSlug,
        role: ctx.admin.role,
      },
      memberships,
      isLegacyAdmin: ctx.admin.isLegacyAdmin,
    };
  }),

  /** Switch the active tenant for this session. Only works for tenants the
   *  caller is a member of. The new `active_tenant_id` is stamped on the
   *  better-auth session row so subsequent requests pick it up. */
  switchTenant: protectedProcedure
    .input(z.object({ tenantId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const membership = await db.query.memberships.findFirst({
        where: and(
          eq(schema.memberships.userId, ctx.admin.user.id),
          eq(schema.memberships.tenantId, input.tenantId),
        ),
      });
      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "not a member of that tenant",
        });
      }
      if (ctx.admin.isLegacyAdmin) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "legacy ADMIN_TOKEN session cannot switch tenants",
        });
      }
      await db
        .update(schema.sessions)
        .set({ activeTenantId: input.tenantId, updatedAt: new Date() })
        .where(eq(schema.sessions.id, ctx.admin.session.id));
      return { ok: true, tenantId: input.tenantId };
    }),
});
