CREATE TABLE "official_model_price" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"model_slug" text NOT NULL,
	"display_name" text,
	"input_price_per_1m" bigint NOT NULL,
	"output_price_per_1m" bigint NOT NULL,
	"cached_input_price_per_1m" bigint,
	"source_url" text,
	"effective_at" timestamp with time zone,
	"notes" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "needs_pricing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "official_model_price_provider_slug_idx" ON "official_model_price" USING btree ("provider","model_slug") WHERE deleted_at IS NULL;