import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { tenants } from "./tenants";
import {
  providerTypeEnum,
  providerKeyStatusEnum,
  rotationStrategyEnum,
} from "./enums";

/**
 * A provider is a configured LLM backend (e.g. "OpenAI prod", "Anthropic
 * passthrough via freemodel"). Multiple providers of the same type are allowed
 * (e.g. two OpenAI accounts).
 */
export const providers = pgTable(
  "providers",
  {
    id: uuid().defaultRandom().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    slug: varchar({ length: 64 }).notNull(),
    name: varchar({ length: 128 }).notNull(),
    type: providerTypeEnum().notNull(),
    baseUrl: text().notNull(),
    isActive: boolean().notNull().default(true),
    rotationStrategy: rotationStrategyEnum().notNull().default("round_robin"),
    maxRetries: integer().notNull().default(3),
    timeoutMs: integer().notNull().default(60_000),
    config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("providers_tenant_slug_uq").on(t.tenantId, t.slug),
    index("providers_type_idx").on(t.type),
  ],
);

/**
 * Each provider can have a pool of credentials (API keys, OAuth tokens, etc.).
 * Stored encrypted (envelope encryption via app-layer; column type is text).
 */
export const providerKeys = pgTable(
  "provider_keys",
  {
    id: uuid().defaultRandom().primaryKey(),
    providerId: uuid()
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    label: varchar({ length: 128 }),
    keyEncrypted: text().notNull(),
    keyFingerprint: varchar({ length: 64 }).notNull(),
    status: providerKeyStatusEnum().notNull().default("active"),
    weight: integer().notNull().default(1),
    rpmLimit: integer(),
    tpmLimit: integer(),
    cooldownUntil: timestamp({ withTimezone: true }),
    lastUsedAt: timestamp({ withTimezone: true }),
    failureCount: integer().notNull().default(0),
    successCount: integer().notNull().default(0),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("provider_keys_provider_idx").on(t.providerId),
    index("provider_keys_status_idx").on(t.status),
    uniqueIndex("provider_keys_fingerprint_uq").on(t.providerId, t.keyFingerprint),
  ],
);

/**
 * Catalog of models exposed by each provider. Pricing in USD per 1M tokens.
 */
export const models = pgTable(
  "models",
  {
    id: uuid().defaultRandom().primaryKey(),
    providerId: uuid()
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    name: varchar({ length: 128 }).notNull(),
    displayName: varchar({ length: 128 }),
    contextWindow: integer(),
    inputPricePerMtok: bigint({ mode: "number" }),
    outputPricePerMtok: bigint({ mode: "number" }),
    supportsStreaming: boolean().notNull().default(true),
    supportsTools: boolean().notNull().default(false),
    supportsVision: boolean().notNull().default(false),
    isActive: boolean().notNull().default(true),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("models_provider_name_uq").on(t.providerId, t.name),
    index("models_provider_idx").on(t.providerId),
  ],
);

/**
 * Routes map a client-facing model id (e.g. "gpt-4o-mini") to one or more
 * providers with fallback ordering and weighting.
 */
export const routes = pgTable(
  "routes",
  {
    id: uuid().defaultRandom().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    pattern: varchar({ length: 128 }).notNull(),
    primaryProviderId: uuid()
      .notNull()
      .references(() => providers.id, { onDelete: "restrict" }),
    fallbackProviderIds: uuid().array().notNull().default([]),
    cacheTtlSeconds: integer().notNull().default(0),
    isActive: boolean().notNull().default(true),
    priority: integer().notNull().default(100),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("routes_tenant_pattern_uq").on(t.tenantId, t.pattern),
    index("routes_primary_idx").on(t.primaryProviderId),
  ],
);

export const providersRelations = relations(providers, ({ one, many }) => ({
  tenant: one(tenants, { fields: [providers.tenantId], references: [tenants.id] }),
  keys: many(providerKeys),
  models: many(models),
}));

export const providerKeysRelations = relations(providerKeys, ({ one }) => ({
  provider: one(providers, {
    fields: [providerKeys.providerId],
    references: [providers.id],
  }),
}));

export const modelsRelations = relations(models, ({ one }) => ({
  provider: one(providers, {
    fields: [models.providerId],
    references: [providers.id],
  }),
}));

export const routesRelations = relations(routes, ({ one }) => ({
  tenant: one(tenants, { fields: [routes.tenantId], references: [tenants.id] }),
  primaryProvider: one(providers, {
    fields: [routes.primaryProviderId],
    references: [providers.id],
  }),
}));
