CREATE TYPE "public"."proxy_source" AS ENUM('manual', 'scraper');--> statement-breakpoint
CREATE TYPE "public"."proxy_status" AS ENUM('unchecked', 'alive', 'dead');--> statement-breakpoint
CREATE TYPE "public"."proxy_type" AS ENUM('http', 'https', 'socks4', 'socks5');--> statement-breakpoint
CREATE TABLE "proxies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" varchar(128),
	"type" "proxy_type" NOT NULL,
	"host" varchar(255) NOT NULL,
	"port" integer NOT NULL,
	"username" varchar(128),
	"password_encrypted" varchar(512),
	"source" "proxy_source" DEFAULT 'manual' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"status" "proxy_status" DEFAULT 'unchecked' NOT NULL,
	"latency_ms" integer,
	"last_checked_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proxies" ADD CONSTRAINT "proxies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proxies_tenant_endpoint_uq" ON "proxies" USING btree ("tenant_id","type","host","port");--> statement-breakpoint
CREATE INDEX "proxies_tenant_idx" ON "proxies" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "proxies_status_idx" ON "proxies" USING btree ("status");