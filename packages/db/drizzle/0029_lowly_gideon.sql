CREATE TABLE "fault_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"fast_fail" boolean DEFAULT false NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"backoff_type" text DEFAULT 'fixed' NOT NULL,
	"backoff_ms" integer DEFAULT 0 NOT NULL,
	"connect_timeout_ms" integer,
	"ttft_timeout_ms" integer,
	"total_timeout_ms" integer,
	"idle_timeout_ms" integer,
	"retry_codes" jsonb,
	"retry_messages" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "fault_policy_status_allowed" CHECK ("fault_policy"."status" IN ('active', 'disabled')),
	CONSTRAINT "fault_policy_backoff_allowed" CHECK ("fault_policy"."backoff_type" IN ('fixed', 'exponential'))
);
--> statement-breakpoint
ALTER TABLE "upstream_channel" ADD COLUMN "fault_policy_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "fault_policy_name_idx" ON "fault_policy" USING btree ("name") WHERE deleted_at IS NULL;--> statement-breakpoint
ALTER TABLE "upstream_channel" ADD CONSTRAINT "upstream_channel_fault_policy_id_fault_policy_id_fk" FOREIGN KEY ("fault_policy_id") REFERENCES "public"."fault_policy"("id") ON DELETE no action ON UPDATE no action;