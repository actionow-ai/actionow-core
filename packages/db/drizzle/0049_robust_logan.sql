ALTER TABLE "upstream_channel" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_trace" ADD COLUMN "route_tag" text;--> statement-breakpoint
ALTER TABLE "usage_log" ADD COLUMN "route_tag" text;