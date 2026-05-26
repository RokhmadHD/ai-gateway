import { initTRPC, TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@ai-gateway/db";
import type { CreateContextOptions } from "./context";
import { auth } from "./auth";

type UserRole = (typeof schema.userRoleEnum.enumValues)[number];

const ROLE_RANK: Record<UserRole, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

export interface AdminContext {
  user: {
    id: string;
    email: string;
    name: string | null;
  };
  session: { id: string };
  tenantId: string;
  tenantSlug: string;
  role: UserRole;
  // Legacy ADMIN_TOKEN fallback marks the request as platform super-admin
  // bound to the default tenant. Phased out once everyone has signed up.
  isLegacyAdmin: boolean;
}

const t = initTRPC.context<typeof createContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;

function requireRole(minimum: UserRole) {
  return middleware(({ ctx, next }) => {
    if (!ctx.admin) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "not signed in" });
    }
    if (ROLE_RANK[ctx.admin.role] < ROLE_RANK[minimum]) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `role ${ctx.admin.role} insufficient (need ${minimum}+)`,
      });
    }
    return next({ ctx: { ...ctx, admin: ctx.admin } });
  });
}

export const protectedProcedure = t.procedure.use(requireRole("viewer"));
export const memberProcedure = t.procedure.use(requireRole("member"));
export const adminProcedure = t.procedure.use(requireRole("admin"));
export const ownerProcedure = t.procedure.use(requireRole("owner"));

// Legacy: keep `adminProcedure` symbol referenced by old routers — the new
// tier ladder above defines it. (Pre-S6 it gated on ADMIN_TOKEN; now on RBAC.)

async function loadAdminFromSession(headers: Headers): Promise<AdminContext | null> {
  const result = await auth.api.getSession({ headers });
  if (!result?.session || !result.user) return null;
  const db = getDb();
  const sess = result.session as { id: string; activeTenantId?: string | null };

  // Pick the active tenant: prefer the one stored on the session, else first
  // membership. New users always have at least one (personal tenant created
  // in databaseHooks.user.create.after).
  let membership: { tenantId: string; role: UserRole; tenantSlug: string } | null = null;
  if (sess.activeTenantId) {
    const row = await db
      .select({
        tenantId: schema.memberships.tenantId,
        role: schema.memberships.role,
        tenantSlug: schema.tenants.slug,
      })
      .from(schema.memberships)
      .innerJoin(schema.tenants, eq(schema.memberships.tenantId, schema.tenants.id))
      .where(
        and(
          eq(schema.memberships.userId, result.user.id),
          eq(schema.memberships.tenantId, sess.activeTenantId),
        ),
      )
      .limit(1);
    membership = row[0] ?? null;
  }
  if (!membership) {
    const row = await db
      .select({
        tenantId: schema.memberships.tenantId,
        role: schema.memberships.role,
        tenantSlug: schema.tenants.slug,
      })
      .from(schema.memberships)
      .innerJoin(schema.tenants, eq(schema.memberships.tenantId, schema.tenants.id))
      .where(eq(schema.memberships.userId, result.user.id))
      .limit(1);
    membership = row[0] ?? null;
  }
  if (!membership) return null;
  return {
    user: {
      id: result.user.id,
      email: result.user.email,
      name: result.user.name ?? null,
    },
    session: { id: sess.id },
    tenantId: membership.tenantId,
    tenantSlug: membership.tenantSlug,
    role: membership.role,
    isLegacyAdmin: false,
  };
}

async function loadLegacyAdmin(headers: Headers): Promise<AdminContext | null> {
  if (process.env.LEGACY_ADMIN_TOKEN_FALLBACK !== "1") return null;
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return null;
  const auth = headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (token !== expected) return null;
  const db = getDb();
  const row = await db
    .select({ id: schema.tenants.id, slug: schema.tenants.slug })
    .from(schema.tenants)
    .where(eq(schema.tenants.slug, process.env.TENANT_SLUG ?? "default"))
    .limit(1);
  const tenant = row[0];
  if (!tenant) return null;
  return {
    user: { id: "00000000-0000-0000-0000-000000000000", email: "legacy@admin", name: "Legacy ADMIN_TOKEN" },
    session: { id: "legacy" },
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    role: "owner",
    isLegacyAdmin: true,
  };
}

export async function createContext(opts: CreateContextOptions) {
  const headers = opts.req.headers;
  const admin = (await loadAdminFromSession(headers)) ?? (await loadLegacyAdmin(headers));
  return { admin };
}
