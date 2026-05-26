import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  bigint,
  numeric,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { apiKeys } from "./apiKeys";
import { providers, providerKeys, models } from "./providers";
import { quotaPeriodEnum, usageStatusEnum } from "./enums";

/**
 * One row per request that hits the proxy. Append-only.
 * Pricing snapshot is denormalized (don't recompute when model price changes).
 */
export const usageLogs = pgTable(
  "usage_logs",
  {
    id: uuid().defaultRandom().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    apiKeyId: uuid().references(() => apiKeys.id, { onDelete: "set null" }),
    providerId: uuid().references(() => providers.id, { onDelete: "set null" }),
    providerKeyId: uuid().references(() => providerKeys.id, { onDelete: "set null" }),
    modelId: uuid().references(() => models.id, { onDelete: "set null" }),
    modelName: varchar({ length: 128 }).notNull(),
    requestId: varchar({ length: 64 }).notNull(),
    endpoint: varchar({ length: 64 }).notNull(),
    status: usageStatusEnum().notNull(),
    httpStatus: integer(),
    promptTokens: integer().notNull().default(0),
    completionTokens: integer().notNull().default(0),
    totalTokens: integer().notNull().default(0),
    cachedTokens: integer().notNull().default(0),
    costUsd: numeric({ precision: 12, scale: 6 }).notNull().default("0"),
    latencyMs: integer().notNull().default(0),
    firstTokenLatencyMs: integer(),
    errorCode: varchar({ length: 64 }),
    errorMessage: text(),
    clientIp: varchar({ length: 64 }),
    userAgent: text(),
    requestBody: jsonb().$type<unknown>(),
    responseBody: jsonb().$type<unknown>(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("usage_logs_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("usage_logs_api_key_created_idx").on(t.apiKeyId, t.createdAt),
    index("usage_logs_provider_created_idx").on(t.providerId, t.createdAt),
    index("usage_logs_status_idx").on(t.status),
    index("usage_logs_request_id_idx").on(t.requestId),
  ],
);

/**
 * Quotas can attach to either a tenant (org-wide) or a specific api_key.
 * Enforced in proxy hot-path via Redis counters; this table is the source of truth.
 */
export const quotas = pgTable(
  "quotas",
  {
    id: uuid().defaultRandom().primaryKey(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    apiKeyId: uuid().references(() => apiKeys.id, { onDelete: "cascade" }),
    period: quotaPeriodEnum().notNull(),
    tokenLimit: bigint({ mode: "number" }),
    requestLimit: integer(),
    costLimitUsd: numeric({ precision: 12, scale: 2 }),
    hardLimit: integer().notNull().default(1),
    alertThresholdPct: integer().notNull().default(80),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("quotas_tenant_idx").on(t.tenantId),
    index("quotas_api_key_idx").on(t.apiKeyId),
  ],
);

/**
 * Append-only log of admin actions for compliance.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid().defaultRandom().primaryKey(),
    tenantId: uuid().references(() => tenants.id, { onDelete: "set null" }),
    actorUserId: uuid(),
    actorType: varchar({ length: 32 }).notNull().default("user"),
    action: varchar({ length: 64 }).notNull(),
    resourceType: varchar({ length: 64 }).notNull(),
    resourceId: varchar({ length: 128 }),
    before: jsonb(),
    after: jsonb(),
    ip: varchar({ length: 64 }),
    userAgent: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_logs_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("audit_logs_resource_idx").on(t.resourceType, t.resourceId),
  ],
);
