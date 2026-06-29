CREATE TABLE "model_spec" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor" text NOT NULL,
	"model_id" text NOT NULL,
	"display_name" text,
	"family" text,
	"type" text NOT NULL,
	"input_modalities" jsonb,
	"output_modalities" jsonb,
	"media_options" jsonb,
	"key_params" jsonb,
	"sources" jsonb,
	"status" text,
	"context_window" text,
	"max_output" text,
	"intro" text,
	"confidence" text DEFAULT 'secondary' NOT NULL,
	"billing_eligible" boolean DEFAULT false NOT NULL,
	"as_of" text,
	"source_url" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "model_spec_type_allowed" CHECK ("model_spec"."type" IN ('text', 'image', 'video', 'audio', 'multimodal')),
	CONSTRAINT "model_spec_confidence_allowed" CHECK ("model_spec"."confidence" IN ('firstparty', 'secondary', 'reconstructed'))
);
--> statement-breakpoint
ALTER TABLE "official_model_price" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "official_model_price" ADD COLUMN "confidence" text DEFAULT 'firstparty' NOT NULL;--> statement-breakpoint
ALTER TABLE "official_model_price" ADD COLUMN "billing_eligible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "model_spec_vendor_model_idx" ON "model_spec" USING btree ("vendor","model_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "model_spec_vendor_idx" ON "model_spec" USING btree ("vendor");--> statement-breakpoint
CREATE INDEX "model_spec_type_idx" ON "model_spec" USING btree ("type");--> statement-breakpoint
CREATE INDEX "model_spec_confidence_idx" ON "model_spec" USING btree ("confidence");