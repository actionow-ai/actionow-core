ALTER TABLE "usage_log" ADD COLUMN "reasoning_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_log" ADD COLUMN "cached_input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_log" ADD COLUMN "cache_creation_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_log" ADD COLUMN "audio_input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_log" ADD COLUMN "audio_output_tokens" bigint DEFAULT 0 NOT NULL;