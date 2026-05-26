import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { userRoleEnum } from "./enums";
import { relations } from "drizzle-orm";

export const tenants = pgTable(
  "tenants",
  {
    id: uuid().defaultRandom().primaryKey(),
    slug: varchar({ length: 64 }).notNull().unique(),
    name: varchar({ length: 128 }).notNull(),
    isActive: boolean().notNull().default(true),
    metadata: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tenants_slug_idx").on(t.slug)],
);

// Global user identity — one row per (email). Multi-tenant membership lives
// in the `memberships` table. Shape follows better-auth defaults so the
// drizzle adapter can use this table directly.
export const users = pgTable(
  "users",
  {
    id: uuid().defaultRandom().primaryKey(),
    email: varchar({ length: 256 }).notNull(),
    emailVerified: boolean().notNull().default(false),
    name: varchar({ length: 128 }),
    image: text(),
    isActive: boolean().notNull().default(true),
    lastLoginAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_uniq").on(t.email)],
);

// User ↔ tenant join. One user can belong to many tenants with different roles.
export const memberships = pgTable(
  "memberships",
  {
    id: uuid().defaultRandom().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    role: userRoleEnum().notNull().default("member"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("memberships_user_tenant_uniq").on(t.userId, t.tenantId),
    index("memberships_tenant_idx").on(t.tenantId),
  ],
);

export const tenantsRelations = relations(tenants, ({ many }) => ({
  memberships: many(memberships),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  user: one(users, {
    fields: [memberships.userId],
    references: [users.id],
  }),
  tenant: one(tenants, {
    fields: [memberships.tenantId],
    references: [tenants.id],
  }),
}));
