import { pgEnum } from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", [
  "owner",
  "admin",
  "member",
  "viewer",
]);

export const providerTypeEnum = pgEnum("provider_type", [
  "openai",
  "anthropic",
  "anthropic_passthrough",
  "google",
  "deepseek",
  "openrouter",
  "custom_openai",
  "custom_anthropic",
  "kiro",
  "gemini",
]);

export const providerKeyStatusEnum = pgEnum("provider_key_status", [
  "active",
  "disabled",
  "cooldown",
  "exhausted",
  "revoked",
]);

export const apiKeyStatusEnum = pgEnum("api_key_status", [
  "active",
  "revoked",
]);

export const usageStatusEnum = pgEnum("usage_status", [
  "success",
  "client_error",
  "provider_error",
  "rate_limited",
  "timeout",
  "blocked",
]);

export const quotaPeriodEnum = pgEnum("quota_period", [
  "minute",
  "hour",
  "day",
  "month",
  "lifetime",
]);

export const rotationStrategyEnum = pgEnum("rotation_strategy", [
  "round_robin",
  "weighted",
  "least_used",
  "sticky",
  "random",
]);

export const proxyTypeEnum = pgEnum("proxy_type", [
  "http",
  "https",
  "socks4",
  "socks5",
]);

export const proxySourceEnum = pgEnum("proxy_source", [
  "manual",
  "scraper",
]);

export const proxyStatusEnum = pgEnum("proxy_status", [
  "unchecked",
  "alive",
  "dead",
]);
