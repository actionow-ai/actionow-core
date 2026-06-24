ALTER TABLE "model" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "maker" text;--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "context_length" integer;--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "reasoning" text;