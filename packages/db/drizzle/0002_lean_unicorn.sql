ALTER TABLE "usage_logs" ADD COLUMN "request_body" jsonb;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD COLUMN "response_body" jsonb;