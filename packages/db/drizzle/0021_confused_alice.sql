ALTER TABLE "upstream_channel" ADD COLUMN "input_cost_per_1m" bigint;--> statement-breakpoint
ALTER TABLE "upstream_channel" ADD COLUMN "output_cost_per_1m" bigint;--> statement-breakpoint
ALTER TABLE "usage_log" ADD COLUMN "provider_cost" bigint;