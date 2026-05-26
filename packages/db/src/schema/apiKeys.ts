import { pgTable, uuid, varchar, text, timestamp, integer, bigint, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { tenants, users } from "./tenants";
import { apiKeyStatusEnum } from "./enums";

/**
 * API keys are what end-user clients send in `Authorization: Bearer ...`.
 * Stored as bcrypt/argon2 hash; the visible `prefix` is the first 8 chars after
 * the `ap_` namespace for searchability ("which key is this?").
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid().defaultRandom().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    createdByUserId: uuid().references(() => users.id, { onDelete: "set null" }),
    name: varchar({ length: 128 }).notNull(),
    prefix: varchar({ length: 16 }).notNull(),
    keyHash: text().notNull(),
    status: apiKeyStatusEnum().notNull().default("active"),
    scopes: text().array().notNull().default([]),
    allowedIps: text().array(),
    expiresAt: timestamp({ withTimezone: true }),
    lastUsedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    rpmLimit: integer(),
    tpmLimit: bigint({ mode: "number" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("api_keys_tenant_idx").on(t.tenantId),
    index("api_keys_prefix_idx").on(t.prefix),
    index("api_keys_status_idx").on(t.status),
  ],
);

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  tenant: one(tenants, {
    fields: [apiKeys.tenantId],
    references: [tenants.id],
  }),
  createdBy: one(users, {
    fields: [apiKeys.createdByUserId],
    references: [users.id],
  }),
}));
