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
import { relations } from "drizzle-orm";
import { users, tenants } from "./tenants";
import { userRoleEnum } from "./enums";

// better-auth: persistent session token. `activeTenantId` is our extension:
// the tenant the user has selected in the dashboard switcher.
export const sessions = pgTable(
  "sessions",
  {
    id: uuid().defaultRandom().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    ipAddress: text(),
    userAgent: text(),
    activeTenantId: uuid().references(() => tenants.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sessions_token_uniq").on(t.token),
    index("sessions_user_idx").on(t.userId),
  ],
);

// better-auth: OAuth provider link. `providerId` is "google" | "github" | "credential".
// For credential (email/password) accounts, the bcrypt password hash is stored in
// the `password` column here (better-auth convention).
export const accounts = pgTable(
  "accounts",
  {
    id: uuid().defaultRandom().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: varchar({ length: 64 }).notNull(),
    accountId: varchar({ length: 256 }).notNull(),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true }),
    scope: text(),
    password: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("accounts_provider_account_uniq").on(
      t.providerId,
      t.accountId,
    ),
    index("accounts_user_idx").on(t.userId),
  ],
);

// better-auth: email verification, password reset tokens.
export const verifications = pgTable(
  "verifications",
  {
    id: uuid().defaultRandom().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

// Pending tenant invitations. `token` is a random opaque string handed to the
// invitee via `/accept-invite?token=...`. One-shot: deleted on accept.
export const invitations = pgTable(
  "invitations",
  {
    id: uuid().defaultRandom().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    email: varchar({ length: 256 }).notNull(),
    role: userRoleEnum().notNull().default("member"),
    token: text().notNull(),
    invitedByUserId: uuid().references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("invitations_token_uniq").on(t.token),
    index("invitations_tenant_idx").on(t.tenantId),
    index("invitations_email_idx").on(t.email),
  ],
);

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
  activeTenant: one(tenants, {
    fields: [sessions.activeTenantId],
    references: [tenants.id],
  }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const invitationsRelations = relations(invitations, ({ one }) => ({
  tenant: one(tenants, {
    fields: [invitations.tenantId],
    references: [tenants.id],
  }),
  invitedBy: one(users, {
    fields: [invitations.invitedByUserId],
    references: [users.id],
  }),
}));
