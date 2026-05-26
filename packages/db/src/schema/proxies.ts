import {
  pgTable,
  uuid,
  varchar,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { tenants } from "./tenants";
import { proxyTypeEnum, proxySourceEnum, proxyStatusEnum } from "./enums";

export const proxies = pgTable(
  "proxies",
  {
    id: uuid().defaultRandom().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    label: varchar({ length: 128 }),
    type: proxyTypeEnum().notNull(),
    host: varchar({ length: 255 }).notNull(),
    port: integer().notNull(),
    username: varchar({ length: 128 }),
    passwordEncrypted: varchar({ length: 512 }),
    source: proxySourceEnum().notNull().default("manual"),
    isActive: boolean().notNull().default(true),
    status: proxyStatusEnum().notNull().default("unchecked"),
    latencyMs: integer(),
    lastCheckedAt: timestamp({ withTimezone: true }),
    failureCount: integer().notNull().default(0),
    successCount: integer().notNull().default(0),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("proxies_tenant_endpoint_uq").on(t.tenantId, t.type, t.host, t.port),
    index("proxies_tenant_idx").on(t.tenantId),
    index("proxies_status_idx").on(t.status),
  ],
);

export const proxiesRelations = relations(proxies, ({ one }) => ({
  tenant: one(tenants, { fields: [proxies.tenantId], references: [tenants.id] }),
}));
