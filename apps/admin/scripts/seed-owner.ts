/**
 * One-shot bootstrap: create an owner user for the default tenant.
 *
 * Reads SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD from the environment, runs
 * better-auth's sign-up flow (so the password is hashed correctly and
 * recorded in the `accounts` table), then promotes the resulting membership
 * to `owner` of the existing default tenant.
 *
 * Idempotent: if the email already exists, just ensures the owner role on
 * the default tenant.
 *
 *   SEED_OWNER_EMAIL=you@example.com \
 *   SEED_OWNER_PASSWORD=super-secret \
 *   pnpm tsx apps/admin/scripts/seed-owner.ts
 */
import { and, eq } from "drizzle-orm";
import { closeDb, getDb, schema } from "@ai-gateway/db";
import { auth } from "../src/auth";

const DEFAULT_TENANT_SLUG = process.env.SEED_TENANT_SLUG ?? "default";

async function main() {
  const email = process.env.SEED_OWNER_EMAIL;
  const password = process.env.SEED_OWNER_PASSWORD;
  if (!email || !password) {
    console.warn("⚠  SEED_OWNER_EMAIL or SEED_OWNER_PASSWORD not set — skipping owner seed.");
    return;
  }
  const db = getDb();
  const tenant = await db.query.tenants.findFirst({
    where: eq(schema.tenants.slug, DEFAULT_TENANT_SLUG),
  });
  if (!tenant) {
    throw new Error(
      `tenant "${DEFAULT_TENANT_SLUG}" not found — run \`pnpm db:seed\` first.`,
    );
  }

  const existing = await db.query.users.findFirst({
    where: eq(schema.users.email, email),
  });

  let userId: string;
  if (existing) {
    console.log(`= user: ${email} (exists)`);
    userId = existing.id;
  } else {
    // Sign up via better-auth so the bcrypt hash + accounts row are right.
    // The user-create hook in auth.ts creates a personal tenant for them.
    const res = await auth.api.signUpEmail({
      body: {
        email,
        password,
        name: email.split("@")[0] ?? "Owner",
      },
    });
    if (!res?.user?.id) {
      throw new Error("signUp returned no user");
    }
    userId = res.user.id;
    console.log(`+ user: ${email}`);
  }

  // Ensure they're an owner of the default tenant (in addition to the personal
  // tenant the afterHook would have created).
  const membership = await db.query.memberships.findFirst({
    where: and(
      eq(schema.memberships.userId, userId),
      eq(schema.memberships.tenantId, tenant.id),
    ),
  });
  if (membership) {
    if (membership.role !== "owner") {
      await db
        .update(schema.memberships)
        .set({ role: "owner", updatedAt: new Date() })
        .where(eq(schema.memberships.id, membership.id));
      console.log(`~ membership: promoted to owner of ${tenant.slug}`);
    } else {
      console.log(`= membership: already owner of ${tenant.slug}`);
    }
  } else {
    await db.insert(schema.memberships).values({
      userId,
      tenantId: tenant.id,
      role: "owner",
    });
    console.log(`+ membership: owner of ${tenant.slug}`);
  }

  console.log("\n✓ owner seed complete");
}

main()
  .catch((err) => {
    console.error("✗ owner seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
