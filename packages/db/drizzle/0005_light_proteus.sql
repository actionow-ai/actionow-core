ALTER TABLE "upstream_channel" ADD COLUMN "endpoint" text;--> statement-breakpoint
ALTER TABLE "upstream_channel" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "upstream_channel" ADD COLUMN "proxy_ref" text;--> statement-breakpoint
ALTER TABLE "upstream_channel" ADD COLUMN "config" jsonb;