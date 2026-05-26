import { z } from "zod";
import { and, desc, eq, gte } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { getDb, schema } from "@ai-gateway/db";
import { adminProcedure, ownerProcedure, protectedProcedure, router } from "../trpc";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const roleInput = z.enum(["admin", "member", "viewer"]);

function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export const invitationsRouter = router({
  /** List pending invites for the active tenant (admin+). */
  list: adminProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db
      .select({
        id: schema.invitations.id,
        email: schema.invitations.email,
        role: schema.invitations.role,
        expiresAt: schema.invitations.expiresAt,
        createdAt: schema.invitations.createdAt,
        invitedByUserId: schema.invitations.invitedByUserId,
      })
      .from(schema.invitations)
      .where(
        and(
          eq(schema.invitations.tenantId, ctx.admin.tenantId),
          gte(schema.invitations.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(schema.invitations.createdAt));
    return rows;
  }),

  /** Create an invite. Returns the token to embed in /accept-invite link. */
  create: adminProcedure
    .input(
      z.object({
        email: z.string().email().toLowerCase(),
        role: roleInput.default("member"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const token = newToken();
      const [row] = await db
        .insert(schema.invitations)
        .values({
          tenantId: ctx.admin.tenantId,
          email: input.email,
          role: input.role,
          token,
          invitedByUserId: ctx.admin.isLegacyAdmin ? null : ctx.admin.user.id,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        })
        .returning({
          id: schema.invitations.id,
          email: schema.invitations.email,
          role: schema.invitations.role,
          expiresAt: schema.invitations.expiresAt,
        });
      return { ...row, token };
    }),

  revoke: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [row] = await db
        .delete(schema.invitations)
        .where(
          and(
            eq(schema.invitations.id, input.id),
            eq(schema.invitations.tenantId, ctx.admin.tenantId),
          ),
        )
        .returning({ id: schema.invitations.id });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return { ok: true, id: row.id };
    }),

  /** Caller (must be logged in) accepts an invite token. Joins them to the
   *  tenant. Idempotent: if membership already exists, just deletes the
   *  invite and returns ok. */
  accept: protectedProcedure
    .input(z.object({ token: z.string().min(8) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const invite = await db.query.invitations.findFirst({
        where: eq(schema.invitations.token, input.token),
      });
      if (!invite) {
        throw new TRPCError({ code: "NOT_FOUND", message: "invite invalid or expired" });
      }
      if (invite.expiresAt.getTime() < Date.now()) {
        await db.delete(schema.invitations).where(eq(schema.invitations.id, invite.id));
        throw new TRPCError({ code: "FORBIDDEN", message: "invite expired" });
      }
      // Idempotent join. Skip insert if already a member.
      const existing = await db.query.memberships.findFirst({
        where: and(
          eq(schema.memberships.userId, ctx.admin.user.id),
          eq(schema.memberships.tenantId, invite.tenantId),
        ),
      });
      if (!existing) {
        await db.insert(schema.memberships).values({
          userId: ctx.admin.user.id,
          tenantId: invite.tenantId,
          role: invite.role,
        });
      }
      await db.delete(schema.invitations).where(eq(schema.invitations.id, invite.id));
      const tenant = await db.query.tenants.findFirst({
        where: eq(schema.tenants.id, invite.tenantId),
      });
      return { ok: true, tenantId: invite.tenantId, tenantSlug: tenant?.slug ?? null };
    }),

  /** List members of the active tenant. */
  members: adminProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db
      .select({
        userId: schema.memberships.userId,
        membershipId: schema.memberships.id,
        role: schema.memberships.role,
        email: schema.users.email,
        name: schema.users.name,
        image: schema.users.image,
        createdAt: schema.memberships.createdAt,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.memberships.userId, schema.users.id))
      .where(eq(schema.memberships.tenantId, ctx.admin.tenantId))
      .orderBy(desc(schema.memberships.createdAt));
    return rows;
  }),

  /** Owner-only: change a member's role. Cannot demote the last owner. */
  setMemberRole: ownerProcedure
    .input(
      z.object({
        membershipId: z.string().uuid(),
        role: z.enum(["owner", "admin", "member", "viewer"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const membership = await db.query.memberships.findFirst({
        where: and(
          eq(schema.memberships.id, input.membershipId),
          eq(schema.memberships.tenantId, ctx.admin.tenantId),
        ),
      });
      if (!membership) throw new TRPCError({ code: "NOT_FOUND" });
      if (membership.role === "owner" && input.role !== "owner") {
        // Ensure at least one owner remains.
        const owners = await db
          .select({ id: schema.memberships.id })
          .from(schema.memberships)
          .where(
            and(
              eq(schema.memberships.tenantId, ctx.admin.tenantId),
              eq(schema.memberships.role, "owner"),
            ),
          );
        if (owners.length <= 1) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "cannot demote the last owner",
          });
        }
      }
      const [row] = await db
        .update(schema.memberships)
        .set({ role: input.role, updatedAt: new Date() })
        .where(eq(schema.memberships.id, input.membershipId))
        .returning({ id: schema.memberships.id, role: schema.memberships.role });
      return row;
    }),

  /** Owner-only: remove a member. Cannot remove the last owner. */
  removeMember: ownerProcedure
    .input(z.object({ membershipId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const membership = await db.query.memberships.findFirst({
        where: and(
          eq(schema.memberships.id, input.membershipId),
          eq(schema.memberships.tenantId, ctx.admin.tenantId),
        ),
      });
      if (!membership) throw new TRPCError({ code: "NOT_FOUND" });
      if (membership.role === "owner") {
        const owners = await db
          .select({ id: schema.memberships.id })
          .from(schema.memberships)
          .where(
            and(
              eq(schema.memberships.tenantId, ctx.admin.tenantId),
              eq(schema.memberships.role, "owner"),
            ),
          );
        if (owners.length <= 1) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "cannot remove the last owner",
          });
        }
      }
      await db.delete(schema.memberships).where(eq(schema.memberships.id, input.membershipId));
      return { ok: true };
    }),
});
