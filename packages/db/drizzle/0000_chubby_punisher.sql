CREATE TYPE "public"."api_key_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."provider_key_status" AS ENUM('active', 'disabled', 'cooldown', 'exhausted', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."provider_type" AS ENUM('openai', 'anthropic', 'anthropic_passthrough', 'google', 'deepseek', 'openrouter', 'custom_openai', 'custom_anthropic');--> statement-breakpoint
CREATE TYPE "public"."quota_period" AS ENUM('minute', 'hour', 'day', 'month', 'lifetime');--> statement-breakpoint
CREATE TYPE "public"."rotation_strategy" AS ENUM('round_robin', 'weighted', 'least_used', 'sticky', 'random');--> statement-breakpoint
CREATE TYPE "public"."usage_status" AS ENUM('success', 'client_error', 'provider_error', 'rate_limited', 'timeout', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'admin', 'member', 'viewer');--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" varchar(256) NOT NULL,
	"name" varchar(128),
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"password_hash" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"name" varchar(128) NOT NULL,
	"prefix" varchar(16) NOT NULL,
	"key_hash" text NOT NULL,
	"status" "api_key_status" DEFAULT 'active' NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"allowed_ips" text[],
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"rpm_limit" integer,
	"tpm_limit" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"display_name" varchar(128),
	"context_window" integer,
	"input_price_per_mtok" integer,
	"output_price_per_mtok" integer,
	"supports_streaming" boolean DEFAULT true NOT NULL,
	"supports_tools" boolean DEFAULT false NOT NULL,
	"supports_vision" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"label" varchar(128),
	"key_encrypted" text NOT NULL,
	"key_fingerprint" varchar(64) NOT NULL,
	"status" "provider_key_status" DEFAULT 'active' NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"rpm_limit" integer,
	"tpm_limit" integer,
	"cooldown_until" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"type" "provider_type" NOT NULL,
	"base_url" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"rotation_strategy" "rotation_strategy" DEFAULT 'round_robin' NOT NULL,
	"max_retries" integer DEFAULT 3 NOT NULL,
	"timeout_ms" integer DEFAULT 60000 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pattern" varchar(128) NOT NULL,
	"primary_provider_id" uuid NOT NULL,
	"fallback_provider_ids" uuid[] DEFAULT '{}' NOT NULL,
	"cache_ttl_seconds" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"actor_user_id" uuid,
	"actor_type" varchar(32) DEFAULT 'user' NOT NULL,
	"action" varchar(64) NOT NULL,
	"resource_type" varchar(64) NOT NULL,
	"resource_id" varchar(128),
	"before" jsonb,
	"after" jsonb,
	"ip" varchar(64),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"api_key_id" uuid,
	"period" "quota_period" NOT NULL,
	"token_limit" bigint,
	"request_limit" integer,
	"cost_limit_usd" numeric(12, 2),
	"hard_limit" integer DEFAULT 1 NOT NULL,
	"alert_threshold_pct" integer DEFAULT 80 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"api_key_id" uuid,
	"provider_id" uuid,
	"provider_key_id" uuid,
	"model_id" uuid,
	"model_name" varchar(128) NOT NULL,
	"request_id" varchar(64) NOT NULL,
	"endpoint" varchar(64) NOT NULL,
	"status" "usage_status" NOT NULL,
	"http_status" integer,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"first_token_latency_ms" integer,
	"error_code" varchar(64),
	"error_message" text,
	"client_ip" varchar(64),
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_primary_provider_id_providers_id_fk" FOREIGN KEY ("primary_provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotas" ADD CONSTRAINT "quotas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotas" ADD CONSTRAINT "quotas_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_provider_key_id_provider_keys_id_fk" FOREIGN KEY ("provider_key_id") REFERENCES "public"."provider_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenants_slug_idx" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "users_tenant_idx" ON "users" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "api_keys_tenant_idx" ON "api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "api_keys_prefix_idx" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_keys_status_idx" ON "api_keys" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "models_provider_name_uq" ON "models" USING btree ("provider_id","name");--> statement-breakpoint
CREATE INDEX "models_provider_idx" ON "models" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "provider_keys_provider_idx" ON "provider_keys" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "provider_keys_status_idx" ON "provider_keys" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_keys_fingerprint_uq" ON "provider_keys" USING btree ("provider_id","key_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "providers_tenant_slug_uq" ON "providers" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "providers_type_idx" ON "providers" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "routes_tenant_pattern_uq" ON "routes" USING btree ("tenant_id","pattern");--> statement-breakpoint
CREATE INDEX "routes_primary_idx" ON "routes" USING btree ("primary_provider_id");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_created_idx" ON "audit_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_resource_idx" ON "audit_logs" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "quotas_tenant_idx" ON "quotas" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "quotas_api_key_idx" ON "quotas" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "usage_logs_tenant_created_idx" ON "usage_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_logs_api_key_created_idx" ON "usage_logs" USING btree ("api_key_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_logs_provider_created_idx" ON "usage_logs" USING btree ("provider_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_logs_status_idx" ON "usage_logs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "usage_logs_request_id_idx" ON "usage_logs" USING btree ("request_id");