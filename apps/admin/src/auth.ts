import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { getDb, schema } from "@ai-gateway/db";
import { eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";

const db = getDb();

function randomSlugSuffix(): string {
  return randomBytes(3).toString("hex");
}

function slugifyEmail(email: string): string {
  const local = email.split("@")[0] ?? "user";
  return local.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "user";
}

async function makeUniqueSlug(base: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const candidate = i === 0 ? base : `${base}-${randomSlugSuffix()}`;
    const existing = await db
      .select({ id: schema.tenants.id })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, candidate))
      .limit(1);
    if (existing.length === 0) return candidate;
  }
  return `${base}-${randomBytes(6).toString("hex")}`;
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    usePlural: true,
    schema: {
      users: schema.users,
      sessions: schema.sessions,
      accounts: schema.accounts,
      verifications: schema.verifications,
    },
  }),
  // Our tables use uuid PKs; better-auth's default 32-char id format won't
  // parse as uuid. Generate one explicitly.
  advanced: {
    database: {
      generateId: () => randomUUID(),
    },
  },
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:7780",
  secret: process.env.BETTER_AUTH_SECRET || "dev-better-auth-secret-change-me",
  trustedOrigins: process.env.CORS_ORIGIN?.split(",").map((s) => s.trim()).filter(Boolean) ?? [
    "http://localhost:7790",
    "http://127.0.0.1:7790",
    "http://localhost:3000",
  ],
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    minPasswordLength: 8,
  },
  socialProviders: {
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          },
        }
      : {}),
    ...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
      ? {
          github: {
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
          },
        }
      : {}),
  },
  session: {
    additionalFields: {
      activeTenantId: { type: "string", required: false, input: false },
    },
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  databaseHooks: {
    user: {
      create: {
        // After a new user row is inserted, auto-create a personal tenant and
        // owner membership. Invite flow attaches to existing tenants instead
        // (handled in the invitations router), so first-time signups get a
        // home org and don't see an empty dashboard.
        after: async (user) => {
          const baseSlug = slugifyEmail(user.email);
          const slug = await makeUniqueSlug(baseSlug);
          const name = user.name?.trim() || `${baseSlug}'s workspace`;
          const [tenant] = await db
            .insert(schema.tenants)
            .values({ slug, name })
            .returning({ id: schema.tenants.id });
          if (tenant) {
            await db.insert(schema.memberships).values({
              userId: user.id,
              tenantId: tenant.id,
              role: "owner",
            });
          }
        },
      },
    },
  },
});

export type Auth = typeof auth;
